// ---------------------------------------------------------------------------
// Sliding-window rate limiter — algorithm and in-process store.
//
// WHY THIS SHAPE
//
// Phase 4 replaces the store with Redis so the limit is shared across replicas.
// The point of this file is that Phase 4 changes only the store, not the
// middleware: `hit()` is already async and already returns everything the
// response headers need, so swapping a Map for a Redis client is a drop-in.
// An interface that is synchronous today would have to be rewritten later, and
// "I had to rewrite the caller" is the usual reason a supposedly swappable
// component is not.
//
// ALGORITHM: sliding window log, not fixed window.
//
// A fixed window (one counter per minute bucket) permits a burst of 2x the limit
// across a boundary: `max` requests at 11:59:59 and `max` more at 12:00:00. A
// sliding window log keeps the timestamps of the requests still inside the
// window, so the limit holds over every possible window position.
//
// The cost is memory: one timestamp per request in flight, per key. That is
// bounded here by discarding timestamps that no longer matter (see `hit`), so a
// key never holds more than `limit` entries. This maps 1:1 onto a Redis sorted
// set — ZREMRANGEBYSCORE to expire, ZADD to record, ZCARD to count — which is
// precisely the Lua script Phase 4 needs, and is the reason for choosing this
// algorithm now rather than something that would have to be rethought.
//
// WHAT THIS IS NOT
//
// It is not distributed. Three replicas each hold their own Map, so the
// effective limit is 3x the configured one. That is a correctness defect and it
// is deliberately left in place: Phase 4 measures it across 3 replicas, fixes
// it, and measures again. Recorded here rather than in a commit message so the
// limitation cannot be mistaken for an oversight.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LimitDecision
 * @property {boolean} allowed      false when the request should be rejected
 * @property {number}  limit        configured ceiling for this key
 * @property {number}  remaining    requests left in the current window
 * @property {number}  resetMs      ms until the window frees a slot
 * @property {number}  count        requests recorded in the window, incl. this one
 */

/**
 * In-process sliding-window store.
 *
 * Deliberately holds no Express or logger dependency so it can be unit-tested
 * and so the Redis implementation in Phase 4 has an obvious contract to satisfy.
 */
export class MemorySlidingWindowStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sweepIntervalMs] how often to evict idle keys
   * @param {() => number} [opts.now] injectable clock, for tests
   */
  constructor({ sweepIntervalMs = 60_000, now = Date.now } = {}) {
    /** @type {Map<string, number[]>} key -> ascending hit timestamps (ms) */
    this.windows = new Map();
    this.now = now;
    this.sweepIntervalMs = sweepIntervalMs;
    this.timer = null;
  }

  /**
   * Record a hit and decide. Async by contract, not by need — see the header.
   *
   * @param {string} key
   * @param {number} limit     max requests per window
   * @param {number} windowMs  window length
   * @returns {Promise<LimitDecision>}
   */
  async hit(key, limit, windowMs) {
    const nowMs = this.now();
    const cutoff = nowMs - windowMs;

    let hits = this.windows.get(key);
    if (hits === undefined) {
      hits = [];
      this.windows.set(key, hits);
    }

    // Drop timestamps that have fallen out of the window. Timestamps are pushed
    // in ascending order, so everything expired is a prefix — one splice, not a
    // filter, so this stays O(expired) instead of O(window).
    let expired = 0;
    while (expired < hits.length && hits[expired] <= cutoff) expired++;
    if (expired > 0) hits.splice(0, expired);

    const countBefore = hits.length;

    if (countBefore >= limit) {
      // Over the limit. Do NOT record the rejected request: counting rejections
      // would extend the penalty every time a client retried, which turns a
      // rate limit into an escalating ban. The oldest surviving timestamp is
      // what determines when a slot frees up.
      const resetMs = Math.max(0, hits[0] + windowMs - nowMs);
      return { allowed: false, limit, remaining: 0, resetMs, count: countBefore };
    }

    hits.push(nowMs);
    return {
      allowed: true,
      limit,
      remaining: limit - hits.length,
      // With room to spare the window resets when the oldest hit ages out.
      resetMs: Math.max(0, hits[0] + windowMs - nowMs),
      count: hits.length,
    };
  }

  /** Forget one key. Used by tests and by an admin reset path later. */
  async reset(key) {
    this.windows.delete(key);
  }

  /** Forget everything. */
  async clear() {
    this.windows.clear();
  }

  /**
   * Evict keys whose newest hit is older than `maxIdleMs`.
   *
   * Without this the Map is an unbounded memory leak keyed by client IP, which
   * is a denial-of-service vector against the limiter itself: an attacker
   * rotating source addresses grows the Map without ever being rate limited.
   */
  sweep(maxIdleMs) {
    const cutoff = this.now() - maxIdleMs;
    let removed = 0;
    for (const [key, hits] of this.windows) {
      if (hits.length === 0 || hits[hits.length - 1] <= cutoff) {
        this.windows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Start periodic sweeping.
   *
   * `unref()` matters: without it this interval keeps the event loop alive, so
   * `node src/index.js` would never exit after SIGTERM and jest would hang
   * reporting an open handle. A background timer that blocks graceful shutdown
   * is the classic version of this bug.
   */
  startSweeping(maxIdleMs) {
    if (this.timer) return this;
    this.timer = setInterval(() => this.sweep(maxIdleMs), this.sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /** Stop sweeping. Called from the shutdown sequence. */
  close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of tracked keys — exposed for the metrics work in Phase 6. */
  get size() {
    return this.windows.size;
  }
}

export default MemorySlidingWindowStore;
