// ---------------------------------------------------------------------------
// The shared request journey, used by realistic.js and saturation.js.
//
// WHY THIS FILE EXISTS, AND WHY baseline.js DOES NOT IMPORT IT.
//
// Finding F-17 was that the open-model probe measured the wrong thing:
// saturation.js hit `GET /api`, a static route, with security bypassed, so it
// reported Express routing throughput rather than the capacity of the real
// endpoint mix. Fixing that means saturation.js and the closed-model script have
// to issue the same requests, which means the journey belongs in one place.
//
// baseline.js deliberately keeps its own inline copy. It is the FROZEN instrument
// the v0 numbers were produced with, and the v0-vs-v1 comparison is only valid
// while it stays the same instrument. Importing a shared journey would mean a
// later edit here silently changed what v0-vs-v1 measures — a comparison that
// quietly stops being a comparison. So this is one case where duplication is the
// correct trade: DRY across a frozen instrument and a live one buys nothing and
// costs the property that makes the frozen one useful.
//
// THE MIX, and why it differs from baseline.js.
//
// baseline.js runs /health + sign-in + users-list + user-by-id every iteration:
// exactly 25% authentication. Phase 0 measured bcrypt at 54.8 ms per compare
// (F-05), so one request in four ran a 54.8 ms key derivation and bcrypt alone was
// 37% of the per-iteration CPU budget. No real read-heavy workload looks like
// that — a production API sees one sign-in per hundreds of reads — so the v0
// numbers describe a workload nobody runs.
//
// Here sign-in is probabilistic at AUTH_RATIO (default 1%), against two reads per
// iteration: roughly one sign-in per 200 requests, or 0.5%. That is the mix worth
// quoting for capacity. The frozen 25% mix stays the instrument for the
// before/after delta, because that is what v0 was measured with.
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check, group } from 'k6';
import { BASE_URL } from './config.js';
import {
  healthLatency,
  usersListLatency,
  userByIdLatency,
  signinLatency,
  record,
} from './metrics.js';

export const SEED_PASSWORD = __ENV.SEED_PASSWORD || 'BenchPassword123!';
export const SEED_USER_COUNT = Number(__ENV.SEED_USER_COUNT || 1000);
export const SEED_ADMIN_EMAIL = __ENV.SEED_ADMIN_EMAIL || 'bench_admin@example.test';

// Fraction of iterations that authenticate. 0.01 with two reads per iteration is
// ~0.5% of requests, against 25% in the frozen baseline.
export const AUTH_RATIO = Number(__ENV.AUTH_RATIO || 0.01);
// Fraction of iterations that hit the liveness probe, standing in for orchestrator
// traffic without letting a free endpoint inflate throughput.
export const HEALTH_RATIO = Number(__ENV.HEALTH_RATIO || 0.1);

export function seedEmail(n) {
  return `bench_user_${n}@example.test`;
}

export function extractToken(res) {
  const setCookie = res.headers['Set-Cookie'];
  if (!setCookie) return null;
  const m = /token=([^;]+)/.exec(setCookie);
  return m ? m[1] : null;
}

/**
 * Authenticate as the seeded admin. Shared by both scripts' setup().
 *
 * Admin specifically, and this is finding F-10: `GET /api/users` is guarded by
 * `authorize('admin')`, which rejects with 403 from middleware BEFORE the
 * controller runs. A VU authenticated as a regular user never reaches the list
 * query, so every users_list sample would be the cost of a middleware rejection
 * — a benchmark that completes, produces plausible numbers, and measures the
 * wrong code path.
 *
 * Note on session lifetime: Phase 1 shortened the access token to 15 minutes
 * (src/config/env.js), and setup() runs once per k6 invocation. A single run is
 * ramp + hold + drain, under 4 minutes at every level in the matrix, so one token
 * comfortably outlives it. If a future phase runs a level for longer than the
 * session TTL, this needs re-authentication mid-run — recorded here because the
 * failure mode would be a wave of 401s misread as a regression.
 */
export function authenticateAdmin() {
  const health = http.get(`${BASE_URL}/health`, { timeout: '10s' });
  if (health.status !== 200) {
    throw new Error(
      `Target not healthy at ${BASE_URL}/health (status ${health.status}). Start the bench stack first.`
    );
  }

  const res = http.post(
    `${BASE_URL}/api/auth/sign-in`,
    JSON.stringify({ email: SEED_ADMIN_EMAIL, password: SEED_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '20s' }
  );

  if (res.status === 429) {
    // The F-16 corollary, now on our own limiter rather than Arcjet's. Every VU
    // shares one source IP, so a tight auth limit turns the whole matrix into
    // 429s. .env.bench raises RATE_LIMIT_AUTH_MAX for exactly this reason, and
    // failing loudly here is better than discovering it in the results.
    throw new Error(
      'Admin sign-in was rate limited (429). Raise RATE_LIMIT_AUTH_MAX in .env.bench — ' +
        'all VUs share one source IP, so the default per-IP limit cannot support a load test.'
    );
  }

  const adminToken = res.status === 200 ? extractToken(res) : null;
  if (!adminToken) {
    throw new Error(
      `Could not authenticate admin ${SEED_ADMIN_EMAIL} (status ${res.status}). ` +
        'Run `npm run bench:seed` first — GET /api/users needs an admin session or the ' +
        'list query is never exercised.'
    );
  }

  return { adminToken, startedAt: new Date().toISOString() };
}

/**
 * One read-heavy iteration.
 *
 * `expectPaginated` records whether the list endpoint is expected to return a
 * bounded page. Left false for v0-shaped runs so the same script can be pointed at
 * the pre-pagination code without the checks failing for the wrong reason.
 */
export function readHeavyIteration(data, { expectPaginated = true } = {}) {
  const jar = { headers: { Cookie: `token=${data.adminToken}` } };

  if (Math.random() < HEALTH_RATIO) {
    group('health', () => {
      const res = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'health' } });
      record(res, healthLatency);
      check(res, { 'health 200': (r) => r.status === 200 });
    });
  }

  group('users_list', () => {
    const res = http.get(`${BASE_URL}/api/users`, { ...jar, tags: { endpoint: 'users_list' } });
    record(res, usersListLatency);
    check(res, {
      'users list reached the DB (200)': (r) => r.status === 200,
      // Asserts the FIX, not just the absence of an error. Before Phase 1 this
      // response carried 1,001 rows and 167 KiB; a bounded page is the whole
      // claim, so a regression to unbounded must show up as a failed check
      // rather than as a quietly larger number.
      'response is a bounded page': (r) => {
        if (!expectPaginated || r.status !== 200) return true;
        return r.body.length < 32768;
      },
    });
  });

  group('user_by_id', () => {
    const id = Math.floor(Math.random() * SEED_USER_COUNT) + 1;
    const res = http.get(`${BASE_URL}/api/users/${id}`, {
      ...jar,
      tags: { endpoint: 'user_by_id' },
    });
    record(res, userByIdLatency);
    check(res, { 'user by id answered': (r) => [200, 404].includes(r.status) });
  });

  if (Math.random() < AUTH_RATIO) {
    group('signin', () => {
      const n = Math.floor(Math.random() * SEED_USER_COUNT) + 1;
      const res = http.post(
        `${BASE_URL}/api/auth/sign-in`,
        JSON.stringify({ email: seedEmail(n), password: SEED_PASSWORD }),
        { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'signin' } }
      );
      record(res, signinLatency);
      check(res, { 'signin 200': (r) => r.status === 200 });
    });
  }
}
