// ---------------------------------------------------------------------------
// Authentication endpoints.
//
// PHASE 4 ADDS THE HALF THAT WAS MISSING. Phase 1 shortened the access token to 15 minutes
// with no refresh and no revocation, and said so plainly: sign-out cleared a cookie and the
// token stayed valid. Both ends are now real —
//
//   sign-in / sign-up  issue a short access JWT *and* an opaque refresh token
//   POST /refresh      rotates the refresh token and mints a new access token
//   sign-out           revokes the access token by `jti` and kills the refresh family
//
// TWO COOKIES, DIFFERENT SCOPES, and the difference is deliberate. The access cookie is sent
// on every request because every request needs it. The refresh cookie is scoped to
// `/api/auth`, so it is not attached to the hundreds of ordinary API calls that have no use
// for it — less exposure in logs, in proxies, and to anything that can read a request.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import config from '#config/env.js';
import { authenticateUser, createUser } from '#services/auth.service.js';
import { getUserById } from '#services/users.service.js';
import { cookies } from '#utils/cookies.js';
import { formatValidationError, validationIssues } from '#utils/format.js';
import { jwttoken } from '#utils/jwt.js';
import { signinSchema, signupSchema } from '#validations/auth.validation.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeByToken,
  revokeFamily,
} from '#auth/refresh.service.js';
import { denyAccessToken } from '#auth/denylist.service.js';

/** Refresh tokens live in Redis; without it the Phase 1 behaviour stands unchanged. */
const refreshEnabled = () => Boolean(config.redis.url);

const REFRESH_COOKIE_OPTIONS = {
  maxAge: config.refresh.ttlMs,
  // Not sent to any endpoint that cannot use it.
  path: '/api/auth',
};

/** Issue both credentials and attach both cookies. */
async function establishSession(res, user, { requestId } = {}) {
  const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
  cookies.set(res, 'token', token);

  if (!refreshEnabled()) return { refreshed: false };

  try {
    const { token: refreshToken, family } = await issueRefreshToken(user);
    cookies.set(res, config.refresh.cookieName, refreshToken, REFRESH_COOKIE_OPTIONS);
    return { refreshed: true, family };
  } catch (e) {
    // The access token is already valid, so the sign-in SUCCEEDS with a 15-minute session
    // rather than failing outright. Degrading to the Phase 1 behaviour is the right trade for
    // a Redis blip during login; failing the login would be worse for the user and no safer.
    logger.error('Could not issue a refresh token — session is access-token only', {
      requestId,
      userId: user.id,
      error: e.message,
    });
    return { refreshed: false, error: 'refresh-store-unavailable' };
  }
}

export const signup = async (req, res, next) => {
  try {
    const validationResult = signupSchema.safeParse(req.body);
    if (!validationResult.success) {
      // `.issues`, not `.errors` — the latter is undefined in Zod 4, so this line
      // used to log nothing useful. See the note in src/utils/format.js.
      logger.warn('Validation error during signup', {
        requestId: req.id,
        issues: validationIssues(validationResult.error),
      });
      return res.status(400).json({
        message: 'Validation failed',
        errors: formatValidationError(validationResult.error),
      });
    }

    // No `role`, and the schema will not accept one. The v0 line was:
    //   const { name, email, password, role } = validationResult.data;
    // and that single extra binding is what made the whole RBAC layer bypassable.
    const { name, email, password } = validationResult.data;
    const user = await createUser({ name, email, password });

    await establishSession(res, user, { requestId: req.id });

    logger.info('User signed up', { requestId: req.id, userId: user.id });
    return res.status(201).json({
      message: 'User created successfully',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e) {
    // No message-string matching here any more. The service throws AppError with
    // a status and src/middleware/error.middleware.js renders it. v0 compared
    // `e.message === 'User already exists'`, which coupled the HTTP status of an
    // operation to the exact wording of a string in another file — rewording a
    // log message would have silently turned a 409 into a 500.
    return next(e);
  }
};

export const signin = async (req, res, next) => {
  try {
    const validationResult = signinSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn('Validation error during signin', {
        requestId: req.id,
        issues: validationIssues(validationResult.error),
      });
      return res.status(400).json({
        message: 'Validation failed',
        errors: formatValidationError(validationResult.error),
      });
    }

    const { email, password } = validationResult.data;
    const user = await authenticateUser(email, password);

    await establishSession(res, user, { requestId: req.id });

    logger.info('User signed in', { requestId: req.id, userId: user.id });
    return res.status(200).json({
      message: 'Sign in successful',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * POST /api/auth/refresh — rotate the refresh token, mint a new access token.
 *
 * THE USER IS RE-READ FROM POSTGRES, and that is not laziness about caching. The refresh
 * record could carry `email` and `role` and save a query, but then a demotion, a rename or a
 * deleted account would not take effect until the refresh token expired — up to 30 days of a
 * former admin still holding admin. One indexed primary-key lookup per 15 minutes per session
 * is a small price for authorization that is at most 15 minutes stale.
 */
export const refresh = async (req, res, next) => {
  try {
    if (!refreshEnabled()) {
      // 503, not 404: the endpoint exists and is expected to work, it is the deployment that
      // has no Redis. A 404 would send a client looking for a spelling mistake.
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Refresh tokens require Redis, which is not configured for this deployment.',
      });
    }

    const presented = req.cookies?.[config.refresh.cookieName];
    if (!presented) {
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'No refresh token was presented' });
    }

    // Throws 401 on anything that is not a clean rotation, including reuse — which also
    // revokes the family inside the Lua script.
    const rotated = await rotateRefreshToken(presented);

    const user = await getUserById(rotated.userId);
    if (!user) {
      // The account is gone but the chain is still live. Kill the family rather than leaving a
      // token that would keep failing this check for the next 30 days.
      await revokeFamily(rotated.family).catch(() => {});
      cookies.clear(res, config.refresh.cookieName, { path: '/api/auth' });
      return res.status(401).json({ error: 'Unauthorized', message: 'Account no longer exists' });
    }

    const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
    cookies.set(res, 'token', token);
    cookies.set(res, config.refresh.cookieName, rotated.token, REFRESH_COOKIE_OPTIONS);

    logger.info('Session refreshed', {
      requestId: req.id,
      userId: user.id,
      family: rotated.family,
      generation: rotated.generation,
    });

    return res.status(200).json({
      message: 'Session refreshed',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      // Useful to a client deciding when to refresh next, and it is not a secret.
      expiresIn: config.session.ttlSeconds,
    });
  } catch (e) {
    if (e?.code === 'REFRESH_REJECTED') {
      // Always clear the cookie on rejection. Leaving a dead token in the browser means the
      // client retries with it forever, and every retry looks like an attack in the logs.
      cookies.clear(res, config.refresh.cookieName, { path: '/api/auth' });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Please sign in again',
        code: e.code,
        requestId: req.id,
      });
    }
    return next(e);
  }
};

export const signout = async (req, res, next) => {
  try {
    // BEST EFFORT, IN BOTH DIRECTIONS, and always a 200. Sign-out is the one operation a user
    // performs when they think something is wrong; answering 500 because Redis is briefly down
    // would be the worst possible moment to be unhelpful. What can be revoked is revoked, what
    // cannot is logged, and the cookies are cleared regardless.
    const accessToken = req.cookies?.token;
    const refreshToken = req.cookies?.[config.refresh.cookieName];

    let revokedAccess = false;
    if (accessToken) {
      try {
        // Verified rather than decoded: a token that does not verify has nothing worth
        // denylisting, and writing an attacker-supplied `jti` would let anyone fill the
        // denylist with junk keys.
        const claims = jwttoken.verify(accessToken);
        const result = await denyAccessToken(claims);
        revokedAccess = result.denied;
      } catch {
        // An expired or tampered token needs no revocation.
      }
    }

    let revokedRefresh = false;
    if (refreshToken && refreshEnabled()) {
      const result = await revokeByToken(refreshToken).catch((e) => {
        logger.error('Could not revoke refresh family on sign-out', { error: e.message });
        return { revoked: false };
      });
      revokedRefresh = result.revoked;
    }

    cookies.clear(res, 'token');
    cookies.clear(res, config.refresh.cookieName, { path: '/api/auth' });

    logger.info('User signed out', {
      requestId: req.id,
      userId: req.user?.id,
      revokedAccess,
      revokedRefresh,
    });

    return res.status(200).json({
      message: 'Sign out successful',
      // Honest about what actually happened. When both are false — no Redis configured — the
      // access token remains valid until it expires, which is the Phase 1 behaviour and worth
      // saying out loud rather than implying revocation that did not occur.
      revoked: { accessToken: revokedAccess, refreshFamily: revokedRefresh },
    });
  } catch (e) {
    return next(e);
  }
};
