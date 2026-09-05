import express from 'express';
import { signin, signout, signup } from '#controllers/auth.controller.js';
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

// Sign-out is not limited. It only clears a cookie, costs nothing, and rate
// limiting the exit from a session means a user who suspects their token is
// compromised is told to wait — the wrong trade in both directions.
router.post('/sign-out', signout);

export default router;
