// ---------------------------------------------------------------------------
// Request logging — replaces morgan.
//
// v0 src/app.js:19 piped morgan's Apache-combined string into winston:
//
//   app.use(morgan('combined', {stream: {write: m => logger.info(m.trim())}}))
//
// which produced two problems at once. Every request was logged twice (morgan's
// line plus whatever the controller logged), and morgan's output is an
// unstructured string stuffed inside a JSON `message` field — so the repo had
// "structured logging" that no log processor could actually query by status or
// duration. Dropping morgan is not a dependency-count exercise; it is the
// difference between a searchable field and a string to regex.
//
// One line per completed response, with the fields you would actually filter on.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';

// Probes are excluded from info-level logging on purpose. A Kubernetes liveness
// probe every 10s across 3 replicas is ~26k log lines a day that describe
// nothing, and they drown the lines that matter. Still emitted at debug.
const QUIET_PATHS = new Set(['/health', '/ready']);

export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const fields = {
      requestId: req.id,
      method: req.method,
      // `req.originalUrl` rather than `req.path`. Express REWRITES `req.url` and
      // `req.baseUrl` as a request descends into a mounted router and restores
      // them as the stack unwinds, so `req.path` read from a 'finish' listener
      // depends on where the response was produced. Observed directly: the same
      // sign-up route logged path '/sign-up' when the controller answered inside
      // the router, and '/api/auth/sign-in' when `next(e)` unwound to the
      // app-level error handler first. `originalUrl` is never rewritten.
      path: req.originalUrl.split('?')[0],
      // The matched pattern, WITHOUT its mount prefix — `/:id`, not
      // `/api/users/:id`. The prefix lives in `req.baseUrl`, which is already
      // restored by the time an error-path response is written, so a
      // fully-qualified route label is not reliably reconstructable here. Phase 6
      // gets it properly from OpenTelemetry's `http.route` attribute; until then
      // method + path is what aggregation should use.
      routePattern: req.route?.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userId: req.user?.id,
      // Query STRING is deliberately not logged. Tokens, reset codes and
      // pagination cursors end up there, and a log store is a lower-trust place
      // than a session cookie. Key names are enough to debug a bad request.
      queryKeys: Object.keys(req.query || {}),
      contentLength: res.get('content-length'),
      userAgent: req.get('user-agent'),
    };

    const quiet = QUIET_PATHS.has(req.originalUrl.split('?')[0]);
    const level =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : quiet ? 'debug' : 'info';

    logger.log(level, 'request', fields);
  });

  next();
}

export default requestLogger;
