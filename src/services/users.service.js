import { asc, eq, sql } from 'drizzle-orm';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { users } from '#models/user.model.js';
import { AppError } from '#middleware/error.middleware.js';

// The public column set. `password` is absent on purpose and must stay absent —
// `db.select().from(users)` (no projection) returns the bcrypt hash, which is
// exactly what authenticateUser does deliberately and what a list endpoint must
// never do.
const PUBLIC_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  created_at: users.created_at,
  updated_at: users.updated_at,
};

/**
 * List users, one page at a time.
 *
 * WHAT THIS REPLACED, and why it is the clearest measured win in Phase 1.
 *
 * v0 lines 6-20 were a `SELECT` of every row with no LIMIT, no OFFSET and no
 * ORDER BY. Phase 0 measured the consequences at 1,001 seeded rows:
 *
 *   167 KiB per response
 *   7.36 ms of JSON.stringify per response, before node-postgres parses 1001
 *          rows off the wire in text format and drizzle maps them to objects
 *   2.20 ms in Postgres — i.e. the database was never the problem
 *
 * That last figure is the interesting one. The reflex fix for a slow list
 * endpoint is an index, and an index here would have achieved nothing: the scan
 * was 0.335 ms of execution against 21 shared-buffer hits, entirely cached. The
 * cost was shipping and materialising rows in Node. Pagination is the fix
 * because it reduces the number of rows, not the cost of finding them.
 *
 * The missing ORDER BY was a correctness bug independent of performance: without
 * it Postgres may return rows in any order, so paging without ordering would skip
 * and duplicate rows as the heap changed underneath. Ordering by the primary key
 * is stable and free — it is an index-ordered scan.
 *
 * OFFSET, NOT KEYSET, and deliberately so. `OFFSET n` makes the database walk and
 * discard n rows, so page 10,000 costs 10,000 rows of work; keyset pagination
 * (`WHERE id > :cursor`) is O(page). At 1,001 rows the difference is unmeasurable,
 * and Phase 3 introduces the write-heavy entity at 1M+ rows where it becomes
 * measurable and gets the before/after it deserves. Shipping keyset now would
 * mean claiming an improvement that could not be demonstrated.
 *
 * @param {{limit: number, offset: number}} page
 */
export const getAllUsers = async ({ limit, offset }) => {
  // Two queries, and the count is the expensive one: COUNT(*) is a full scan in
  // Postgres because MVCC gives no single authoritative row count. Trivial at
  // 1,001 rows, not trivial at 1M — Phase 3 replaces it on the new entity with
  // either an estimate from pg_class.reltuples or a cursor-based response with no
  // total at all, which is what large APIs actually do.
  const [rows, [{ total }]] = await Promise.all([
    db.select(PUBLIC_COLUMNS).from(users).orderBy(asc(users.id)).limit(limit).offset(offset),
    db.select({ total: sql`count(*)::int` }).from(users),
  ]);

  return {
    users: rows,
    pagination: {
      limit,
      offset,
      total,
      returned: rows.length,
      hasMore: offset + rows.length < total,
    },
  };
};

export const getUserById = async (id) => {
  const result = await db.select(PUBLIC_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
  return result[0] || null;
};

export const updateUser = async (id, updates) => {
  // READ-MODIFY-WRITE RACE, unchanged and recorded.
  //
  // This reads the row, decides it exists, then writes — with no transaction and
  // no version check. Two concurrent updates to the same user both read the same
  // state and the second silently overwrites the first: a lost update. The
  // existence check is also redundant with the UPDATE itself, which is what makes
  // the fix cheap.
  //
  // Phase 3 replaces this with either `SELECT … FOR UPDATE` inside a transaction
  // or an optimistic-concurrency version column returning 409 on conflict, and
  // that comparison is the point of the isolation-level section. Fixing it here
  // would spend the exhibit before there is a benchmark to show it in.
  const existingUser = await getUserById(id);
  if (!existingUser) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }

  const result = await db
    .update(users)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(users.id, id))
    .returning(PUBLIC_COLUMNS);

  logger.info('User updated', { userId: id, fields: Object.keys(updates) });
  return result[0];
};

export const deleteUser = async (id) => {
  // Same race as updateUser, same reason for leaving it.
  const existingUser = await getUserById(id);
  if (!existingUser) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }

  await db.delete(users).where(eq(users.id, id));
  logger.info('User deleted', { userId: id });
  return { success: true };
};
