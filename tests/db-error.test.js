// ---------------------------------------------------------------------------
// Driver errors as the application actually receives them (finding F-36).
//
// Every test here builds a DrizzleQueryError-shaped error — the wrapper drizzle
// rethrows on any failing query — rather than a raw pg error. That distinction is
// the entire point of the file: the original tests for the 503 mapping and the
// 23505 translation constructed raw errors, passed, and both mappings were dead in
// the real path because drizzle puts the driver error in `cause` and gives the
// wrapper a message of "Failed query: …" and no code.
// ---------------------------------------------------------------------------
import { classify } from '#middleware/error.middleware.js';
import {
  causeChain,
  pgCodeOf,
  systemCodeOf,
  chainMessageIncludes,
  RETRYABLE_DRIVER_MESSAGES,
} from '#utils/db-error.js';

/**
 * The real shape, copied from node_modules/drizzle-orm/errors.js:10.
 * Constructed here rather than imported so the test states the contract it relies
 * on: if drizzle changes this shape, these tests should be what notices.
 */
function drizzleWrap(cause, query = 'select "id" from "users" where "users"."email" = $1') {
  const err = new Error(`Failed query: ${query}\nparams: a@b.test`);
  err.name = 'DrizzleQueryError';
  err.query = query;
  err.params = ['a@b.test'];
  err.cause = cause;
  return err;
}

function pgError(message, code) {
  return Object.assign(new Error(message), { code });
}

describe('cause-chain helpers', () => {
  it('walks outermost-first', () => {
    const inner = new Error('inner');
    const outer = drizzleWrap(inner);
    expect([...causeChain(outer)]).toEqual([outer, inner]);
  });

  it('terminates on a self-referential cause instead of hanging', () => {
    const loop = new Error('loop');
    loop.cause = loop;
    expect([...causeChain(loop)]).toHaveLength(1);
  });

  it('caps depth, so a long chain cannot spin', () => {
    let err = new Error('deepest');
    for (let i = 0; i < 50; i++) err = drizzleWrap(err);
    expect([...causeChain(err)].length).toBeLessThanOrEqual(8);
  });

  it('distinguishes a SQLSTATE from a Node system code', () => {
    // SQLSTATE is five chars of [0-9A-Z]. Node attaches `code` to plenty of
    // unrelated errors, and treating ECONNREFUSED as SQLSTATE would map a
    // programming error onto an HTTP status.
    expect(pgCodeOf(drizzleWrap(pgError('dup', '23505')))).toBe('23505');
    expect(pgCodeOf(drizzleWrap(pgError('refused', 'ECONNREFUSED')))).toBeNull();
    expect(systemCodeOf(drizzleWrap(pgError('refused', 'ECONNREFUSED')))).toBe('ECONNREFUSED');
    expect(pgCodeOf(new Error('no code at all'))).toBeNull();
  });

  it('finds a message anywhere in the chain, not just at the top', () => {
    const wrapped = drizzleWrap(new Error('timeout exceeded when trying to connect'));
    // The wrapper's own message says nothing about the timeout.
    expect(wrapped.message).not.toContain('timeout exceeded');
    expect(chainMessageIncludes(wrapped, 'timeout exceeded when trying to connect')).toBe(true);
  });
});

describe('the matched driver strings still exist in the installed pg (F-37)', () => {
  // Matching a dependency's error text is fragile. This is what makes it a checked
  // contract instead of a hope: every needle in the table must still appear in the
  // source it was taken from, so a pg upgrade that rewords one FAILS HERE rather
  // than silently turning load shedding back into a 500 — which is precisely how
  // F-33 and F-37 stayed hidden until a benchmark tripped over them.
  const sources = {};

  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    sources['pg-pool'] = readFileSync('node_modules/pg-pool/index.js', 'utf8');
    sources['pg'] = readFileSync('node_modules/pg/lib/client.js', 'utf8');
  });

  it('covers both connectionTimeoutMillis paths, which is the whole point', () => {
    const needles = RETRYABLE_DRIVER_MESSAGES.map((e) => e.needle);
    expect(needles).toContain('timeout exceeded when trying to connect');
    expect(needles).toContain('Connection terminated due to connection timeout');
  });

  it.each(RETRYABLE_DRIVER_MESSAGES.map((e) => [e.source, e.needle]))(
    '%s still emits "%s"',
    (source, needle) => {
      expect(sources[source]).toContain(needle);
    }
  );
});

describe('classify sees through the drizzle wrapper', () => {
  it('maps a wrapped unique violation to 409', () => {
    // The signup race. Before F-36 this returned 500 in the real path while the
    // raw-error unit test reported success.
    const wrapped = drizzleWrap(pgError('duplicate key value violates unique constraint', '23505'));
    expect(classify(wrapped)).toMatchObject({ status: 409, kind: 'database' });
  });

  it('maps wrapped pool exhaustion to 503, not 500', () => {
    // Path 1: the pool is at `max` and this request waited in the queue past
    // connectionTimeoutMillis (pg-pool/index.js:224).
    const wrapped = drizzleWrap(new Error('timeout exceeded when trying to connect'));
    expect(classify(wrapped)).toMatchObject({ status: 503, kind: 'saturation' });
    expect(classify(wrapped).status).not.toBe(500);
  });

  it('maps the OTHER connection-timeout error to 503 as well (F-37)', () => {
    // Path 2, and the one that produced 6 × 500 in the v1 20-VU run. The pool was
    // BELOW max, opened a new client, and that client's connect() did not finish in
    // time — so pg-pool/index.js:276 raises a different message for the same
    // configured condition, itself wrapping the underlying error.
    //
    // Reproduced with the real nesting: drizzle -> pg-pool -> connect error.
    const inner = new Error('timeout expired');
    const poolErr = new Error('Connection terminated due to connection timeout', { cause: inner });
    const wrapped = drizzleWrap(poolErr);

    expect(classify(wrapped)).toMatchObject({ status: 503, kind: 'saturation' });
    // Nothing distinguishes the two paths operationally, so they must not produce
    // different statuses — which is exactly the bug this replaces.
    expect(classify(wrapped).status).toBe(
      classify(drizzleWrap(new Error('timeout exceeded when trying to connect'))).status
    );
  });

  it('maps a lost connection mid-query to 503', () => {
    const wrapped = drizzleWrap(new Error('Connection terminated unexpectedly'));
    expect(classify(wrapped)).toMatchObject({ status: 503, kind: 'dependency' });
  });

  it('maps a wrapped shutdown-race error to 503', () => {
    const wrapped = drizzleWrap(new Error('Cannot use a pool after calling end on the pool'));
    expect(classify(wrapped)).toMatchObject({ status: 503, kind: 'shutdown' });
  });

  it('maps a wrapped unreachable dependency to 503', () => {
    const wrapped = drizzleWrap(pgError('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'));
    expect(classify(wrapped)).toMatchObject({ status: 503, kind: 'dependency' });
  });

  it('maps the other known SQLSTATEs through the wrapper', () => {
    expect(classify(drizzleWrap(pgError('bad input', '22P02'))).status).toBe(400);
    expect(classify(drizzleWrap(pgError('fk', '23503'))).status).toBe(409);
    expect(classify(drizzleWrap(pgError('too many', '53300'))).status).toBe(503);
  });

  it('still returns 500 for a wrapped error it does not recognise', () => {
    // The fallback must stay a fallback: an unrecognised database failure is a
    // genuine 500 and must not be laundered into a 503.
    const wrapped = drizzleWrap(pgError('syntax error at or near "slect"', '42601'));
    expect(classify(wrapped)).toMatchObject({ status: 500, kind: 'unknown' });
  });

  it('does not let a leaked query string reach the client', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { errorHandler } = await import('#middleware/error.middleware.js');
    const { requestId } = await import('#middleware/request-id.middleware.js');

    // The wrapper's message contains the SQL and the bound parameters — an email
    // address here, but it is whatever the caller sent. It must not be echoed.
    const wrapped = drizzleWrap(pgError('syntax error', '42601'));
    const app = express();
    app.use(requestId);
    app.get('/boom', (req, res, next) => next(wrapped));
    app.use(errorHandler);

    const res = await request(app).get('/boom').expect(500);
    expect(res.body).toEqual({ error: 'Internal Server Error', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/select|params|a@b\.test/i);
  });
});
