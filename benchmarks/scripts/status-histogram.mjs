#!/usr/bin/env node
// ---------------------------------------------------------------------------
// What, exactly, returned a 5xx — by status, endpoint and method.
//
//   node benchmarks/scripts/status-histogram.mjs benchmarks/v1-correctness/results/v1-baseline-vus20.samples.json.gz
//
// WHY THIS EXISTS. `assert_clean_run` in run-phase.sh can tell you that a run
// produced "6 non-503 5xx responses" because the aggregate metrics carry counts. It
// cannot tell you WHICH status on WHICH endpoint, because the aggregate has no
// breakdown — and those are the only two facts that make the number actionable.
//
// That is the same defect as finding F-12, one level down: a correct number that
// reliably sends the reader to the wrong place. F-12 was about a failure RATE being
// unattributable; this is about a failure COUNT being unattributable. Both are
// fixed the same way — read the per-request stream that already has the answer.
//
// The stream is `k6 run --out json=…`: newline-delimited JSON, gzipped, gitignored
// because it is ~10 MB per matrix. Every `http_req_duration` point carries the
// response status and the request name in its tags.
// ---------------------------------------------------------------------------
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error(`usage: node benchmarks/scripts/status-histogram.mjs <run>.samples.json.gz`);
  process.exit(1);
}

const buckets = new Map();
let total = 0;

const rl = createInterface({
  input: createReadStream(file).pipe(createGunzip()),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  // Cheap prefilter: the stream is mostly other metrics.
  if (!line.includes('"http_req_duration"')) continue;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    continue;
  }
  if (d.metric !== 'http_req_duration' || d.type !== 'Point') continue;
  total += 1;

  const t = d.data.tags || {};
  const status = String(t.status ?? '0');
  // Only the interesting ones. A 2xx breakdown is noise here.
  if (status === '0' || Number(status) < 400) continue;

  // `name` is the URL with path parameters still substituted, so /api/users/417
  // and /api/users/9 would be separate keys. Collapse the numeric segments.
  const endpoint = String(t.name ?? t.url ?? '?').replace(/\/\d+(?=$|\/|\?)/g, '/:id');
  const key = `${status} ${t.method ?? '?'} ${endpoint}`;
  const b = buckets.get(key) || { n: 0, ms: [] };
  b.n += 1;
  b.ms.push(d.data.value);
  buckets.set(key, b);
}

if (buckets.size === 0) {
  console.log(`no 4xx/5xx responses in ${file} (${total} requests)`);
  process.exit(0);
}

const rows = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
const med = (ms) => {
  const s = [...ms].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log(`\n  ${file}  (${total} requests)\n`);
console.log('    count  median ms  status method endpoint');
console.log('    -----  ---------  ------------------------------------------');
for (const [key, b] of rows) {
  console.log(`    ${String(b.n).padStart(5)}  ${med(b.ms).toFixed(0).padStart(9)}  ${key}`);
}

// The distinction that matters, spelled out rather than left to be inferred.
const shed = rows.filter(([k]) => k.startsWith('503')).reduce((n, [, b]) => n + b.n, 0);
const other5xx = rows
  .filter(([k]) => Number(k.slice(0, 3)) >= 500 && !k.startsWith('503'))
  .reduce((n, [, b]) => n + b.n, 0);
console.log('');
if (shed) console.log(`    ${shed} × 503 — load shed, expected past the knee`);
if (other5xx) {
  console.log(`    ${other5xx} × non-503 5xx — application error; check the app log:`);
  console.log(
    `      docker compose -f docker-compose.bench.yml --env-file .env.bench logs app \\
        | grep '"kind":"unknown"' | tail -5`
  );
}
console.log('');
