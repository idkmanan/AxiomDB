// ---------------------------------------------------------------------------
// The Redis sliding-window store.
//
// These tests exercise the store against the transcription of its Lua script (see
// tests/helpers/fake-redis.js for why that distinction matters, and where the real script is
// verified). What they pin down is the behaviour the middleware depends on and the two bugs
// that are easy to write here:
//
//   * a rejected request must NOT be recorded, or a client that keeps retrying extends its own
//     penalty and a rate limit becomes an escalating ban
//   * the sorted-set member must be unique per request, or two hits in the same millisecond
//     collapse into one — undercounting precisely under the load where the limit matters
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { RedisSlidingWindowStore } from '#rate-limit/redis-store.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';
import { FakeRedis } from './helpers/fake-redis.js';

/** A store over a fake Redis with a controllable clock. */
function storeWith(startAt = 1_000_000) {
  let now = startAt;
  const client = new FakeRedis({ now: () => now });
  const store = new RedisSlidingWindowStore({ client });
  return { store, client, advance: (ms) => (now += ms), at: () => now };
}

describe('window accounting', () => {
  it('allows up to the limit and then rejects', async () => {
    const { store } = storeWith();
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await store.hit('k', 3, 1000));

    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false]);
    expect(outcomes.map((o) => o.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('does not record a rejected request', async () => {
    const { store, client } = storeWith();
    for (let i = 0; i < 3; i++) await store.hit('k', 3, 1000);

    const before = await client.zcard(store.keyFor('k'));
    for (let i = 0; i < 10; i++) await store.hit('k', 3, 1000);
    const after = await client.zcard(store.keyFor('k'));

    // Ten rejected retries must leave the window exactly as they found it. Counting them would
    // push the reset further out every time the client tried again.
    expect(before).toBe(3);
    expect(after).toBe(3);
  });

  it('counts two hits in the same millisecond as two', async () => {
    // THE MEMBER-UNIQUENESS BUG. `ZADD key <score> <member>` with an existing member updates its
    // score instead of adding an entry, so using the timestamp as the member silently merges
    // simultaneous requests. The clock does not move in this test, which is exactly the case
    // that would break.
    const { store } = storeWith();
    const a = await store.hit('k', 5, 1000);
    const b = await store.hit('k', 5, 1000);

    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
  });

  it('slides: a hit that leaves the window frees a slot', async () => {
    const { store, advance } = storeWith();
    await store.hit('k', 2, 1000);
    advance(400);
    await store.hit('k', 2, 1000);

    advance(100); // t=500, both hits still inside the 1000ms window
    expect((await store.hit('k', 2, 1000)).allowed).toBe(false);

    advance(600); // t=1100, the first hit has aged out
    expect((await store.hit('k', 2, 1000)).allowed).toBe(true);
  });

  it('derives resetMs from the oldest surviving hit', async () => {
    const { store, advance } = storeWith();
    await store.hit('k', 1, 1000);
    advance(250);

    const rejected = await store.hit('k', 1, 1000);
    expect(rejected.allowed).toBe(false);
    // 1000ms window, 250ms elapsed since the only hit — a slot frees in 750ms, and that is what
    // Retry-After has to say. A fixed value here would tell every client to retry at once.
    expect(rejected.resetMs).toBe(750);
  });

  it('keeps keys independent and namespaced', async () => {
    const { store, client } = storeWith();
    await store.hit('api:u:1', 1, 1000);
    expect((await store.hit('api:u:2', 1, 1000)).allowed).toBe(true);

    // The prefix is what stops a shared Redis from mixing this application's limiter with
    // anything else in the same database.
    expect([...client.data.keys()].every((k) => k.startsWith('acq:rl:'))).toBe(true);
  });

  it('expires an idle key instead of holding it forever', async () => {
    const { store, client, advance } = storeWith();
    await store.hit('k', 5, 1000);
    expect(await client.exists(store.keyFor('k'))).toBe(1);

    advance(1001);
    // PEXPIRE on every hit is what makes this true. Without it the key set grows with every
    // distinct client address — the same unbounded-growth defect the in-process store needed a
    // sweeper for, except in someone else's memory.
    expect(await client.exists(store.keyFor('k'))).toBe(0);
  });

  it('clears with SCAN rather than KEYS', async () => {
    const { store, client } = storeWith();
    await store.hit('a', 5, 1000);
    await store.hit('b', 5, 1000);

    await store.clear();

    expect(client.calls.some((c) => c.name === 'scan')).toBe(true);
    // KEYS is O(N) over the whole keyspace and blocks the server for the duration — on a shared
    // Redis that is an outage caused by a test helper.
    expect(client.calls.some((c) => c.name === 'keys')).toBe(false);
    expect(await client.zcard(store.keyFor('a'))).toBe(0);
  });

  it('reports no key count rather than paying for a SCAN per scrape', async () => {
    const { store } = storeWith();
    expect(store.size).toBeUndefined();
  });
});

describe('what happens when Redis is unreachable', () => {
  /** A one-route app, so the policy branch is observed through a real response. */
  function appWith(policyName, store) {
    const app = express();
    app.get('/probe', rateLimit(policyName, { store }), (req, res) => res.json({ ok: true }));
    return app;
  }

  it('fails CLOSED on the auth policy', async () => {
    const { store, client } = storeWith();
    client.failOnce('Connection is closed.');

    const res = await request(appWith('auth', store)).get('/probe').expect(503);

    // A brute-force window is worse than a 503 — ADR 0002. The Retry-After is what makes the
    // 503 usable rather than just a wall.
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.message).toMatch(/fails closed/);
  });

  it('fails OPEN on the authenticated policy', async () => {
    const { store, client } = storeWith();
    client.failOnce('Connection is closed.');

    // Availability wins where the downside is an unmetered read. The difference from Arcjet
    // (F-07) is not the direction of the failure — it is that this one is chosen per route, and
    // counted.
    await request(appWith('authenticated', store)).get('/probe').expect(200);
  });

  it('recovers on the next request', async () => {
    const { store, client } = storeWith();
    client.failOnce();

    const app = appWith('authenticated', store);
    await request(app).get('/probe').expect(200);
    const res = await request(app).get('/probe').expect(200);

    // The limiter is live again, so the headers come back. A store that stayed broken after one
    // error would turn a blip into an unlimited endpoint.
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('the drop-in claim', () => {
  it('implements the same surface as the in-process store', async () => {
    // Phase 1's promise was "Phase 4 replaces the store and nothing else changes". This is that
    // promise as an assertion: the middleware only ever calls `hit`, and the shutdown path calls
    // `close`.
    const { MemorySlidingWindowStore } = await import('#rate-limit/sliding-window.js');
    const memory = new MemorySlidingWindowStore();
    const { store: redis } = storeWith();

    for (const method of ['hit', 'reset', 'clear', 'close']) {
      expect(typeof memory[method]).toBe('function');
      expect(typeof redis[method]).toBe('function');
    }

    const a = await memory.hit('k', 2, 1000);
    const b = await redis.hit('k', 2, 1000);
    // Same decision shape, so the middleware cannot tell them apart.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());

    memory.close();
  });
});
