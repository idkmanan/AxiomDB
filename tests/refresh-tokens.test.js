// ---------------------------------------------------------------------------
// Refresh-token rotation, reuse detection, and the access-token denylist.
//
// The properties being pinned down are the ones that make this better than a long-lived JWT
// rather than merely different:
//
//   * nothing usable is stored — Redis holds SHA-256, so a dump yields no sessions
//   * one token, one use — rotation invalidates the presented token atomically
//   * a replayed token kills the family, because a rotated token in a second pair of hands
//     means one of them is a thief and there is no way to tell which
//   * rotation cannot extend a session forever — the family has an absolute cap
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { FakeRedis } from './helpers/fake-redis.js';

const FAMILY_TTL_MS = 3_600_000;

/**
 * Load the auth modules with Redis "configured".
 *
 * `config.redis.url` is read at import time, so the environment has to be set before the module
 * registry is rebuilt — the same mechanism (and the same trap) as the per-registry JWT secret in
 * tests/deals-http.test.js.
 */
async function loadAuth({ startAt = 1_000_000 } = {}) {
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.REFRESH_TTL_MS = String(FAMILY_TTL_MS);
  jest.resetModules();

  let now = startAt;
  const client = new FakeRedis({ now: () => now });
  const refresh = await import('#auth/refresh.service.js');
  const denylist = await import('#auth/denylist.service.js');

  return { refresh, denylist, client, advance: (ms) => (now += ms), at: () => now };
}

const user = { id: 42, email: 'owner@example.test', role: 'user' };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

describe('issuing', () => {
  it('produces a family-prefixed opaque token', async () => {
    const { refresh, client } = await loadAuth();
    const { token, family } = await refresh.issueRefreshToken(user, { client });

    expect(token.startsWith(`${family}.`)).toBe(true);
    // Long enough that guessing is not a strategy: 32 random bytes in the secret half.
    expect(token.length).toBeGreaterThan(60);
  });

  it('stores a hash, never the token', async () => {
    const { refresh, client } = await loadAuth();
    const { token } = await refresh.issueRefreshToken(user, { client });

    const keys = [...client.data.keys()];
    // The token itself must not appear anywhere in Redis — not as a key, not as a value. A
    // `--bigkeys` scan, a backup on the wrong bucket or an operator with read access then yields
    // nothing usable.
    expect(keys.some((k) => k.includes(token))).toBe(false);
    expect(JSON.stringify([...client.data.values()])).not.toContain(token);
    expect(keys.some((k) => k.includes(sha256(token)))).toBe(true);
  });

  it('sets the absolute family lifetime once', async () => {
    const { refresh, client } = await loadAuth();
    const { family } = await refresh.issueRefreshToken(user, { client });

    const liveTtl = await client.pttl(`acq:rt:l:${family}`);
    expect(liveTtl).toBe(FAMILY_TTL_MS);
  });
});

describe('rotation', () => {
  it('issues a new token and invalidates the presented one', async () => {
    const { refresh, client } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });

    const second = await refresh.rotateRefreshToken(first.token, { client });

    expect(second.token).not.toBe(first.token);
    expect(second.userId).toBe(42);
    expect(second.generation).toBe(2);
    // The new token works.
    const third = await refresh.rotateRefreshToken(second.token, { client });
    expect(third.generation).toBe(3);
  });

  it('carries the user forward without a database lookup', async () => {
    const { refresh, client } = await loadAuth();
    const first = await refresh.issueRefreshToken({ ...user, id: 7 }, { client });
    const rotated = await refresh.rotateRefreshToken(first.token, { client });
    expect(rotated.userId).toBe(7);
  });

  it('does not extend the session beyond the family cap', async () => {
    const { refresh, client, advance } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });

    advance(FAMILY_TTL_MS / 2);
    const rotated = await refresh.rotateRefreshToken(first.token, { client });

    // Half the family lifetime is gone, so the new token gets half — not a fresh full TTL.
    // Otherwise a client that refreshes often never has to sign in again, which is an eternal
    // session wearing rotation as a disguise.
    const ttl = await client.pttl(`acq:rt:a:${sha256(rotated.token)}`);
    expect(ttl).toBe(FAMILY_TTL_MS / 2);
  });

  it('refuses once the family has outlived its cap', async () => {
    const { refresh, client, advance } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });

    advance(FAMILY_TTL_MS + 1);

    await expect(refresh.rotateRefreshToken(first.token, { client })).rejects.toMatchObject({
      statusCode: 401,
      code: 'REFRESH_REJECTED',
    });
  });
});

describe('reuse detection', () => {
  it('revokes the whole family when a rotated token is presented again', async () => {
    const { refresh, client } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });
    const second = await refresh.rotateRefreshToken(first.token, { client });

    // The thief (or a buggy client) replays the token that was already exchanged.
    await expect(refresh.rotateRefreshToken(first.token, { client })).rejects.toMatchObject({
      statusCode: 401,
      reason: 'reused',
    });

    // AND the legitimate holder's newer token is dead too. That is the point: there is no way to
    // tell the victim from the thief, so the only safe move is to end the chain and make both
    // sign in again. Leaving the newest token alive would be betting on the thief being slower.
    await expect(refresh.rotateRefreshToken(second.token, { client })).rejects.toMatchObject({
      reason: 'revoked',
    });
  });

  it('treats two concurrent uses of one token as reuse', async () => {
    const { refresh, client } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });

    // A client that retried a refresh, or a thief racing the victim. Exactly one may succeed —
    // if both minted a child the family would silently fork and rotation would stop meaning
    // anything. The DEL inside the script is the serialization point.
    const results = await Promise.allSettled([
      refresh.rotateRefreshToken(first.token, { client }),
      refresh.rotateRefreshToken(first.token, { client }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0].reason.reason).toBe('reused');
  });

  it('keeps the evidence for as long as the family could live', async () => {
    const { refresh, client, advance } = await loadAuth();
    const first = await refresh.issueRefreshToken(user, { client });
    await refresh.rotateRefreshToken(first.token, { client });

    advance(FAMILY_TTL_MS - 1);
    // A thief who waits for the used-marker to expire would otherwise get a clean 'unknown'
    // instead of tripping the alarm. The marker outlives the token deliberately.
    await expect(refresh.rotateRefreshToken(first.token, { client })).rejects.toMatchObject({
      reason: 'reused',
    });
  });

  it('rejects an unknown token without revoking anything', async () => {
    const { refresh, client } = await loadAuth();
    const live = await refresh.issueRefreshToken(user, { client });

    const stranger = `${'A'.repeat(22)}.${'B'.repeat(43)}`;
    await expect(refresh.rotateRefreshToken(stranger, { client })).rejects.toMatchObject({
      reason: 'expired',
    });

    // A made-up token must not be able to take down a real session — otherwise anyone could
    // log a user out by guessing family ids.
    const rotated = await refresh.rotateRefreshToken(live.token, { client });
    expect(rotated.generation).toBe(2);
  });

  it.each([['no-dot-at-all'], [''], ['.secret'], ['family.'], ['sh0rt.x']])(
    'rejects the malformed token %p before touching Redis',
    async (token) => {
      const { refresh, client } = await loadAuth();
      const before = client.calls.length;

      await expect(refresh.rotateRefreshToken(token, { client })).rejects.toMatchObject({
        statusCode: 401,
        reason: 'malformed',
      });
      expect(client.calls.length).toBe(before);
    }
  );
});

describe('explicit revocation', () => {
  it('kills a family by token, which is what sign-out does', async () => {
    const { refresh, client } = await loadAuth();
    const issued = await refresh.issueRefreshToken(user, { client });

    const result = await refresh.revokeByToken(issued.token, { client });
    expect(result.revoked).toBe(true);

    await expect(refresh.rotateRefreshToken(issued.token, { client })).rejects.toMatchObject({
      reason: 'revoked',
    });
  });

  it('ignores a malformed token rather than throwing during sign-out', async () => {
    const { refresh, client } = await loadAuth();
    // Sign-out must not fail because the browser sent something odd — the user is trying to
    // leave.
    expect(await refresh.revokeByToken('rubbish', { client })).toEqual({
      revoked: false,
      reason: 'malformed',
    });
  });
});

describe('the access-token denylist', () => {
  const claims = (over = {}) => ({
    jti: 'e6f1b0c2-0000-4000-8000-000000000001',
    exp: Math.floor(Date.now() / 1000) + 900,
    ...over,
  });

  it('revokes a token for exactly its remaining life', async () => {
    const { denylist, client } = await loadAuth();
    const result = await denylist.denyAccessToken(claims(), { client });

    expect(result.denied).toBe(true);
    // Bounded by the token's own expiry, so the denylist can never grow past the number of
    // revocations in one token lifetime. A fixed long TTL would accumulate keys for tokens that
    // stopped working hours earlier.
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.ttlMs).toBeLessThanOrEqual(900_000);
    expect(await denylist.isAccessTokenDenied(claims().jti, { client })).toBe(true);
  });

  it('does not write a key for a token that has already expired', async () => {
    const { denylist, client } = await loadAuth();
    const result = await denylist.denyAccessToken(
      claims({ exp: Math.floor(Date.now() / 1000) - 10 }),
      { client }
    );

    expect(result.denied).toBe(false);
    expect(client.data.size).toBe(0);
  });

  it('allows a token that was never revoked', async () => {
    const { denylist, client } = await loadAuth();
    expect(await denylist.isAccessTokenDenied('never-seen', { client })).toBe(false);
  });

  it('fails OPEN when Redis is unreachable, and counts it', async () => {
    const { denylist, client } = await loadAuth();
    client.failOnce('Connection is closed.');

    // The deliberate trade (see the header of src/auth/denylist.service.js): failing closed
    // would 401 every authenticated request during a Redis blip. Exposure is bounded by the
    // 15-minute token TTL, and the counter is what keeps it from being invisible.
    expect(await denylist.isAccessTokenDenied('some-jti', { client })).toBe(false);
    expect(denylist.denylistStats.failures).toBe(1);
  });

  it('is inert when Redis is not configured at all', async () => {
    delete process.env.REDIS_URL;
    jest.resetModules();
    const denylist = await import('#auth/denylist.service.js');
    const client = new FakeRedis();

    expect(denylist.denylistEnabled()).toBe(false);
    expect(await denylist.isAccessTokenDenied('x', { client })).toBe(false);
    // Nothing pretends to work: no key is written and no check is counted, which is the honest
    // version of "this deployment has no revocation".
    expect(client.calls).toHaveLength(0);
  });
});
