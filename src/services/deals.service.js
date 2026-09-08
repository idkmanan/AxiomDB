// ---------------------------------------------------------------------------
// Deals — the read and write paths Phase 3 measures.
//
// FOUR THINGS ARE BEING DEMONSTRATED HERE, and each one has a committed plan or a
// script behind it rather than a claim:
//
//   1. Keyset pagination against OFFSET, at 1M rows      (listDeals / listDealsPage)
//   2. Composite and partial indexes that match the query (see src/models/deal.model.js)
//   3. Optimistic concurrency with a version column       (updateDeal)
//   4. Pessimistic row locking where the decision depends on current state
//                                                        (advanceDealStage)
//
// Every write takes an optional `executor`, defaulting to the pool-backed `db`. That
// is not speculative generality: Phase 5 writes an outbox row in the SAME transaction
// as the domain write, and a service whose functions can only run standalone would
// have to be rewritten to allow it. One parameter now, no rewrite later — the same
// reasoning that made the rate-limit store swappable in Phase 1.
// ---------------------------------------------------------------------------
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { deals, DEAL_COLUMNS, TERMINAL_STAGES, nextStages } from '#models/deal.model.js';
import { AppError } from '#middleware/error.middleware.js';
import { encodeCursor, decodeCursor } from '#utils/cursor.js';
import { withTransaction } from '#utils/tx.js';
import { enqueueEvent } from '#events/outbox.service.js';

/**
 * The ORDER BY, written once.
 *
 * `DESC NULLS LAST` is spelled out, and that is not pedantry — it is the difference
 * between an index scan and a sort of 1,000,000 rows. In SQL, `ORDER BY x DESC`
 * defaults to `NULLS FIRST`, while the index in drizzle/0001_deals.sql is built
 * `DESC NULLS LAST`. Postgres matches an index to a requested ordering by comparing
 * pathkeys, and the null placement is part of that comparison — it does not reason
 * about the columns being NOT NULL. So `orderBy(desc(deals.created_at))`, which is
 * what drizzle's helper emits, would produce a plan with an explicit Sort node above
 * a full scan while the "correct" index sat unused. FINDING F-47.
 *
 * The cheap alternative is a plain ascending index, which Postgres can walk backwards
 * to satisfy `DESC NULLS FIRST`. That works only while every column in the ORDER BY
 * points the same way; the moment one is mixed (`created_at DESC, id ASC`) no
 * single-direction index can serve it and the index has to be declared to match.
 * Declaring both sides explicitly is the version that keeps working.
 */
const KEYSET_ORDER = sql`${deals.created_at} desc nulls last, ${deals.id} desc nulls last`;

/**
 * Build the WHERE clause shared by both pagination strategies, so the offset-vs-keyset
 * comparison differs in exactly one thing: how the page boundary is expressed.
 *
 * The `closed_at IS NULL` predicate is the interesting line. When the requested stage
 * is non-terminal, `deals_closed_at_matches_stage` (a CHECK constraint) already
 * guarantees the column is NULL, so the predicate adds no selectivity — it is there
 * purely to make the PARTIAL index `deals_open_created_idx` usable. Postgres decides
 * whether a partial index applies with `predicate_implied_by()`, which reasons over
 * the query's own qualifiers; it does not consult table CHECK constraints to prove
 * that `stage = 'diligence'` implies `closed_at IS NULL`. A fact that is true of the
 * data and unprovable from the query is not available to the planner, so the query
 * states it.
 */
function buildFilters({ ownerId, stage }) {
  const clauses = [];
  if (ownerId !== undefined && ownerId !== null) clauses.push(eq(deals.owner_id, ownerId));
  if (stage) {
    clauses.push(eq(deals.stage, stage));
    if (!TERMINAL_STAGES.includes(stage)) clauses.push(isNull(deals.closed_at));
  }
  return clauses;
}

/**
 * Keyset ("cursor") page.
 *
 * THE QUERY, and why it is a row-value comparison rather than the usual OR-chain:
 *
 *   WHERE (created_at, id) < ($1, $2)
 *
 * The naive form is `created_at < $1 OR (created_at = $1 AND id < $2)`, which is
 * logically identical and considerably worse in practice: Postgres cannot use it as a
 * single index qualifier, so it filters rather than seeks. The row constructor is
 * directly usable against a multicolumn btree index — it is the one form that turns
 * "the next 20 rows" into 20 rows of work regardless of how deep the page is.
 *
 * `LIMIT n + 1`, and no COUNT. Fetching one extra row is how `hasMore` is answered
 * without a second query; the extra row is discarded. See `estimateDealCount` for why
 * there is no exact total — FINDING F-45.
 *
 * @param {object} q
 * @param {number} q.limit
 * @param {string} [q.cursor] opaque cursor from the previous page
 * @param {number} [q.ownerId]
 * @param {string} [q.stage]
 */
export const listDeals = async ({ limit, cursor, ownerId, stage }) => {
  const clauses = buildFilters({ ownerId, stage });

  if (cursor) {
    // Throws a 400 AppError on anything malformed, so a crafted cursor cannot reach
    // Postgres as a type error.
    const { createdAt, id } = decodeCursor(cursor);
    // Explicit casts: without them the parameter types in a row comparison are
    // inferred, and an inference that resolves `$1` to `text` compares timestamps
    // lexically — which mostly works, and stops working across a timezone or a
    // precision boundary.
    clauses.push(
      sql`(${deals.created_at}, ${deals.id}) < (${createdAt}::timestamptz, ${id}::bigint)`
    );
  }

  const rows = await db
    .select(DEAL_COLUMNS)
    .from(deals)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(KEYSET_ORDER)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    deals: page,
    pagination: {
      limit,
      returned: page.length,
      hasMore,
      // Only when there is a next page. A cursor on the last page invites a client to
      // keep polling an endpoint that will only ever return zero rows.
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      strategy: 'keyset',
    },
  };
};

/**
 * OFFSET page — kept deliberately, as the comparison instrument.
 *
 * This is the query keyset pagination replaces, and it stays reachable
 * (`GET /api/deals?offset=…`) for one reason: a before/after claim needs both halves
 * to be runnable against the same data, through the same stack, by the same k6
 * script. Removing it would leave the improvement as arithmetic.
 *
 * WHY IT IS SLOW, precisely: `OFFSET 950000 LIMIT 20` does not skip 950,000 rows, it
 * READS them, in order, and discards them. The work is linear in the offset, so page
 * one and page 47,500 differ by five orders of magnitude of I/O for an identically
 * sized response. It is also incorrect in a way that has nothing to do with speed:
 * a row inserted while a client pages shifts every subsequent offset, so the client
 * sees a row twice or never — which keyset pagination fixes as a side effect of
 * anchoring on a value rather than a position.
 *
 * The offset ceiling is enforced by the validator (src/validations/deals.validation.js)
 * rather than here, because an unbounded offset is a caller-controlled cost — the same
 * defect class as the uncapped `limit` that pagination itself introduced in Phase 1.
 */
export const listDealsPage = async ({ limit, offset, ownerId, stage }) => {
  const clauses = buildFilters({ ownerId, stage });

  const rows = await db
    .select(DEAL_COLUMNS)
    .from(deals)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(KEYSET_ORDER)
    .limit(limit)
    .offset(offset);

  return {
    deals: rows,
    pagination: {
      limit,
      offset,
      returned: rows.length,
      // No `total`, and therefore no honest `hasMore` — a full row is deliberately not
      // fetched here because the point of this path is to be the unmodified OFFSET
      // query. `returned === limit` is the conventional heuristic and it is a guess.
      hasMore: rows.length === limit,
      strategy: 'offset',
    },
  };
};

/**
 * Approximate row count.
 *
 * FINDING F-45. `SELECT count(*)` in Postgres reads every visible row: MVCC keeps no
 * authoritative counter, because "how many rows are there" has a different answer per
 * snapshot. At the 1,001 rows of `users` that is 2.20 ms and nobody notices — which is
 * why src/services/users.service.js still does it, honestly labelled. At 1M rows it is
 * a full scan on every page request, and it is the reason a paginated list endpoint
 * that reports an exact total is often slower than the page it returns.
 *
 * `reltuples` is the planner's own estimate, maintained by ANALYZE and autovacuum. It
 * is wrong by design — the API labels it `total_estimated`, never `total`, because a
 * number a client believes to be exact and is not is worse than an admitted estimate.
 * An exact count remains available as a product decision with a measured price.
 */
export const estimateDealCount = async () => {
  const result = await db.execute(
    sql`select reltuples::bigint as estimate from pg_class where relname = 'deals'`
  );
  const [row] = rowsOf(result);
  const estimate = Number(row?.estimate ?? -1);
  // -1 means the table has never been analysed. Reporting it as 0 would be a lie that
  // a UI would render as "no results".
  return estimate < 0 ? null : estimate;
};

/**
 * Rows out of a raw `db.execute()` result.
 *
 * Worth a helper because the shape is driver-dependent and that dependency used to be
 * invisible: `drizzle-orm/node-postgres` returns node-postgres' `QueryResult`, so rows
 * live under `.rows`, while `drizzle-orm/neon-http` returned a plain array. Code
 * written against one shape silently produced `undefined` under the other — one more
 * item on the bill for the driver branch F-38 removed.
 */
function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

export const getDealById = async (id, { executor = db } = {}) => {
  const [row] = await executor.select(DEAL_COLUMNS).from(deals).where(eq(deals.id, id)).limit(1);
  return row || null;
};

/**
 * Insert a deal, and its event, in one transaction.
 *
 * No existence check on `owner_id`, and that is the same lesson as F-41 applied forwards: a
 * `SELECT` to confirm the user exists would be check-then-act, would race a concurrent account
 * deletion, and would add a round trip to every write. The foreign key is the authority. Its
 * violation (SQLSTATE 23503) is already mapped to 409 by src/middleware/error.middleware.js, so
 * the client gets a correct answer from one statement.
 *
 * `version` and `created_at` are not accepted from the caller — they are server facts.
 *
 * THE OUTBOX INSERT IS WHY THIS IS A TRANSACTION (Phase 5). The alternative — insert the deal,
 * then publish to Kafka — has no correct ordering: publish first and a database failure announces
 * a deal that does not exist; write first and a broker failure loses the event silently, after the
 * client already has its 201. Writing the event to a table in the same commit removes the second
 * system from the critical path entirely. See src/models/outbox.model.js.
 */
export const createDeal = async (
  { ownerId, title, company, amountCents, currency = 'USD', stage },
  { executor } = {}
) => {
  const run = async (tx) => {
    const [row] = await tx
      .insert(deals)
      .values({
        owner_id: ownerId,
        title,
        company,
        amount_cents: amountCents,
        currency,
        ...(stage ? { stage } : {}),
      })
      .returning(DEAL_COLUMNS);

    await enqueueEvent(tx, {
      aggregateType: 'deal',
      aggregateId: row.id,
      eventType: 'deal.created',
      // The whole row as the payload. A payload of `{id}` would force every consumer to call back
      // into this service to learn anything, which turns an event stream into a queue of RPC
      // triggers and couples the consumer's availability to ours.
      payload: row,
    });

    logger.info('Deal created', { dealId: row.id, ownerId, amountCents, currency });
    return row;
  };

  // An executor means the caller already has a transaction and expects this to join it.
  if (executor) return run(executor);
  return withTransaction(db, run, { label: 'createDeal' });
};

/**
 * Update a deal with an optimistic version check.
 *
 * THE SHAPE THAT MATTERS:
 *
 *   UPDATE deals SET …, version = version + 1
 *   WHERE id = $1 AND version = $2
 *   RETURNING …
 *
 * One statement. The read the client already performed supplies `$2`, so no lock is
 * held across the client's thinking time and no transaction is open while a human
 * decides. Zero rows affected means somebody else got there first, and the client is
 * told so with 409 plus the current version — enough to re-read, re-apply and retry.
 *
 * WHAT THIS REPLACES — FINDING F-42. v0's `updateUser` (and this service's first
 * draft) read the row, decided it existed, then wrote:
 *
 *   const existing = await getUserById(id);      // <- decision
 *   if (!existing) throw 404;
 *   await db.update(users).set(updates)…         // <- action, on stale state
 *
 * Two concurrent updates both read the same state and the second silently overwrites
 * the first: a lost update, invisible in logs, and indistinguishable from "the user
 * changed their mind". The existence check was also redundant with the UPDATE, so the
 * fix removes a round trip while fixing the race — the rare case where the correct
 * version is also the faster one.
 *
 * WHY THE 404/409 DISTINCTION COSTS A SECOND QUERY, and only on failure: zero rows
 * updated is ambiguous. Reading the row first to disambiguate would put the check back
 * before the act, which is the bug. So the extra read happens only after the update
 * has already failed, where it cannot affect correctness.
 */
export const updateDeal = async (id, updates, { expectedVersion, ownerId, executor = db } = {}) => {
  if (!Number.isInteger(expectedVersion)) {
    // A 428 rather than a 400: the request is well-formed, it is the missing
    // precondition that makes it unsafe. RFC 6585's exact use case, and it lets a
    // client library distinguish "I sent nonsense" from "I forgot to send the version
    // I read".
    throw new AppError('A version is required to update a deal', 428, {
      code: 'VERSION_REQUIRED',
    });
  }

  // OWNERSHIP IS A WHERE CLAUSE, NOT A PRE-READ. Checking "is this mine?" with a SELECT
  // and then issuing the UPDATE is check-then-act again (F-41, F-42) and costs a round
  // trip on every write. Folded into the predicate, the statement is atomic and the
  // failure path — zero rows — is the only place that needs to work out why.
  const scope = [eq(deals.id, id), eq(deals.version, expectedVersion)];
  if (ownerId !== undefined && ownerId !== null) scope.push(eq(deals.owner_id, ownerId));

  const [row] = await executor
    .update(deals)
    .set({
      ...updates,
      version: sql`${deals.version} + 1`,
      // `now()` rather than a JS `Date`: the database's clock, evaluated inside the
      // transaction, so two rows written in one transaction carry the same timestamp
      // and no client clock skew can order them wrongly.
      updated_at: sql`now()`,
    })
    .where(and(...scope))
    .returning(DEAL_COLUMNS);

  if (row) {
    logger.info('Deal updated', { dealId: id, fields: Object.keys(updates), version: row.version });
    return row;
  }

  // Three reasons for zero rows, and they are different answers: the deal is gone
  // (404), it belongs to someone else (404 — never 403, which would confirm it exists),
  // or somebody else updated it first (409 with the current version).
  const current = await getDealById(id, { executor });
  if (!current) throw new AppError('Deal not found', 404, { code: 'DEAL_NOT_FOUND' });
  if (ownerId !== undefined && ownerId !== null && current.owner_id !== ownerId) {
    throw new AppError('Deal not found', 404, { code: 'DEAL_NOT_FOUND' });
  }

  logger.warn('Deal update rejected — version conflict', {
    dealId: id,
    expectedVersion,
    currentVersion: current.version,
  });
  const conflict = new AppError('Deal was modified by someone else', 409, {
    code: 'VERSION_CONFLICT',
  });
  conflict.currentVersion = current.version;
  throw conflict;
};

/**
 * Advance a deal to the next stage, with a real row lock.
 *
 * WHY PESSIMISTIC HERE WHEN `updateDeal` IS OPTIMISTIC — this is the comparison the
 * phase exists to make, and the answer is not "locks are slower":
 *
 *   The request is "advance this deal", not "set stage to X if version is 7". Whether
 *   the move is legal depends on the CURRENT value in the database, which the client
 *   may never have read. There is no version for it to send, so an optimistic check has
 *   nothing to check against — and inventing one (re-read, compare, write) is exactly
 *   the read-modify-write race of F-42 with extra steps.
 *
 *   `SELECT … FOR UPDATE` inside a transaction makes the read and the decision
 *   atomic: a second caller blocks on the row until this transaction commits, then
 *   reads the new stage and is correctly refused. Two concurrent "advance" calls
 *   therefore produce one advance and one 409, never a double advance and never a
 *   stage that skips a step.
 *
 * THE LOCK IS HELD FOR MICROSECONDS, AND THAT IS THE WHOLE DISCIPLINE. It is taken and
 * released inside one transaction, on the server, with no network round trip to a
 * client in between. `SELECT FOR UPDATE` becomes a scalability disaster when the lock
 * spans a user's thinking time — that is the version people mean when they say
 * pessimistic locking does not scale, and it is a different design, not a different
 * primitive.
 *
 * NOT `SKIP LOCKED`, deliberately: skipping a locked row is right for a work queue
 * (Phase 5's outbox poller uses it) and wrong here, because "somebody else is moving
 * this deal" must be answered, not silently ignored.
 */
export const advanceDealStage = async (id, toStage, { ownerId, executor } = {}) => {
  const run = async (tx) => {
    const scope = [eq(deals.id, id)];
    if (ownerId !== undefined && ownerId !== null) scope.push(eq(deals.owner_id, ownerId));

    const [current] = await tx
      .select({ id: deals.id, stage: deals.stage, version: deals.version })
      .from(deals)
      .where(and(...scope))
      .limit(1)
      .for('update');

    if (!current) throw new AppError('Deal not found', 404, { code: 'DEAL_NOT_FOUND' });

    const allowed = nextStages(current.stage);
    if (!allowed.includes(toStage)) {
      const err = new AppError(
        `A deal in stage "${current.stage}" cannot move to "${toStage}"`,
        409,
        { code: 'ILLEGAL_STAGE_TRANSITION' }
      );
      err.currentStage = current.stage;
      err.allowedStages = allowed;
      throw err;
    }

    const closing = TERMINAL_STAGES.includes(toStage);
    const [updated] = await tx
      .update(deals)
      .set({
        stage: toStage,
        // The CHECK constraint `deals_closed_at_matches_stage` makes this line
        // mandatory rather than tidy: a terminal stage without a closing timestamp is
        // rejected by the database, so the invariant cannot drift even if a future
        // caller forgets.
        closed_at: closing ? sql`now()` : null,
        version: sql`${deals.version} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(deals.id, id))
      .returning(DEAL_COLUMNS);

    logger.info('Deal stage advanced', {
      dealId: id,
      from: current.stage,
      to: toStage,
      version: updated.version,
    });

    // In the same transaction as the stage change, for the same reason as `createDeal`. Note the
    // event carries the NEW state including `closed_at`, so a consumer never has to ask what
    // changed — and never sees a stage it cannot explain, because the partition key
    // (`deal:<id>`) keeps this event behind the `deal.created` one.
    await enqueueEvent(tx, {
      aggregateType: 'deal',
      aggregateId: id,
      eventType: 'deal.stage_advanced',
      payload: { ...updated, previous_stage: current.stage },
    });

    return updated;
  };

  // When an executor is supplied we are already inside a transaction — opening a
  // nested one would emit a SAVEPOINT, which is not wrong but is not what the caller
  // asked for. Phase 5 calls this from inside its own transaction.
  if (executor) return run(executor);
  return withTransaction(db, run, { label: 'advanceDealStage' });
};

/**
 * Delete a deal. Single statement, no existence check — same reasoning as `updateDeal`.
 */
export const deleteDeal = async (id, { ownerId, executor = db } = {}) => {
  const scope = [eq(deals.id, id)];
  if (ownerId !== undefined && ownerId !== null) scope.push(eq(deals.owner_id, ownerId));

  const [row] = await executor
    .delete(deals)
    .where(and(...scope))
    .returning({ id: deals.id });
  if (!row) throw new AppError('Deal not found', 404, { code: 'DEAL_NOT_FOUND' });
  logger.info('Deal deleted', { dealId: id });
  return { success: true };
};

/**
 * Aggregate the open pipeline by stage.
 *
 * Included because it is the query an index cannot save: a GROUP BY over every open
 * row has to read every open row. It is here to be the honest counterexample in the
 * report — the point of the phase is that indexes fix the queries they fix, and the
 * fix for this one is a materialised summary or an incrementally maintained counter,
 * not another index.
 */
export const pipelineSummary = async () => {
  const rows = await db
    .select({
      stage: deals.stage,
      count: sql`count(*)::int`.as('count'),
      total_cents: sql`coalesce(sum(${deals.amount_cents}), 0)::bigint`.as('total_cents'),
    })
    .from(deals)
    .where(isNull(deals.closed_at))
    .groupBy(deals.stage);

  return rows.map((r) => ({
    stage: r.stage,
    count: Number(r.count),
    total_cents: Number(r.total_cents),
  }));
};
