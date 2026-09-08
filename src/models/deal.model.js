// ---------------------------------------------------------------------------
// `deals` — the write-heavy entity Phase 3 exists to exercise.
//
// WHY A SECOND ENTITY AT ALL. `users` is an auth core: a few thousand rows, read
// by primary key, written once per signup. Nothing about it can demonstrate an
// index choice, a pagination strategy or a locking policy, because at 1,001 rows
// Postgres answers every query from shared buffers in under a millisecond — Phase 0
// measured the unbounded list scan at 2.20 ms total, of which 0.335 ms was
// execution (finding F-04). An index would have improved nothing.
//
// `deals` is seeded to 1,000,000 rows and is written on every pipeline advance, so
// the plan choices below are measurable rather than asserted.
//
// COLUMN DECISIONS, each of which is a trade rather than a default:
//
// * `amount_cents bigint`, not `numeric` and never a float. Money in a binary
//   float is wrong for the reason everyone quotes and few demonstrate:
//   0.1 + 0.2 !== 0.3, so summing a pipeline produces a total that disagrees with
//   itself. `numeric` is exact but node-postgres hands it back as a STRING (it
//   cannot be represented in a JS number safely), so every consumer has to parse,
//   and aggregation in Postgres is slower than integer arithmetic. Integer minor
//   units side-steps both: exact, fast, and JSON-safe up to 2^53 cents.
//
// * `timestamptz`, not `timestamp` — FINDING F-40. The `users` table uses
//   `timestamp` (no zone), which stores a wall-clock reading with no offset: two
//   rows written at the same instant in different zones compare as different times,
//   and `now()` is cast to the *server's* local zone on the way in. `timestamptz`
//   stores an absolute instant. The existing columns are deliberately NOT converted
//   here: `ALTER COLUMN … TYPE timestamptz` rewrites the whole table under an
//   ACCESS EXCLUSIVE lock, which is free at 1,001 rows and an outage at 1M, and the
//   right place to demonstrate that difference is a migration-strategy section
//   rather than a silent schema change in a phase about something else.
//
// * `timestamptz(3)` — the PRECISION is not cosmetic, it is FINDING F-46, and it is
//   the kind of bug that only appears under load. Postgres timestamps default to
//   microsecond precision; a JavaScript `Date` holds milliseconds, and node-postgres
//   hands back a `Date`. So a value read from the database has already been
//   truncated, and a keyset cursor built from it points at a *different instant* than
//   the row it came from.
//
//   Concretely: the last row of page one is written at 10:00:00.123456 and comes back
//   as 10:00:00.123. The cursor asks for rows older than 10:00:00.123, and every row
//   in the 456-microsecond gap — rows the client has never seen — is silently skipped.
//   It cannot be reproduced at low write rates, which is exactly why it survives
//   review.
//
//   Declaring the column at millisecond precision makes the round trip lossless: what
//   Postgres stores is what JavaScript can represent. The alternative is to override
//   the pg type parser so timestamps arrive as strings and are echoed back verbatim,
//   which keeps microseconds but makes every consumer handle a string. Matching the
//   column to the driver is the smaller change, and it fails safe.

//
// * `version integer`, for optimistic concurrency. Cheaper than a row lock for the
//   read-then-write path a REST client actually performs, and it is the column that
//   turns the lost update in v0's `updateUser` (finding F-42) into a 409 the client
//   can retry. The pessimistic alternative is also implemented, on the stage
//   transition, so the two can be compared instead of argued about — see
//   src/services/deals.service.js.
//
// * FK `owner_id` with ON DELETE RESTRICT, not CASCADE. Cascade silently destroys
//   business records when an account is removed; restrict makes the caller decide.
//   The FK violation (SQLSTATE 23503) is already mapped to 409 by
//   src/middleware/error.middleware.js, so the API answer is "this user still owns
//   deals" rather than a 500 or a quiet data loss.
// ---------------------------------------------------------------------------
import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  integer,
  varchar,
  char,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { users } from '#models/user.model.js';

/**
 * Pipeline stages, in order. The order is load-bearing: `advanceDealStage` only
 * permits a move to the next stage or to a terminal one, and that rule is what the
 * pessimistic-locking example protects.
 */
export const DEAL_STAGES = [
  'sourced',
  'screening',
  'diligence',
  'negotiation',
  'closed_won',
  'closed_lost',
];

/** Stages from which no further transition is legal. */
export const TERMINAL_STAGES = ['closed_won', 'closed_lost'];

/**
 * A native enum rather than `varchar` + CHECK.
 *
 * Storage is 4 bytes against up to 12 for the string, which at 1M rows and a
 * composite index on `(stage, …)` is the difference between an index that fits in
 * cache and one that does not. The cost is evolution: adding a value needs
 * `ALTER TYPE … ADD VALUE` (fine on Postgres 12+, and it cannot be used in the same
 * transaction that adds it), and removing one is not supported at all. That trade is
 * acceptable for a closed set that changes about never; it would be the wrong trade
 * for something like a tag.
 */
export const dealStage = pgEnum('deal_stage', DEAL_STAGES);

export const deals = pgTable(
  'deals',
  {
    // `bigserial`, not `serial`. `serial` is a 32-bit int and tops out at
    // 2,147,483,647 — which sounds distant until a write-heavy table with retries
    // and deletes burns sequence values without producing rows. The users table
    // already had to have that ceiling defended in a validator
    // (src/validations/users.validation.js:14) because ids beyond it reach Postgres
    // as SQLSTATE 22003 and surface as a 500.
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    owner_id: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    title: varchar('title', { length: 200 }).notNull(),
    company: varchar('company', { length: 200 }).notNull(),
    stage: dealStage('stage').notNull().default('sourced'),

    // Minor units. See the header note on money types.
    amount_cents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),

    // Optimistic concurrency token. Starts at 1 and is incremented by the UPDATE
    // itself, never by the caller.
    version: integer('version').notNull().default(1),

    created_at: timestamp('created_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    // Set when the deal reaches a terminal stage. Nullable on purpose: a NULL here
    // means "still open", which is a fact, whereas a sentinel date would be a lie
    // that sorts.
    closed_at: timestamp('closed_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    // -----------------------------------------------------------------------
    // INDEXES. Each one exists to serve a specific query, and each is captured in
    // benchmarks/v3-postgres/explain-*.txt with and without it — the "without" run
    // is produced by dropping the index inside a transaction that is then rolled
    // back, which is possible because Postgres has transactional DDL.
    // -----------------------------------------------------------------------

    // The global page: ORDER BY created_at DESC, id DESC.
    //
    // The `id` tiebreaker is not decoration — FINDING F-44. `created_at` is not
    // unique (the seeder alone writes thousands of rows per second), and a keyset
    // cursor over a non-unique sort key either skips rows or returns them twice: the
    // next page starts "after the last value seen", and every row sharing that
    // timestamp is on the wrong side of the boundary. A unique tiebreaker makes the
    // ordering a total order, which is what the cursor arithmetic assumes.
    index('deals_created_at_id_idx').on(t.created_at.desc(), t.id.desc()),

    // "My deals, newest first" — equality on owner_id, then the sort key.
    //
    // COLUMN ORDER IS THE WHOLE POINT. Equality predicates first, range/sort columns
    // after. With (created_at, owner_id) Postgres would have to scan every row in the
    // time range and filter on owner; with (owner_id, created_at) it descends
    // straight to the owner's slice and walks it in order, so LIMIT 20 reads 20 rows
    // rather than a page of the table. This is also why the composite index makes the
    // ORDER BY free rather than merely fast: the rows arrive sorted.
    index('deals_owner_created_id_idx').on(t.owner_id, t.created_at.desc(), t.id.desc()),

    // The open pipeline, as a PARTIAL index.
    //
    // Most rows in a mature pipeline are closed, and the dashboard query only ever
    // wants the open ones. A partial index stores only matching rows, so it is a
    // fraction of the size and stays cache-resident — and it is only usable when the
    // planner can prove the query's predicate implies the index's, which is the
    // reason the service always writes `closed_at IS NULL` literally rather than
    // deriving the same set from `stage NOT IN (…)`. Two predicates that select the
    // same rows are not interchangeable to the planner.
    index('deals_open_created_idx')
      .on(t.stage, t.created_at.desc(), t.id.desc())
      .where(sql`closed_at is null`),

    // -----------------------------------------------------------------------
    // CONSTRAINTS. The last line of defence, and the only one that survives a bug in
    // the application layer — validation in zod protects the endpoint, a CHECK
    // protects the table from every writer including the seeder and psql.
    // -----------------------------------------------------------------------
    check('deals_amount_nonnegative', sql`${t.amount_cents} >= 0`),
    check('deals_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // The invariant the state machine depends on, stated once, in the one place that
    // cannot be bypassed: a deal is closed exactly when it has a closing timestamp.
    check(
      'deals_closed_at_matches_stage',
      sql`(${t.stage} in ('closed_won', 'closed_lost')) = (${t.closed_at} is not null)`
    ),
  ]
);

/**
 * Columns safe to return to any authenticated caller.
 *
 * Same discipline as `PUBLIC_COLUMNS` in src/services/users.service.js: an explicit
 * projection, because `db.select().from(deals)` returns every column and a schema
 * that later grows a private field would start leaking it with no code change.
 */
export const DEAL_COLUMNS = {
  id: deals.id,
  owner_id: deals.owner_id,
  title: deals.title,
  company: deals.company,
  stage: deals.stage,
  amount_cents: deals.amount_cents,
  currency: deals.currency,
  version: deals.version,
  created_at: deals.created_at,
  updated_at: deals.updated_at,
  closed_at: deals.closed_at,
};

/** Next legal stages from a given stage. Empty once terminal. */
export function nextStages(stage) {
  if (TERMINAL_STAGES.includes(stage)) return [];
  const i = DEAL_STAGES.indexOf(stage);
  const forward = DEAL_STAGES[i + 1];
  // A deal can always be lost or won from any open stage — that is a business
  // reality, not a shortcut — but it can only step FORWARD one stage at a time.
  return [...new Set([forward, 'closed_won', 'closed_lost'].filter(Boolean))];
}

export default deals;
