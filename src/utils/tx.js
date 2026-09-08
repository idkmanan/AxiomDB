// ---------------------------------------------------------------------------
// Transactions, and the retry loop that makes the stricter isolation levels
// usable.
//
// THE THING PEOPLE GET WRONG ABOUT TRANSACTIONS, stated first because the rest of
// this file is downstream of it: `BEGIN … COMMIT` is not a mutex. At READ COMMITTED
// — the Postgres default — wrapping a read and a write in a transaction changes
// nothing about the race between two concurrent callers. Each statement sees a fresh
// snapshot of committed data, so both transactions can read "no such row" and both
// can then insert. That is FINDING F-41, it is why `createUser` does not use a
// transaction to protect its check-then-insert, and it is demonstrated rather than
// asserted by scripts/db/isolation-demo.mjs.
//
// What a transaction gives you is atomicity (both writes or neither) and a
// consistent snapshot. What prevents two callers from making conflicting decisions is
// one of: a unique constraint, an explicit row lock (`SELECT … FOR UPDATE`), an
// optimistic version check, or SERIALIZABLE isolation. This project uses all four,
// each on the path where it is the right instrument:
//
//   unique constraint   signup      — the correct tool for "this value may exist once"
//   version column      deal update — cheap, no lock held across a client round trip
//   FOR UPDATE          stage move  — the transition depends on the current value
//   SERIALIZABLE        (available) — for the anomaly demonstration
//
// WHY RETRIES ARE NOT OPTIONAL AT SERIALIZABLE. Postgres implements Serializable
// Snapshot Isolation, which detects conflicts rather than preventing them with locks.
// It is allowed to abort a transaction that would in fact have been fine — false
// positives are part of the design. So SERIALIZABLE without a retry loop is not
// "stricter correctness", it is an endpoint that randomly returns 500 under
// concurrency. The same applies to deadlocks (40P01) at any isolation level.
//
// TWO RULES FOR ANYTHING PASSED TO `withTransaction`:
//
//   1. The WHOLE function is retried, not the failed statement. A serialization
//      failure invalidates the snapshot every read in that transaction was taken
//      from, so re-issuing only the write would compute a new result from stale
//      reads. This is the single most common way a hand-rolled retry makes
//      correctness worse while appearing to fix an error rate.
//
//   2. It must therefore contain no external side effects — no email, no HTTP call,
//      no Kafka produce. It may run more than once. Phase 5's outbox pattern exists
//      precisely because "publish an event" cannot live inside a retryable block:
//      the event goes into a table in the same transaction, and a separate publisher
//      sends it after commit.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { pgCodeOf } from '#utils/db-error.js';

/** SQLSTATE codes that mean "this transaction can be retried as-is". */
export const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure — SSI conflict at REPEATABLE READ / SERIALIZABLE
  '40P01', // deadlock_detected — Postgres picked this transaction as the victim
]);

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Is this error worth retrying?
 *
 * Reads the code from the CAUSE CHAIN, not from the top-level error — finding F-36.
 * Drizzle rethrows every driver failure wrapped in a `DrizzleQueryError` whose own
 * message is "Failed query: …" and which carries no `code`, so `err.code === '40001'`
 * is never true in this codebase. A retry loop written against the raw pg shape would
 * silently never retry, and it would pass a unit test built from the same wrong
 * assumption.
 */
export function isRetryableTxError(err) {
  const code = pgCodeOf(err);
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Full jitter backoff: a random delay in [0, base * 2^attempt).
 *
 * Not fixed, and not exponential-without-jitter. Every conflicting transaction fails
 * at the same instant and would otherwise retry at the same instant, reproducing the
 * conflict — a synchronised retry storm that turns a transient conflict into a
 * sustained one.
 */
export function backoffMs(attempt, baseMs = 10) {
  const ceiling = baseMs * 2 ** attempt;
  return Math.floor(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` inside a transaction, retrying serialization failures and deadlocks.
 *
 * @template T
 * @param {object} db drizzle instance (or anything exposing `.transaction`)
 * @param {(tx: object) => Promise<T>} fn
 * @param {object} [opts]
 * @param {'read committed'|'repeatable read'|'serializable'} [opts.isolationLevel]
 * @param {'read write'|'read only'} [opts.accessMode]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.baseBackoffMs]
 * @param {(ms: number) => Promise<void>} [opts.wait] injectable for tests, so the
 *        retry behaviour can be verified without real delays
 * @returns {Promise<T>}
 */
export async function withTransaction(db, fn, opts = {}) {
  const {
    isolationLevel,
    accessMode,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = 10,
    wait = sleep,
    label = 'tx',
  } = opts;

  // Only pass the config object when something is actually set: drizzle emits
  // `SET TRANSACTION ISOLATION LEVEL …` as a separate statement, so an unnecessary
  // one is an extra round trip on every transaction.
  const txConfig = {};
  if (isolationLevel) txConfig.isolationLevel = isolationLevel;
  if (accessMode) txConfig.accessMode = accessMode;
  const hasConfig = Object.keys(txConfig).length > 0;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return hasConfig
        ? await db.transaction((tx) => fn(tx), txConfig)
        : await db.transaction((tx) => fn(tx));
    } catch (e) {
      lastError = e;
      if (!isRetryableTxError(e)) throw e;

      const isLast = attempt === maxAttempts - 1;
      if (isLast) {
        // Exhausted. 503 rather than 500: the request was valid and a later attempt
        // may well succeed, which is a materially different instruction to the client
        // than "we have a bug".
        logger.error('Transaction exhausted its retries', {
          label,
          sqlstate: pgCodeOf(e),
          attempts: maxAttempts,
        });
        const err = new Error('Transaction could not be completed under contention', { cause: e });
        err.statusCode = 503;
        err.code = 'TX_RETRY_EXHAUSTED';
        throw err;
      }

      const delay = backoffMs(attempt, baseBackoffMs);
      logger.warn('Retrying transaction after a serialization conflict', {
        label,
        sqlstate: pgCodeOf(e),
        attempt: attempt + 1,
        delayMs: delay,
      });
      await wait(delay);
    }
  }

  /* c8 ignore next — unreachable: the loop either returns or throws. */
  throw lastError;
}

export default withTransaction;
