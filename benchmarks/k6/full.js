// ---------------------------------------------------------------------------
// The v7 mix — the whole system, and the instrument for the final number.
//
//   k6 run -e VUS=100 -e RUN_TAG=v7-full benchmarks/k6/full.js
//
// WHY A THIRD SCRIPT. baseline.js is frozen (it is the v0↔v1 instrument) and realistic.js knows
// nothing about deals, so neither can exercise what Phases 3-5 added. This one drives the
// endpoints that the architecture claims are fast or correct:
//
//   GET  /api/deals            keyset page over 1,000,000 rows       (the F-47 index claim)
//   GET  /api/deals?offset=…   the same page by OFFSET               (the comparison)
//   GET  /api/deals/:id        indexed point read
//   POST /api/deals            write + outbox row, one transaction   (the dual-write claim)
//   POST /api/deals/:id/stage  SELECT … FOR UPDATE transition        (the locking claim)
//   GET  /api/notifications    the consumer's output                 (the pipeline claim)
//
// THE MIX IS READ-HEAVY AND WRITE-BEARING, which is the shape of the workload the schema was
// designed for: 1% sign-in (as in realistic.js), and writes at WRITE_RATIO — high enough that
// the outbox and the publisher are genuinely in the path, low enough that the run is not a
// write benchmark wearing a read benchmark's name.
//
// Every write carries an `Idempotency-Key`. Not for the retry semantics — k6 does not retry —
// but because the middleware is then in the measured path, so the cost of the feature appears
// in the number rather than being assumed to be zero.
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { BASE_URL, thresholds, stages, runTags, RUN_TAG, VUS, RESULTS_DIR } from './lib/config.js';
import { authenticateAdmin, SEED_USER_COUNT } from './lib/journey.js';
import {
  healthLatency,
  dealsKeysetLatency,
  dealsOffsetLatency,
  dealByIdLatency,
  dealCreateLatency,
  dealStageLatency,
  notificationsLatency,
  countIdempotentReplay,
  record,
} from './lib/metrics.js';

const WRITE_RATIO = Number(__ENV.WRITE_RATIO || 0.1);
const OFFSET_RATIO = Number(__ENV.OFFSET_RATIO || 0.1);
const HEALTH_RATIO = Number(__ENV.HEALTH_RATIO || 0.05);
// How deep the OFFSET probe pages. 100,000 is the endpoint's cap
// (src/validations/deals.validation.js) — deep enough for the difference to be unambiguous
// without letting a load test ask the database to scan a million rows per request.
const OFFSET_DEPTH = Number(__ENV.OFFSET_DEPTH || 100000);

export const options = {
  scenarios: {
    full_system: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: stages(),
      gracefulRampDown: '10s',
      tags: { scenario: 'full_system' },
    },
  },
  thresholds,
  tags: runTags(),
  noConnectionReuse: false,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  const data = authenticateAdmin();
  // One deal to advance and read by id, so those two paths are not measuring a 404. Created in
  // setup rather than per-iteration because setup runs once: a deal created per VU would make the
  // table grow during the run and change what the read paths are measuring.
  const res = http.post(
    `${BASE_URL}/api/deals`,
    JSON.stringify({ title: 'k6 anchor deal', company: 'Bench Co', amount_cents: 250000 }),
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: `token=${data.adminToken}`,
        'Idempotency-Key': `k6-anchor-${Date.now()}`,
      },
    }
  );
  const anchor = res.status === 201 ? res.json('deal') : null;
  if (!anchor) {
    throw new Error(
      `Could not create the anchor deal (status ${res.status}). Has the schema been migrated ` +
        'and is the admin seeded? Run `npm run db:migrate` and `npm run bench:seed`.'
    );
  }
  return { ...data, anchorId: anchor.id, anchorVersion: anchor.version };
}

export default function (data) {
  const jar = { headers: { Cookie: `token=${data.adminToken}` } };

  if (Math.random() < HEALTH_RATIO) {
    group('health', () => {
      const res = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'health' } });
      record(res, healthLatency);
      check(res, { 'health 200': (r) => r.status === 200 });
    });
  }

  group('deals_keyset', () => {
    const res = http.get(`${BASE_URL}/api/deals?limit=20`, {
      ...jar,
      tags: { endpoint: 'deals_keyset' },
    });
    record(res, dealsKeysetLatency);
    check(res, {
      'keyset page 200': (r) => r.status === 200,
      // Asserts the STRATEGY, not just the status. A regression that silently routed this to the
      // offset path would otherwise show up only as a latency change nobody could attribute.
      'keyset strategy reported': (r) =>
        r.status !== 200 || r.json('pagination.strategy') === 'keyset',
    });
  });

  if (Math.random() < OFFSET_RATIO) {
    group('deals_offset', () => {
      const res = http.get(`${BASE_URL}/api/deals?limit=20&offset=${OFFSET_DEPTH}`, {
        ...jar,
        tags: { endpoint: 'deals_offset' },
      });
      record(res, dealsOffsetLatency);
      check(res, { 'offset page answered': (r) => [200, 400].includes(r.status) });
    });
  }

  group('deal_by_id', () => {
    const res = http.get(`${BASE_URL}/api/deals/${data.anchorId}`, {
      ...jar,
      tags: { endpoint: 'deal_by_id' },
    });
    record(res, dealByIdLatency);
    check(res, { 'deal by id answered': (r) => [200, 404].includes(r.status) });
  });

  if (Math.random() < WRITE_RATIO) {
    group('deal_create', () => {
      const key = `k6-${__VU}-${__ITER}-${Date.now()}`;
      const res = http.post(
        `${BASE_URL}/api/deals`,
        JSON.stringify({
          title: `k6 deal ${__VU}-${__ITER}`,
          company: `Company ${Math.floor(Math.random() * SEED_USER_COUNT)}`,
          amount_cents: Math.floor(Math.random() * 5_000_000),
        }),
        {
          ...jar,
          headers: { ...jar.headers, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          tags: { endpoint: 'deal_create' },
        }
      );
      record(res, dealCreateLatency);
      if (res.headers['Idempotent-Replay'] === 'true') countIdempotentReplay.add(1);
      check(res, { 'deal created': (r) => r.status === 201 });
    });

    group('deal_stage', () => {
      // Every VU advances the SAME deal, which is the point: this is the contended write path, so
      // most attempts legitimately answer 409 (illegal transition once it is closed, or a lost
      // race). The check accepts 409 because a 409 here is the concurrency control working.
      const res = http.post(
        `${BASE_URL}/api/deals/${data.anchorId}/stage`,
        JSON.stringify({ to: 'screening' }),
        {
          ...jar,
          headers: { ...jar.headers, 'Content-Type': 'application/json' },
          tags: { endpoint: 'deal_stage' },
        }
      );
      record(res, dealStageLatency);
      check(res, { 'stage transition resolved': (r) => [200, 409, 404].includes(r.status) });
    });

    group('notifications', () => {
      const res = http.get(`${BASE_URL}/api/notifications?limit=10`, {
        ...jar,
        tags: { endpoint: 'notifications' },
      });
      record(res, notificationsLatency);
      check(res, { 'notifications 200': (r) => r.status === 200 });
    });
  }

  // Same 1s think time as the other closed-model scripts, so a VU count still corresponds to
  // something like a concurrent user.
  sleep(1);
}

export function handleSummary(data) {
  const out = {
    meta: {
      run_tag: RUN_TAG,
      vus: VUS,
      base_url: BASE_URL,
      model: 'closed (ramping-vus)',
      mix: 'full system (deals + events)',
      write_ratio: WRITE_RATIO,
      offset_ratio: OFFSET_RATIO,
      offset_depth: OFFSET_DEPTH,
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
  const row = (label, metric) =>
    `  ${label.padEnd(24)}${g(metric, 'med').padEnd(11)}${g(metric, 'p(95)').padEnd(11)}${g(metric, 'p(99)').padEnd(11)}${g(metric, 'max')}`;

  return [
    '',
    `  run_tag: ${RUN_TAG}   VUs: ${VUS}   mix: full system (writes ${(WRITE_RATIO * 100).toFixed(0)}%/iter)`,
    '  ---------------------------------------------------------------',
    `  iterations              ${g('iterations', 'count')}  (${g('iterations', 'rate')}/s)`,
    `  throughput (req/s)      ${g('http_reqs', 'rate')}`,
    `  http_req_failed         ${g('http_req_failed', 'rate')}`,
    '',
    '  latency (ms)            p50        p95        p99        max',
    row('overall', 'http_req_duration'),
    row('GET /deals (keyset)', 'lat_deals_keyset'),
    row(`GET /deals?offset=${OFFSET_DEPTH}`, 'lat_deals_offset'),
    row('GET /deals/:id', 'lat_deal_by_id'),
    row('POST /deals', 'lat_deal_create'),
    row('POST /deals/:id/stage', 'lat_deal_stage'),
    row('GET /notifications', 'lat_notifications'),
    '',
    `  429 (own limiter)       ${g('rejected_rate_limited', 'rate')}   <- must be 0 for a valid run`,
    `  409 (concurrency)       ${g('conflict_409', 'count')}   <- expected on the contended stage path`,
    `  503 (shed)              ${g('shed_503', 'count')}`,
    `  5xx rate                ${g('server_errors', 'rate')}`,
    `  idempotent replays      ${g('idempotent_replays', 'count')}`,
    `  network failures        ${g('network_failures', 'count')}`,
    '',
  ].join('\n');
}
