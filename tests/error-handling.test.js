// ---------------------------------------------------------------------------
// Global error handling.
//
// v0 had no error handler at all — `grep -rn "err, req, res, next" src/` returned
// nothing — so every `next(e)` reached Express's built-in final handler, which
// writes the stack trace into the response body whenever NODE_ENV is not
// 'production'. That leaks absolute file paths, dependency versions and internal
// structure to anyone who can provoke an unhandled error.
//
// The assertions worth reading are the negative ones: nothing internal on the
// wire, in any status class, ever.
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import realApp from '#src/app.js';
import { AppError, classify, errorHandler, notFoundHandler } from '#middleware/error.middleware.js';
import { requestId } from '#middleware/request-id.middleware.js';

function appThatThrows(thrown) {
  const app = express();
  app.use(requestId);
  app.get('/boom', (req, res, next) => next(thrown));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('classify', () => {
  it('honours an explicit statusCode from application code', () => {
    expect(classify(new AppError('nope', 404))).toMatchObject({ status: 404, message: 'nope' });
    expect(classify(new AppError('conflict', 409))).toMatchObject({ status: 409 });
  });

  it('ignores an out-of-range statusCode rather than emitting an invalid status', () => {
    // res.status(200) on an error path, or res.status(99), would be worse than a
    // 500: the first reports success, the second is not a valid HTTP status at all.
    expect(classify(Object.assign(new Error('x'), { statusCode: 200 })).status).toBe(500);
    expect(classify(Object.assign(new Error('x'), { statusCode: 99 })).status).toBe(500);
  });

  it('maps a Postgres unique violation to 409, not 500', () => {
    // This is the signup race. Two concurrent sign-ups for one address both pass
    // the existence check; the unique constraint rejects the loser. v0 surfaced
    // that as a 500 even though the controller was written to return 409 — same
    // data outcome, but a 500 on a dashboard says "we have a bug" rather than
    // "a client raced itself".
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(classify(pgErr)).toMatchObject({ status: 409, kind: 'database' });
  });

  it('maps other Postgres codes it knows about', () => {
    expect(classify(Object.assign(new Error(''), { code: '22P02' })).status).toBe(400);
    expect(classify(Object.assign(new Error(''), { code: '23503' })).status).toBe(409);
    expect(classify(Object.assign(new Error(''), { code: '53300' })).status).toBe(503);
  });

  it('treats malformed JSON as a client error', () => {
    const syntax = Object.assign(new SyntaxError('Unexpected token'), { body: '{bad' });
    expect(classify(syntax)).toMatchObject({ status: 400, kind: 'client' });
  });

  it('treats an unreachable dependency as 503, since a retry may succeed', () => {
    expect(classify(Object.assign(new Error('down'), { code: 'ECONNREFUSED' })).status).toBe(503);
  });

  it('falls back to 500 for anything unrecognised', () => {
    expect(classify(new Error('who knows'))).toMatchObject({ status: 500, kind: 'unknown' });
    expect(classify(undefined).status).toBe(500);
    expect(classify('a thrown string').status).toBe(500);
  });
});

describe('error responses leak nothing', () => {
  it('returns a fixed 500 body with a request id and no stack', async () => {
    const secret = new Error('connection string postgres://user:hunter2@db/app failed');
    const res = await request(appThatThrows(secret)).get('/boom').expect(500);

    expect(res.body).toEqual({ error: 'Internal Server Error', requestId: expect.any(String) });
    // The three things v0's default handler would have shipped.
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2/);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);
    expect(res.body).not.toHaveProperty('stack');
  });

  it('does not put the internal message in a 5xx body even when classify has one', async () => {
    const res = await request(appThatThrows(new AppError('internal detail', 503)))
      .get('/boom')
      .expect(503);
    expect(res.body.error).toBe('Internal Server Error');
    expect(JSON.stringify(res.body)).not.toMatch(/internal detail/);
  });

  it('does describe the problem on a 4xx, where it is the caller’s own mistake', async () => {
    const res = await request(appThatThrows(new AppError('User not found', 404)))
      .get('/boom')
      .expect(404);
    expect(res.body).toMatchObject({ error: 'User not found', message: 'User not found' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('correlates the response to the log by request id', async () => {
    const res = await request(appThatThrows(new Error('x')))
      .get('/boom')
      .set('X-Request-Id', 'trace-me-42');
    // The pairing that makes a stackless 500 debuggable: the client can quote an
    // id, and the full stack is in the log under that same id.
    expect(res.body.requestId).toBe('trace-me-42');
    expect(res.headers['x-request-id']).toBe('trace-me-42');
  });
});

describe('the real app wires the handler in', () => {
  it('turns malformed JSON into a sanitised 400 that still carries a request id', async () => {
    const res = await request(realApp)
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    // express.json() throws a SyntaxError here. Without a global handler it became a
    // 500 with a body-parser stack trace attached.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);

    // Finding F-31, both halves. The parser's own message must not reach the client
    // — it can quote a fragment of the offending body — and the response must carry
    // a request id even though the failure happened inside the body parser, before
    // most of the middleware stack ran.
    expect(res.body.error).toBe('Malformed JSON in request body');
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('rejects an oversized body with 413, not a truncated read', async () => {
    const res = await request(realApp)
      .post('/api/auth/sign-in')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(200_000) }));

    expect(res.status).toBe(413);
    expect(res.body.requestId).toEqual(expect.any(String));
  });
});
