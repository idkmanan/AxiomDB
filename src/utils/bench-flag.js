/**
 * Phase 0 measurement control — TEMPORARY, removed in Phase 1.
 *
 * Extracted into its own module for one reason: the guard must be testable
 * without duplicating the boolean expression in the test. If the guard lived
 * inline in app.js, a test could only re-implement it, which would keep passing
 * even if app.js were later loosened.
 *
 * Policy: the bypass activates only when the env var is EXACTLY the string '1'
 * AND NODE_ENV is not 'production'. Both conditions, no coercion, no truthiness.
 * A misconfigured or malicious deploy therefore cannot disable security.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} true when security middleware should be skipped
 */
export function isSecurityBypassed(env = process.env) {
  return env.BENCH_BYPASS_SECURITY === '1' && env.NODE_ENV !== 'production';
}
