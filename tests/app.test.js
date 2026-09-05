// ---------------------------------------------------------------------------
// Routes that need no database.
//
// v0's entire test suite was three of these cases and nothing else. They are kept
// because they are still the right smoke tests, and extended with the two things
// Phase 1 added at this layer: the probe split (/health is liveness, /ready is
// readiness) and a request id on every response.
// ---------------------------------------------------------------------------
import request from 'supertest';
import { jest } from '@jest/globals';
import app from '#src/app.js';

describe('liveness and metadata endpoints', () => {
  it('GET /health reports liveness without touching a dependency', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body).toHaveProperty('status', 'OK');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('uptime');
  });

  it('GET /health is not rate limited', async () => {
    // Deliberate, and a direct response to finding F-16: v0 mounted its security
    // middleware app-wide, so a liveness probe paid a full bot-detection and
    // rate-limit check — 404.69 ms p95 on an endpoint that does no I/O. A limiter
    // in front of a health check also means a saturated service begins failing its
    // probes and gets restarted, which turns load into an outage.
    const statuses = [];
    let sawLimitHeader = false;
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get('/health');
      statuses.push(res.status);
      if (res.headers['ratelimit-limit'] !== undefined) sawLimitHeader = true;
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(sawLimitHeader).toBe(false);
  });

  it('GET /api returns the service banner', async () => {
    const response = await request(app).get('/api').expect(200);
    expect(response.body).toHaveProperty('message', 'Acquisitions API is running!');
  });

  it('an unknown route returns 404 with a request id and no stack trace', async () => {
    const response = await request(app).get('/nonexistent').expect(404);

    expect(response.body).toHaveProperty('error', 'Route not found');
    expect(response.body).toHaveProperty('requestId');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.js:\d+/);
  });

  it('echoes a well-formed inbound X-Request-Id and replaces a malformed one', async () => {
    const good = await request(app).get('/api').set('X-Request-Id', 'abc-123_XYZ.9');
    expect(good.headers['x-request-id']).toBe('abc-123_XYZ.9');

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // An inbound id is echoed into every log line for the request, so it is
    // untrusted input on two axes: length (unbounded values inflate every record)
    // and charset (separators and control characters confuse log parsers and
    // invite forged entries). Both are replaced rather than sanitised.
    //
    // Note what is NOT tested here: a literal newline. Node's HTTP client refuses
    // to transmit one (ERR_INVALID_CHAR), so the classic header-injection payload
    // cannot reach the server through a compliant client at all. Asserting on it
    // would be testing Node, and would fail for the wrong reason.
    const tooLong = await request(app).get('/api').set('X-Request-Id', 'a'.repeat(200));
    expect(tooLong.headers['x-request-id']).toMatch(uuid);

    const badCharset = await request(app).get('/api').set('X-Request-Id', 'id with spaces; k=v');
    expect(badCharset.headers['x-request-id']).toMatch(uuid);
  });
});

describe('CORS is driven by CORS_ORIGIN (F-29)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function appWithCors(value) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    if (value === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = value;
    const mod = await import(`#src/app.js?bust=${Math.random()}`);
    return mod.default;
  }

  it('reflects a configured origin and allows credentials', async () => {
    // v0 called cors() with no options while documenting CORS_ORIGIN in three env
    // templates, so the effective policy was `*` and the variable was read by
    // nothing. This asserts the variable now reaches the response.
    const configured = await appWithCors('https://app.example.test');
    const res = await request(configured).get('/api').set('Origin', 'https://app.example.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an origin that is not on the list', async () => {
    const configured = await appWithCors('https://app.example.test');
    const res = await request(configured).get('/api').set('Origin', 'https://evil.example.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('falls back to a wildcard only when CORS_ORIGIN is unset', async () => {
    const open = await appWithCors(undefined);
    const res = await request(open).get('/api').set('Origin', 'https://anything.example.test');
    // The library default. Kept as the fallback rather than made a hard failure so a
    // fresh clone runs, and warned about at startup when NODE_ENV=production.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // A wildcard must never be paired with credentials — browsers reject the
    // combination, so sending it would be a policy that silently does not apply.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
