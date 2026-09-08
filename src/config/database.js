// ---------------------------------------------------------------------------
// Database connection. One driver, one pool, no environment-dependent branch.
//
// PHASE 3 CHANGE — FINDING F-38. What this file used to do:
//
//   if (nodeEnv === 'development') { pg.Pool + drizzle/node-postgres }
//   else                          { neon(DATABASE_URL) + drizzle/neon-http }
//
// So `NODE_ENV` chose the *database driver*, and the two drivers do not have the
// same capabilities. The Neon HTTP driver is request-per-query over HTTPS: no
// connection pool, no session state, therefore no `BEGIN`/`COMMIT`, no
// `SET TRANSACTION ISOLATION LEVEL`, no `SELECT … FOR UPDATE`, no advisory locks,
// and nothing for `closeDatabase()` to drain on SIGTERM.
//
// Two consequences, and the second is worse than the first:
//
//   1. Every Phase 3 deliverable — transactions, isolation levels, row locking —
//      was literally impossible in production while this branch existed.
//   2. Development and production ran DIFFERENT CODE at the driver boundary, so
//      no amount of local testing could exercise what production would do. That
//      is the same root cause as F-06 (the driver switch was silent) and F-32
//      (a local environment that differs from CI is a test that has not run),
//      now met for a third time in a third disguise.
//
// Neon stays a viable deploy target — it speaks the Postgres wire protocol, so
// `pg.Pool` connects to it directly. What is gone is the HTTP driver, and with it
// the idea that the driver is an environment detail. See ADR 0004.
//
// RETAINED FROM PHASE 1 — FINDING F-15. v0 read, in full:
//
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
//
// which inherited `max = 10` against a server configured for 200 connections, and
// `connectionTimeoutMillis = 0`, meaning "queue forever" rather than "no timeout".
// Both now come from src/config/env.js: visible, validated, tunable.
//
// NOTE: no `import 'dotenv/config'` here, and its absence is part of F-32. A
// library module that populates the environment makes import ORDER decide
// configuration, and a test cannot then control what the module sees. The
// entrypoint loads dotenv; modules below it only read `process.env`.
// ---------------------------------------------------------------------------
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import config from '#config/env.js';
import logger from '#config/logger.js';

let db;
/** @type {import('pg').Pool | null} */
let pool = null;

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Stand-in for `db` when no DATABASE_URL is configured.
 *
 * FINDING F-32. Both drivers used to be constructed unconditionally at import
 * time, and `neon()` throws when handed `undefined`, so importing ANY module that
 * reached `#config/database.js` — most of `src/` — required a database URL even in
 * a test that never issues a query. That broke CI the moment `DATABASE_URL` was
 * removed from the Tests workflow on the correct grounds that the suite does not
 * talk to a database. It passed locally only because a gitignored `.env` supplied
 * the variable.
 *
 * A proxy rather than a `null`: the failure happens at the point of USE, names the
 * missing variable, and cannot be mistaken for a query error.
 */
function unconfiguredDb() {
  const fail = () => {
    throw new Error(
      'DATABASE_URL is not set, so no database driver was constructed. Set it, or ' +
        'mock #config/database.js in tests that need query behaviour.'
    );
  };
  return new Proxy(
    {},
    {
      get: fail,
      apply: fail,
    }
  );
}

if (!DATABASE_URL) {
  // Production must not reach this quietly — a service that starts without a
  // database and reports itself live is worse than one that refuses to start.
  if (config.isProduction) {
    throw new Error('DATABASE_URL is required in production.');
  }
  db = unconfiguredDb();
  if (!config.isTest) {
    logger.warn('DATABASE_URL is not set — database access will throw on first use.');
  }
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    maxLifetimeSeconds: config.pool.maxLifetimeSeconds,
    // Statement timeout as a server-side backstop. Without it a single pathological
    // query holds a pool slot for as long as it likes, and pool exhaustion (F-33)
    // then presents as a service-wide 503 caused by one bad request. Sent as a
    // connection parameter so it applies to every session in the pool.
    statement_timeout: config.pool.statementTimeoutMs,
    query_timeout: config.pool.queryTimeoutMs,
    application_name: 'acquisitions-api',
  });

  // Without this listener, an error on an IDLE client is an unhandled 'error'
  // event on an EventEmitter — which terminates the process. The pool already
  // knows how to discard and replace that client; the crash is purely the missing
  // handler.
  pool.on('error', (err) => {
    logger.error('Idle client error in pg pool — client will be discarded', {
      message: err.message,
      code: err.code,
    });
  });

  db = drizzle(pool);
  logger.debug('Database: node-postgres pool', {
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    statementTimeoutMs: config.pool.statementTimeoutMs,
  });
}

/**
 * Open `n` connections before serving traffic, then release them to the pool.
 *
 * FINDING F-39, and it is the fix F-37 pointed at rather than another symptom
 * patch. node-postgres has no `min` option: the pool starts EMPTY and opens each
 * connection lazily on first use. Establishing a Postgres connection is not cheap —
 * TCP, optional TLS, then authentication and backend fork — and the callback that
 * completes it has to be scheduled on the event loop.
 *
 * At the v1 20-VU level the loop was blocked in bcrypt (sign-in p50 2091 ms), so
 * `connect()` could not finish inside `connectionTimeoutMillis` and six requests
 * failed with 'Connection terminated due to connection timeout' — while Postgres
 * was entirely healthy and the pool was below `max`. Raising `PG_POOL_MAX` would
 * have made that worse, not better: more concurrent queries on a core that is
 * already saturated.
 *
 * Pre-warming moves that cost to startup, where there is no load and no deadline,
 * and it happens BEFORE the readiness probe passes. Called from src/server.js, not
 * at import time — import-time side effects are what F-32 was about.
 *
 * Failure here is logged, not thrown: a pool that could not pre-warm still works,
 * it is just cold, and refusing to start would turn a slow database into an outage.
 */
export async function prewarmPool(n = config.pool.prewarm) {
  if (!pool || n <= 0) return { warmed: 0, requested: n, skipped: !pool };

  const started = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(n, config.pool.max) }, async () => {
      const client = await pool.connect();
      try {
        // A real round trip, so the connection is authenticated and usable rather
        // than merely opened.
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    })
  );

  const warmed = settled.filter((r) => r.status === 'fulfilled').length;
  const failed = settled.length - warmed;
  const durationMs = Date.now() - started;

  if (failed > 0) {
    logger.warn('Pool pre-warm partially failed — continuing with a cold pool', {
      warmed,
      failed,
      durationMs,
      firstError: settled.find((r) => r.status === 'rejected')?.reason?.message,
    });
  } else {
    logger.info('Pool pre-warmed', { warmed, durationMs, max: config.pool.max });
  }

  return { warmed, failed, requested: n, durationMs };
}

/**
 * Close the pool. Part of the graceful-shutdown sequence in src/server.js.
 *
 * Now unconditionally meaningful. Under the HTTP driver this was a no-op that
 * returned `{ closed: false, reason: 'http-driver-holds-no-connections' }`, which
 * is a fair illustration of why that branch had to go: every claim about draining
 * connections on SIGTERM was false in the only environment that mattered.
 */
export async function closeDatabase() {
  if (!pool) return { closed: false, reason: 'no-pool-configured' };
  await pool.end();
  return { closed: true };
}

/**
 * Cheap dependency check for the readiness probe.
 *
 * Deliberately a real round trip rather than an inspection of pool counters: a
 * readiness probe that only checks whether the process is up is the reason
 * "readiness" and "liveness" get conflated, and it will happily report ready while
 * every query fails.
 */
export async function pingDatabase() {
  if (!pool) return { ok: true, driver: 'none', checked: false };
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return { ok: true, driver: 'pg-pool', checked: true };
  } finally {
    client.release();
  }
}

/**
 * Pool gauges, exported as Prometheus metrics by src/metrics/collectors.js.
 *
 * `waiting` is the number that explains a latency cliff nothing else accounts for:
 * requests queued for a connection are indistinguishable from slow queries in an
 * application latency histogram, and they are the leading indicator of the 503s
 * F-33 introduced.
 */
export function poolStats() {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: config.pool.max,
  };
}

export { db, pool };
