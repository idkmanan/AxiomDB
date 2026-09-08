// ---------------------------------------------------------------------------
// A distributed lock, and an honest account of what it does not guarantee.
//
// THE IMPLEMENTATION IS THE EASY PART:
//
//   SET lock:<name> <random-token> NX PX <ttl>     acquire
//   if GET == token then DEL                       release, atomically, in Lua
//
// `NX` makes acquisition atomic. `PX` means a holder that crashes cannot keep the lock forever.
// The random token is what makes release safe: without it, a holder whose lock had already
// expired would delete a lock now held by someone else, and `DEL` is not conditional.
//
// WHAT IT DOES NOT GUARANTEE — THE FENCING PROBLEM, and this is the part usually left out.
//
// A lock with a timeout cannot provide mutual exclusion for an external side effect. Suppose A
// acquires the lock with a 10-second TTL, then its process is paused — a stop-the-world GC, a
// hypervisor migration, a suspended container — for 15 seconds. The lock expires. B acquires it
// legitimately and writes. A resumes, believing it still holds the lock, and writes too. Both
// wrote; the lock was working correctly the whole time. No amount of clock accuracy or Redis
// replication fixes this, because the flaw is that the LOCK and the RESOURCE are different
// systems and the resource never checks.
//
// THE FIX IS A FENCING TOKEN: a monotonically increasing number issued with the lock and
// validated BY THE RESOURCE, which rejects any write carrying a token older than the last one
// it accepted. This project already has one, which is the reason this file can be as small as
// it is:
//
//   `deals.version` IS the fencing token (src/services/deals.service.js).
//
// Every write is `WHERE id = $1 AND version = $2`, so a resumed process holding a stale version
// updates zero rows and gets a 409. Postgres — the resource — is the arbiter, and the lock is
// an optimisation that reduces contention rather than a correctness mechanism. That is the only
// role a Redis lock should be given.
//
// (This is Martin Kleppmann's critique of Redlock, and the reason a single-instance lock is used
// here rather than a multi-node Redlock: Redlock adds complexity to defend against a Redis
// failover, while leaving the fencing problem — the one that actually corrupts data —
// untouched. If a lock is only an optimisation, one instance is enough; if it is load-bearing
// for correctness, no number of instances is.)
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';
import logger from '#config/logger.js';
import { getRedis, redisKey } from '#redis/client.js';

/** Compare-and-delete. Two commands in the application would not be atomic. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function scripted(client) {
  if (typeof client.defineCommand === 'function' && !client.releaseLock) {
    client.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_LUA });
  }
  return client;
}

/**
 * Try once to acquire a lock.
 *
 * Deliberately NOT a blocking acquire with retries. A caller that must wait should decide how
 * long it is prepared to wait; hiding a retry loop in here produces requests that hang for
 * reasons the caller never chose. Returns null rather than throwing, because "somebody else has
 * it" is an ordinary outcome, not an error.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] how long before the lock expires on its own
 * @returns {Promise<{token: string, release: () => Promise<boolean>} | null>}
 */
export async function acquireLock(name, { ttlMs = 5000, client } = {}) {
  const redis = client ?? getRedis();
  const key = redisKey('lock', name);
  const token = randomBytes(16).toString('hex');

  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;

  return {
    token,
    async release() {
      const released = await scripted(redis).releaseLock(key, token);
      if (released !== 1) {
        // The lock had already expired and possibly been taken by someone else. Worth a line:
        // it means the critical section ran longer than its TTL, which is the condition under
        // which the fencing problem above becomes real.
        logger.warn('Lock was no longer held at release time', { name, ttlMs });
      }
      return released === 1;
    },
  };
}

/**
 * Run `fn` while holding the lock, or return `{ acquired: false }`.
 *
 * The `finally` is the point: a critical section that throws must still release, or the lock is
 * held until its TTL and every subsequent caller is refused for no reason.
 */
export async function withLock(name, fn, { ttlMs = 5000, client } = {}) {
  const lock = await acquireLock(name, { ttlMs, client });
  if (!lock) return { acquired: false, result: undefined };

  try {
    return { acquired: true, result: await fn(lock.token) };
  } finally {
    await lock
      .release()
      .catch((e) => logger.error('Lock release failed', { name, error: e.message }));
  }
}

export const __testing = { RELEASE_LUA };
export default { acquireLock, withLock };
