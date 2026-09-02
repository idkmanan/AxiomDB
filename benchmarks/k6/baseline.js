// ---------------------------------------------------------------------------
// Baseline load test — read-heavy mix.
//
// Run:
//   k6 run -e VUS=500 -e RUN_TAG=v0-asbuilt benchmarks/k6/baseline.js
//
// Scenario choice matters. This uses ONE scenario with a fixed VU count
// (a closed model) rather than constant-arrival-rate (an open model), because
// the question Phase 0 answers is "what does this system do at N concurrent
// clients" — which is the claim shape you want on a resume. The open-model
// variant lives in saturation.js and answers a different question.
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, thresholds, stages, runTags, RUN_TAG, VUS } from './lib/config.js';
import {
  healthLatency,
  usersListLatency,
  userByIdLatency,
  signinLatency,
  record,
} from './lib/metrics.js';

export const options = {
  scenarios: {
    read_heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: '10s',
      tags: { scenario: 'read_heavy' },
    },
  },
  thresholds,
  tags: runTags(),
  // Reuse connections: without this, every iteration pays a TCP+TLS handshake
  // and the measurement becomes a test of connection setup.
  noConnectionReuse: false,
  // Do not let k6 silently drop iterations at high VU counts.
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// Seeded users, created by benchmarks/scripts/seed.mjs.
const SEED_PASSWORD = __ENV.SEED_PASSWORD || 'BenchPassword123!';
const SEED_USER_COUNT = Number(__ENV.SEED_USER_COUNT || 1000);
const SEED_ADMIN_EMAIL = __ENV.SEED_ADMIN_EMAIL || 'bench_admin@example.test';

function seedEmail(n) {
  return `bench_user_${n}@example.test`;
}

function extractToken(res) {
  const setCookie = res.headers['Set-Cookie'];
  if (!setCookie) return null;
  const m = /token=([^;]+)/.exec(setCookie);
  return m ? m[1] : null;
}

// setup() runs ONCE, before any VU starts, and its return value is handed to
// every iteration of default().
//
// It signs in as the admin here rather than per-iteration for a specific reason:
// GET /api/users is guarded by authorize('admin') at src/routes/users.routes.js:15,
// and authorize() rejects with 403 BEFORE the controller runs
// (src/middleware/auth.middleware.js:35-40). A VU authenticated as a regular
// 'user' therefore never reaches fetchAllUsers, so the unbounded SELECT at
// src/services/users.service.js:6-14 — the single most important optimisation
// target in this project — would never be executed and its latency never
// measured. Every users_list sample would be the cost of a middleware rejection.
//
// Signing in once and sharing the token also avoids 1000 VUs each paying ~75ms
// of bcrypt to obtain an admin session, which would distort the signin metric.
// The JWT lasts 1 day (src/utils/jwt.js:5), comfortably longer than any run.
export function setup() {
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

  const adminToken = res.status === 200 ? extractToken(res) : null;

  if (!adminToken) {
    // Loud, not silent. Without an admin token the run still completes but the
    // users_list numbers would be meaningless, and a quietly useless benchmark
    // is worse than a failed one.
    throw new Error(
      `Could not authenticate admin ${SEED_ADMIN_EMAIL} (status ${res.status}). ` +
        'Run `npm run bench:seed` first — GET /api/users needs an admin session ' +
        'or the unbounded-scan latency is never exercised.'
    );
  }

  return { adminToken, startedAt: new Date().toISOString() };
}

export default function (data) {
  // ---- 1. Liveness: no I/O, isolates framework + middleware overhead --------
  group('health', () => {
    const res = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'health' } });
    record(res, healthLatency);
    check(res, { 'health 200': (r) => r.status === 200 });
  });

  // ---- 2. Authenticate: bcrypt cost 10, measured ~75ms per compare ---------
  // This is the CPU wall. At 1 app CPU that caps signin throughput around
  // 13/s regardless of concurrency — an expected, explainable bottleneck.
  // Signs in as a regular seeded user: this metric is about bcrypt cost, and
  // must not be contaminated by the shared admin session used for reads.
  group('signin', () => {
    const n = Math.floor(Math.random() * SEED_USER_COUNT) + 1;
    const res = http.post(
      `${BASE_URL}/api/auth/sign-in`,
      JSON.stringify({ email: seedEmail(n), password: SEED_PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'signin' } }
    );
    record(res, signinLatency);
    check(res, {
      'signin 200 or throttled': (r) => r.status === 200 || r.status === 403 || r.status === 429,
    });
  });

  // ---- 3. Authenticated reads, as admin -----------------------------------
  // Uses the token from setup() so authorize('admin') passes and the request
  // actually reaches the database layer.
  const jar = { headers: { Cookie: `token=${data.adminToken}` } };

  // Unbounded SELECT, no LIMIT and no ORDER BY (users.service.js:6-14).
  // The clearest before/after target in the project.
  group('users_list', () => {
    const res = http.get(`${BASE_URL}/api/users`, {
      ...jar,
      tags: { endpoint: 'users_list' },
    });
    record(res, usersListLatency);
    // 200 is the expected outcome now. A 403 here means the admin token was
    // rejected and the scan was NOT measured — treated as a check failure so it
    // shows up in the summary rather than passing silently.
    check(res, {
      'users list reached the DB (200)': (r) => r.status === 200,
      'users list answered': (r) => [200, 429].includes(r.status),
    });
  });

  // Indexed primary-key lookup — the fast path, for contrast.
  group('user_by_id', () => {
    const id = Math.floor(Math.random() * SEED_USER_COUNT) + 1;
    const res = http.get(`${BASE_URL}/api/users/${id}`, {
      ...jar,
      tags: { endpoint: 'user_by_id' },
    });
    record(res, userByIdLatency);
    check(res, { 'user by id answered': (r) => [200, 404, 429].includes(r.status) });
  });

  // Think time. Without it, VUs behave as an infinite-rate hammer and the VU
  // count stops corresponding to anything like real concurrent users.
  sleep(1);
}

export function handleSummary(data) {
  const out = {
    meta: {
      run_tag: RUN_TAG,
      vus: VUS,
      base_url: BASE_URL,
      generated_at: new Date().toISOString(),
      k6_version: (typeof __ENV.K6_VERSION !== 'undefined' && __ENV.K6_VERSION) || 'unknown',
    },
    metrics: data.metrics,
  };
  const stem = `benchmarks/v0-baseline/results/${RUN_TAG}-vus${VUS}`;
  return {
    [`${stem}.json`]: JSON.stringify(out, null, 2),
    stdout: textSummary(data),
  };
}

// Minimal human-readable summary. k6's own textSummary lives in a remote module
// (jslib.k6.io); inlining keeps the harness runnable with zero network access.
function textSummary(data) {
  const m = data.metrics;
  const g = (name, stat) => {
    const v = m[name] && m[name].values && m[name].values[stat];
    return typeof v === 'number' ? v.toFixed(2) : 'n/a';
  };
  const lines = [
    '',
    `  run_tag: ${RUN_TAG}   VUs: ${VUS}`,
    '  ---------------------------------------------------------------',
    `  iterations              ${g('iterations', 'count')}`,
    `  throughput (req/s)      ${g('http_reqs', 'rate')}`,
    `  http_req_failed         ${g('http_req_failed', 'rate')}`,
    '',
    '  latency (ms)            p50        p95        p99        max',
    `  overall                 ${g('http_req_duration', 'med').padEnd(10)} ${g('http_req_duration', 'p(95)').padEnd(10)} ${g('http_req_duration', 'p(99)').padEnd(10)} ${g('http_req_duration', 'max')}`,
    `  /health                 ${g('lat_health', 'med').padEnd(10)} ${g('lat_health', 'p(95)').padEnd(10)} ${g('lat_health', 'p(99)').padEnd(10)} ${g('lat_health', 'max')}`,
    `  POST /sign-in           ${g('lat_signin', 'med').padEnd(10)} ${g('lat_signin', 'p(95)').padEnd(10)} ${g('lat_signin', 'p(99)').padEnd(10)} ${g('lat_signin', 'max')}`,
    `  GET /api/users          ${g('lat_users_list', 'med').padEnd(10)} ${g('lat_users_list', 'p(95)').padEnd(10)} ${g('lat_users_list', 'p(99)').padEnd(10)} ${g('lat_users_list', 'max')}`,
    `  GET /api/users/:id      ${g('lat_user_by_id', 'med').padEnd(10)} ${g('lat_user_by_id', 'p(95)').padEnd(10)} ${g('lat_user_by_id', 'p(99)').padEnd(10)} ${g('lat_user_by_id', 'max')}`,
    '',
    `  429 (correct throttle)  ${g('rejected_rate_limited', 'rate')}`,
    `  403 (as-built throttle) ${g('forbidden_403', 'count')}`,
    `  5xx rate                ${g('server_errors', 'rate')}`,
    `  network failures        ${g('network_failures', 'count')}`,
    '',
  ];
  return lines.join('\n');
}
