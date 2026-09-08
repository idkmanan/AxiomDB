// ---------------------------------------------------------------------------
// A small in-memory stand-in for ioredis.
//
// WHAT IT IS FOR, AND WHAT IT CANNOT DO — stated first, because a fake that is trusted too far
// is worse than no fake.
//
// The `ioredis` package cannot be installed in the sandbox this was written in, and the Lua
// scripts in src/ run inside Redis, not in Node. So this implements the COMMANDS (strings,
// hashes, sorted sets, TTLs, MULTI) faithfully, and for each `defineCommand` script it provides
// a JavaScript TRANSCRIPTION of the Lua kept deliberately line-for-line with the original.
//
// That means these tests verify the application's use of the store — argument order, reply
// mapping, branch handling, TTL arithmetic — and the SEMANTICS the scripts are supposed to have.
// They do not verify the Lua source itself. That gap is covered by scripts/redis/*.mjs, which
// run the real scripts against a real Redis and assert the same properties. Anywhere the
// transcription and the Lua could drift, the proof script is the authority.
//
// TTLs use an injectable clock, so window expiry and session caps can be tested without
// sleeping.
// ---------------------------------------------------------------------------

export class FakeRedis {
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, {type: string, value: any, expiresAt: number|null}>} */
    this.data = new Map();
    this.now = now;
    this.calls = [];
    this.scripts = new Map();
    this.failNext = null;
    /** Serialises script execution — see `defineCommand`. */
    this.scriptQueue = Promise.resolve();
  }

  // -- internals ------------------------------------------------------------

  /** Read with lazy expiry, which is how Redis behaves from a client's point of view. */
  entry(key) {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return e;
  }

  record(name, args) {
    this.calls.push({ name, args });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  /** Make the next command reject, so fail-open/fail-closed branches can be exercised. */
  failOnce(message = 'Connection is closed.') {
    this.failNext = new Error(message);
    return this;
  }

  // -- strings --------------------------------------------------------------

  async set(key, value, ...opts) {
    this.record('set', [key, value, ...opts]);
    const flags = opts.map((o) => (typeof o === 'string' ? o.toUpperCase() : o));
    const nx = flags.includes('NX');
    const pxIndex = flags.indexOf('PX');
    const ttl = pxIndex !== -1 ? Number(opts[pxIndex + 1]) : null;

    const existing = this.entry(key);
    if (nx && existing) return null;

    this.data.set(key, {
      type: 'string',
      value: String(value),
      expiresAt: ttl === null ? null : this.now() + ttl,
    });
    return 'OK';
  }

  async get(key) {
    this.record('get', [key]);
    const e = this.entry(key);
    return e && e.type === 'string' ? e.value : null;
  }

  async del(...keys) {
    this.record('del', keys);
    let n = 0;
    for (const k of keys.flat()) if (this.data.delete(k)) n += 1;
    return n;
  }

  async exists(...keys) {
    this.record('exists', keys);
    return keys.flat().filter((k) => this.entry(k) !== null).length;
  }

  async pttl(key) {
    this.record('pttl', [key]);
    const e = this.entry(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return e.expiresAt - this.now();
  }

  async pexpire(key, ms) {
    this.record('pexpire', [key, ms]);
    const e = this.entry(key);
    if (!e) return 0;
    e.expiresAt = this.now() + Number(ms);
    return 1;
  }

  // -- hashes ---------------------------------------------------------------

  async hset(key, fieldOrObject, value) {
    this.record('hset', [key, fieldOrObject, value]);
    let e = this.entry(key);
    if (!e) {
      e = { type: 'hash', value: new Map(), expiresAt: null };
      this.data.set(key, e);
    }
    const pairs =
      typeof fieldOrObject === 'object' ? Object.entries(fieldOrObject) : [[fieldOrObject, value]];
    for (const [f, v] of pairs) e.value.set(String(f), String(v));
    return pairs.length;
  }

  async hget(key, field) {
    this.record('hget', [key, field]);
    const e = this.entry(key);
    return e?.type === 'hash' ? (e.value.get(field) ?? null) : null;
  }

  async hgetall(key) {
    this.record('hgetall', [key]);
    const e = this.entry(key);
    if (!e || e.type !== 'hash') return {};
    return Object.fromEntries(e.value);
  }

  async hincrby(key, field, by) {
    this.record('hincrby', [key, field, by]);
    const e = this.entry(key);
    if (!e) return null;
    const next = Number(e.value.get(field) ?? 0) + Number(by);
    e.value.set(field, String(next));
    return next;
  }

  // -- sorted sets ----------------------------------------------------------

  zsetOf(key) {
    let e = this.entry(key);
    if (!e) {
      e = { type: 'zset', value: new Map(), expiresAt: null };
      this.data.set(key, e);
    }
    return e;
  }

  async zadd(key, score, member) {
    this.record('zadd', [key, score, member]);
    this.zsetOf(key).value.set(String(member), Number(score));
    return 1;
  }

  async zcard(key) {
    this.record('zcard', [key]);
    const e = this.entry(key);
    return e?.type === 'zset' ? e.value.size : 0;
  }

  async zremrangebyscore(key, min, max) {
    this.record('zremrangebyscore', [key, min, max]);
    const e = this.entry(key);
    if (!e || e.type !== 'zset') return 0;
    let removed = 0;
    for (const [member, score] of [...e.value]) {
      if (score >= Number(min) && score <= Number(max)) {
        e.value.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  /** Ascending by score, with scores, which is the only form the scripts use. */
  sortedMembers(key) {
    const e = this.entry(key);
    if (!e || e.type !== 'zset') return [];
    return [...e.value.entries()].sort((a, b) => a[1] - b[1]);
  }

  // -- misc -----------------------------------------------------------------

  async ping() {
    this.record('ping', []);
    return 'PONG';
  }

  async quit() {
    this.record('quit', []);
    return 'OK';
  }

  disconnect() {
    this.record('disconnect', []);
  }

  async scan(cursor, ...args) {
    this.record('scan', [cursor, ...args]);
    const matchIndex = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
    const pattern = matchIndex !== -1 ? String(args[matchIndex + 1]) : '*';
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
    );
    const keys = [...this.data.keys()].filter((k) => re.test(k) && this.entry(k) !== null);
    return ['0', keys];
  }

  /** MULTI/EXEC. Queued thunks, run in order — enough for the pipelines in src/. */
  multi() {
    const queued = [];
    const proxy = {};
    for (const name of ['set', 'del', 'hset', 'pexpire', 'get', 'exists']) {
      proxy[name] = (...args) => {
        queued.push(() => this[name](...args));
        return proxy;
      };
    }
    proxy.exec = async () => {
      const out = [];
      for (const thunk of queued) out.push([null, await thunk()]);
      return out;
    };
    return proxy;
  }

  /**
   * `defineCommand`, with a JavaScript transcription per script.
   *
   * The transcriptions live here rather than in src/ so there is exactly one copy of the Lua —
   * the one that runs in production. Each is a statement-by-statement mirror; where a Redis
   * behaviour matters (ZADD updating an existing member's score rather than adding a second
   * entry, PTTL returning -2 for a missing key) the mirror relies on this fake implementing it
   * the same way, which the command methods above do.
   *
   * SCRIPTS RUN SERIALLY, and that is the most important line in this file. Redis is
   * single-threaded, so a script is atomic: nothing observes it half-applied. A mirror written
   * with `await` between steps would interleave two concurrent invocations and let both take the
   * same branch — which would make the refresh-rotation race test fail against a fake while
   * passing against real Redis. Queueing them models the property the Lua depends on.
   */
  defineCommand(name, { lua, numberOfKeys }) {
    this.scripts.set(name, { lua, numberOfKeys });
    const mirror = FakeRedis.MIRRORS[name];
    if (!mirror) {
      throw new Error(`No transcription for script "${name}" in tests/helpers/fake-redis.js`);
    }

    this[name] = async (...args) => {
      const previous = this.scriptQueue;
      let release;
      this.scriptQueue = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await mirror(this, args.slice(0, numberOfKeys), args.slice(numberOfKeys));
      } finally {
        release();
      }
    };
    return this[name];
  }
}

/**
 * Transcriptions of the Lua in src/. Keyed by the name passed to `defineCommand`.
 */
FakeRedis.MIRRORS = {
  /** src/rate-limit/redis-store.js — SLIDING_WINDOW_LUA */
  async slidingWindowHit(redis, [key], [windowMs, limit, member]) {
    const window = Number(windowMs);
    const max = Number(limit);
    // The Lua reads Redis' own clock; the fake's clock is the same source of truth here.
    const now = redis.now();

    await redis.zremrangebyscore(key, 0, now - window);
    const count = await redis.zcard(key);

    if (count >= max) {
      const oldest = redis.sortedMembers(key)[0];
      return [0, count, String(oldest ? oldest[1] : now), String(now)];
    }

    await redis.zadd(key, now, member);
    await redis.pexpire(key, window);
    const oldest = redis.sortedMembers(key)[0];
    return [1, count + 1, String(oldest ? oldest[1] : now), String(now)];
  },

  /** src/auth/refresh.service.js — ROTATE_LUA */
  async rotateRefreshToken(redis, [activeOld, usedOld, activeNew, revoked, live], [rotatedAt]) {
    if ((await redis.exists(revoked)) === 1) return ['revoked'];

    const remaining = await redis.pttl(live);
    if (remaining <= 0) return ['expired'];

    const rec = await redis.hgetall(activeOld);
    if (Object.keys(rec).length > 0) {
      await redis.del(activeOld);
      await redis.hset(usedOld, rec);
      await redis.pexpire(usedOld, remaining);

      await redis.hset(activeNew, rec);
      await redis.hincrby(activeNew, 'generation', 1);
      await redis.hset(activeNew, 'rotatedAt', rotatedAt);
      await redis.pexpire(activeNew, remaining);

      return [
        'rotated',
        await redis.hget(activeNew, 'userId'),
        await redis.hget(activeNew, 'generation'),
        String(remaining),
      ];
    }

    const usedUser = await redis.hget(usedOld, 'userId');
    if (usedUser) {
      await redis.set(revoked, '1', 'PX', remaining);
      await redis.del(live);
      return ['reused', usedUser];
    }

    return ['unknown'];
  },

  /** src/redis/lock.js — RELEASE_LUA */
  async releaseLock(redis, [key], [token]) {
    if ((await redis.get(key)) === token) return redis.del(key);
    return 0;
  },
};

export default FakeRedis;
