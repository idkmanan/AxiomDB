// ---------------------------------------------------------------------------
// Keyset pagination cursors.
//
// WHAT A CURSOR IS HERE: the sort key of the last row of the previous page,
// encoded. Nothing more. The next page is "the rows that sort after this one",
// which Postgres answers with an index seek instead of the count-and-discard walk
// that OFFSET performs.
//
// WHY IT IS OPAQUE, AND WHY IT IS NOT SIGNED. Opaque because the encoding is the
// server's business: the sort key can change (a `stage` filter could add a column)
// without breaking a client that has been told only to echo the value back.
// Unsigned because a cursor carries no authority — every value it can hold is a
// value the caller could have passed as a plain query parameter, and the query it
// feeds is still scoped by the same authorization checks. Signing it would add key
// management to protect nothing. What it does need is strict VALIDATION, because a
// malformed cursor must produce a 400 and not a 500 from a `Date` coercion or a
// Postgres type error, and that is what `decodeCursor` is for.
//
// FORMAT: base64url of `v1|<epoch-milliseconds>|<id>`.
//
// * base64url, not base64 — `+` and `/` are not URL-safe and would have to be
//   percent-encoded by every client, which is a papercut that shows up as
//   intermittent "invalid cursor" reports from whichever client forgets.
// * epoch milliseconds, not ISO 8601 — no timezone to misparse, no fractional-second
//   ambiguity, and it makes the millisecond contract from finding F-46 explicit at
//   the boundary rather than implicit in a string format.
// * a version prefix, so a future change to the sort key can reject old cursors with
//   a clear message instead of misinterpreting them.
// ---------------------------------------------------------------------------
import { AppError } from '#middleware/error.middleware.js';

const VERSION = 'v1';

// A cursor is only ever produced from a row we just read, so these bounds exist to
// reject a hand-crafted value rather than to constrain real data. 1970-01-01 to
// ~2286-11-20 (the millisecond range that `new Date()` renders sanely), and the
// bigserial id range as far as JavaScript can represent it exactly.
const MIN_EPOCH_MS = 0;
const MAX_EPOCH_MS = 1e13;
const MAX_ID = Number.MAX_SAFE_INTEGER;

/**
 * Encode the sort key of a row.
 *
 * @param {{created_at: Date|string|number, id: number|string}} row
 * @returns {string} URL-safe cursor
 */
export function encodeCursor(row) {
  const ms = row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at);
  const id = Number(row.id);
  if (!Number.isFinite(ms) || !Number.isFinite(id)) {
    // A programming error, not a client error: the row came from our own query.
    throw new Error(`Cannot encode cursor from row {created_at:${row.created_at}, id:${row.id}}`);
  }
  return Buffer.from(`${VERSION}|${ms}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decode and validate a cursor.
 *
 * Every failure path is a 400 with the same message. Distinguishing "not base64"
 * from "bad version" would tell a caller nothing actionable — the only correct
 * response to any of them is to restart paging — and it would invite a client to
 * write logic against our internals.
 *
 * @param {string} raw
 * @returns {{createdAt: Date, id: number}}
 */
export function decodeCursor(raw) {
  const invalid = () => new AppError('Invalid pagination cursor', 400, { code: 'INVALID_CURSOR' });

  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) throw invalid();

  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw invalid();
  }

  const parts = decoded.split('|');
  if (parts.length !== 3 || parts[0] !== VERSION) throw invalid();

  // DIGITS ONLY, checked on the raw text before any numeric conversion. `Number('1e3')`
  // is 1000 and `Number(' 5')` is 5, so a check that only asks "is it an integer?"
  // accepts several spellings of the same cursor — two distinct strings denoting one
  // position. That is the same leniency that made `parseInt('12abc')` a real defect in
  // v0's id handling (src/validations/users.validation.js:6). A cursor is an opaque
  // token the server minted: exactly one spelling of it is legitimate.
  if (!/^\d{1,14}$/.test(parts[1]) || !/^\d{1,16}$/.test(parts[2])) throw invalid();

  const ms = Number(parts[1]);
  const id = Number(parts[2]);

  // The explicit bounds then reject a value that is a well-formed integer but not a
  // plausible one, which is what stops a crafted cursor from reaching Postgres as an
  // out-of-range timestamp (SQLSTATE 22008) — the same class of bug as the 32-bit id
  // ceiling in src/validations/users.validation.js.
  if (!Number.isInteger(ms) || ms < MIN_EPOCH_MS || ms > MAX_EPOCH_MS) throw invalid();
  if (!Number.isInteger(id) || id < 1 || id > MAX_ID) throw invalid();

  return { createdAt: new Date(ms), id };
}

export default { encodeCursor, decodeCursor };
