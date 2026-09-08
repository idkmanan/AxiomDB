// ---------------------------------------------------------------------------
// The access-token denylist: instant revocation for a token that cannot be recalled.
//
// THE PROBLEM. A JWT is valid because it verifies, not because a server says so. That is the
// property that makes it cheap — no lookup per request — and it is exactly why sign-out could
// not do anything real in Phase 1: clearing the cookie asks the client to forget a credential
// that still works for the rest of its lifetime. `grep -rn "revoke\|denylist" src/` returned
// nothing, and the 15-minute TTL was the whole mitigation.
//
// THE FIX, and its cost. Every access token now carries a `jti` (src/utils/jwt.js). Sign-out
// writes that id to Redis with a TTL equal to the token's REMAINING life, and `authenticate`
// refuses any token whose id is present. The token stops working immediately; the entry
// disappears exactly when the token would have expired anyway, so the denylist can never grow
// beyond the number of revocations in one token lifetime.
//
// The cost is one Redis round trip per authenticated request, which is the thing JWTs are
// often chosen to avoid. Worth being explicit that this trade is deliberate: a GET on a short
// key is sub-millisecond on a local Redis, and it buys the ability to end a session — which is
// not optional for anything holding real data.
//
// FAIL OPEN, AND THIS IS A DECISION, NOT AN ACCIDENT (ADR 0002's reasoning, applied to a
// different dependency). If Redis is unreachable the check cannot be performed, and there are
// only two options:
//
//   fail closed → every authenticated request 401s during a Redis blip. A cache outage
//                 becomes a total outage, and the blast radius is every user.
//   fail open   → a revoked token keeps working until it expires. The exposure is bounded by
//                 SESSION_TTL_MS (15 minutes) and applies only to tokens revoked during the
//                 outage.
//
// Fail open, counted and logged, because the denylist is a MITIGATION layered on a short
// expiry rather than the primary access control. `auth_denylist_failures_total` is the metric
// that makes the window visible instead of assumed — the same instrumentation Arcjet lacked
// when it failed open silently (F-07).
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import config from '#config/env.js';
import { getRedis, redisKey } from '#redis/client.js';

const key = (jti) => redisKey('dl', jti);

/** Counters, mirrored into Prometheus by src/metrics/collectors.js. */
export const denylistStats = {
  checks: 0,
  hits: 0,
  failures: 0,
  revocations: 0,
};

/**
 * Is the denylist usable at all?
 *
 * Without Redis there is no revocation, and pretending otherwise would be worse than not
 * having it: `authenticate` would silently accept every token while the code implied it was
 * checking. Reported by /ready so a deployment cannot be wrong about it quietly.
 */
export function denylistEnabled() {
  return Boolean(config.redis.url);
}

/**
 * Revoke a token by its id.
 *
 * @param {{jti: string, exp: number}} claims `exp` is in SECONDS (the JWT convention), so it
 *        is converted here. Using the token's own expiry as the TTL is what keeps this bounded.
 */
export async function denyAccessToken({ jti, exp }, { client } = {}) {
  if (!denylistEnabled() || !jti) return { denied: false, reason: 'denylist-disabled' };

  const remainingMs = typeof exp === 'number' ? exp * 1000 - Date.now() : config.session.ttlMs;
  if (remainingMs <= 0) {
    // Already expired: writing it would be a key that protects nothing.
    return { denied: false, reason: 'already-expired' };
  }

  try {
    const redis = client ?? getRedis();
    await redis.set(key(jti), '1', 'PX', remainingMs);
    denylistStats.revocations += 1;
    logger.info('Access token revoked', { jti, ttlMs: remainingMs });
    return { denied: true, ttlMs: remainingMs };
  } catch (e) {
    denylistStats.failures += 1;
    // Loud, because the user asked to be signed out and was not. The refresh family is revoked
    // in Postgres-independent storage by the same handler, so the session cannot be RENEWED —
    // this failure limits the damage to the current access token's remaining minutes.
    logger.error('Failed to revoke access token — it remains valid until it expires', {
      jti,
      error: e.message,
    });
    return { denied: false, reason: 'store-unavailable' };
  }
}

/**
 * Is this token id revoked?
 *
 * Returns false — allow — when the denylist is disabled or unreachable. See the header.
 */
export async function isAccessTokenDenied(jti, { client } = {}) {
  if (!denylistEnabled() || !jti) return false;

  denylistStats.checks += 1;
  try {
    const redis = client ?? getRedis();
    const found = await redis.exists(key(jti));
    if (found === 1) {
      denylistStats.hits += 1;
      return true;
    }
    return false;
  } catch (e) {
    denylistStats.failures += 1;
    logger.error('Denylist check failed — failing OPEN, token accepted', {
      jti,
      error: e.message,
    });
    return false;
  }
}

export default { denyAccessToken, isAccessTokenDenied, denylistEnabled, denylistStats };
