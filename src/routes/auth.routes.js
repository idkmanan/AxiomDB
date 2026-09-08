import express from 'express';
import { signin, signout, signup, refresh } from '#controllers/auth.controller.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';

const router = express.Router();

// The tightest limit in the application, and mounted here rather than at app
// level for a reason: these are the only two endpoints where an unauthenticated
// caller can make the server do expensive work. Each one runs bcrypt at cost 10,
// measured at 54.8 ms per compare on one core (finding F-05), so ~18 requests per
// second saturates the whole service. Unthrottled, that is both a
// credential-stuffing channel and the cheapest available denial of service.
//
// Keyed by IP because the caller has no identity yet, and fails CLOSED if the
// limiter's store is unreachable — see src/rate-limit/policy.js for why that
// choice differs from the read endpoints.
const authLimiter = rateLimit('auth');

router.post('/sign-up', authLimiter, signup);
router.post('/sign-in', authLimiter, signin);

// REFRESH IS RATE LIMITED TOO, and it belongs on the auth bucket rather than the
// authenticated one: the caller presents no access token, so there is no `req.user` to key on,
// and the endpoint's whole purpose is to hand out credentials. An unthrottled refresh endpoint
// is a free oracle for testing stolen tokens — each attempt either mints a session or reveals
// that a token has already been rotated.
//
// It fails CLOSED with the rest of the auth policy: if the limiter's store is unreachable,
// refusing to refresh costs a user a re-login, while allowing unlimited attempts costs a
// brute-force window. Note the interaction worth knowing about: the store that limits this
// endpoint and the store that holds the refresh tokens are the same Redis, so during a Redis
// outage this endpoint is 503 either way.
router.post('/refresh', authLimiter, refresh);

// Sign-out is not limited. It now performs real revocation (the access token's `jti` goes on
// the denylist and the refresh family is killed), and rate limiting the exit from a session
// means a user who suspects their token is compromised is told to wait — the wrong trade in
// both directions. It is also idempotent and cheap: two Redis writes at most.
router.post('/sign-out', signout);

export default router;
