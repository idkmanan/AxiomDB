// ---------------------------------------------------------------------------
// Access-token signing and verification.
//
// TWO PHASE 1 FIXES.
//
// 1. LIFETIME. v0 hardcoded `JWT_EXPIRES_IN = '1d'` here while
//    src/utils/cookies.js:6 set the cookie's maxAge to 15 minutes. The browser
//    discarded the cookie after 15 minutes, but the token stayed
//    cryptographically valid for another 23h45m — and with no revocation path
//    (`grep -rn "revoke\|denylist" src/` returned nothing), anyone who had
//    captured it kept a working session for a day. Both values now derive from
//    config.session, so they cannot disagree.
//
// 2. SECRET. v0 line 4 fell back to a literal string committed in this
//    repository. A production deploy that forgot JWT_SECRET would sign tokens
//    with a publicly known key and behave completely normally — anyone could
//    then mint an admin token. src/config/env.js now throws in production rather
//    than defaulting, and flags the development fallback.
//
// PHASE 4 CLOSES THE REVOCATION GAP. Every token now carries a `jti`, and
// src/auth/denylist.service.js writes that id to Redis on sign-out with a TTL equal to
// the token's remaining life, so `authenticate` can refuse it immediately. The long-lived
// credential is an opaque refresh token in Redis with rotation and reuse detection
// (src/auth/refresh.service.js) — deliberately not a JWT, because the whole point is that
// it can be deleted.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import logger from '#config/logger.js';
import config from '#config/env.js';

if (config.session.usingInsecureDevSecret) {
  logger.warn(
    'JWT_SECRET is not set — using a random secret generated for this process. ' +
      'Every restart invalidates all sessions. Set JWT_SECRET for stable local ' +
      'sessions (openssl rand -base64 32).'
  );
}

export const jwttoken = {
  sign: (payload) => {
    try {
      return jwt.sign(payload, config.session.jwtSecret, {
        expiresIn: config.session.ttlSeconds,
        // A unique id per token, so a single session can be revoked without invalidating the
        // signing key for everyone. `jsonwebtoken` will not generate one, and a claim that
        // does not exist cannot be denylisted — which is why this line is the difference
        // between a sign-out that works and one that only clears a cookie.
        jwtid: randomUUID(),
      });
    } catch (e) {
      logger.error('Failed to sign token', e);
      // `cause` preserved: the symptom error is what the caller sees, and
      // without the cause the original jsonwebtoken message is lost from the
      // log entirely.
      throw new Error('Failed to sign token', { cause: e });
    }
  },
  verify: (token) => {
    try {
      return jwt.verify(token, config.session.jwtSecret);
    } catch (e) {
      // Debug, not error. An expired or tampered token is the expected outcome
      // of an unauthenticated request, and logging it at error level means a
      // scanner probing the API fills the error log — which is how real errors
      // get missed.
      logger.debug('Token verification failed', { reason: e.message });
      throw new Error('Failed to authenticate token', { cause: e });
    }
  },
};
