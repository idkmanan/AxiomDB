import { asc, eq, sql } from 'drizzle-orm';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { users } from '#models/user.model.js';
import { AppError } from '#middleware/error.middleware.js';
import { pgCodeOf } from '#utils/db-error.js';

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

export const updateUser = async (id, updates, { executor = db } = {}) => {
  // ONE STATEMENT — FINDING F-42. What was here:
  //
  //   const existing = await getUserById(id);   // decision
  //   if (!existing) throw new AppError(…404…);
  //   await db.update(users).set(updates)…      // action, on state that may have moved
  //
  // Two problems, one fix. The existence check was redundant with the UPDATE — a
  // predicate that matches no rows returns no rows, which is the same information — so
  // it bought nothing and cost a round trip on every request. And between the read and
  // the write another request could delete or modify the row, which is the check-then-act
  // pattern F-41 covers in its other form.
  //
  // WHAT THIS DOES AND DOES NOT GUARANTEE, stated because "fixed the lost update" would
  // be too strong: drizzle sets only the columns present in `updates`, so two concurrent
  // updates to DIFFERENT fields now both survive — under the old read-modify-write shape
  // the second would have carried stale values for the first's fields. Two concurrent
  // updates to the SAME field remain last-writer-wins, which is the conventional
  // semantics for a partial update over HTTP and is a policy rather than a bug.
  //
  // Where that policy is not good enough, the alternative is a version column and a 409,
  // which is exactly what `deals` does (src/services/deals.service.js). Putting both in
  // the codebase is the point: the comparison is the deliverable, not the winner.
  const [row] = await executor
    .update(users)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(users.id, id))
    .returning(PUBLIC_COLUMNS);

  if (!row) throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });

  logger.info('User updated', { userId: id, fields: Object.keys(updates) });
  return row;
};

export const deleteUser = async (id, { executor = db } = {}) => {
  try {
    const [row] = await executor.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  } catch (e) {
    // NEW IN PHASE 3, and a direct consequence of `deals.owner_id` being declared
    // ON DELETE RESTRICT rather than CASCADE. Deleting a user who still owns deals is
    // now refused by the database with SQLSTATE 23503.
    //
    // The generic handler in src/middleware/error.middleware.js maps 23503 to
    // "Referenced resource does not exist", which is the correct message for the INSERT
    // direction and misleading for this one — the referenced row exists, it is the
    // referencing rows that block the delete. So the direction is disambiguated here,
    // where the intent is known, rather than by making the shared table vaguer.
    //
    // CASCADE was the alternative and it is the wrong default for business records: it
    // would silently destroy a pipeline when an account is closed, and the caller would
    // never learn how much was deleted.
    if (pgCodeOf(e) === '23503') {
      logger.warn('User delete refused — the user still owns deals', { userId: id });
      throw new AppError(
        'This user still owns deals. Reassign or delete them before deleting the account.',
        409,
        { code: 'USER_HAS_DEALS', cause: e }
      );
    }
    throw e;
  }

  logger.info('User deleted', { userId: id });
  return { success: true };
};
