// ---------------------------------------------------------------------------
// Custom metrics.
//
// k6's built-in http_req_duration mixes every endpoint together. That average is
// useless here: /health does no I/O, GET /api/users does an unbounded table scan
// (src/services/users.service.js:6-14), and POST /sign-in runs bcrypt at cost 10
// (src/services/auth.service.js:12, measured at ~75ms). Blending them produces a
// p95 that describes no real user journey.
//
// So each endpoint class gets its own Trend. That is what makes it possible to
// say "the users list p95 went from X to Y" and have the claim mean something.
// ---------------------------------------------------------------------------
import { Trend, Rate, Counter } from 'k6/metrics';

// Per-endpoint latency.
export const healthLatency = new Trend('lat_health', true);
export const usersListLatency = new Trend('lat_users_list', true);
export const userByIdLatency = new Trend('lat_user_by_id', true);
export const signinLatency = new Trend('lat_signin', true);
export const signupLatency = new Trend('lat_signup', true);

// Used by saturation.js for the unauthenticated /api probe. Kept separate so an
// open-model capacity number is never confused with a users-list latency.
export const apiRootLatency = new Trend('lat_api_root', true);

// Error accounting, split by cause. A 429 is the system working as designed; a
// 500 is a defect. Collapsing both into "error rate" hides which one you have.
export const rate429 = new Rate('rejected_rate_limited');
export const rate4xx = new Rate('client_errors');
export const rate5xx = new Rate('server_errors');
export const count403 = new Counter('forbidden_403');
export const countNetworkFail = new Counter('network_failures');

// 503 specifically, added in Phase 1 and NOT the same thing as a 500.
//
// Once `connectionTimeoutMillis` is set, pool exhaustion produces a fast failure
// rather than an unbounded wait — that is the system shedding load, and the correct
// status for it is 503 (finding F-33). A 500 means application code broke. Both are
// 5xx, so `server_errors` alone cannot tell them apart, and the difference is
// exactly the one you need at high concurrency: "saturated, shedding correctly"
// versus "there is a bug".
//
// This is additive OBSERVATION over the same responses. It changes no request, no
// load shape and no threshold, so it does not break the freeze on baseline.js —
// which is about the stimulus, not the instrumentation.
export const count503 = new Counter('shed_503');

// Records one response against the right metrics.
export function record(res, latencyTrend) {
  if (latencyTrend) latencyTrend.add(res.timings.duration);

  const s = res.status;

  // status 0 means the request never completed (connection refused, timeout).
  // Distinct from an HTTP error and must not be counted as a 5xx.
  if (s === 0) {
    countNetworkFail.add(1);
    rate5xx.add(false);
    rate4xx.add(false);
    rate429.add(false);
    return;
  }

  rate429.add(s === 429);
  rate4xx.add(s >= 400 && s < 500);
  rate5xx.add(s >= 500);

  // v0 returned 403 for rate-limit rejections (src/middleware/security.middleware.js:41)
  // instead of the correct 429. Kept so a regression to the old status is visible.
  if (s === 403) count403.add(1);

  // Load shedding, not a defect. See the note on count503 above.
  if (s === 503) count503.add(1);
}
