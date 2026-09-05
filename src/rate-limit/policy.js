// ---------------------------------------------------------------------------
// Rate-limit policy.
//
// Three decisions live here, and each one is a direct answer to something
// Phase 0 measured or found:
//
// 1. WHAT IS LIMITED. Not everything. `/health` and `/ready` are deliberately
//    unlimited. The v0 code mounted its security middleware at app level
//    (src/app.js:20) so a liveness probe paid the full check — measured at
//    404.69 ms p95 for an endpoint that does no I/O, against 4.19 ms with the
//    middleware bypassed (finding F-16). A limiter in front of a health check
//    means a saturated service also fails its probe and gets restarted, which
//    converts a load problem into an outage.
//
// 2. WHO IS COUNTED. The v0 middleware read `req.user?.role` while mounted
//    BEFORE `authenticate`, so `req.user` was always undefined and every caller
//    — including admins — silently got the 5/min guest bucket. Role-based
//    limiting had never worked. Here the authenticated limiter is mounted after
//    `authenticate` and keys on user id; only the unauthenticated policies key
//    on IP.
//
// 3. WHAT HAPPENS WHEN THE LIMITER ITSELF FAILS. ADR 0002. The store is
//    in-process today so it cannot realistically fail, but Phase 4 moves it to
//    Redis, and the whole reason Arcjet was removed is that it failed OPEN
//    silently (F-07). So the policy is explicit and per-route now, while the
//    cost of getting it wrong is still zero:
//      - auth endpoints fail CLOSED — a brute-force window is worse than a
//        503 during a Redis outage
//      - read endpoints fail OPEN — availability wins where the downside is
//        an unmetered read
//    Either way it is logged and counted, which is exactly what Arcjet did not
//    do.
// ---------------------------------------------------------------------------

function intFromEnv(name, fallback, { min = 1, max = 10_000_000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}" — expected an integer between ${min} and ${max}.`);
  }
  return n;
}

/** Window length shared by every policy, so `RateLimit-Reset` means one thing. */
export const WINDOW_MS = intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1000 });

/**
 * Per-role ceilings for authenticated traffic.
 *
 * Ordered admin > user because an admin legitimately drives list endpoints
 * harder. Anything not in this map falls back to `user`, so adding a role to the
 * schema cannot accidentally grant an unlimited bucket.
 */
export const ROLE_LIMITS = {
  admin: intFromEnv('RATE_LIMIT_ADMIN_MAX', 300),
  user: intFromEnv('RATE_LIMIT_USER_MAX', 100),
};

/**
 * Named policies. `name` is part of the storage key, so a client's budget on the
 * auth endpoints is separate from its budget on reads — otherwise a burst of
 * reads would lock someone out of signing in.
 */
export const POLICIES = {
  /**
   * Credential endpoints: sign-up and sign-in.
   *
   * The tightest limit in the application, and the one that earns its keep.
   * bcrypt at cost 10 measured 54.8 ms per compare on the benchmark host
   * (finding F-05), so unthrottled sign-in attempts are both a credential-
   * stuffing channel and the cheapest available CPU exhaustion attack: ~18
   * requests per second saturates one core. 10/minute/IP leaves real users
   * unaffected.
   */
  auth: {
    name: 'auth',
    max: intFromEnv('RATE_LIMIT_AUTH_MAX', 10),
    windowMs: WINDOW_MS,
    identify: 'ip',
    onStoreFailure: 'closed',
  },

  /**
   * Authenticated API traffic. Keyed by user id, limit chosen by role.
   */
  authenticated: {
    name: 'api',
    max: null, // resolved per-request from ROLE_LIMITS
    windowMs: WINDOW_MS,
    identify: 'user',
    onStoreFailure: 'open',
  },
};

/**
 * Resolve the ceiling for a request under a policy.
 * @param {object} policy
 * @param {{role?: string}} [user]
 */
export function limitFor(policy, user) {
  if (policy.max !== null && policy.max !== undefined) return policy.max;
  const role = user?.role;
  return ROLE_LIMITS[role] ?? ROLE_LIMITS.user;
}

/**
 * Storage key for a request.
 *
 * Keying authenticated traffic on user id rather than IP is the substantive
 * change from v0: an IP key both under-counts (one user across mobile networks
 * gets several buckets) and over-counts (an office behind one NAT shares a
 * single bucket). Falls back to IP when there is no session, which is what makes
 * the `auth` policy work at all — the caller has no identity yet.
 */
export function keyFor(policy, req) {
  const scope = policy.name;
  if (policy.identify === 'user' && req.user?.id !== undefined) {
    return `${scope}:u:${req.user.id}`;
  }
  return `${scope}:ip:${clientIp(req)}`;
}

/**
 * Client address.
 *
 * `req.ip` honours `X-Forwarded-For` only when Express `trust proxy` is set,
 * which src/app.js sets from TRUST_PROXY and leaves OFF by default. That default
 * is the safe one: with `trust proxy` enabled and no trusted proxy actually in
 * front, any client can spoof the header and mint itself an unlimited number of
 * rate-limit buckets — the limiter is then decorative. Phase 7 sets it
 * deliberately once there is a known ingress in front.
 */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
