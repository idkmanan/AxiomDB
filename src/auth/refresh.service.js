// ---------------------------------------------------------------------------
// Refresh tokens: opaque, hashed at rest, rotated on every use, with reuse detection.
//
// WHAT PROBLEM THIS SOLVES. Phase 1 left a 15-minute access token with no refresh and no
// revocation, and documented the trade honestly: a session genuinely ended after 15 minutes.
// The naive fix — a longer-lived JWT — makes the original defect worse, because a bearer
// token cannot be withdrawn. So the long-lived credential is deliberately NOT a JWT: it is an
// opaque random string whose only meaning is a row in Redis, which means it can be deleted.
//
// THE FOUR PROPERTIES, and the mechanism for each:
//
//   opaque          32 bytes from `randomBytes`. Nothing is encoded in it, so nothing can be
//                   forged, and no signing key can leak it.
//   hashed at rest  Redis stores SHA-256 of the token, never the token. A Redis dump, an
//                   `--bigkeys` scan, an operator with read access or a backup on the wrong
//                   S3 bucket therefore yields no usable session. This is the same reason
//                   `users.password` is a bcrypt digest, and it costs one hash per refresh.
//                   (SHA-256 and not bcrypt: the input is 256 bits of entropy we generated,
//                   so there is nothing to brute-force and no salt to add — the slow-hash
//                   argument applies to human-chosen passwords, not to random tokens.)
//   rotated         every successful refresh invalidates the presented token and issues a new
//                   one. A stolen token is therefore usable for at most one refresh before it
//                   collides with the legitimate client.
//   reuse detected  presenting an ALREADY-ROTATED token is the signal that two parties hold
//                   the chain, which happens when one of them stole it. The response is to
//                   revoke the whole FAMILY — every descendant of the original login — because
//                   there is no way to tell the thief from the victim, and letting the thief
//                   keep the newest token would be exactly the wrong guess.
//                   (This is the OAuth 2.0 Security BCP's refresh-token rotation model.)
//
// TOKEN SHAPE: `<family>.<secret>`, both base64url. The family id travels in the token so
// that a token which is NOT in Redis can still be attributed to a family and revoke it. It is
// not a secret: knowing a family id lets you revoke that family, which is what an attacker
// would be triggering anyway by reusing a token.
//
// ABSOLUTE SESSION CAP. Rotation with a fresh TTL each time is an eternal session: keep
// refreshing and you never have to log in again. So each family also holds a "live" key set
// once, at login, with the full refresh TTL and NEVER extended. Rotation reads its remaining
// PTTL and gives the new token exactly that — so the chain expires when the family does,
// however often it is rotated.
// ---------------------------------------------------------------------------
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import config from '#config/env.js';
import logger from '#config/logger.js';
import { getRedis, redisKey } from '#redis/client.js';
import { AppError } from '#middleware/error.middleware.js';

const KEY = {
  active: (hash) => redisKey('rt', 'a', hash),
  used: (hash) => redisKey('rt', 'u', hash),
  revoked: (family) => redisKey('rt', 'r', family),
  live: (family) => redisKey('rt', 'l', family),
};

/** SHA-256, hex. The stored form of a token. */
const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Split `<family>.<secret>` without throwing on malformed input. */
function parseToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const family = token.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(family)) return null;
  return { family, hash: hashToken(token) };
}

/**
 * The rotation script. Every state transition happens here, atomically.
 *
 * KEYS: 1 active(old) · 2 used(old) · 3 active(new) · 4 revoked(family) · 5 live(family)
 * ARGV: 1 the rotation timestamp
 *
 * Returns { outcome, … } where outcome is one of rotated | reused | revoked | expired | unknown.
 *
 * WHY ONE SCRIPT AND NOT FOUR COMMANDS. Two concurrent refreshes with the same token — a
 * client that retried, or a thief racing the victim — must produce exactly one new token. With
 * GET-then-DEL-then-SET in the application, both callers can pass the GET and both can mint a
 * child, which silently forks the family and defeats the whole scheme. Inside a script the
 * DEL is the serialization point: the second caller finds nothing under `active` and takes the
 * reuse branch, which is the correct answer to what actually happened.
 *
 * WHY THE RECORD IS A HASH AND NOT JSON. Lua has no JSON parser in Redis' sandbox worth
 * relying on, so a JSON record would have to be copied forward blindly and then rewritten by
 * the application — leaving a window in which the new token exists with an incomplete record.
 * A concurrent refresh in that window would read a record with no `userId`. With a hash,
 * HGETALL → HSET → HINCRBY does the whole transition inside the script, and no follow-up write
 * exists to race.
 */
const ROTATE_LUA = `
local activeOld = KEYS[1]
local usedOld   = KEYS[2]
local activeNew = KEYS[3]
local revoked   = KEYS[4]
local live      = KEYS[5]
local rotatedAt = ARGV[1]

if redis.call('EXISTS', revoked) == 1 then
  return { 'revoked' }
end

-- The absolute session cap: set once at login, never extended. Its absence (-2) means the
-- family has outlived its maximum lifetime, whatever an individual token's TTL says. A live
-- key with no expiry at all (-1) is treated the same way rather than as an eternal session.
local remaining = redis.call('PTTL', live)
if remaining <= 0 then
  return { 'expired' }
end

local rec = redis.call('HGETALL', activeOld)
if #rec > 0 then
  redis.call('DEL', activeOld)
  -- The used marker outlives the token itself: reuse has to be detectable for as long as the
  -- family can live, otherwise a thief simply waits for the evidence to expire.
  redis.call('HSET', usedOld, unpack(rec))
  redis.call('PEXPIRE', usedOld, remaining)

  redis.call('HSET', activeNew, unpack(rec))
  redis.call('HINCRBY', activeNew, 'generation', 1)
  redis.call('HSET', activeNew, 'rotatedAt', rotatedAt)
  redis.call('PEXPIRE', activeNew, remaining)

  return {
    'rotated',
    redis.call('HGET', activeNew, 'userId'),
    redis.call('HGET', activeNew, 'generation'),
    tostring(remaining)
  }
end

local usedUser = redis.call('HGET', usedOld, 'userId')
if usedUser then
  -- REUSE. Two parties hold this chain. Revoke the family; the honest client will be asked to
  -- sign in again, which is the correct cost.
  redis.call('SET', revoked, '1', 'PX', remaining)
  redis.call('DEL', live)
  return { 'reused', usedUser }
end

return { 'unknown' }
`;

function scripted(client) {
  if (typeof client.defineCommand === 'function' && !client.rotateRefreshToken) {
    client.defineCommand('rotateRefreshToken', { numberOfKeys: 5, lua: ROTATE_LUA });
  }
  return client;
}

/**
 * Issue the first token of a new family. Called on sign-in and sign-up.
 *
 * @param {{id: number, email: string, role: string}} user
 */
export async function issueRefreshToken(user, { client = getRedis() } = {}) {
  const family = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const token = `${family}.${secret}`;
  const ttl = config.refresh.ttlMs;

  // A MULTI, so a family is never live without its first token or vice versa. Both directions
  // of a partial write are recoverable, but only one of them is silent: an active token with no
  // live key is refused as expired, which is correct; a live key with no token means the user
  // must sign in again, which is visible.
  await client
    .multi()
    .hset(KEY.active(hashToken(token)), {
      userId: String(user.id),
      family,
      jti: randomUUID(),
      issuedAt: String(Date.now()),
      generation: '1',
    })
    .pexpire(KEY.active(hashToken(token)), ttl)
    .set(KEY.live(family), '1', 'PX', ttl)
    .exec();

  logger.info('Refresh token issued', { userId: user.id, family });
  return { token, family, expiresAt: new Date(Date.now() + ttl) };
}

/**
 * Exchange a refresh token for the next one in its family.
 *
 * @returns {Promise<{token: string, family: string, userId: number, expiresAt: Date}>}
 * @throws {AppError} 401 for anything that is not a clean rotation
 */
export async function rotateRefreshToken(presented, { client = getRedis() } = {}) {
  const parsed = parseToken(presented);
  // A malformed token gets the same 401 as a revoked one. Distinguishing them would tell an
  // attacker which half of the token was wrong.
  if (!parsed) throw unauthorized('malformed');

  const { family, hash } = parsed;
  const nextSecret = randomBytes(32).toString('base64url');
  const nextToken = `${family}.${nextSecret}`;

  const [outcome, userId, generation, remainingMs] = await scripted(client).rotateRefreshToken(
    KEY.active(hash),
    KEY.used(hash),
    KEY.active(hashToken(nextToken)),
    KEY.revoked(family),
    KEY.live(family),
    String(Date.now())
  );

  if (outcome === 'rotated') {
    const id = Number(userId);
    // Fails closed on a record that cannot name its user. Reachable only from data written by
    // an older version of this code or by hand, and issuing an access token for `NaN` would be
    // considerably worse than a 401.
    if (!Number.isInteger(id) || id < 1) {
      logger.error('Refresh record has no usable userId — refusing', { family });
      throw unauthorized('corrupt-record');
    }

    logger.info('Refresh token rotated', { userId: id, family, generation: Number(generation) });
    return {
      token: nextToken,
      family,
      userId: id,
      generation: Number(generation),
      expiresAt: new Date(Date.now() + Number(remainingMs)),
    };
  }

  if (outcome === 'reused') {
    // The one event in this file worth alerting on: a token that had already been rotated was
    // presented again. Either a client is replaying an old value, or a token was stolen. The
    // family is already revoked by the script.
    logger.error('Refresh token REUSE detected — family revoked', {
      family,
      userId: Number(userId) || undefined,
    });
    throw unauthorized('reused');
  }

  logger.warn('Refresh token rejected', { family, outcome });
  throw unauthorized(outcome);
}

/** Revoke a family. Used by sign-out, and by an operator responding to the reuse alert. */
export async function revokeFamily(family, { client = getRedis() } = {}) {
  const ttl = config.refresh.ttlMs;
  await client.multi().set(KEY.revoked(family), '1', 'PX', ttl).del(KEY.live(family)).exec();
  logger.info('Refresh family revoked', { family });
  return { revoked: true, family };
}

/** Revoke the family a presented token belongs to, without validating the token. */
export async function revokeByToken(presented, { client = getRedis() } = {}) {
  const parsed = parseToken(presented);
  if (!parsed) return { revoked: false, reason: 'malformed' };
  await client.del(KEY.active(parsed.hash));
  return revokeFamily(parsed.family, { client });
}

function unauthorized(reason) {
  const err = new AppError('Refresh token is not valid', 401, { code: 'REFRESH_REJECTED' });
  err.reason = reason;
  return err;
}

export const __testing = { KEY, hashToken, parseToken, ROTATE_LUA };
