// ---------------------------------------------------------------------------
// The Redis connection.
//
// TWO DELIBERATE CHOICES THAT DECIDE HOW THIS FAILS, and both are the reason Arcjet was
// removed (finding F-07: it failed open, silently):
//
// 1. `enableOfflineQueue: false`. By default ioredis QUEUES commands while the connection
//    is down and replays them when it returns. That sounds helpful and is the opposite:
//    during a Redis outage every rate-limit check would hang until its timeout instead of
//    failing, so the explicit fail-open/fail-closed policy in ADR 0002 would never run and
//    the outage would present as latency. An error is what the policy is written to handle.
//
// 2. `maxRetriesPerRequest: 1` and a 300 ms command timeout. The limiter sits in front of
//    every authenticated request; a limiter that retries three times with backoff has made
//    itself the outage. One retry, then tell the caller.
//
// WHY THE DRIVER IS IMPORTED DYNAMICALLY. `ioredis` is imported inside `connectRedis()`
// rather than at module scope, and that is not style — the offline unit suite must be able
// to import any module that touches this file without the driver being installed, and every
// consumer takes an INJECTED client so the tests never construct a real one. It is the same
// shape as the `unconfiguredDb` proxy in src/config/database.js (F-32): the failure happens
// at the point of use, with a message that names the missing configuration.
//
// NO `keyPrefix` OPTION, deliberately. ioredis can prefix keys transparently, but the
// prefix then also applies to KEYS passed to Lua scripts, which makes the key a script
// reader sees differ from the key Redis holds. Prefixes are applied explicitly by each
// module (see `redisKey`) so that what is in the code is what is in the database.
// ---------------------------------------------------------------------------
import config from '#config/env.js';
import logger from '#config/logger.js';

/** @type {import('ioredis').Redis | null} */
let client = null;
let connected = false;
let lastError = null;

/** Namespaced key. Every Redis key in the application goes through this. */
export const redisKey = (...parts) => `${config.redis.keyPrefix}${parts.join(':')}`;

/**
 * Connect, and fail loudly if the driver or the URL is missing.
 *
 * Called once from src/server.js when a Redis-backed feature is enabled. Returns the client
 * so a caller can hold it rather than reaching for a module global.
 */
export async function connectRedis({ url = config.redis.url } = {}) {
  if (client) return client;
  if (!url) throw new Error('REDIS_URL is not set, so no Redis client can be constructed.');

  let Redis;
  try {
    ({ default: Redis } = await import('ioredis'));
  } catch (e) {
    throw new Error(
      'The "ioredis" package is not installed, but a Redis-backed feature is enabled. ' +
        'Run `npm install`, or set RATE_LIMIT_STORE=memory and leave REDIS_URL unset.',
      { cause: e }
    );
  }

  client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.redis.connectTimeoutMs,
    commandTimeout: config.redis.commandTimeoutMs,
    // Capped backoff. Uncapped exponential reconnection means a Redis that comes back after
    // ten minutes is not noticed for another ten.
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
  });

  client.on('error', (err) => {
    // Logged, never thrown: an unhandled 'error' event on the client terminates the process,
    // which turns a dependency blip into a restart loop. The per-command error is what the
    // request path actually handles.
    lastError = err.message;
    logger.error('Redis client error', { message: err.message });
  });
  client.on('ready', () => {
    connected = true;
    lastError = null;
    logger.info('Redis ready', { keyPrefix: config.redis.keyPrefix });
  });
  client.on('end', () => {
    connected = false;
  });

  await client.connect();
  return client;
}

/**
 * The connected client, or a clear error.
 *
 * Deliberately not a silent `null`: a store that quietly does nothing when Redis is absent
 * is a limiter that is not limiting, which is precisely the Arcjet failure mode.
 */
export function getRedis() {
  if (!client) {
    throw new Error('Redis has not been connected. Call connectRedis() during startup.');
  }
  return client;
}

/** Inject a client — used by tests, and by the proof scripts in scripts/redis/. */
export function setRedisClient(injected) {
  client = injected;
  connected = Boolean(injected);
  return client;
}

export async function closeRedis() {
  if (!client) return { closed: false, reason: 'no-client' };
  try {
    // `quit` waits for in-flight commands and sends QUIT; `disconnect` drops the socket.
    // The graceful one matters here because shutdown runs after the drain, so anything still
    // in flight is work we promised to finish.
    await client.quit();
  } catch (e) {
    logger.warn('Redis quit failed; forcing disconnect', { error: e.message });
    client.disconnect();
  }
  client = null;
  connected = false;
  return { closed: true };
}

/** For the readiness probe. A real round trip, for the same reason as `pingDatabase`. */
export async function pingRedis() {
  if (!client) return { ok: true, enabled: false, checked: false };
  const started = Date.now();
  const pong = await client.ping();
  return { ok: pong === 'PONG', enabled: true, checked: true, latencyMs: Date.now() - started };
}

export function redisStatus() {
  return { enabled: Boolean(client), connected, lastError };
}

export default { connectRedis, getRedis, closeRedis, pingRedis, redisStatus, redisKey };
