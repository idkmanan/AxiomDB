// ---------------------------------------------------------------------------
// Idempotency keys, and the distributed lock.
//
// The idempotency cases below are the ones a client actually hits: a retry after a lost
// response, two retries racing each other, and a key accidentally reused for a different
// request. The lock cases are about the one thing a lock implementation usually gets wrong —
// releasing somebody else's lock.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { FakeRedis } from './helpers/fake-redis.js';

/** Load the middleware with Redis "configured", and a fake client installed. */
async function loadIdempotency({ startAt = 1_000_000 } = {}) {
  process.env.REDIS_URL = 'redis://localhost:6379';
  jest.resetModules();

  let now = startAt;
  const client = new FakeRedis({ now: () => now });
  const { setRedisClient } = await import('#redis/client.js');
  setRedisClient(client);
  const { idempotency, idempotencyStats } = await import('#middleware/idempotency.middleware.js');

  return { idempotency, idempotencyStats, client, advance: (ms) => (now += ms) };
}

/**
 * An app whose handler counts its own executions, so "did the write happen twice" is answered
 * by the handler rather than inferred from a response.
 */
function appWith(middleware, { status = 201 } = {}) {
  const state = { runs: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: Number(req.get('X-Test-User') || 7) };
    next();
  });
  app.post('/api/deals', middleware, (req, res) => {
    state.runs += 1;
    res.status(status).json({ id: 100 + state.runs, title: req.body?.title, runs: state.runs });
  });
  return { app, state };
}

describe('idempotency', () => {
  it('is a no-op without the header', async () => {
    const { idempotency } = await loadIdempotency();
    const { app, state } = appWith(idempotency());

    await request(app).post('/api/deals').send({ title: 'A' }).expect(201);
    await request(app).post('/api/deals').send({ title: 'A' }).expect(201);

    // Optional by design: requiring the header would break every existing client, and a caller
    // that does not care about retry safety is allowed not to.
    expect(state.runs).toBe(2);
  });

  it('replays the stored response instead of writing twice', async () => {
    const { idempotency } = await loadIdempotency();
    const { app, state } = appWith(idempotency());
    const key = 'client-generated-key-1';

    const first = await request(app)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ title: 'A' })
      .expect(201);

    const second = await request(app)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ title: 'A' })
      .expect(201);

    // The handler ran once. This is the whole point: the client could not tell whether its
    // request or its response was lost, and only the server can.
    expect(state.runs).toBe(1);
    expect(second.body).toEqual(first.body);
    // The header is how a client tells a replay from a fresh execution.
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(first.headers['idempotent-replay']).toBeUndefined();
  });

  it('answers 409 while the first attempt is still running', async () => {
    const { idempotency, client } = await loadIdempotency();
    // Only the run counter is needed here; the app below is built by hand so the handler can be
    // held open.
    const state = { runs: 0 };
    const key = 'in-flight-key';

    // Two retries arriving together: the SET NX claim is what makes exactly one of them proceed.
    // GET-then-SET would let both through, which is F-41's mistake in a different store.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.use((req, res, next) => {
      req.user = { id: 7 };
      next();
    });
    slowApp.post('/api/deals', idempotency(), async (req, res) => {
      state.runs += 1;
      await gate;
      res.status(201).json({ ok: true });
    });

    // `.then()` rather than `await`: supertest only fires the request when it is subscribed to,
    // so a bare `const p = request(...)` would not have taken the claim yet and this test would
    // deadlock waiting for a gate the second request is holding.
    const inFlight = request(slowApp)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ a: 1 })
      .then((r) => r);
    // Give the first request time to take the claim.
    await new Promise((r) => setTimeout(r, 20));

    const racing = await request(slowApp)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ a: 1 })
      .expect(409);

    // Retry-After rather than blocking: holding the second request open ties up a connection,
    // and the client's own timeout is usually shorter than the wait.
    expect(racing.headers['retry-after']).toBe('1');
    release();
    await inFlight;
    expect(state.runs).toBe(1);
    expect(client.calls.filter((c) => c.name === 'set').length).toBeGreaterThan(0);
  });

  it('refuses a key reused with a different body', async () => {
    const { idempotency, idempotencyStats } = await loadIdempotency();
    const { app, state } = appWith(idempotency());
    const key = 'shared-key';

    await request(app)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ title: 'A' })
      .expect(201);

    const mismatch = await request(app)
      .post('/api/deals')
      .set('Idempotency-Key', key)
      .send({ title: 'B' })
      .expect(422);

    // Replaying the first response for a different request would hand the client the wrong
    // resource and look like success. 422 says "your key means one operation".
    expect(mismatch.body.message).toMatch(/different request body/);
    expect(state.runs).toBe(1);
    expect(idempotencyStats.mismatches).toBe(1);
  });

  it('does not cache a failure', async () => {
    const { idempotency } = await loadIdempotency();
    const { app, state } = appWith(idempotency(), { status: 500 });
    const key = 'failing-key';

    await request(app).post('/api/deals').set('Idempotency-Key', key).send({ a: 1 }).expect(500);
    await request(app).post('/api/deals').set('Idempotency-Key', key).send({ a: 1 }).expect(500);

    // A cached 500 would make a transient failure permanent for 24 hours. The claim is released
    // so the retry the client is entitled to actually runs.
    expect(state.runs).toBe(2);
  });

  it('scopes the key per user', async () => {
    const { idempotency } = await loadIdempotency();
    const { app, state } = appWith(idempotency());

    await request(app)
      .post('/api/deals')
      .set('X-Test-User', '7')
      .set('Idempotency-Key', 'same')
      .send({ a: 1 })
      .expect(201);
    await request(app)
      .post('/api/deals')
      .set('X-Test-User', '8')
      .set('Idempotency-Key', 'same')
      .send({ a: 1 })
      .expect(201);

    // A global namespace would let one caller replay another's response — the worst possible
    // outcome for a feature whose job is correctness.
    expect(state.runs).toBe(2);
  });

  it('rejects an absurdly long key', async () => {
    const { idempotency } = await loadIdempotency();
    const { app } = appWith(idempotency());
    await request(app)
      .post('/api/deals')
      .set('Idempotency-Key', 'x'.repeat(201))
      .send({ a: 1 })
      .expect(400);
  });

  it('fails open by default, and closed on request', async () => {
    const { idempotency, client, idempotencyStats } = await loadIdempotency();

    const open = appWith(idempotency());
    client.failOnce();
    // Refusing writes because the dedupe cache is down converts a Redis blip into a write
    // outage. For a pipeline record that is the right way round; for money it would not be.
    await request(open.app)
      .post('/api/deals')
      .set('Idempotency-Key', 'k')
      .send({ a: 1 })
      .expect(201);
    expect(open.state.runs).toBe(1);
    expect(idempotencyStats.failures).toBe(1);

    const closed = appWith(idempotency({ onStoreFailure: 'closed' }));
    client.failOnce();
    await request(closed.app)
      .post('/api/deals')
      .set('Idempotency-Key', 'k2')
      .send({ a: 1 })
      .expect(503);
    expect(closed.state.runs).toBe(0);
  });
});

describe('the distributed lock', () => {
  async function loadLock({ startAt = 1_000_000 } = {}) {
    process.env.REDIS_URL = 'redis://localhost:6379';
    jest.resetModules();
    let now = startAt;
    const client = new FakeRedis({ now: () => now });
    const lock = await import('#redis/lock.js');
    return { lock, client, advance: (ms) => (now += ms) };
  }

  it('is exclusive, and releasable', async () => {
    const { lock, client } = await loadLock();

    const first = await lock.acquireLock('publish', { client });
    expect(first).not.toBeNull();

    // `SET … NX` is what makes this atomic. A GET-then-SET would let both callers in.
    expect(await lock.acquireLock('publish', { client })).toBeNull();

    expect(await first.release()).toBe(true);
    expect(await lock.acquireLock('publish', { client })).not.toBeNull();
  });

  it('expires on its own, so a crashed holder cannot block forever', async () => {
    const { lock, client, advance } = await loadLock();
    await lock.acquireLock('publish', { ttlMs: 1000, client });

    advance(1001);
    expect(await lock.acquireLock('publish', { client })).not.toBeNull();
  });

  it('never releases a lock it no longer holds', async () => {
    const { lock, client, advance } = await loadLock();

    const stale = await lock.acquireLock('publish', { ttlMs: 1000, client });
    advance(1001); // the lock expires while the holder is paused — a GC pause, a suspended pod
    const fresh = await lock.acquireLock('publish', { ttlMs: 1000, client });

    // THE BUG THIS PREVENTS: a plain `DEL` here would delete the lock the *new* holder is
    // relying on, and both would then be inside the critical section. The compare-and-delete
    // makes release conditional on still being the owner.
    expect(await stale.release()).toBe(false);
    expect(await lock.acquireLock('publish', { client })).toBeNull();
    expect(await fresh.release()).toBe(true);
  });

  it('releases even when the critical section throws', async () => {
    const { lock, client } = await loadLock();

    await expect(
      lock.withLock(
        'publish',
        () => {
          throw new Error('boom');
        },
        { client }
      )
    ).rejects.toThrow('boom');

    // Without the `finally`, the lock would be held until its TTL and every subsequent caller
    // refused for no reason.
    expect(await lock.acquireLock('publish', { client })).not.toBeNull();
  });

  it('tells the caller when it did not get the lock rather than waiting', async () => {
    const { lock, client } = await loadLock();
    await lock.acquireLock('publish', { client });

    let ran = false;
    const result = await lock.withLock(
      'publish',
      () => {
        ran = true;
      },
      { client }
    );

    // No hidden retry loop: a caller that must wait should choose how long it waits.
    expect(result).toEqual({ acquired: false, result: undefined });
    expect(ran).toBe(false);
  });
});
