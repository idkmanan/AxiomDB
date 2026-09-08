import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import logger from '#config/logger.js';
import { db } from '#config/database.js';
import { users } from '#models/user.model.js';
import { AppError } from '#middleware/error.middleware.js';
import { pgCodeOf } from '#utils/db-error.js';

// bcrypt cost 10, measured on the benchmark host at 54.8 ms per compare
// (finding F-05, re-measured during the Phase 0 run). That is the largest single
// item in the per-iteration CPU budget and it is NOT a defect — it is the
// security/throughput trade the cost factor exists to make. Lowering it to make a
// benchmark look better makes the system worse, which is why the number is
// recorded rather than tuned. What Phase 1 adds is a rate limit in front of it
// (src/rate-limit/policy.js), so it can no longer be used as a cheap CPU
// exhaustion channel: at ~18 compares/s per core, 20 concurrent attackers were
// the whole service.
const BCRYPT_COST = 10;

export const hashPassword = async (password) => {
  try {
    return await bcrypt.hash(password, BCRYPT_COST);
  } catch (e) {
    logger.error('Error hashing the password', e);
    throw new AppError('Error hashing password', 500, { cause: e });
  }
};

export const comparePassword = async (password, hash) => {
  try {
    return await bcrypt.compare(password, hash);
  } catch (e) {
    logger.error('Error comparing the password', e);
    throw new AppError('Error comparing password', 500, { cause: e });
  }
};

export const authenticateUser = async (email, password) => {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Identical 401 and identical message for "no such user" and "wrong password".
  // v0 threw 'User not found' and 'Invalid password' as distinguishable errors;
  // the controller happened to collapse both to one response, but the service
  // contract invited a caller to tell them apart, and a different response for
  // the two lets an unauthenticated client enumerate registered addresses.
  //
  // What is NOT fixed here, stated rather than left silent: with no user found no
  // bcrypt compare runs, so the response returns measurably sooner than a
  // wrong-password attempt. That is a timing oracle for the same enumeration.
  // Closing it needs a dummy compare against a fixed hash, and it belongs with
  // the Phase 4 rebuild of the credential path.
  if (!user) {
    throw new AppError('Invalid email or password', 401, { code: 'INVALID_CREDENTIALS' });
  }

  const valid = await comparePassword(password, user.password);
  if (!valid) {
    throw new AppError('Invalid email or password', 401, { code: 'INVALID_CREDENTIALS' });
  }

  logger.info('User authenticated', { userId: user.id });
  return user;
};

/**
 * Create a user.
 *
 * NOTE THE SIGNATURE: it takes no `role`. That is the second half of the
 * privilege-escalation fix. v0 accepted `role` as a parameter with a `'user'`
 * default, and its only caller passed whatever arrived in the request body
 * (auth.controller.js:19-20). A safe default is no protection when the caller
 * overrides it. Role assignment is a server decision, so the server makes it, and
 * promoting a user is a separate authenticated admin-only operation
 * (src/controllers/users.controller.js:86-89).
 */
export const createUser = async ({ name, password, email }, { executor = db } = {}) => {
  // NO EXISTENCE CHECK, AND THAT IS THE PHASE 3 FIX — FINDING F-41.
  //
  // What was here in v0 and in Phase 1:
  //
  //   const existing = await db.select({id}).from(users).where(eq(users.email, email))
  //   if (existing.length > 0) throw new AppError(…409…)
  //   …then INSERT
  //
  // The Phase 1 comment promised that Phase 3 would "wrap it in a transaction where it
  // becomes the worked example for isolation levels". Working through it produced a
  // better answer, and the fact that the plan was wrong is the interesting part:
  //
  // A TRANSACTION WOULD NOT HAVE FIXED IT. At READ COMMITTED — the Postgres default —
  // each statement takes a fresh snapshot of committed data, and an uncommitted INSERT
  // in another transaction is invisible. So both callers run the SELECT, both see
  // nothing, both INSERT, and one gets a unique-violation on COMMIT. `BEGIN` changes
  // the failure's timing and nothing about its existence. Only SERIALIZABLE would
  // detect it, at the cost of a 40001 that has to be retried — for a case the unique
  // index already handles perfectly.
  //
  // So the check is DELETED rather than defended. The unique constraint from
  // drizzle/0000_dapper_hedge_knight.sql:10 is the serialization point; it is atomic,
  // it costs nothing extra, and it is enforced against every writer including psql and
  // the seeder. The 23505 handler below stops being a fallback for a lost race and
  // becomes the primary path — which also removes one round trip from every signup.
  //
  // scripts/db/isolation-demo.mjs demonstrates all three behaviours (READ COMMITTED
  // both-pass, SERIALIZABLE 40001, unique-constraint 23505) against a real database
  // rather than asserting them here.
  const password_hash = await hashPassword(password);

  try {
    const [newUser] = await executor
      .insert(users)
      .values({ name, email, password: password_hash, role: 'user' })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        created_at: users.created_at,
      });
    logger.info('User created', { userId: newUser.id });
    return newUser;
  } catch (e) {
    // `pgCodeOf` walks the cause chain rather than reading `e.code`, and that is
    // finding F-36: drizzle rethrows every driver failure as a DrizzleQueryError whose
    // own message is "Failed query: …" and which carries no code, so the original
    // `e?.code === '23505'` never matched and a duplicate signup still produced a 500.
    // The unit test passed because it constructed a raw pg-shaped error rather than the
    // wrapped shape the application actually throws.
    if (pgCodeOf(e) === '23505') {
      logger.info('Signup rejected by the unique constraint on users.email');
      throw new AppError('User with this email already exists', 409, {
        code: 'EMAIL_TAKEN',
        cause: e,
      });
    }
    logger.error('Error creating the user', e);
    throw e;
  }
};
