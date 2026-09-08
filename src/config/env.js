// ---------------------------------------------------------------------------
// Configuration, read once and validated at import time.
//
// Phase 1 introduces three groups of tunables — session lifetime, rate-limit
// policy, and connection-pool sizing — and every one of them was previously
// either hardcoded, duplicated, or silently defaulted. Centralising them here is
// what makes the Phase 1 defects un-reintroducible:
//
//   * SESSION_TTL_MS is consumed by BOTH src/utils/jwt.js and
//     src/utils/cookies.js. The v0 bug was that jwt.js:5 said '1d' and
//     cookies.js:6 said 15 minutes, so the browser discarded a cookie that
//     stayed cryptographically valid for another 23h45m. Two constants cannot
//     disagree if there is only one constant.
//
//   * JWT_SECRET had a hardcoded fallback (v0 src/utils/jwt.js:4). A production
//     deploy that forgot the variable would sign tokens with a string published
//     in this repository, and nothing would say so. Now it throws.
//
// This is deliberately NOT a full schema-validated config layer — that arrives
// with the TypeScript migration in Phase 2, where it can be typed rather than
// hand-checked. What is here is the minimum needed so that no Phase 1 fix
// depends on a value being remembered in two places.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_TEST = NODE_ENV === 'test';

/** Parse an integer env var, falling back when unset. Throws on garbage rather
 *  than silently using the default — a typo'd limit should not look like a
 *  deliberate one. */
function intFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}" — expected an integer between ${min} and ${max}.`);
  }
  return n;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Invalid ${name}="${raw}" — expected true/false or 1/0.`);
}

// ---------------------------------------------------------------------------
// Session lifetime — ONE value, two consumers.
// ---------------------------------------------------------------------------
// 15 minutes is short on purpose and is not yet paired with a refresh token:
// Phase 4 adds opaque refresh tokens in Redis with rotation and reuse detection.
// Until then a session genuinely expires after 15 minutes. That is the correct
// trade to make in this order — a long-lived token with no revocation path is a
// worse defect than a short session with no refresh, because the first is
// invisible and the second is merely inconvenient.
const SESSION_TTL_MS = intFromEnv('SESSION_TTL_MS', 15 * 60 * 1000, {
  min: 60 * 1000,
  max: 24 * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// JWT secret — no usable fallback, and no literal in the repository.
// ---------------------------------------------------------------------------
// v0 fell back to a hardcoded string (F-25). Phase 1's first fix was to throw in
// production, but the literal itself stayed, which left two problems: a committed
// credential-shaped constant that a secret scanner is right to object to, and a
// value a forker could accidentally rely on.
//
// So the development fallback is now GENERATED per process. Consequences, both
// intended: nothing secret-shaped is committed, and a developer who wants sessions
// to survive a restart has to set JWT_SECRET — which the warning below tells them,
// and which `.env.development` already does.
function generateEphemeralSecret() {
  return randomBytes(32).toString('base64');
}

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (IS_PRODUCTION) {
    throw new Error(
      'JWT_SECRET is required in production and must be at least 32 characters. ' +
        'Generate one with: openssl rand -base64 32'
    );
  }
  if (secret) {
    // Present but too short. Allowed outside production so tests and local runs are
    // not blocked, but it must not pass silently.
    return secret;
  }
  return generateEphemeralSecret();
}

// ---------------------------------------------------------------------------
// Connection pool (finding F-15).
// ---------------------------------------------------------------------------
// v0 src/config/database.js:11-13 called `new Pool({ connectionString })` with
// nothing else, so node-postgres applied its own defaults: max=10 against a
// server configured for PG_MAX_CONNECTIONS=200, and connectionTimeoutMillis=0,
// which means a request waits for a free slot forever rather than failing fast.
// Under the Phase 0 load that is indistinguishable from a hung request.
const pool = {
  max: intFromEnv('PG_POOL_MAX', 20, { min: 1, max: 500 }),
  // Fail fast instead of queueing indefinitely. A 503 in 5s is a usable signal;
  // a request that never returns is not.
  connectionTimeoutMillis: intFromEnv('PG_POOL_CONNECTION_TIMEOUT_MS', 5000, { min: 100 }),
  idleTimeoutMillis: intFromEnv('PG_POOL_IDLE_TIMEOUT_MS', 30000, { min: 1000 }),
  // Recycle connections so a long-lived pool cannot accumulate server-side state
  // or leak memory in a driver.
  maxLifetimeSeconds: intFromEnv('PG_POOL_MAX_LIFETIME_S', 1800, { min: 60 }),

  // ---- Phase 3 additions -------------------------------------------------
  // Pre-warm (finding F-39). node-postgres has no `min`, so the pool starts empty
  // and pays connection setup on the first request that needs each slot — under
  // load, on an event loop that is already busy, which is how F-37's
  // 'Connection terminated due to connection timeout' happened against a healthy
  // database. Half of `max` is warmed at boot before readiness passes.
  prewarm: intFromEnv('PG_POOL_PREWARM', 0, { min: 0, max: 500 }),

  // Server-side backstops. Without them one pathological query holds a pool slot
  // indefinitely and pool exhaustion (F-33) turns a single bad request into a
  // service-wide 503. `statement_timeout` is enforced by Postgres and cancels the
  // query; `query_timeout` is enforced by the client and only stops waiting — both
  // are set because each covers a case the other misses (a server that never
  // replies, versus a query that runs forever).
  statementTimeoutMs: intFromEnv('PG_STATEMENT_TIMEOUT_MS', 15000, { min: 100 }),
  queryTimeoutMs: intFromEnv('PG_QUERY_TIMEOUT_MS', 20000, { min: 100 }),
};

// Default the pre-warm to half the pool rather than hardcoding a number that
// contradicts `max` when someone tunes it. Expressed here rather than in the
// literal above so `PG_POOL_PREWARM=0` remains a way to switch it off entirely.
if (!process.env.PG_POOL_PREWARM) {
  pool.prewarm = Math.max(1, Math.floor(pool.max / 2));
}

// ---------------------------------------------------------------------------
// Pagination (replaces the unbounded SELECT at v0 users.service.js:6-14).
// ---------------------------------------------------------------------------
// The v0 list endpoint returned every row: 1001 rows and 167 KiB per response,
// where the cost was Node-side row mapping and serialisation, not the 2.20 ms
// query. A cap is the fix; an index would have achieved nothing.
const pagination = {
  defaultLimit: intFromEnv('PAGINATION_DEFAULT_LIMIT', 20, { min: 1, max: 1000 }),
  maxLimit: intFromEnv('PAGINATION_MAX_LIMIT', 100, { min: 1, max: 1000 }),
};

// ---------------------------------------------------------------------------
// CORS.
// ---------------------------------------------------------------------------
// v0 documented CORS_ORIGIN in three env templates and read it nowhere:
// src/app.js called `cors()` with no options, which sets
// `Access-Control-Allow-Origin: *`. So the policy a reader would infer from the
// configuration was not the policy in force — the worst kind of security config,
// because it looks deliberate.
//
// Note the interaction with the session cookie, which is why `credentials` is not
// simply hardcoded true: the cookie is `sameSite=strict`, so a browser will not
// send it cross-site regardless of what CORS says. An allow-list here therefore
// governs who may READ responses, not who may authenticate. Both matter; conflating
// them is how people conclude CORS is an authentication control.
function resolveCors() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw || raw.trim() === '') return { origins: null, credentials: false };
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // `credentials: true` is invalid alongside a wildcard — browsers reject the
  // combination — so it is only enabled when an explicit list exists.
  return { origins, credentials: origins.length > 0 && !origins.includes('*') };
}

// ---------------------------------------------------------------------------
// Redis (Phase 4).
// ---------------------------------------------------------------------------
// Three separate concerns share one connection: the rate-limit store, refresh-token
// storage, and the access-token denylist. One connection because ioredis multiplexes
// commands over a single socket and a second connection buys nothing until something
// blocks on it (a subscriber or a BLPOP would need its own — neither exists here).
//
// `store` is what makes the Phase 1 → Phase 4 claim measurable: the limiter is
// `memory` until this flips to `redis`, and the in-process version is provably wrong
// across replicas. Keeping both switchable means the wrong behaviour can be
// demonstrated on demand rather than described.
const redis = {
  url: process.env.REDIS_URL || '',
  keyPrefix: process.env.REDIS_KEY_PREFIX || 'acq:',
  // Fail fast. A limiter that waits 10s for Redis has become the outage.
  connectTimeoutMs: intFromEnv('REDIS_CONNECT_TIMEOUT_MS', 2000, { min: 50 }),
  commandTimeoutMs: intFromEnv('REDIS_COMMAND_TIMEOUT_MS', 300, { min: 10 }),
};

const rateLimitStore = (() => {
  const raw = (process.env.RATE_LIMIT_STORE || 'memory').toLowerCase();
  if (!['memory', 'redis'].includes(raw)) {
    throw new Error(`Invalid RATE_LIMIT_STORE="${raw}" — expected "memory" or "redis".`);
  }
  if (raw === 'redis' && !redis.url) {
    // Silently falling back to the in-process store would leave three replicas enforcing
    // 3x the configured limit while the configuration says otherwise — the exact failure
    // Phase 4 exists to fix, reintroduced as a config accident.
    throw new Error('RATE_LIMIT_STORE=redis requires REDIS_URL to be set.');
  }
  return raw;
})();

// ---------------------------------------------------------------------------
// Refresh tokens (Phase 4).
// ---------------------------------------------------------------------------
// The access token stays short (SESSION_TTL_MS, 15 min) and is now paired with an
// opaque refresh token in Redis. 30 days is the outer bound on a stolen refresh token
// that is never used again; rotation plus reuse detection is what bounds the damage
// when it IS used (see src/auth/refresh.service.js).
const refresh = {
  ttlMs: intFromEnv('REFRESH_TTL_MS', 30 * 24 * 60 * 60 * 1000, {
    min: 5 * 60 * 1000,
    max: 365 * 24 * 60 * 60 * 1000,
  }),
  cookieName: process.env.REFRESH_COOKIE_NAME || 'refresh_token',
};

// Replayed responses for unsafe writes. 24 hours is the window in which a retry of the
// same request returns the original answer rather than creating a second deal.
const idempotency = {
  ttlMs: intFromEnv('IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000, { min: 60 * 1000 }),
};

// ---------------------------------------------------------------------------
// Kafka and the outbox (Phase 5).
// ---------------------------------------------------------------------------
// Optional, like Redis: with no brokers configured the outbox table still receives every event
// (the domain write is unaffected), and nothing publishes them. That is a deliberate property
// rather than a degradation — it is exactly the state the broker-down drill puts the system in,
// and the rows wait.
//
// ONE TOPIC, keyed by aggregate. A topic per event type is the more common first instinct and it
// breaks ordering: `deal.created` and `deal.stage_advanced` on different topics have no relative
// order at all, so a consumer can see a stage change for a deal it has not been told about. One
// topic keyed by `deal:<id>` puts every event for one deal in one partition, and Kafka guarantees
// order within a partition.
const kafka = {
  brokers: (process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean),
  clientId: process.env.KAFKA_CLIENT_ID || 'acquisitions',
  topic: process.env.KAFKA_TOPIC || 'acquisitions.events',
  // A real DLQ topic, not a log line. A dead-lettered event has to be inspectable and replayable
  // by something other than the process that failed to handle it.
  dlqTopic: process.env.KAFKA_DLQ_TOPIC || 'acquisitions.events.dlq',
  consumerGroup: process.env.KAFKA_CONSUMER_GROUP || 'acquisitions-workers',
  // The poller. 250 ms is well under any human-visible latency and far above the cost of an
  // indexed query that usually returns nothing.
  pollIntervalMs: intFromEnv('OUTBOX_POLL_INTERVAL_MS', 250, { min: 25 }),
  // Small on purpose: the publishing transaction stays open across the Kafka send, and a long
  // transaction holds back VACUUM.
  batchSize: intFromEnv('OUTBOX_BATCH_SIZE', 100, { min: 1, max: 1000 }),
  // Consumer-side handler retries before the event goes to the DLQ.
  maxHandlerAttempts: intFromEnv('CONSUMER_MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
};

export const config = {
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  isTest: IS_TEST,
  port: intFromEnv('PORT', 3000, { min: 1, max: 65535 }),
  logLevel: process.env.LOG_LEVEL || 'info',

  session: {
    ttlMs: SESSION_TTL_MS,
    // jsonwebtoken accepts seconds as a number for expiresIn. Deriving it here
    // rather than in jwt.js keeps the cookie and the token provably in step.
    ttlSeconds: Math.floor(SESSION_TTL_MS / 1000),
    jwtSecret: resolveJwtSecret(),
    usingInsecureDevSecret: !process.env.JWT_SECRET && !IS_PRODUCTION,
  },

  pool,
  pagination,
  cors: resolveCors(),
  redis,
  rateLimitStore,
  refresh,
  idempotency,
  kafka,

  // Graceful shutdown (see src/server.js). Kubernetes sends SIGTERM and then
  // SIGKILL after terminationGracePeriodSeconds; this must be comfortably lower.
  shutdown: {
    drainTimeoutMs: intFromEnv('SHUTDOWN_DRAIN_TIMEOUT_MS', 10000, { min: 100 }),
    // Delay between failing readiness and closing the listener, so a load
    // balancer has time to notice and stop routing. Phase 7 wires this to the
    // real readiness probe period.
    readinessDelayMs: intFromEnv('SHUTDOWN_READINESS_DELAY_MS', IS_TEST ? 0 : 2000, { min: 0 }),
  },

  // Whether to expose error details in HTTP responses. Never in production.
  exposeErrorDetails: boolFromEnv('EXPOSE_ERROR_DETAILS', false) && !IS_PRODUCTION,
};

export default config;
