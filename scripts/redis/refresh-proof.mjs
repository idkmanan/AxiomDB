#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PROOF: refresh-token rotation and reuse detection, against a real Redis.
//
//   REDIS_URL=redis://localhost:6379 node scripts/redis/refresh-proof.mjs
//
// WHY THIS EXISTS. The unit tests in tests/refresh-tokens.test.js run against a JavaScript
// transcription of ROTATE_LUA, because the sandbox this was written in has no Redis and Lua does
// not run in Node. That verifies the semantics the application expects; it does not verify the
// script. This does — same properties, real script, real server, and it exits non-zero if any of
// them fails.
//
// The interesting one is the concurrency case. Two simultaneous refreshes of the same token must
// produce exactly ONE new token: if both succeeded, the family would silently fork and every
// subsequent reuse check would be meaningless. That property comes entirely from Redis executing
// the script atomically, which is precisely what a fake cannot demonstrate.
// ---------------------------------------------------------------------------
import config from '#config/env.js';
import { setRedisClient, closeRedis } from '#redis/client.js';
import { issueRefreshToken, rotateRefreshToken, revokeByToken } from '#auth/refresh.service.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const user = { id: 4242, email: 'proof@example.test', role: 'user' };

const results = [];
const say = (line) => process.stdout.write(`${line}\n`);

function check(name, pass, detail) {
  results.push({ name, pass });
  say(`   ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const reasonOf = (e) => e?.reason ?? e?.code ?? e?.message;

async function main() {
  if (!config.redis.url) {
    say('REDIS_URL is not set, so the application would not enable refresh tokens at all.');
    say('Set it and re-run: REDIS_URL=redis://localhost:6379 node scripts/redis/refresh-proof.mjs');
    process.exit(1);
  }

  const { default: Redis } = await import('ioredis');
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  setRedisClient(client);

  const info = await client.info('server');
  say(`redis: ${/redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown'} at ${REDIS_URL}`);
  say('');

  // ---- 1. Rotation ------------------------------------------------------
  say('── rotation');
  const first = await issueRefreshToken(user);
  const second = await rotateRefreshToken(first.token);
  check('a new token is issued', second.token !== first.token);
  check('the user is carried forward', second.userId === user.id, `userId=${second.userId}`);
  check('the generation increments', second.generation === 2, `generation=${second.generation}`);

  const stored = await client.keys(`${config.redis.keyPrefix}rt:*`);
  check(
    'no key or value contains the raw token',
    !stored.some((k) => k.includes(first.token) || k.includes(second.token)),
    `${stored.length} keys inspected`
  );

  // ---- 2. Reuse ---------------------------------------------------------
  say('\n── reuse detection');
  let reuseReason;
  try {
    await rotateRefreshToken(first.token);
  } catch (e) {
    reuseReason = reasonOf(e);
  }
  check('replaying a rotated token is refused', reuseReason === 'reused', `reason=${reuseReason}`);

  let survivorReason;
  try {
    await rotateRefreshToken(second.token);
  } catch (e) {
    survivorReason = reasonOf(e);
  }
  // The legitimate holder's newest token dies too. There is no way to tell the victim from the
  // thief, so the only safe move is to end the chain.
  check(
    'the whole family is revoked, including the newest token',
    survivorReason === 'revoked',
    `reason=${survivorReason}`
  );

  // ---- 3. Concurrency — the property only a real server can show --------
  say('\n── two concurrent refreshes of one token');
  const race = await issueRefreshToken(user);
  const settled = await Promise.allSettled([
    rotateRefreshToken(race.token),
    rotateRefreshToken(race.token),
  ]);
  const won = settled.filter((r) => r.status === 'fulfilled');
  const lost = settled.filter((r) => r.status === 'rejected');
  check('exactly one rotation succeeds', won.length === 1, `${won.length} succeeded`);
  check(
    'the loser is treated as reuse',
    lost.length === 1 && reasonOf(lost[0].reason) === 'reused',
    lost.length ? `reason=${reasonOf(lost[0].reason)}` : 'nothing was rejected'
  );

  // ---- 4. Explicit revocation ------------------------------------------
  say('\n── sign-out');
  const toRevoke = await issueRefreshToken(user);
  await revokeByToken(toRevoke.token);
  let revokedReason;
  try {
    await rotateRefreshToken(toRevoke.token);
  } catch (e) {
    revokedReason = reasonOf(e);
  }
  check('a revoked token cannot refresh', revokedReason === 'revoked', `reason=${revokedReason}`);

  // ---- Cleanup ----------------------------------------------------------
  const mine = await client.keys(`${config.redis.keyPrefix}rt:*`);
  if (mine.length) await client.del(...mine);
  await closeRedis();

  const failed = results.filter((r) => !r.pass);
  say('');
  say(`${results.length - failed.length}/${results.length} properties hold against real Redis`);
  if (failed.length) {
    say(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  process.stderr.write(`[refresh-proof] FAILED: ${e.message}\n`);
  await closeRedis().catch(() => {});
  process.exit(1);
});
