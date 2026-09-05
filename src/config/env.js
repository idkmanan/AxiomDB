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
};

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
