// ---------------------------------------------------------------------------
// Saturation test — open model, fixed arrival rate.
//
//   k6 run -e RATE=20 -e RUN_TAG=v1-saturation benchmarks/k6/saturation.js
//
// WHY THIS SCRIPT EXISTS alongside the closed-model ones:
//
// A closed model (ramping-vus) has each VU wait for its response before sending
// the next request, so when the server slows down the load generator slows down
// with it. The system is never pushed past what it can absorb and the latency
// distribution looks better than reality — coordinated omission. An open model
// (constant-arrival-rate) issues requests on a schedule regardless, and reports
// `dropped_iterations` when it cannot keep to that schedule. That is the honest
// saturation signal.
//
// ---------------------------------------------------------------------------
// FINDING F-17 — FIXED HERE. This script used to measure the wrong thing.
//
// The v0 version hit `GET /api`, a static JSON response with no database access
// and no bcrypt, and run-baseline.sh started these probes with
// BENCH_BYPASS_SECURITY=1 so the middleware was skipped as well. It therefore
// reported Express routing throughput on the pinned core — 500 req/s at p95
// 3.33 ms with zero drops — and never dropped an iteration even at 500 rps.
// Reading that as "the saturation point" would have been wrong by more than an
// order of magnitude: the real mix managed 27 req/s on the same core.
//
// That number was not useless — docs/INTERVIEW_PHASE_0.md §5 uses it as the proof
// that framework overhead is not the constraint, which is exactly the sort of
// claim a static-route probe CAN support. It just was not capacity.
//
// It now drives the same journey as realistic.js, against the real application
// with its real middleware, so `dropped_iterations` means what the docs say it
// means. Consequence worth expecting: the useful RATE values fall by roughly two
// orders of magnitude. v0 probed 50/200/500 rps and absorbed all of it; the real
// mix knees in the low tens, so the runner probes there instead. A probe whose
// every level passes has not found a limit.
// ---------------------------------------------------------------------------
import { BASE_URL, RUN_TAG, RESULTS_DIR } from './lib/config.js';
import { authenticateAdmin, readHeavyIteration, AUTH_RATIO } from './lib/journey.js';

const RATE = Number(__ENV.RATE || 10); // iterations per second
const DURATION = __ENV.DURATION || '1m';

// preAllocatedVUs must be generous: if k6 runs out of VUs it under-delivers the
// requested rate, which looks like the server coping when it is not. The v0 value
// was tuned for a static route answering in ~3 ms; the real mix takes far longer
// per iteration, so many more VUs are needed to sustain the same arrival rate.
const PRE_ALLOCATED = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(50, RATE * 20));
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
    dropped_iterations: ['count>=0'],
    http_req_duration: ['p(95)>=0'],
  },
  tags: { run_tag: RUN_TAG },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  return authenticateAdmin();
}

export default function (data) {
  // No think time. In an open model the arrival schedule sets the offered load, so
  // a sleep here would only occupy VUs and make k6 run out of them.
  readHeavyIteration(data);
}

export function handleSummary(data) {
  const stem = `${RESULTS_DIR}/${RUN_TAG}-rate${RATE}`;
  const dropped =
    (data.metrics.dropped_iterations && data.metrics.dropped_iterations.values.count) || 0;
  const completed = (data.metrics.iterations && data.metrics.iterations.values.count) || 0;
  const requests = (data.metrics.http_reqs && data.metrics.http_reqs.values.count) || 0;

  return {
    [`${stem}.json`]: JSON.stringify(
      {
        meta: {
          run_tag: RUN_TAG,
          model: 'open (constant-arrival-rate)',
          mix: 'realistic read-heavy (same journey as realistic.js)',
          auth_ratio: AUTH_RATIO,
          requested_rate_ips: RATE,
          duration: DURATION,
          base_url: BASE_URL,
          generated_at: new Date().toISOString(),
        },
        capacity: {
          requested_iterations: RATE * parseDurationSeconds(DURATION),
          completed_iterations: completed,
          completed_requests: requests,
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
    stdout:
      `\n  requested ${RATE} iter/s for ${DURATION}  (mix: realistic)\n` +
      `  completed iterations: ${completed}\n` +
      `  completed requests:   ${requests}\n` +
      `  dropped iterations:   ${dropped}\n` +
      `  p95: ${fmt(data.metrics.http_req_duration, 'p(95)')} ms   ` +
      `p99: ${fmt(data.metrics.http_req_duration, 'p(99)')} ms\n\n`,
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
