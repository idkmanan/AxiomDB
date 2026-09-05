#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Turns raw k6 JSON into the markdown table that goes in a phase SUMMARY.md.
//
//   node benchmarks/scripts/report.mjs
//   node benchmarks/scripts/report.mjs --phase v1 \
//        --dir benchmarks/v1-correctness/results \
//        --out benchmarks/v1-correctness/SUMMARY.md \
//        --compare benchmarks/v0-baseline/results
//
// Exists so the numbers in the docs are GENERATED from committed raw output and
// never hand-typed. If a reviewer doubts a figure, they run this and get the same
// table. That is the difference between a claim and evidence.
//
// `--compare` is new in Phase 1 and is the deliverable of the phase: a v0-vs-v1
// delta computed by a script rather than asserted in prose. It refuses to compare
// rows produced by different instruments, and refuses to compare censored rows —
// see the guards in the compare section, which exist because F-13 showed a
// censored row will happily report an "improvement" that is only a shift in where
// the queue overflowed.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const PHASE = getArg('phase', 'v0');
const DEFAULT_DIR = PHASE === 'v0' ? 'benchmarks/v0-baseline' : `benchmarks/${PHASE}-correctness`;
const DIR = getArg('dir', `${DEFAULT_DIR}/results`);
const OUT = getArg('out', `${DEFAULT_DIR}/SUMMARY.md`);
const COMPARE_DIR = getArg('compare', null);

if (!existsSync(DIR)) {
  console.error(`no results directory: ${DIR}`);
  console.error(`run: PHASE=${PHASE} ./benchmarks/scripts/run-phase.sh`);
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.summary.json'));

if (files.length === 0) {
  console.error(`no result files in ${DIR}`);
  process.exit(1);
}

/**
 * Which k6 script produced a row.
 *
 * This is load-bearing for `--compare`. `baseline.js` runs the frozen 25%-auth mix
 * and is the only instrument whose rows may be compared across phases;
 * `realistic.js` runs a ~0.5%-auth mix whose series starts at v1. Comparing the
 * two would be comparing different workloads and calling the difference an
 * improvement.
 */
function instrumentOf(doc, tag) {
  if (doc.meta && doc.meta.mix) {
    return doc.meta.mix.startsWith('realistic') ? 'realistic' : 'frozen';
  }
  if (tag.includes('realistic')) return 'realistic';
  // v0 result files predate the `mix` field; every one of them is baseline.js.
  return 'frozen';
}

const num = (m, stat) => {
  const v = m && m.values && m.values[stat];
  return typeof v === 'number' ? v : null;
};
const fmt = (v, digits = 2) => (v === null ? '—' : v.toFixed(digits));
const pct = (v) => (v === null ? '—' : (v * 100).toFixed(2) + '%');

const rows = [];
for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  } catch {
    console.warn(`skipping unparseable ${f}`);
    continue;
  }
  const m = doc.metrics || {};
  // Latency of the requests that actually got an answer. The blended
  // http_req_duration includes abandoned requests, whose "duration" is the
  // client timeout, not a server response time — see the censoring note below.
  const served = m['http_req_duration{expected_response:true}'];
  const netfail = num(m.network_failures, 'count') || 0;
  rows.push({
    file: f,
    tag: (doc.meta && doc.meta.run_tag) || 'unknown',
    vus: (doc.meta && doc.meta.vus) || null,
    rps: num(m.http_reqs, 'rate'),
    reqs: num(m.http_reqs, 'count'),
    itersRate: num(m.iterations, 'rate'),
    iters: num(m.iterations, 'count'),
    p50: num(m.http_req_duration, 'med'),
    p95: num(m.http_req_duration, 'p(95)'),
    p99: num(m.http_req_duration, 'p(99)'),
    max: num(m.http_req_duration, 'max'),
    servedP50: num(served, 'med'),
    servedP95: num(served, 'p(95)'),
    servedN: num(served, 'count'),
    failed: num(m.http_req_failed, 'rate'),
    e5xx: num(m.server_errors, 'rate'),
    n4xx: num(m.client_errors, 'passes'),
    n5xx: num(m.server_errors, 'passes'),
    n429: num(m.rejected_rate_limited, 'passes'),
    throttled403: num(m.forbidden_403, 'count'),
    netfail,
    // A run with abandoned requests has a censored latency distribution: every
    // quantile at or beyond the abandonment point is the timeout value.
    censored: netfail > 0,
    signinP95: num(m.lat_signin, 'p(95)'),
    usersListP95: num(m.lat_users_list, 'p(95)'),
    healthP95: num(m.lat_health, 'p(95)'),
    dropped: num(m.dropped_iterations, 'count'),
    requestedRate:
      (doc.meta && (doc.meta.requested_rate_rps ?? doc.meta.requested_rate_ips)) || null,
    instrument: instrumentOf(doc, (doc.meta && doc.meta.run_tag) || ''),
  });
}

rows.sort((a, b) => a.tag.localeCompare(b.tag) || (a.vus || 0) - (b.vus || 0));

// Open-model (saturation) runs are reported in their own section. Including them
// in the closed-model tables produces rows with no VU count and no per-endpoint
// data, which reads as missing data rather than as a different kind of test.
const closed = rows.filter((r) => !r.tag.includes('saturation'));
const sat = rows.filter((r) => r.tag.includes('saturation'));

const lines = [];
const PHASE_TITLE = {
  v0: 'v0 baseline — measured results',
  v1: 'v1 correctness & security — measured results',
};
lines.push(`# ${PHASE_TITLE[PHASE] || `${PHASE} — measured results`}`);
lines.push('');
lines.push('Generated by `benchmarks/scripts/report.mjs` from the raw k6 JSON in');
lines.push('`results/`. Do not edit by hand — regenerate instead.');
lines.push('');
if (PHASE !== 'v0') {
  lines.push('Two instruments appear below and they are NOT interchangeable:');
  lines.push('');
  lines.push('- **frozen** — `benchmarks/k6/baseline.js`, the 25%-authentication mix the v0');
  lines.push('  matrix was measured with. The only rows comparable across phases.');
  lines.push('- **realistic** — `benchmarks/k6/realistic.js`, roughly 0.5% authentication.');
  lines.push('  A better description of a read-heavy workload, and a series that starts');
  lines.push('  here. Never compare a realistic row against a v0 row.');
  lines.push('');
}

let env = null;
const envPath = join(DIR, '..', 'environment.json');
if (existsSync(envPath)) {
  env = JSON.parse(readFileSync(envPath, 'utf8'));
  // The fingerprint writer substitutes the literal string 'unavailable' when a
  // git command fails, so a missing tag arrives as truthy text rather than null.
  // Left unnormalised it renders as "(tag `unavailable`)" and, worse, makes the
  // Reproduce block emit `git checkout unavailable`.
  const tag = env.git.tag && env.git.tag !== 'unavailable' ? env.git.tag : null;
  env.git.tag = tag;
  lines.push('## Environment');
  lines.push('');
  lines.push(`- commit: \`${env.git.commit}\`${env.git.tag ? ` (tag \`${env.git.tag}\`)` : ''}`);
  if (env.git.src_tree && env.git.src_tree !== 'unavailable') {
    lines.push(
      `- src/ tree: \`${env.git.src_tree}\` — comparable across any commit with this hash`
    );
  }
  lines.push(`- host: ${env.host.cpu_count} × ${env.host.cpu_model}, ${env.host.total_mem_mb} MB`);
  lines.push(`- node: ${env.tooling.node} · k6: ${env.tooling.k6}`);
  lines.push(`- captured: ${env.captured_at}`);
  lines.push('');
  lines.push('Container limits are pinned in `.env.bench` (`APP_CPUS`, `PG_CPUS`).');
  lines.push('Changing them invalidates comparison with these numbers.');
  lines.push('');
}

lines.push('## Closed model — what N concurrent clients experience');
lines.push('');
lines.push(
  '| run | VUs | iter/s | req/s | p50 ms | p95 ms | p99 ms | p95 served ms | failed | 5xx |'
);
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of closed) {
  const mark = r.censored ? '†' : '';
  lines.push(
    `| ${r.tag} | ${r.vus ?? '—'} | ${fmt(r.itersRate)} | ${fmt(r.rps)} | ${fmt(r.p50)}${mark} | ${fmt(r.p95)}${mark} | ${fmt(r.p99)}${mark} | ${fmt(r.servedP95)} | ${pct(r.failed)} | ${pct(r.e5xx)} |`
  );
}
lines.push('');
lines.push('**† = timeout-censored. Do not quote these as latency.** In a row with any');
lines.push('abandoned request, every quantile at or past the abandonment point equals the');
lines.push('client timeout rather than a measured server response time, so `p95` there says');
lines.push('"the client gave up", not "the server took this long". `p95 served` is the p95');
lines.push('over `http_req_duration{expected_response:true}` — the requests that actually');
lines.push('got an answer — and is the only latency figure on a censored row that means');
lines.push('anything. `iter/s` is the honest capacity number: one iteration is one');
lines.push('/health + one sign-in + one users list + one user-by-id.');
lines.push('');
lines.push('The blended p95 above is reported for completeness but is the *least*');
lines.push('useful number here: it mixes a no-I/O health check with a bcrypt signin');
lines.push('and an unbounded table scan. Use the per-endpoint table below.');
lines.push('');

// Failure attribution. Without this split, a high `failed` rate reads as "the
// server is erroring" when it can equally mean "the client stopped waiting" —
// two findings with opposite fixes.
lines.push('## Failure attribution — what "failed" actually was');
lines.push('');
lines.push('| run | VUs | requests | answered | abandoned (status 0) | 4xx | 5xx | 429 | 403 |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of closed) {
  lines.push(
    `| ${r.tag} | ${r.vus ?? '—'} | ${r.reqs ?? '—'} | ${r.servedN ?? '—'} | ${r.netfail ?? 0} | ${r.n4xx ?? 0} | ${r.n5xx ?? 0} | ${r.n429 ?? 0} | ${r.throttled403 ?? 0} |`
  );
}
lines.push('');
lines.push('`abandoned` is k6 status 0: no HTTP response was received at all. It is not an');
lines.push('application error — the app never got the chance to return one. A run whose');
lines.push('failures are entirely status 0, with 4xx/5xx/429/403 all zero, is a run where');
lines.push('offered load exceeded capacity and the load generator timed out waiting. The');
lines.push('fix for that is capacity or a smaller offered load, never error handling.');
lines.push('');
lines.push('`failure-attribution.txt` splits status 0 by k6 `error_code`, taken from the');
lines.push('per-request `--out json` streams: **1220** (`read: connection reset by peer`,');
lines.push('an RST from the server side, clustered at 15001 ms) and **1050** (`request');
lines.push('timeout`, k6 giving up at its 60 s default). Regenerate it with');
lines.push('`node benchmarks/scripts/attribute-failures.mjs`.');
lines.push('');

// The knee is the largest concurrency level that produced no abandonment. Every
// before/after claim has to be anchored at or below it, so it is computed here
// rather than left for a reader to eyeball off the table.
const knees = new Map();
for (const r of closed) {
  if (!r.vus) continue;
  const variant = r.tag;
  const prev = knees.get(variant);
  if (!r.censored && (!prev || r.vus > prev)) knees.set(variant, r.vus);
}
if (knees.size) {
  lines.push('### Knee');
  lines.push('');
  for (const [variant, vus] of [...knees.entries()].sort()) {
    const row = closed.find((r) => r.tag === variant && r.vus === vus);
    const next = closed
      .filter((r) => r.tag === variant && r.vus > vus)
      .sort((a, b) => a.vus - b.vus)[0];
    lines.push(
      `- \`${variant}\`: last clean level is **${vus} VUs** — ${fmt(row.itersRate)} iter/s, ` +
        `p95 ${fmt(row.p95)} ms, zero abandoned` +
        (next ? `; at ${next.vus} VUs abandonment starts (${pct(next.failed)}).` : '.')
    );
  }
  lines.push('');
  lines.push('Quote the knee row, not the rows above it. Anything past the knee is partly a');
  lines.push('measurement of how long the load generator was willing to wait.');
  lines.push('');
}

lines.push('## Per-endpoint p95 (ms)');
lines.push('');
lines.push('| run | VUs | /health | POST /sign-in | GET /api/users | 403 throttled | net fails |');
lines.push('|---|---:|---:|---:|---:|---:|---:|');
for (const r of closed) {
  lines.push(
    `| ${r.tag} | ${r.vus ?? '—'} | ${fmt(r.healthP95)} | ${fmt(r.signinP95)} | ${fmt(r.usersListP95)} | ${r.throttled403 ?? '—'} | ${r.netfail ?? '—'} |`
  );
}
lines.push('');
lines.push('`GET /api/users` is measured with an admin session (see `setup()` in');
lines.push("`benchmarks/k6/baseline.js`). Without one, `authorize('admin')` rejects the");
lines.push('request before the controller runs and the unbounded scan is never executed —');
lines.push('the number would be the cost of a middleware rejection, not of the query.');
lines.push('');

if (sat.length) {
  lines.push('## Open model — where capacity runs out');
  lines.push('');
  lines.push('| run | rate req/s | completed | dropped | p95 ms | p99 ms |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const r of sat) {
    lines.push(
      `| ${r.file.replace(/\.json$/, '')} | ${r.requestedRate ?? '—'} | ${r.iters ?? '—'} | ${r.dropped ?? 0} | ${fmt(r.p95)} | ${fmt(r.p99)} |`
    );
  }
  lines.push('');
  lines.push('`dropped` is k6 `dropped_iterations`: requests the load generator could not');
  lines.push('start on schedule because the system was not keeping up. Any value above zero');
  lines.push('is the saturation point. A closed-model test cannot surface this — when the');
  lines.push('server slows, closed-model VUs slow with it and the offered load silently');
  lines.push('drops (coordinated omission).');
  lines.push('');
  lines.push("**Scope caveat — this is not the application's capacity.** `saturation.js`");
  if (PHASE === 'v0') {
    lines.push('hits `GET /api`, which returns a static object with no database access and no');
    lines.push('bcrypt, and `run-baseline.sh` starts these runs with `BENCH_BYPASS_SECURITY=1`');
    lines.push('so the middleware is skipped too. What these rows measure is Express routing');
    lines.push('throughput on the pinned CPU, which is why nothing was ever dropped. The');
    lines.push('capacity of the real endpoint mix is the `iter/s` column of the closed-model');
    lines.push('table, an order of magnitude lower. Pointing this scenario at the same mix as');
    lines.push('`baseline.js` is what would turn it into an actual knee measurement.');
  } else {
    lines.push('now drives the same read-heavy journey as `realistic.js` against the real');
    lines.push('application with its real middleware — finding F-17 fixed. So `dropped` on');
    lines.push('these rows is a genuine capacity signal rather than a measurement of Express');
    lines.push('routing. The requested rate is in ITERATIONS per second, not requests, and the');
    lines.push('useful range is two orders of magnitude below v0’s: v0 probed 50/200/500 rps');
    lines.push('against a static route and absorbed all of it, which is exactly the reading');
    lines.push('this change removes. These rows must not be compared against the v0');
    lines.push('open-model rows — different endpoint, different unit, different question.');
  }
  lines.push('');
}

// Variant comparison: quantifies exactly how much of the baseline latency was
// the Arcjet round-trip rather than this application.
const byVus = new Map();
for (const r of closed) {
  if (!r.vus) continue;
  if (!byVus.has(r.vus)) byVus.set(r.vus, {});
  if (r.tag.includes('asbuilt')) byVus.get(r.vus).asbuilt = r;
  if (r.tag.includes('nolimit')) byVus.get(r.vus).nolimit = r;
}
const pairs = [...byVus.entries()].filter(([, v]) => v.asbuilt && v.nolimit);
if (pairs.length) {
  lines.push('## Attribution: how much of the baseline was Arcjet?');
  lines.push('');
  lines.push('Comparing blended p95 across variants is only valid where neither row is');
  lines.push('censored: once both runs are pinned at the client timeout, their p95 difference');
  lines.push('is zero by construction and would understate Arcjet to nothing. Above the knee');
  lines.push('the cost shows up as lost throughput and extra abandonment instead, so both');
  lines.push('are reported.');
  lines.push('');
  lines.push(
    '| VUs | p95 as-built | p95 bypassed | delta ms | share of p95 | iter/s as-built | iter/s bypassed | throughput lost | failed as-built | failed bypassed |'
  );
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [vus, v] of pairs) {
    const cens = v.asbuilt.censored || v.nolimit.censored;
    const d =
      !cens && v.asbuilt.p95 !== null && v.nolimit.p95 !== null
        ? v.asbuilt.p95 - v.nolimit.p95
        : null;
    const share = d !== null && v.asbuilt.p95 ? d / v.asbuilt.p95 : null;
    const lost =
      v.asbuilt.itersRate !== null && v.nolimit.itersRate
        ? 1 - v.asbuilt.itersRate / v.nolimit.itersRate
        : null;
    lines.push(
      `| ${vus} | ${fmt(v.asbuilt.p95)}${v.asbuilt.censored ? '†' : ''} | ${fmt(v.nolimit.p95)}${v.nolimit.censored ? '†' : ''} | ${d === null ? 'censored' : fmt(d)} | ${d === null ? 'censored' : pct(share)} | ${fmt(v.asbuilt.itersRate)} | ${fmt(v.nolimit.itersRate)} | ${pct(lost)} | ${pct(v.asbuilt.failed)} | ${pct(v.nolimit.failed)} |`
    );
  }
  lines.push('');
  lines.push('This is why both variants are run. Attributing the whole baseline p95 to');
  lines.push('application code, when a third-party network hop was inside the request');
  lines.push('path, would overstate every later improvement.');
  lines.push('');
  lines.push('Note what the 403 column of the failure table shows: **zero**. The as-built');
  lines.push('sliding window at `src/middleware/security.middleware.js:25` runs in `LIVE`');
  lines.push('mode with a limit of 5 requests/minute for `guest`, yet nothing was ever');
  lines.push('throttled — because `ARCJET_KEY` is empty for the baseline and an errored');
  lines.push('decision is treated as allow (finding F-07). Arcjet was in the request path');
  lines.push('costing latency, but it was never enforcing anything. Supplying a working key');
  lines.push('would not fix these runs, it would end them: at 5 requests/minute per IP,');
  lines.push('every VU shares one source address and the whole matrix becomes 403s.');
  lines.push('');
}

// ---------------------------------------------------------------------------
// Cross-phase comparison. The Phase 1 deliverable, computed rather than asserted.
// ---------------------------------------------------------------------------
if (COMPARE_DIR) {
  lines.push(`## Comparison against \`${COMPARE_DIR}\``);
  lines.push('');

  if (!existsSync(COMPARE_DIR)) {
    lines.push(`Directory not found, so no comparison was produced.`);
    lines.push('');
  } else {
    const prior = new Map();
    for (const f of readdirSync(COMPARE_DIR).filter((x) => x.endsWith('.json'))) {
      let doc;
      try {
        doc = JSON.parse(readFileSync(join(COMPARE_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      const m = doc.metrics || {};
      const tag = (doc.meta && doc.meta.run_tag) || '';
      if (tag.includes('saturation')) continue;
      const inst = instrumentOf(doc, tag);
      if (inst !== 'frozen') continue;
      const vus = (doc.meta && doc.meta.vus) || null;
      if (!vus) continue;
      const nf = num(m.network_failures, 'count') || 0;
      const row = {
        tag,
        vus,
        p95: num(m.http_req_duration, 'p(95)'),
        itersRate: num(m.iterations, 'rate'),
        rps: num(m.http_reqs, 'rate'),
        usersListP95: num(m.lat_users_list, 'p(95)'),
        healthP95: num(m.lat_health, 'p(95)'),
        censored: nf > 0,
      };
      // v0 recorded two variants per level. `asbuilt` is what the code actually
      // did, so that is the honest "before" — comparing against the bypassed
      // variant would credit Phase 1 with removing something it did not remove.
      const existing = prior.get(vus);
      if (!existing || tag.includes('asbuilt')) prior.set(vus, row);
    }

    const nowFrozen = closed.filter((r) => r.instrument === 'frozen' && r.vus);
    const usable = [];
    const skipped = [];
    for (const cur of nowFrozen) {
      const before = prior.get(cur.vus);
      if (!before) continue;
      // F-13: a censored row's quantiles equal the client timeout, not a response
      // time, so a delta between them measures where the queue overflowed. Refused
      // rather than printed with a footnote, because a printed number gets quoted.
      if (before.censored || cur.censored) {
        skipped.push({
          vus: cur.vus,
          why: before.censored && cur.censored ? 'both censored' : 'one censored',
        });
        continue;
      }
      usable.push({ before, cur });
    }

    if (!usable.length) {
      lines.push('No comparable pair: every level was timeout-censored on one side or the');
      lines.push('other, and a delta between censored rows measures the client timeout rather');
      lines.push('than latency (finding F-13).');
      lines.push('');
    } else {
      lines.push('Frozen instrument only (`baseline.js`, 25% authentication), uncensored rows');
      lines.push('only. Both constraints are enforced by the script, not by convention.');
      lines.push('');
      lines.push(
        '| VUs | p95 before | p95 after | p95 Δ | iter/s before | iter/s after | throughput Δ | users-list p95 before | after |'
      );
      lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
      for (const { before, cur } of usable) {
        const dP95 =
          before.p95 !== null && cur.p95 !== null ? (cur.p95 - before.p95) / before.p95 : null;
        const dThru =
          before.itersRate && cur.itersRate !== null
            ? (cur.itersRate - before.itersRate) / before.itersRate
            : null;
        const sign = (v) => (v === null ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%');
        lines.push(
          `| ${cur.vus} | ${fmt(before.p95)} | ${fmt(cur.p95)} | ${sign(dP95)} | ${fmt(before.itersRate)} | ${fmt(cur.itersRate)} | ${sign(dThru)} | ${fmt(before.usersListP95)} | ${fmt(cur.usersListP95)} |`
        );
      }
      lines.push('');
      lines.push('A negative p95 Δ and a positive throughput Δ is the improvement. Read them');
      lines.push('together: a latency drop with flat throughput can also mean requests are');
      lines.push('being rejected quickly, which is why the runner refuses any run where the');
      lines.push('rate limiter fired.');
      lines.push('');
    }

    if (skipped.length) {
      lines.push(
        'Excluded as censored: ' + skipped.map((s) => `${s.vus} VUs (${s.why})`).join(', ') + '.'
      );
      lines.push('');
    }
  }
}

lines.push('## Reproduce');
lines.push('');
lines.push('```bash');
lines.push('cp .env.bench.example .env.bench');
lines.push(`git checkout ${env ? env.git.tag || env.git.short : `${PHASE}-baseline`}`);
lines.push(`PHASE=${PHASE} ./benchmarks/scripts/run-phase.sh`);
lines.push(
  `node benchmarks/scripts/report.mjs --phase ${PHASE} --dir ${DIR} --out ${OUT}${
    PHASE === 'v0' ? '' : ' \\\n     --compare benchmarks/v0-baseline/results'
  }`
);
lines.push(`node benchmarks/scripts/attribute-failures.mjs --dir ${DIR}`);
lines.push('```');
lines.push('');
lines.push('Every level set is env-overridable, so a quick partial probe needs no code');
lines.push('change:');
lines.push('');
lines.push('```bash');
lines.push(`VU_LEVELS="5 10" REALISTIC_LEVELS="" SAT_RATES="10" \\`);
lines.push(`  PHASE=${PHASE} ./benchmarks/scripts/run-phase.sh`);
lines.push('```');
lines.push('');
lines.push('The default frozen-instrument matrix is all seven levels because the report');
lines.push('needs both sides of the knee. Extrapolated from the Phase 0 run at ~4.4 minutes');
lines.push('per closed-model run including cool-down, the defaults come to roughly 50');
lines.push('minutes.');
lines.push('');

const md = lines.join('\n');
writeFileSync(OUT, md);
console.log(md);
console.error(`\n[report] wrote ${OUT} from ${rows.length} result file(s)`);
