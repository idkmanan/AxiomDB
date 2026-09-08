// ---------------------------------------------------------------------------
// What is measured, and the middleware that measures it.
//
// THE ONE RULE THAT MATTERS HERE IS LABEL CARDINALITY. Every distinct combination of label
// values is a separate time series, held in memory in this process and again in Prometheus.
// `route="/api/deals/:id"` is one series; `route="/api/deals/8123"` is one series PER DEAL,
// so a scanner walking ids — or an ordinary client paging through a million rows — turns a
// metrics endpoint into an out-of-memory incident in the monitoring system. That failure is
// self-inflicted and common, so the route label is always a ROUTE PATTERN and never a path,
// and anything unmatched collapses to a single bucket.
//
// The set below is deliberately small: RED (rate, errors, duration) per route, pool
// saturation, limiter rejections, and event-loop lag. Each one earns its place by having
// explained a real failure in this project:
//
//   http_request_duration_seconds  the v0→v1 p95 claim, measured in-process rather than
//                                 only at the k6 client
//   pg_pool_connections{waiting}   finding F-33: requests queued for a connection are
//                                 indistinguishable from slow queries in a latency
//                                 histogram, and they are what precedes the 503s
//   nodejs_eventloop_lag_seconds   finding F-37: `connect()` timed out against a healthy
//                                 database because the loop was blocked in bcrypt. This is
//                                 the metric that says so
//   rate_limit_*                   the fail-open/fail-closed decision from ADR 0002 is
//                                 invisible without a counter, which is exactly what
//                                 Arcjet's silent failure was (F-07)
// ---------------------------------------------------------------------------
import { monitorEventLoopDelay } from 'node:perf_hooks';
import config from '#config/env.js';
import { registry } from '#metrics/registry.js';
import { poolStats } from '#config/database.js';
import { rateLimitStats } from '#middleware/rate-limit.middleware.js';
import { denylistStats, denylistEnabled } from '#auth/denylist.service.js';
import { idempotencyStats } from '#middleware/idempotency.middleware.js';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export const httpRequests = registry.counter(
  'http_requests_total',
  'Total HTTP requests by method, route pattern and status code.',
  ['method', 'route', 'status']
);

export const httpDuration = registry.histogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds, by method and route pattern.',
  ['method', 'route'],
  // Buckets chosen from the measured numbers rather than from a library default: v0 sat at
  // 4-6 s at the knee, v1's fast path is single-digit milliseconds, and the pool timeout is
  // 5 s. A bucket boundary near each of those is what makes the histogram readable.
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
);

export const httpInFlight = registry.gauge(
  'http_requests_in_flight',
  'Requests currently being served.'
);

/**
 * The route pattern for a finished request.
 *
 * `req.route` is only populated once a route has matched, which is why this is computed
 * after the response rather than before it. `req.baseUrl` carries the router's mount path,
 * so a router-relative `/:id` becomes `/api/deals/:id`.
 */
export function routeLabel(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    const path = req.route.path === '/' ? '' : req.route.path;
    return `${base}${path}` || '/';
  }
  // Nothing matched: a 404, a body-parser rejection, or a request stopped by middleware
  // before routing. One bucket for all of it — the alternative is a series per URL a
  // scanner invents.
  return 'unmatched';
}

/**
 * Express middleware. Mounted early so it observes requests that later middleware rejects —
 * a 401 from `authenticate` and a 429 from the limiter are both real traffic, and a
 * dashboard that only counts successes cannot show a spike in either.
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  httpInFlight.inc({}, 1);

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route: routeLabel(req) };
    httpDuration.observe(labels, seconds);
    httpRequests.inc({ ...labels, status: String(res.statusCode) });
    httpInFlight.dec({}, 1);
  });

  // `finish` does not fire if the client disconnects before the response completes, which is
  // exactly what happened to the 752 abandoned requests in finding F-34. Without this the
  // in-flight gauge would drift upwards forever and eventually read as a saturated server
  // that is actually idle.
  res.on('close', () => {
    if (!res.writableFinished) {
      httpInFlight.dec({}, 1);
      httpRequests.inc({ method: req.method, route: routeLabel(req), status: 'client_closed' });
    }
  });

  next();
}

// ---------------------------------------------------------------------------
// Connection pool (finding F-33)
// ---------------------------------------------------------------------------
registry
  .gauge('pg_pool_connections', 'node-postgres pool connections by state.', ['state'])
  // Read at scrape time from the pool's own counters. Keeping a copy in sync would be a
  // second source of truth, and the pool already knows.
  .collect((g) => {
    const stats = poolStats();
    if (!stats) return;
    g.set({ state: 'total' }, stats.total);
    g.set({ state: 'idle' }, stats.idle);
    // The leading indicator. `waiting > 0` means requests are queued for a connection, which
    // an application latency histogram reports as "slow queries" and a database dashboard
    // reports as nothing at all.
    g.set({ state: 'waiting' }, stats.waiting);
  });

registry
  .gauge('pg_pool_max', 'Configured maximum pool size.')
  .collect((g) => g.set({}, config.pool.max));

// ---------------------------------------------------------------------------
// Rate limiter (ADR 0002, finding F-07)
// ---------------------------------------------------------------------------
const limiterRejected = registry.counter(
  'rate_limit_rejected_total',
  'Requests rejected with 429 by the sliding-window limiter.'
);
const limiterStoreFailures = registry.counter(
  'rate_limit_store_failures_total',
  'Limiter store failures, by what the policy did about it.',
  ['action']
);

registry
  .gauge('rate_limit_keys_tracked', 'Keys currently held by the limiter store.')
  .collect((g) => {
    // Mirrored here rather than incremented in the limiter, so the limiter keeps no
    // dependency on the metrics layer. `setTotal` refuses to go backwards — see
    // src/metrics/registry.js.
    limiterRejected.setTotal({}, rateLimitStats.rejected);
    limiterStoreFailures.setTotal({ action: 'allowed' }, rateLimitStats.storeFailuresAllowed);
    limiterStoreFailures.setTotal({ action: 'rejected' }, rateLimitStats.storeFailuresRejected);
    g.set({}, rateLimitStats.keysTracked ?? 0);
  });

// ---------------------------------------------------------------------------
// Auth: revocation and idempotency (Phase 4)
// ---------------------------------------------------------------------------
// Both of these are FAIL-OPEN paths, which is exactly why they need counters. A mechanism that
// silently stops working while the code still calls it is the Arcjet failure (F-07); a
// non-zero `_failures_total` is the difference between "revocation is working" and "revocation
// has been off for a week".
const denylistCounters = registry.counter(
  'auth_denylist_events_total',
  'Access-token denylist activity, by event.',
  ['event']
);
const idempotencyCounters = registry.counter(
  'idempotency_events_total',
  'Idempotency-Key handling, by outcome.',
  ['event']
);

registry
  .gauge('auth_denylist_enabled', 'Whether token revocation is configured (1) or not (0).')
  .collect((g) => {
    denylistCounters.setTotal({ event: 'check' }, denylistStats.checks);
    denylistCounters.setTotal({ event: 'hit' }, denylistStats.hits);
    denylistCounters.setTotal({ event: 'failure' }, denylistStats.failures);
    denylistCounters.setTotal({ event: 'revocation' }, denylistStats.revocations);
    idempotencyCounters.setTotal({ event: 'replayed' }, idempotencyStats.replayed);
    idempotencyCounters.setTotal({ event: 'conflict' }, idempotencyStats.conflicts);
    idempotencyCounters.setTotal({ event: 'body_mismatch' }, idempotencyStats.mismatches);
    idempotencyCounters.setTotal({ event: 'failure' }, idempotencyStats.failures);
    g.set({}, denylistEnabled() ? 1 : 0);
  });

// ---------------------------------------------------------------------------
// Process and event loop (finding F-37)
// ---------------------------------------------------------------------------
registry
  .gauge('process_uptime_seconds', 'Seconds since process start.')
  .collect((g) => g.set({}, process.uptime()));

registry
  .gauge('process_resident_memory_bytes', 'Resident set size in bytes.')
  .collect((g) => g.set({}, process.memoryUsage.rss()));

registry
  .gauge('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.')
  .collect((g) => g.set({}, process.memoryUsage().heapUsed));

/**
 * Event-loop delay, from `perf_hooks` — built in, so no dependency.
 *
 * THIS IS THE METRIC F-37 NEEDED. Six requests failed with 'Connection terminated due to
 * connection timeout' against a database that was healthy and a pool that was below `max`:
 * the loop was blocked in bcrypt (sign-in p50 2091 ms), so the callback completing the
 * connection could not be scheduled inside 5 s. Nothing in a latency histogram or a pool
 * gauge says that. Loop lag does, in one number.
 *
 * Reported as quantiles of a resolution-10ms sampling histogram, in seconds to match
 * Prometheus base-unit convention. Not enabled under NODE_ENV=test: the monitor holds a
 * libuv handle, and an open handle in a unit test is a hang rather than a warning.
 */
const loopDelay = config.isTest ? null : monitorEventLoopDelay({ resolution: 10 });
loopDelay?.enable();

registry
  .gauge('nodejs_eventloop_lag_seconds', 'Event-loop delay quantiles, in seconds.', ['quantile'])
  .collect((g) => {
    if (!loopDelay) return;
    g.set({ quantile: 'p50' }, loopDelay.percentile(50) / 1e9);
    g.set({ quantile: 'p99' }, loopDelay.percentile(99) / 1e9);
    g.set({ quantile: 'max' }, loopDelay.max / 1e9);
  });

/** Release the loop-delay handle. Part of the shutdown sequence in src/server.js. */
export function stopMetrics() {
  loopDelay?.disable();
}

export { registry };
