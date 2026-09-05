// ---------------------------------------------------------------------------
// Rate-limit middleware.
//
// Replaces src/middleware/security.middleware.js, which called Arcjet on every
// request. That middleware had four defects, all measured or verified in Phase 0:
//
//   F-07  it failed OPEN and silently — an unreachable provider produced an
//         ERROR decision, which `isDenied()` reports as false, so the request
//         was served with no limiting at all and nothing was logged
//   F-08  it answered 403 with no Retry-After; the correct status is 429
//   F-16  it cost ~75 ms of CPU per request, capping throughput at ~1/3, and
//         with no key configured it enforced nothing at all: zero rejections
//         across 14 runs against a configured 5 req/min window
//   —     it was mounted before `authenticate`, so `req.user` was always
//         undefined and its role switch always chose the guest bucket
//
// This file fixes all four and, unlike the thing it replaces, is honest about
// what it does when its own dependency is unavailable.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { MemorySlidingWindowStore } from '#rate-limit/sliding-window.js';
import { POLICIES, keyFor, limitFor, clientIp } from '#rate-limit/policy.js';

// One store for the process. Phase 4 replaces this line with a Redis-backed
// store implementing the same `hit`/`reset`/`close` contract; nothing below
// changes.
export const store = new MemorySlidingWindowStore().startSweeping(
  Math.max(POLICIES.auth.windowMs, POLICIES.authenticated.windowMs) * 10
);

/** Counters for the observability work in Phase 6. Cheap enough to always keep. */
export const rateLimitStats = {
  rejected: 0,
  storeFailuresAllowed: 0,
  storeFailuresRejected: 0,
};

/**
 * Set the draft `RateLimit-*` response headers.
 *
 * Field names follow draft-ietf-httpapi-ratelimit-headers. They are advisory but
 * they are what makes a limit usable by a client: without `Reset` a well-behaved
 * caller can only guess, so it retries immediately and the limiter spends its
 * time rejecting the same request. v0 sent none of these.
 */
function setLimitHeaders(res, decision) {
  const resetSeconds = Math.ceil(decision.resetMs / 1000);
  res.set('RateLimit-Limit', String(decision.limit));
  res.set('RateLimit-Remaining', String(Math.max(0, decision.remaining)));
  res.set('RateLimit-Reset', String(resetSeconds));
  return resetSeconds;
}

/**
 * Build a limiter for a named policy.
 *
 * @param {keyof typeof POLICIES} policyName
 * @param {object} [deps] injectable for tests — a store whose `hit` rejects is
 *        how the fail-open/fail-closed behaviour is actually verified rather
 *        than merely asserted in a comment
 */
export function rateLimit(policyName, deps = {}) {
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(`Unknown rate-limit policy: ${policyName}`);
  const backing = deps.store || store;

  return async function rateLimitMiddleware(req, res, next) {
    const key = keyFor(policy, req);
    const limit = limitFor(policy, req.user);

    let decision;
    try {
      decision = await backing.hit(key, limit, policy.windowMs);
    } catch (e) {
      // The branch Arcjet got wrong. Explicit, per-policy, and LOUD — an
      // unavailable limiter is an incident either way, and the difference
      // between the two policies is a deliberate trade rather than an accident
      // of which predicate someone happened to check.
      const failClosed = policy.onStoreFailure === 'closed';
      if (failClosed) {
        rateLimitStats.storeFailuresRejected++;
        logger.error('Rate limiter unavailable — failing CLOSED', {
          policy: policy.name,
          path: req.path,
          ip: clientIp(req),
          error: e.message,
        });
        res.set('Retry-After', String(Math.ceil(policy.windowMs / 1000)));
        return res.status(503).json({
          error: 'Service Unavailable',
          message: 'Rate limiting is temporarily unavailable; this endpoint fails closed.',
        });
      }
      rateLimitStats.storeFailuresAllowed++;
      logger.error('Rate limiter unavailable — failing OPEN, request NOT limited', {
        policy: policy.name,
        path: req.path,
        ip: clientIp(req),
        error: e.message,
      });
      return next();
    }

    const resetSeconds = setLimitHeaders(res, decision);

    if (!decision.allowed) {
      rateLimitStats.rejected++;
      // 429, not 403. 403 says "you may never do this"; 429 says "not yet", and
      // only 429 carries a documented retry contract. A client cannot tell the
      // difference between v0's 403 and a genuine authorization failure.
      res.set('Retry-After', String(resetSeconds));
      logger.warn('Rate limit exceeded', {
        policy: policy.name,
        key,
        limit,
        path: req.path,
        method: req.method,
        retryAfterSeconds: resetSeconds,
      });
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit of ${limit} requests per ${Math.round(policy.windowMs / 1000)}s exceeded.`,
        retryAfter: resetSeconds,
      });
    }

    return next();
  };
}

/** Release the sweeper timer. Called from the shutdown sequence in server.js. */
export function closeRateLimiter() {
  store.close();
}

export default rateLimit;
