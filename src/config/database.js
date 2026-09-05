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
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import config from '#config/env.js';
import logger from '#config/logger.js';

let db;
/** @type {import('pg').Pool | null} */
let pool = null;

if (config.nodeEnv === 'development') {
  const { Pool } = await import('pg');
  const { drizzle: drizzlePg } = await import('drizzle-orm/node-postgres');

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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
  const sql = neon(process.env.DATABASE_URL);
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
