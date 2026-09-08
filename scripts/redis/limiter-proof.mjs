#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PROOF: the in-process limiter is wrong across replicas, and the Redis one is not.
//
//   docker compose -f docker-compose.bench.yml up -d redis     # or any local Redis
//   REDIS_URL=redis://localhost:6379 node scripts/redis/limiter-proof.mjs
//
// WHY THIS SCRIPT EXISTS. Phase 1 shipped an in-process sliding-window limiter and recorded, in
// src/rate-limit/sliding-window.js, that it "is not distributed. Three replicas each hold their
// own Map, so the effective limit is 3x the configured one." That is a claim. This turns it into
// a measurement, and then shows the same test passing with the store swapped — which is the
// Phase 4 deliverable: rate limiting proven correct across replicas, the claim Arcjet could
// never support.
//
// WHAT IT ACTUALLY RUNS. Three Express apps on three ports, each with the same limiter
// middleware the API uses, behind a round-robin client. Deliberately NOT the full application:
// no database, no auth, no k6. The claim is about the limiter, so the limiter is what is
// isolated — anything else in the request path would only add noise to a count of 200s and 429s.
//
// It also runs the REAL Lua script against REAL Redis, which is the half the offline unit tests
// cannot reach (see the header of tests/helpers/fake-redis.js).
// ---------------------------------------------------------------------------
import express from 'express';
import { MemorySlidingWindowStore } from '#rate-limit/sliding-window.js';
import { RedisSlidingWindowStore } from '#rate-limit/redis-store.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';

const REPLICAS = Number(process.env.REPLICAS || 3);
const LIMIT = Number(process.env.RATE_LIMIT_USER_MAX || 100);
const REQUESTS = Number(process.env.PROOF_REQUESTS || LIMIT * REPLICAS + 20);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const say = (line) => process.stdout.write(`${line}\n`);

/** One replica: the real limiter middleware, a stand-in user, and nothing else. */
function startReplica(store) {
  const app = express();
  app.use((req, res, next) => {
    // A fixed identity, because the point is that all three replicas are counting the SAME
    // caller. Keying on IP would work too and would be less obviously deliberate.
    req.user = { id: 1, role: 'user' };
    next();
  });
  app.get('/probe', rateLimit('authenticated', { store }), (req, res) => res.json({ ok: true }));

  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Fire `REQUESTS` requests round-robin across the replicas, sequentially.
 *
 * Sequential on purpose: a limiter's correctness is about the total count inside the window, and
 * concurrent firing would add scheduling noise to a number that is supposed to be exact. The
 * window is 60s by default, so every request in this run falls inside one window.
 */
async function drive(ports) {
  let allowed = 0;
  let rejected = 0;
  let other = 0;

  for (let i = 0; i < REQUESTS; i++) {
    const port = ports[i % ports.length];
    const res = await fetch(`http://127.0.0.1:${port}/probe`);
    if (res.status === 200) allowed += 1;
    else if (res.status === 429) rejected += 1;
    else other += 1;
    await res.arrayBuffer();
  }

  return { allowed, rejected, other };
}

/**
 * Run one scenario: `REPLICAS` replicas, each with its OWN store object.
 *
 * Constructing a store per replica is the faithful part. Three pods each run `new Store(...)`;
 * whether they then share state is precisely what distinguishes the two scenarios, and it is
 * decided by the store, not by the harness.
 */
async function scenario(name, makeStoreForReplica) {
  const stores = Array.from({ length: REPLICAS }, (_, i) => makeStoreForReplica(i));
  const replicas = await Promise.all(stores.map((store) => startReplica(store)));
  const ports = replicas.map((r) => r.port);

  say(`\n── ${name}`);
  say(
    `   ${REPLICAS} replicas on ports ${ports.join(', ')}, limit ${LIMIT}/window, ${REQUESTS} requests`
  );

  const result = await drive(ports);
  say(
    `   allowed ${result.allowed}, rejected ${result.rejected}${result.other ? `, other ${result.other}` : ''}`
  );

  await Promise.all(replicas.map((r) => new Promise((done) => r.server.close(done))));
  for (const store of stores) store.close?.();
  return result;
}

async function main() {
  say(`limiter proof — limit ${LIMIT}, ${REPLICAS} replicas, ${REQUESTS} requests`);

  // ---- 1. In-process: one Map per replica, which is what three pods actually have.
  const memory = await scenario(
    'in-process store (one Map per replica)',
    () => new MemorySlidingWindowStore()
  );

  // ---- 2. Redis: three store objects, one shared window, the real Lua script.
  const { default: Redis } = await import('ioredis');
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  await new RedisSlidingWindowStore({ client }).clear();

  const redis = await scenario(
    'Redis store (three replicas, one window)',
    () => new RedisSlidingWindowStore({ client })
  );

  await new RedisSlidingWindowStore({ client }).clear();
  await client.quit();

  // ---- Verdict
  const expectedMemory = LIMIT * REPLICAS;
  const memoryWrong = memory.allowed > LIMIT;
  const redisCorrect = redis.allowed === LIMIT;

  say('\n── verdict');
  say(`   in-process: ${memory.allowed} allowed against a configured limit of ${LIMIT}`);
  say(
    `               → ${(memory.allowed / LIMIT).toFixed(1)}x the limit (expected ~${expectedMemory} with ${REPLICAS} replicas)`
  );
  say(`   redis:      ${redis.allowed} allowed against a configured limit of ${LIMIT}`);
  say(`               → ${redisCorrect ? 'exact' : 'NOT exact — investigate'}`);

  if (!memoryWrong || !redisCorrect) {
    say(
      '\nFAILED: the demonstration did not reproduce. Check that REQUESTS exceeds LIMIT*REPLICAS'
    );
    say('and that the window (RATE_LIMIT_WINDOW_MS) is longer than this run takes.');
    process.exit(1);
  }

  say('\nBoth halves reproduced: the in-process limiter over-admits by a factor of the replica');
  say('count, and the Redis-backed one admits exactly the configured limit.');
}

main().catch((e) => {
  process.stderr.write(`[limiter-proof] FAILED: ${e.message}\n`);
  process.exit(1);
});
