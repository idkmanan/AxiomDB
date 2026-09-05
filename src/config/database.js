// ---------------------------------------------------------------------------
// Database connection.
//
// FINDING F-15 (Phase 0). v0 read, in full:
//
//   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
//
// Everything else was left to node-postgres defaults, and two of those defaults
// are wrong here:
//
//   max = 10                      while the benchmark Postgres was started with
//                                 max_connections=200. The app could never use
//                                 more than 5% of the connections provisioned
//                                 for it, and nothing said so.
//   connectionTimeoutMillis = 0   means "wait forever for a free slot", not "no
//                                 timeout". Under the Phase 0 load a request
//                                 queued behind a busy pool is indistinguishable
//                                 from a hung one, and it is a plausible
//                                 contributor to the still-unattributed 15 s
//                                 server-side resets (F-14).
//
// Both now come from src/config/env.js: visible, validated, tunable per
// environment rather than inherited silently.
//
// STILL A PHASE 3 PROBLEM, deliberately unchanged: the NODE_ENV branch below.
// Outside development this uses the Neon HTTP driver, which is stateless
// request-per-query — no pool to size, no BEGIN/COMMIT, no advisory locks, no
// isolation levels. So the pool settings above apply to development and
// benchmark runs only, and half of the Phase 3 plan is impossible until the
// branch is gone. Phase 1 leaves it because deleting it would change what the
// v1 benchmark measures beyond the four changes being attributed. What Phase 1
// does add is a loud warning, which v0 did not have: the driver switch was
// silent, and F-06 exists because of it.
// ---------------------------------------------------------------------------
// NOTE: no `import 'dotenv/config'` here, and its removal is part of F-32.
//
// v0 loaded dotenv from inside this module. That makes a library module responsible
// for populating the environment, so import ORDER decides configuration and a test
// cannot control what the module sees — deleting `process.env.DATABASE_URL` in a test
// had no effect, because importing this file put it straight back from a gitignored
// `.env`. That is precisely the mechanism that hid the CI failure. The entrypoint
// (`src/index.js`) loads dotenv before anything else, and `drizzle.config.js` loads
// its own; modules below the entrypoint just read `process.env`.
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
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
 * time, and `neon()` throws when handed `undefined`:
 *
 *   No database connection string was provided to `neon()`.
 *   Perhaps an environment variable has not been set?
 *
 * So importing ANY module that reaches `#config/database.js` — which is most of
 * `src/` — required a database URL even for a test that never issues a query. That
 * broke CI the moment `DATABASE_URL` was removed from the Tests workflow on the
 * (correct) grounds that the suite does not talk to a database. It passed locally
 * only because a gitignored `.env` was supplying the variable, which is the whole
 * lesson: **a local environment that differs from CI is a test that has not run.**
 *
 * A proxy rather than a `null`: the failure now happens at the point of USE, names
 * the missing variable, and is impossible to mistake for a query error.
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
} else if (config.nodeEnv === 'development') {
  const { Pool } = await import('pg');
  const { drizzle: drizzlePg } = await import('drizzle-orm/node-postgres');

  pool = new Pool({
    connectionString: DATABASE_URL,
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    maxLifetimeSeconds: config.pool.maxLifetimeSeconds,
  });

  // Without this listener, an error on an IDLE client is an unhandled 'error'
  // event on an EventEmitter — which terminates the process. The pool already
  // knows how to discard and replace that client; the crash is purely the
  // missing handler.
  pool.on('error', (err) => {
    logger.error('Idle client error in pg pool — client will be discarded', {
      message: err.message,
      code: err.code,
    });
  });

  db = drizzlePg(pool);
  logger.debug('Database: node-postgres pool', {
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
  });
} else {
  const sql = neon(DATABASE_URL);
  db = drizzle(sql);
  if (!config.isTest) {
    logger.warn(
      'Database: Neon HTTP driver selected because NODE_ENV is not "development". ' +
        'This driver is request-per-query: no connection pooling, no transactions, ' +
        'no isolation levels, and closeDatabase() has nothing to drain on SIGTERM. ' +
        'Phase 3 removes this branch — see PROJECT_LIFECYCLE.md findings F-06 and F-15.'
    );
  }
}

/**
 * Close the pool. Part of the graceful-shutdown sequence in src/server.js.
 *
 * A no-op on the Neon HTTP driver, which holds nothing to close — itself a fair
 * illustration of why that branch has to go before any claim about draining
 * connections on SIGTERM is credible in production.
 */
export async function closeDatabase() {
  if (!pool) return { closed: false, reason: 'http-driver-holds-no-connections' };
  await pool.end();
  return { closed: true };
}

/**
 * Cheap dependency check for the readiness probe.
 *
 * Deliberately a real round trip rather than an inspection of pool counters: a
 * readiness probe that only checks whether the process is up is the reason
 * "readiness" and "liveness" get conflated, and it will happily report ready
 * while every query fails.
 */
export async function pingDatabase() {
  if (!pool) return { ok: true, driver: 'neon-http', checked: false };
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return { ok: true, driver: 'pg-pool', checked: true };
  } finally {
    client.release();
  }
}

/** Pool gauges. Phase 6 exports these as Prometheus metrics; pool saturation is
 *  the number that explains a latency cliff nothing else accounts for. */
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
