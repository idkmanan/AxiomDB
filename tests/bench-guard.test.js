// ---------------------------------------------------------------------------
// Regression test for the Phase 0 measurement control.
//
// The BENCH_BYPASS_SECURITY flag can switch off the security middleware. That is
// acceptable ONLY because it is double-guarded: the env var must be exactly '1'
// AND NODE_ENV must not be 'production'.
//
// These tests import the real guard from #utils/bench-flag.js rather than
// re-implementing the boolean, so loosening the guard breaks the test. They also
// assert the actual Express wiring, not just the flag value.
// ---------------------------------------------------------------------------
import { jest } from '@jest/globals';
import { isSecurityBypassed } from '#utils/bench-flag.js';

const ORIGINAL_ENV = { ...process.env };

async function loadAppWith(env) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  const mod = await import(`#src/app.js?bust=${Math.random()}`);
  return mod.default;
}

// Express registers securityMiddleware as one router layer. With the bypass
// active there is exactly one fewer layer, which is a real wiring assertion
// rather than a restatement of the flag.
function layerCount(app) {
  const stack = app.router?.stack ?? app._router?.stack ?? [];
  return stack.length;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isSecurityBypassed — the guard itself', () => {
  it('activates only for the exact string "1" outside production', () => {
    expect(isSecurityBypassed({ NODE_ENV: 'development', BENCH_BYPASS_SECURITY: '1' })).toBe(true);
    expect(isSecurityBypassed({ NODE_ENV: 'test', BENCH_BYPASS_SECURITY: '1' })).toBe(true);
  });

  it.each([
    ['production, flag on', { NODE_ENV: 'production', BENCH_BYPASS_SECURITY: '1' }],
    ['flag "true"', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: 'true' }],
    ['flag "01"', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: '01' }],
    ['flag " 1" (padded)', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: ' 1' }],
    ['flag "yes"', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: 'yes' }],
    ['flag numeric 1', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: 1 }],
    ['flag "0"', { NODE_ENV: 'development', BENCH_BYPASS_SECURITY: '0' }],
    ['flag absent', { NODE_ENV: 'development' }],
  ])('stays inactive: %s', (_label, env) => {
    expect(isSecurityBypassed(env)).toBe(false);
  });

  it('cannot be activated in production by any flag value', () => {
    for (const v of ['1', 'true', 'yes', 'on', '01', ' 1', 1, true]) {
      expect(isSecurityBypassed({ NODE_ENV: 'production', BENCH_BYPASS_SECURITY: v })).toBe(false);
    }
  });
});

describe('app wiring reflects the guard', () => {
  it('registers one fewer middleware layer when bypass is active', async () => {
    const secure = await loadAppWith({
      NODE_ENV: 'development',
      BENCH_BYPASS_SECURITY: '0',
    });
    const bypassed = await loadAppWith({
      NODE_ENV: 'development',
      BENCH_BYPASS_SECURITY: '1',
    });

    expect(layerCount(secure)).toBeGreaterThan(0);
    expect(layerCount(bypassed)).toBe(layerCount(secure) - 1);
  });

  it('keeps security middleware mounted in production despite the flag', async () => {
    const prodFlagged = await loadAppWith({
      NODE_ENV: 'production',
      BENCH_BYPASS_SECURITY: '1',
    });
    const devSecure = await loadAppWith({
      NODE_ENV: 'development',
      BENCH_BYPASS_SECURITY: '0',
    });

    expect(layerCount(prodFlagged)).toBe(layerCount(devSecure));
  });
});
