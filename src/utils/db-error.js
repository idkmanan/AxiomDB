// ---------------------------------------------------------------------------
// Reading the truth out of a wrapped driver error.
//
// FINDING F-36, and it made two Phase 1 fixes inert.
//
// Drizzle does not propagate driver errors as-is. Every failing query is rethrown
// as a `DrizzleQueryError` (node_modules/drizzle-orm/errors.js:10):
//
//   class DrizzleQueryError extends Error {
//     constructor(query, params, cause) {
//       super(`Failed query: ${query}\nparams: ${params}`);
//       this.cause = cause;          // <- the real pg error lives HERE
//     }
//   }
//
// So the wrapper's own `message` is always "Failed query: …" and it carries **no**
// `code`. Two Phase 1 changes inspected the top-level error and therefore never
// matched anything:
//
//   * `classify()` mapped pool exhaustion to 503 by matching
//     'timeout exceeded when trying to connect' on `err.message` (F-33). Under
//     drizzle that text is at `err.cause.message`, so pool exhaustion kept
//     returning 500 — which is exactly what the v1 20-VU run reported: 8 non-503
//     5xx responses, 0 shed.
//
//   * `createUser` translated SQLSTATE 23505 to a 409 by reading `e.code`. Under
//     drizzle that is at `e.cause.code`, so the signup race still surfaced as a
//     500 — the defect Phase 1 claimed to have fixed.
//
// Both unit tests passed, because both constructed RAW driver-shaped errors
// (`Object.assign(new Error('duplicate key'), { code: '23505' })`) rather than the
// wrapped shape the application actually produces. Same trap as F-31: a test
// written from the same mental model as the code inherits its blind spots.
//
// Hence this module, and hence tests/db-error.test.js building errors that are
// wrapped the way drizzle wraps them.
// ---------------------------------------------------------------------------

/** Depth cap: a cause chain is a linked list and a cycle would hang the walk. */
const MAX_DEPTH = 8;

/**
 * Yield an error and each of its `cause` ancestors, outermost first.
 * @param {unknown} err
 */
export function* causeChain(err) {
  let current = err;
  for (let depth = 0; depth < MAX_DEPTH && current != null; depth++) {
    yield current;
    const next = current.cause;
    if (next === current) return; // self-referential cause
    current = next;
  }
}

/**
 * The Postgres SQLSTATE from anywhere in the chain.
 *
 * SQLSTATE is five characters, so the shape is checked rather than merely the
 * presence of a `code` property — Node attaches `code` to plenty of unrelated
 * errors (`ECONNREFUSED`, `ERR_INVALID_ARG_TYPE`), and treating those as SQLSTATE
 * would map a programming error onto an HTTP status.
 * @returns {string | null}
 */
export function pgCodeOf(err) {
  for (const link of causeChain(err)) {
    const code = link?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Non-SQLSTATE driver/system code from anywhere in the chain, e.g. ECONNREFUSED. */
export function systemCodeOf(err) {
  for (const link of causeChain(err)) {
    const code = link?.code;
    if (typeof code === 'string' && /^[A-Z_]{4,}$/.test(code)) return code;
  }
  return null;
}

/**
 * Whether any message in the chain contains `needle`.
 *
 * Matching a dependency's error text is fragile, which is why every caller pairs
 * it with a test that fails if the wording changes rather than silently reverting
 * to a 500.
 */
export function chainMessageIncludes(err, needle) {
  for (const link of causeChain(err)) {
    if (typeof link?.message === 'string' && link.message.includes(needle)) return true;
  }
  return false;
}
