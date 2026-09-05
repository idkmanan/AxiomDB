// ---------------------------------------------------------------------------
// Rate limiter.
//
// This file is the replacement for tests/bench-guard.test.js, which was deleted
// along with the Phase 0 measurement flag it guarded. It covers the four defects
// the Arcjet middleware had, so that none of them can return silently:
//
//   429 with Retry-After, not 403 with nothing            (F-08)
//   keyed by authenticated user, not permanently 'guest'  (mount order)
//   an explicit, logged failure policy per route          (F-07, ADR 0002)
//   a bounded store that cannot be grown without limit
//
// The failure-policy tests inject a store whose `hit` rejects. That is the only
// way to actually exercise the branch — the in-process store cannot fail — and it
// is the difference between asserting the behaviour and asserting a comment
// describing it. Arcjet's fail-open path looked correct in source too.
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { MemorySlidingWindowStore } from '#rate-limit/sliding-window.js';
import { POLICIES, ROLE_LIMITS } from '#rate-limit/policy.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';

/** App with a fresh store per test, so ordering cannot leak between cases. */
function appWith(policyName, { store, user } = {}) {
  const app = express();
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.get('/probe', rateLimit(policyName, { store }), (req, res) => res.json({ ok: true }));
  return app;
}

describe('MemorySlidingWindowStore', () => {
  it('allows up to the limit and rejects beyond it', async () => {
    const store = new MemorySlidingWindowStore();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.hit('k', 3, 1000));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('slides: a request leaving the window frees exactly one slot', async () => {
    let now = 1_000_000;
    const store = new MemorySlidingWindowStore({ now: () => now });

    await store.hit('k', 2, 1000); // t=0
    now += 400;
    await store.hit('k', 2, 1000); // t=400
    now += 100;
    expect((await store.hit('k', 2, 1000)).allowed).toBe(false); // t=500, both inside

    // Advance past the first hit only. A FIXED window would have reset the whole
    // counter here and allowed two more; a sliding window frees one slot.
    now += 600; // t=1100, first hit (t=0) is now outside a 1000ms window
    expect((await store.hit('k', 2, 1000)).allowed).toBe(true);
    expect((await store.hit('k', 2, 1000)).allowed).toBe(false);
  });

  it('does not extend the penalty when a rejected client keeps retrying', async () => {
    let now = 0;
    const store = new MemorySlidingWindowStore({ now: () => now });
    await store.hit('k', 1, 1000);

    now = 500;
    const first = await store.hit('k', 1, 1000);
    now = 900;
    const later = await store.hit('k', 1, 1000);

    // Both rejections point at the same reset moment (t=1000). If rejected
    // requests were recorded, each retry would push the window forward and the
    // client could never escape — a rate limit that becomes a permanent ban.
    expect(first.allowed).toBe(false);
    expect(later.allowed).toBe(false);
    expect(now + later.resetMs).toBe(1000);
  });

  it('keeps at most `limit` timestamps per key', async () => {
    const store = new MemorySlidingWindowStore();
    for (let i = 0; i < 50; i++) await store.hit('k', 5, 60_000);
    expect(store.windows.get('k').length).toBe(5);
  });

  it('sweeps idle keys so the map cannot grow without bound', async () => {
    let now = 0;
    const store = new MemorySlidingWindowStore({ now: () => now });
    for (let i = 0; i < 100; i++) await store.hit(`ip-${i}`, 5, 1000);
    expect(store.size).toBe(100);

    now = 10_000;
    await store.hit('still-active', 5, 1000);
    expect(store.sweep(5000)).toBe(100);
    expect(store.size).toBe(1);
  });

  it('unrefs its sweep timer so it cannot block shutdown', () => {
    const store = new MemorySlidingWindowStore({ sweepIntervalMs: 50 });
    store.startSweeping(1000);
    // hasRef() false means the timer will not keep the event loop alive. Without
    // this, SIGTERM would never terminate the process and jest would hang.
    expect(store.timer.hasRef()).toBe(false);
    store.close();
    expect(store.timer).toBeNull();
  });
});

describe('rate limit middleware — response contract', () => {
  it('answers 429 with Retry-After and RateLimit-* headers', async () => {
    const store = new MemorySlidingWindowStore();
    const app = appWith('auth', { store });
    const max = POLICIES.auth.max;

    for (let i = 0; i < max; i++) {
      const ok = await request(app).get('/probe').expect(200);
      expect(ok.headers['ratelimit-limit']).toBe(String(max));
      expect(Number(ok.headers['ratelimit-remaining'])).toBe(max - i - 1);
    }

    const rejected = await request(app).get('/probe');

    // 429, not v0's 403. 403 means "you may never do this"; only 429 carries a
    // retry contract, and a client cannot distinguish v0's 403 from a genuine
    // authorization failure.
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toBe('Too Many Requests');
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
    expect(rejected.headers['ratelimit-remaining']).toBe('0');
  });

  it('never returns 403 for a rate-limit rejection', async () => {
    const store = new MemorySlidingWindowStore();
    const app = appWith('auth', { store });
    const statuses = [];
    for (let i = 0; i < POLICIES.auth.max + 5; i++) {
      statuses.push((await request(app).get('/probe')).status);
    }
    expect(statuses).not.toContain(403);
  });
});

describe('rate limit middleware — who gets counted', () => {
  it('gives each authenticated user their own budget', async () => {
    const store = new MemorySlidingWindowStore();
    const alice = appWith('authenticated', { store, user: { id: 1, role: 'user' } });
    const bob = appWith('authenticated', { store, user: { id: 2, role: 'user' } });

    for (let i = 0; i < ROLE_LIMITS.user; i++) await request(alice).get('/probe').expect(200);
    await request(alice).get('/probe').expect(429);

    // Bob shares Alice's source IP. In v0 an IP key meant one office behind a NAT
    // shared a single bucket; keying on user id is what makes a per-user limit
    // mean anything.
    await request(bob).get('/probe').expect(200);
  });

  it('applies the role ceiling, which v0 never did', async () => {
    // v0 mounted the limiter before `authenticate`, so `req.user` was undefined and
    // its role switch always chose the guest branch: admins silently received the
    // 5/min guest limit. This asserts the two roles actually differ.
    const store = new MemorySlidingWindowStore();
    const asUser = appWith('authenticated', { store, user: { id: 10, role: 'user' } });
    const asAdmin = appWith('authenticated', { store, user: { id: 11, role: 'admin' } });

    expect(ROLE_LIMITS.admin).toBeGreaterThan(ROLE_LIMITS.user);

    const u = await request(asUser).get('/probe');
    const a = await request(asAdmin).get('/probe');
    expect(u.headers['ratelimit-limit']).toBe(String(ROLE_LIMITS.user));
    expect(a.headers['ratelimit-limit']).toBe(String(ROLE_LIMITS.admin));
  });

  it('falls back to the user ceiling for an unknown role', async () => {
    const store = new MemorySlidingWindowStore();
    const app = appWith('authenticated', { store, user: { id: 12, role: 'auditor' } });
    const res = await request(app).get('/probe');
    // A role added to the schema later must not inherit an unlimited bucket.
    expect(res.headers['ratelimit-limit']).toBe(String(ROLE_LIMITS.user));
  });
});

describe('rate limit middleware — failure policy (ADR 0002)', () => {
  const brokenStore = {
    hit: () => Promise.reject(new Error('store unreachable')),
  };

  it('fails CLOSED on credential endpoints', async () => {
    const app = appWith('auth', { store: brokenStore });
    const res = await request(app).get('/probe');

    // A brute-force window is worse than a 503. And unlike Arcjet, the decision is
    // visible to the caller and carries a retry hint.
    expect(POLICIES.auth.onStoreFailure).toBe('closed');
    expect(res.status).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('fails OPEN on authenticated reads', async () => {
    const app = appWith('authenticated', { store: brokenStore, user: { id: 1, role: 'user' } });
    const res = await request(app).get('/probe');

    // Availability wins where the downside is an unmetered read. The difference
    // from v0 is not the direction — Arcjet also failed open — it is that this is
    // chosen per route and logged at error level rather than being an accident of
    // which predicate someone happened to check.
    expect(POLICIES.authenticated.onStoreFailure).toBe('open');
    expect(res.status).toBe(200);
  });
});
