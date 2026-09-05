// ---------------------------------------------------------------------------
// Global error handling.
//
// v0 had none. `grep -rn "err, req, res, next" src/` returned nothing, so every
// `next(e)` in a controller reached Express's built-in final handler, which in a
// non-production NODE_ENV writes the stack trace into the HTTP response body.
// That leaks absolute file paths, dependency versions and internal structure to
// anyone who can provoke an unhandled error.
//
// Two responsibilities, deliberately separated:
//   * translate a thrown thing into a status code, once, in one place
//   * decide what the client is allowed to see
//
// The client always gets the request id. The stack always stays in the log. That
// pairing is what lets you debug a report of "I got a 500 at 14:32" without ever
// putting a stack trace on the wire.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import config from '#config/env.js';
import { pgCodeOf, systemCodeOf, chainMessageIncludes } from '#utils/db-error.js';

/** Error carrying an intended HTTP status. Thrown by services. */
export class AppError extends Error {
  constructor(message, statusCode = 500, { code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

// Postgres SQLSTATE codes worth translating rather than reporting as 500.
// A unique-violation reaching this handler is a real race — two concurrent
// signups for the same address both passed the existence check — and the correct
// answer is 409, not 500. Phase 3 wraps the check-and-insert in a transaction so
// the race is prevented rather than merely reported.
const PG_STATUS = {
  23505: [409, 'Resource already exists'], // unique_violation
  23503: [409, 'Referenced resource does not exist'], // foreign_key_violation
  23502: [400, 'A required field was missing'], // not_null_violation
  '22P02': [400, 'Malformed value in request'], // invalid_text_representation
  22001: [400, 'A value exceeds its maximum length'], // string_data_right_truncation
  53300: [503, 'Too many database connections'], // too_many_connections
};

/**
 * Map anything throwable onto { status, message }.
 * Exported so it can be unit-tested without an HTTP round trip.
 */
export function classify(err) {
  // Body-parser cases come FIRST, ahead of the explicit-status branch, and that
  // order is finding F-31. `express.json()` throws a SyntaxError that already
  // carries `status = 400`, so an explicit-status check placed before this would
  // match and pass `err.message` straight through — leaking the parser's internal
  // text, which can include a fragment of the offending body ("Unexpected token }
  // in JSON at position 12"). The status was right and the message was theirs.
  if (err instanceof SyntaxError && 'body' in err) {
    return { status: 400, message: 'Malformed JSON in request body', kind: 'client' };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 413, message: 'Request body too large', kind: 'client' };
  }

  // Explicit status set by application code.
  const explicit = err?.statusCode ?? err?.status;
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) {
    return { status: explicit, message: err.message || 'Request failed', kind: 'application' };
  }

  // Everything below walks the `cause` chain rather than reading the top-level
  // error, because drizzle rethrows every driver failure wrapped in a
  // DrizzleQueryError whose own message is "Failed query: …" and which carries no
  // code. Reading only the outermost error made all of this dead (finding F-36).
  const pgCode = pgCodeOf(err);
  if (pgCode && PG_STATUS[pgCode]) {
    const [status, message] = PG_STATUS[pgCode];
    return { status, message, kind: 'database' };
  }

  // Connection-level failures reaching the request path. 503 rather than 500: the
  // request was valid and may succeed on retry.
  const sysCode = systemCodeOf(err);
  if (sysCode === 'ECONNREFUSED' || sysCode === 'ETIMEDOUT' || sysCode === 'ENOTFOUND') {
    return { status: 503, message: 'A downstream dependency is unavailable', kind: 'dependency' };
  }

  // POOL EXHAUSTION — finding F-33. Matched on the MESSAGE because node-postgres
  // attaches no code to it (`pg-pool/index.js:224` constructs a bare
  // `new Error('timeout exceeded when trying to connect')`).
  //
  // This is the branch src/config/env.js already claimed existed: "Fail fast
  // instead of queueing indefinitely. A 503 in 5s is a usable signal; a request
  // that never returns is not." Setting `connectionTimeoutMillis` delivered the
  // fail-fast half and nothing mapped the result, so pool exhaustion surfaced as a
  // 500 — indistinguishable from a bug in application code.
  //
  // 503 is correct because the request was valid and a retry may succeed. Matching
  // a dependency's error string is fragile, so it is last, narrow, and paired with
  // a test that fails if the pool changes the wording.
  if (chainMessageIncludes(err, 'timeout exceeded when trying to connect')) {
    return { status: 503, message: 'Server is at capacity; retry shortly', kind: 'saturation' };
  }
  // Raised by pg-pool once `end()` has been called — a request that arrived during
  // the shutdown drain. Also retry-elsewhere, not a bug.
  if (chainMessageIncludes(err, 'Cannot use a pool after calling end on the pool')) {
    return { status: 503, message: 'Server is shutting down', kind: 'shutdown' };
  }

  return { status: 500, message: 'Internal Server Error', kind: 'unknown' };
}

/** Terminal 404 for unmatched routes. Registered before the error handler. */
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found', requestId: req.id });
}

/**
 * Express error handler. The four-argument signature is what marks it as one —
 * with three arguments Express treats it as ordinary middleware and it silently
 * never runs, which is a genuinely easy mistake to ship and produces no warning.
 */
export function errorHandler(err, req, res, next) {
  const { status, message, kind } = classify(err);

  // Once the response has started, the only correct move is to abort the
  // connection — writing a JSON error body after a partial response corrupts it.
  // Express's default handler does exactly this, so delegate.
  if (res.headersSent) {
    logger.error('Error after response started; connection will be destroyed', {
      requestId: req.id,
      path: req.path,
      error: err?.message,
    });
    return next(err);
  }

  // Full detail server-side, always. `stack` and `cause` are the reason the
  // logger's errors({stack:true}) format had to be fixed first — with the v0
  // comma-expression bug at logger.js:5 this object would have been logged
  // without its stack and without a timestamp.
  const logAt = status >= 500 ? 'error' : 'warn';
  logger.log(logAt, 'Unhandled error in request', {
    requestId: req.id,
    method: req.method,
    path: req.path,
    status,
    kind,
    name: err?.name,
    code: err?.code,
    message: err?.message,
    stack: err?.stack,
    cause: err?.cause?.message,
  });

  // Nothing internal on the wire. For 5xx the client gets a fixed string and the
  // request id; `message` from the classifier is only used for 4xx, where it
  // describes the caller's own mistake rather than our internals.
  const body = {
    error: status >= 500 ? 'Internal Server Error' : message,
    requestId: req.id,
  };
  if (status < 500) body.message = message;

  // Opt-in, never in production (see src/config/env.js). Exists so a developer
  // debugging locally does not have to tail the log file, not as a prod switch.
  if (config.exposeErrorDetails) {
    body.debug = { name: err?.name, code: err?.code, message: err?.message, stack: err?.stack };
  }

  res.status(status).json(body);
}

export default errorHandler;
