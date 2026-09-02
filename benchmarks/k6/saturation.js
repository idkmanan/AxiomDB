// ---------------------------------------------------------------------------
// Saturation test — open model, fixed arrival rate.
//
// Run:
//   k6 run -e RATE=200 -e RUN_TAG=v0-saturation benchmarks/k6/saturation.js
//
// Why this exists alongside baseline.js:
//
// baseline.js uses ramping-vus, a CLOSED model. Each VU waits for its response
// before sending the next request, so when the server slows down, the offered
// load drops with it. That hides the true breaking point — the classic
// coordinated-omission problem.
//
// This script uses constant-arrival-rate, an OPEN model: requests are issued on
// a schedule regardless of whether the server is keeping up. When the app cannot
// service them, k6 reports dropped_iterations, which is the honest signal that
// capacity has been exceeded. Being able to explain the difference between these
// two models is the point of shipping both.
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, RUN_TAG } from './lib/config.js';
import { apiRootLatency, record } from './lib/metrics.js';

const RATE = Number(__ENV.RATE || 100); // requests per second
const DURATION = __ENV.DURATION || '1m';

// preAllocatedVUs must be generous: if k6 runs out of VUs it under-delivers the
// requested rate, which looks like the server coping when it is not.
const PRE_ALLOCATED = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(50, RATE * 2));
const MAX_VUS = Number(__ENV.MAX_VUS || PRE_ALLOCATED * 4);

export const options = {
  scenarios: {
    saturation: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED,
      maxVUs: MAX_VUS,
      tags: { scenario: 'saturation' },
    },
  },
  thresholds: {
    // dropped_iterations is the metric that matters here. Anything above zero
    // means the requested arrival rate exceeded what the system could absorb.
    dropped_iterations: ['count>=0'],
    http_req_duration: ['p(95)>=0'],
  },
  tags: { run_tag: RUN_TAG },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  const res = http.get(`${BASE_URL}/health`, { timeout: '10s' });
  if (res.status !== 200) {
    throw new Error(`Target not healthy at ${BASE_URL}/health (status ${res.status}).`);
  }
}

export default function () {
  // Deliberately hits the unauthenticated /api endpoint so this measures
  // request-path capacity without bcrypt dominating the result.
  const res = http.get(`${BASE_URL}/api`, { tags: { endpoint: 'api_root' } });
  record(res, apiRootLatency);
  check(res, { 'answered': (r) => r.status !== 0 });
}

export function handleSummary(data) {
  const stem = `benchmarks/v0-baseline/results/${RUN_TAG}-rate${RATE}`;
  const dropped =
    (data.metrics.dropped_iterations && data.metrics.dropped_iterations.values.count) || 0;
  const completed = (data.metrics.http_reqs && data.metrics.http_reqs.values.count) || 0;

  return {
    [`${stem}.json`]: JSON.stringify(
      {
        meta: {
          run_tag: RUN_TAG,
          model: 'open (constant-arrival-rate)',
          requested_rate_rps: RATE,
          duration: DURATION,
          generated_at: new Date().toISOString(),
        },
        capacity: {
          requested_total: RATE * parseDurationSeconds(DURATION),
          completed_total: completed,
          dropped_iterations: dropped,
          note:
            dropped > 0
              ? 'Arrival rate exceeded system capacity — this is the saturation point.'
              : 'System absorbed the full offered load; raise RATE to find the limit.',
        },
        metrics: data.metrics,
      },
      null,
      2
    ),
    stdout: `\n  requested ${RATE} rps for ${DURATION}\n  completed: ${completed}\n  dropped:   ${dropped}\n  p95:       ${fmt(data.metrics.http_req_duration, 'p(95)')} ms\n  p99:       ${fmt(data.metrics.http_req_duration, 'p(99)')} ms\n\n`,
  };
}

function fmt(metric, stat) {
  const v = metric && metric.values && metric.values[stat];
  return typeof v === 'number' ? v.toFixed(2) : 'n/a';
}

function parseDurationSeconds(d) {
  const m = /^(\d+)([smh])$/.exec(d);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600;
}
