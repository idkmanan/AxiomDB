// ---------------------------------------------------------------------------
// The Redis sliding-window store.
//
// This is the whole Phase 4 rate-limiting change: `MemorySlidingWindowStore` becomes
// `RedisSlidingWindowStore` and NOTHING ELSE MOVES. The middleware, the policies, the
// headers and the fail-open/fail-closed decision are untouched, because Phase 1 defined the
// contract as `hit(key, limit, windowMs) -> LimitDecision` and made it async even though the
// in-process version had no need to be. That was the point of doing it in that order.
//
// WHY LUA AND NOT MULTI/EXEC. The algorithm is read-decide-write:
//
//   ZREMRANGEBYSCORE  drop hits that have left the window
//   ZCARD             count what is left
//   → if count >= limit, REJECT and do not record
//   ZADD              record this hit
//   PEXPIRE           let the key expire on its own
//
// The decision depends on the count, so the count must be read and acted on without another
// client interleaving. MULTI/EXEC is atomic but cannot branch: it pipelines commands and
// returns all the replies at the end, so a MULTI version has to ZADD unconditionally and
// then remove the entry if it turns out to be over the limit. That is not equivalent — it
// briefly counts a rejected request, and under sustained rejection it keeps extending the
// window, turning a rate limit into an escalating ban. The in-process store documents the
// same decision at src/rate-limit/sliding-window.js:93.
//
// Lua runs on the server, atomically, and can branch. One round trip, one decision.
//
// WHY THE CLOCK COMES FROM REDIS. `redis.call('TIME')` rather than a timestamp from the
// application, and this is the correctness fix that only shows up with more than one
// replica: three app pods each have their own clock, and NTP skew of even 50 ms means they
// disagree about where the window starts. Worse, an app clock that jumps backwards lets a
// caller reset their own window. Redis is the single serialization point for the counter, so
// it is also the right clock for it. (Since Redis 5, effect replication is the default, so
// using TIME in a script is replication-safe.)
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import { redisKey } from '#redis/client.js';

/**
 * KEYS[1] = the window key
 * ARGV[1] = window length in ms
 * ARGV[2] = limit
 * ARGV[3] = a unique member for this request
 *
 * Returns { allowed, count, oldestScore, now }.
 */
export const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local member = ARGV[3]

-- Redis' own clock, in milliseconds. TIME returns { seconds, microseconds }.
local t   = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

-- Everything older than the window is irrelevant, so it is deleted rather than counted.
-- This is also what bounds the memory a key can hold: at most 'limit' members survive.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count >= limit then
  -- Rejected, and NOT recorded. The oldest surviving hit is what determines when a slot
  -- frees up, which is what Retry-After has to be derived from.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return { 0, count, oldest[2] or tostring(now), tostring(now) }
end

redis.call('ZADD', key, now, member)

-- PEXPIRE on every hit, not only on creation: the key must outlive the newest hit by one
-- window, and refreshing it is how an idle key disappears instead of accumulating forever.
-- Without this, every key ever created is retained — the same unbounded-growth defect the
-- in-process store needed a sweeper for, except in someone else's memory.
redis.call('PEXPIRE', key, window)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return { 1, count + 1, oldest[2] or tostring(now), tostring(now) }
`;

/**
 * Same contract as `MemorySlidingWindowStore`: `hit`, `reset`, `clear`, `close`, `size`.
 *
 * @param {object} opts
 * @param {import('ioredis').Redis} opts.client injected, never constructed here — see the
 *        note on dynamic imports in src/redis/client.js
 */
export class RedisSlidingWindowStore {
  constructor({ client, namespace = 'rl' } = {}) {
    if (!client) throw new Error('RedisSlidingWindowStore requires a client');
    this.client = client;
    this.namespace = namespace;

    // `defineCommand` registers the script once and calls it with EVALSHA, falling back to
    // EVAL automatically when Redis answers NOSCRIPT — which happens after a Redis restart or
    // a SCRIPT FLUSH. Hand-rolling EVALSHA without that fallback is a limiter that works
    // until the cache is cleared and then fails every request; letting the driver own it is
    // the one case here where the dependency earns its place.
    if (typeof client.defineCommand === 'function' && !client.slidingWindowHit) {
      client.defineCommand('slidingWindowHit', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
    }
  }

  /** The key actually stored, namespaced so a shared Redis cannot collide. */
  keyFor(key) {
    return redisKey(this.namespace, key);
  }

  /**
   * @param {string} key
   * @param {number} limit
   * @param {number} windowMs
   * @returns {Promise<import('#rate-limit/sliding-window.js').LimitDecision>}
   */
  async hit(key, limit, windowMs) {
    // A unique member per request. Using the timestamp as the member — the obvious choice —
    // is a real bug: ZADD with an existing member UPDATES its score instead of adding a
    // second entry, so two requests landing in the same millisecond count once. It
    // undercounts precisely under the load where the limit matters, and it is invisible at
    // low rates.
    const member = `${Date.now()}-${randomBytes(8).toString('hex')}`;

    const [allowed, count, oldestScore, nowScore] = await this.client.slidingWindowHit(
      this.keyFor(key),
      String(windowMs),
      String(limit),
      member
    );

    const now = Number(nowScore);
    const oldest = Number(oldestScore);
    const resetMs = Math.max(0, oldest + windowMs - now);

    return {
      allowed: allowed === 1,
      limit,
      remaining: Math.max(0, limit - Number(count)),
      resetMs,
      count: Number(count),
    };
  }

  async reset(key) {
    await this.client.del(this.keyFor(key));
  }

  /**
   * Delete every window key.
   *
   * SCAN, not KEYS: KEYS is O(N) over the entire keyspace and blocks the server for the
   * duration, which on a shared Redis is an outage caused by a test helper. SCAN is
   * incremental and cursor-based. Only ever called from tests and the proof scripts — nothing
   * on a request path needs it.
   */
  async clear() {
    const match = `${this.keyFor('')}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Not implemented, on purpose.
   *
   * The in-process store can report `windows.size` for free. Counting Redis keys means a full
   * SCAN of the keyspace, and putting one behind a metrics scrape would mean paying O(keys)
   * every 15 seconds to populate a gauge nobody alerts on. `rate_limit_keys_tracked` therefore
   * reports 0 with the Redis store, which is a known gap rather than a wrong number — the
   * useful signals (`rate_limit_rejected_total`, Redis' own `db0.keys`) are elsewhere.
   */
  get size() {
    return undefined;
  }

  /** Nothing to release: the connection is owned by src/redis/client.js and closed there. */
  close() {}
}

export default RedisSlidingWindowStore;
