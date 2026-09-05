/**
 * Jest configuration.
 *
 * v0 shipped `jest --init`'s output: 200 lines, all but six of them commented-out
 * defaults, with `collectCoverage: true` and no thresholds. So every test run
 * wrote a coverage report that nothing read and nothing enforced — and because
 * `coverage/` was tracked in git at the time (finding F-01), it also produced a
 * dirty working tree on every run, which is exactly what the benchmark runner
 * refuses to start on.
 *
 * What is here is what this project actually needs.
 *
 * ESM: the source uses `type: "module"` and `#alias/*` subpath imports, so jest
 * runs under `--experimental-vm-modules` (see the `test` script) with no
 * transform. That is why there is no babel config in this repo — nothing is being
 * compiled, which is also why the TypeScript migration in Phase 2 is a real
 * change to this file rather than a flag.
 *
 * Coverage thresholds are deliberately NOT set yet. Phase 1 replaces three smoke
 * tests with behavioural ones, but a threshold gate belongs with the
 * Testcontainers integration suite in Phase 8, where the number it enforces will
 * mean something rather than being whatever today's figure happens to be. A
 * threshold pinned to the current value is a ratchet, not a standard.
 *
 * @type {import('jest').Config}
 */
const config = {
  testEnvironment: 'node',

  // Reset mock state between tests so ordering cannot leak between them.
  clearMocks: true,
  restoreMocks: true,

  // Written on demand (`npm test -- --coverage`) rather than on every run.
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.js'],

  testMatch: ['**/tests/**/*.test.js'],

  // Surface a leaked handle rather than hanging on it. The rate-limiter sweeper is
  // an interval and the pg pool holds sockets; both are `unref`'d or explicitly
  // closed, and this is the check that keeps them that way.
  detectOpenHandles: true,
  forceExit: false,

  verbose: true,
};

export default config;
