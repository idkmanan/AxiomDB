// ---------------------------------------------------------------------------
// Realistic-mix load test — closed model.
//
//   k6 run -e VUS=50 -e RUN_TAG=v1-realistic benchmarks/k6/realistic.js
//
// NEW IN PHASE 1, and it exists because of the honest admission in
// docs/INTERVIEW_PHASE_0.md §14: baseline.js runs a mix that is exactly 25%
// authentication, and no read-heavy workload looks like that. bcrypt at cost 10
// measures 54.8 ms per compare (F-05), so a quarter of requests running a key
// derivation made bcrypt 37% of the per-iteration CPU budget and depressed every
// throughput number in the matrix.
//
// This script issues roughly one sign-in per 200 requests (AUTH_RATIO=0.01 across
// two reads per iteration) plus probe traffic at HEALTH_RATIO. That is the mix
// worth quoting as capacity.
//
// WHY THIS IS A SEPARATE FILE rather than a change to baseline.js. BENCHMARKING.md
// freezes the k6 scripts across phases: a comparison is only a comparison while
// the instrument is constant. Fixing the mix inside baseline.js would have
// invalidated the committed v0 matrix and required a ~75 minute re-run of Phase 0
// before Phase 1 could claim anything. So baseline.js stays the before/after
// instrument and this becomes a second, better instrument whose own series starts
// at v1. Two numbers with different meanings, each internally comparable — rather
// than one number that quietly changed meaning between phases.
// ---------------------------------------------------------------------------
import { sleep } from 'k6';
import { BASE_URL, thresholds, stages, runTags, RUN_TAG, VUS, RESULTS_DIR } from './lib/config.js';
import { authenticateAdmin, readHeavyIteration, AUTH_RATIO, HEALTH_RATIO } from './lib/journey.js';

export const options = {
  scenarios: {
    read_heavy_realistic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: '10s',
      tags: { scenario: 'read_heavy_realistic' },
    },
  },
  thresholds,
  tags: runTags(),
  noConnectionReuse: false,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  return authenticateAdmin();
}

export default function (data) {
  readHeavyIteration(data);
  // Same 1s think time as baseline.js, so VU count keeps corresponding to
  // something like concurrent users rather than to an infinite-rate hammer.
  sleep(1);
}

export function handleSummary(data) {
  const out = {
    meta: {
      run_tag: RUN_TAG,
      vus: VUS,
      base_url: BASE_URL,
      model: 'closed (ramping-vus)',
      mix: 'realistic read-heavy',
      auth_ratio: AUTH_RATIO,
      health_ratio: HEALTH_RATIO,
      generated_at: new Date().toISOString(),
    },
    metrics: data.metrics,
  };
  const stem = `${RESULTS_DIR}/${RUN_TAG}-vus${VUS}`;
  return {
    [`${stem}.json`]: JSON.stringify(out, null, 2),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const g = (name, stat) => {
    const v = m[name] && m[name].values && m[name].values[stat];
    return typeof v === 'number' ? v.toFixed(2) : 'n/a';
  };
  return [
    '',
    `  run_tag: ${RUN_TAG}   VUs: ${VUS}   mix: realistic (auth ${(AUTH_RATIO * 100).toFixed(1)}%/iter)`,
    '  ---------------------------------------------------------------',
    `  iterations              ${g('iterations', 'count')}  (${g('iterations', 'rate')}/s)`,
    `  throughput (req/s)      ${g('http_reqs', 'rate')}`,
    `  http_req_failed         ${g('http_req_failed', 'rate')}`,
    '',
    '  latency (ms)            p50        p95        p99        max',
    `  overall                 ${g('http_req_duration', 'med').padEnd(10)} ${g('http_req_duration', 'p(95)').padEnd(10)} ${g('http_req_duration', 'p(99)').padEnd(10)} ${g('http_req_duration', 'max')}`,
    `  GET /api/users          ${g('lat_users_list', 'med').padEnd(10)} ${g('lat_users_list', 'p(95)').padEnd(10)} ${g('lat_users_list', 'p(99)').padEnd(10)} ${g('lat_users_list', 'max')}`,
    `  GET /api/users/:id      ${g('lat_user_by_id', 'med').padEnd(10)} ${g('lat_user_by_id', 'p(95)').padEnd(10)} ${g('lat_user_by_id', 'p(99)').padEnd(10)} ${g('lat_user_by_id', 'max')}`,
    `  POST /sign-in           ${g('lat_signin', 'med').padEnd(10)} ${g('lat_signin', 'p(95)').padEnd(10)} ${g('lat_signin', 'p(99)').padEnd(10)} ${g('lat_signin', 'max')}`,
    `  /health                 ${g('lat_health', 'med').padEnd(10)} ${g('lat_health', 'p(95)').padEnd(10)} ${g('lat_health', 'p(99)').padEnd(10)} ${g('lat_health', 'max')}`,
    '',
    `  429 (own limiter)       ${g('rejected_rate_limited', 'rate')}   <- must be 0 for a valid run`,
    `  5xx rate                ${g('server_errors', 'rate')}`,
    `  network failures        ${g('network_failures', 'count')}`,
    '',
  ].join('\n');
}
