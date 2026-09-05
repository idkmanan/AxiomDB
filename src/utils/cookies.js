// ---------------------------------------------------------------------------
// Session cookie helpers.
//
// `maxAge` is the same value the JWT is signed with (src/utils/jwt.js), taken
// from config.session.ttlMs. v0 had 15 minutes here and '1d' there; see the note
// in jwt.js for why that combination was worse than either value alone.
//
// A note on `get`, because it is a good example of a latent bug. v0 line 18 read
// `return req,cookies[name]` — a comma expression that evaluates `req`, throws it
// away, and then indexes this module's own exported `cookies` object. It could
// only ever return `getOptions`, `set`, `clear` or `undefined`. It was harmless
// solely because nothing called it: src/middleware/auth.middleware.js:6 reads
// `req.cookies?.token` directly. Dead code hides bugs from tests and from
// reviewers, and this one would have surfaced as an authentication failure the
// first time someone used the helper as intended.
// ---------------------------------------------------------------------------
import config from '#config/env.js';

export const cookies = {
  getOptions: () => ({
    // Not readable from JavaScript, so an XSS payload cannot exfiltrate the
    // session token.
    httpOnly: true,
    // HTTPS only in production. Left off elsewhere because a Secure cookie is
    // silently dropped over plain http://localhost, which looks like a broken
    // login rather than a policy.
    secure: config.isProduction,
    // 'strict' means the cookie is not sent on any cross-site navigation, which
    // is the strongest CSRF defence available from the cookie alone. It also
    // means a link from an external site lands the user logged out; acceptable
    // for an API whose only cookie is a short-lived session.
    sameSite: 'strict',
    // Single source of truth, shared with the JWT expiry.
    maxAge: config.session.ttlMs,
    path: '/',
  }),

  set: (res, name, value, options = {}) => {
    res.cookie(name, value, { ...cookies.getOptions(), ...options });
  },

  clear: (res, name, options = {}) => {
    // maxAge must not be sent with clearCookie: it would set a future expiry and
    // defeat the clear. Express derives the past expiry itself.
    const { maxAge: _maxAge, ...rest } = cookies.getOptions();
    res.clearCookie(name, { ...rest, ...options });
  },

  get: (req, name) => req.cookies?.[name],
};
