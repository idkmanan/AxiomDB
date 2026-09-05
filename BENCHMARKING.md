# Benchmarking

How to reproduce every latency number this project claims.

## Prerequisites

- Docker with Compose v2 (`docker compose version`)
- k6 — https://grafana.com/docs/k6/latest/set-up/install-k6/
- Node 22+

## Run a phase

```bash
cp .env.bench.example .env.bench

npm run bench:v1            # Phase 1: ~50 min with the default level sets
npm run bench:report:v1     # SUMMARY.md, including the v0 -> v1 delta table
npm run bench:attribute:v1  # distil the per-request streams into a committed artifact
```

`npm run bench:baseline` runs the same thing with `PHASE=v0`. To reproduce the v0
*numbers* rather than the v0 method, check out the tag first — Phase 1 deleted the
`BENCH_BYPASS_SECURITY` variant the v0 matrix used:

```bash
git checkout v0-baseline && npm run bench:baseline
```

Individual steps, if you would rather drive it manually:

```bash
npm run bench:up      # postgres + app, resource-pinned
npm run bench:seed    # 1000 users + 1 admin, idempotent
npm run bench:smoke   # 10 VUs / 20s — verifies the harness works
npm run bench:down    # tear down, removes the volume
```

## What gets measured

Two closed-model instruments, and they are **not interchangeable**.

| Script | Executor | Mix | Question it answers |
|---|---|---|---|
| `benchmarks/k6/baseline.js` | `ramping-vus` (closed) | 25% auth — **frozen** | What changed between phases? |
| `benchmarks/k6/realistic.js` | `ramping-vus` (closed) | ~0.5% auth | What is capacity under a realistic workload? |
| `benchmarks/k6/saturation.js` | `constant-arrival-rate` (open) | ~0.5% auth | At what arrival rate does it fall over? |

`baseline.js` is the **frozen instrument**. Its rows are the only ones comparable
across phases, because a comparison is only a comparison while the instrument is
constant. `realistic.js` exists because a mix that is 25% authentication describes
no real workload — bcrypt at cost 10 measures 54.8 ms per compare, so a quarter of
requests running a key derivation made bcrypt 37% of the per-iteration CPU budget
and depressed every throughput number in the v0 matrix. Its series starts at v1.
`report.mjs` refuses to pair rows from different instruments.

Concurrency levels for the frozen instrument: 5, 10, 20, 50, 100, 500, 1000 VUs.
Every level set is env-overridable:

```bash
VU_LEVELS="5 10 20 50" REALISTIC_LEVELS="" SAT_RATES="10" \
  PHASE=v1 ./benchmarks/scripts/run-phase.sh
```

Per-endpoint latency is tracked separately (`benchmarks/k6/lib/metrics.js`) because
`/health` does no I/O, `POST /sign-in` is bcrypt-bound, and `GET /api/users` was the
unbounded scan. A blended p95 across those describes no real user.

Errors are split by cause: 429 (the limiter working as designed), 5xx (defects), and
status 0 (network failures, which are not HTTP errors and must not be counted as
5xx). The v0-era 403 column is retained in the metrics so a regression to the old
throttle status would be visible.

## Choosing concurrency levels, and reading a censored run

The matrix spans both sides of the knee on purpose. Measured at v0: `v0-nolimit` was
clean through 100 VUs and started abandoning requests at 500; `v0-asbuilt` was clean
through 50 and started at 100. Throughput was flat across the clean levels — around
2.2 iterations/s as-built and 3.9–6.8 bypassed — the signature of a server already
at capacity, where extra concurrency buys latency rather than work.

Past the knee the consequences show up in two places that are easy to misread:

- **`failed` is abandonment, not errors.** Across the whole v0 matrix there were
  zero 4xx, 5xx, 429 and 403. `failure-attribution.txt` splits the status-0 failures
  by k6 `error_code`: **1220** (`read: connection reset by peer`, clustered at
  15001 ms — the RST came from the server, so the request was never answered) and
  **1050** (`request timeout`, k6 giving up at 60 s). At 1000 VUs as-built, 83% of
  all requests ended in 1220.
- **Latency quantiles are censored.** Once requests are abandoned, every quantile
  past the abandonment point equals the timeout, not a response time. Rows in that
  state are flagged `†` and must not be quoted as latency. Use `p95 served`,
  computed over `http_req_duration{expected_response:true}`.

Quote the knee row. A level above it partly measures how long k6 was willing to
wait, and it will happily show an "improvement" that is really a shift in where the
queue overflowed. `report.mjs --compare` enforces this: it refuses to compute a
delta for any level censored on either side, and names the levels it dropped.

## Requirements

Compose **V2** (`docker compose`, the plugin) is required, not V1
(`docker-compose`, the Python script). V1 silently ignores
`deploy.resources.limits`, which would leave containers unconstrained and make the
results a measurement of your host machine. `run-phase.sh` reads the applied limits
back via `docker inspect` and aborts if they are unset, rather than trusting the
compose file.

## Rules that keep the numbers honest

1. **Tag before measuring.** `run-phase.sh` refuses to start if `src/`,
   `package.json` or `Dockerfile` have uncommitted changes. Override with
   `ALLOW_DIRTY=1` only if you know why.
2. **Pinned everything, then verified.** Exact image tags, explicit CPU and memory
   limits in `.env.bench`, and a `docker inspect` check that they actually applied.
   Changing those values invalidates comparison with previously committed runs —
   record any change in `PROJECT_LIFECYCLE.md`.
3. **Warm-up discarded.** 20s of throwaway load before the first real run; JIT and
   cold cache otherwise inflate p99 — and, worse, make every *later* phase look
   artificially better once you have learned to warm up.
4. **45s cool-down between runs.** Otherwise `TIME_WAIT` sockets and a warm page
   cache bleed into the next measurement.
5. **`ANALYZE` after seeding.** Stale planner statistics mean you benchmark a bad
   plan rather than the schema.
6. **Raw JSON is committed.** Summary tables are generated by
   `benchmarks/scripts/report.mjs`, never hand-written.
7. **Fingerprint every run.** `environment.json` records commit, `src/` tree hash,
   CPU model and count, memory, and tool versions. The `src` tree hash is the one
   that matters: `HEAD` moves whenever the harness or docs change, so two genuinely
   comparable runs would otherwise look incomparable.
8. **The rate limiter must never fire during a run.** Every VU shares one source IP,
   so a production-shaped per-IP limit would reject most of the matrix — and
   rejections are fast, so the report would show a large latency "improvement" that
   was really the limiter refusing to work. `.env.bench` raises the ceilings far
   above what the matrix can generate; the limiter still executes on every request,
   so its CPU cost is still measured. `run-phase.sh` reads the ceilings out of the
   running container before starting *and* asserts after every run that zero
   requests were rejected. This replaced the Phase 0 check that verified
   `BENCH_BYPASS_SECURITY` in-container.
9. **Admin session is checked before the matrix starts.** `GET /api/users` requires
   an admin; without one, `authorize()` returns 403 before the controller runs and
   the list query is never measured. The runner probes sign-in, the k6 `setup()`
   throws on failure, and the k6 check asserts 200 rather than tolerating 403.
10. **The response shape is asserted, not assumed.** For any phase after v0 the
    runner checks that `GET /api/users` returns under 32 KB before starting, and the
    k6 check asserts the same per request. v0 shipped 167 KiB and 1,001 rows; "the
    number got better" and "the fix shipped" are different claims.

## Freezing the instrument

`benchmarks/k6/baseline.js` must not change between phases. What is frozen is the
**measured behaviour**: the request mix, the load shape, the thresholds, the tags.
Its output directory is read from `RESULTS_DIR` because where a file lands is not
part of the measurement — that one line is the only post-Phase-0 edit to the file,
and an auditor should be able to diff it and find nothing else.

If the mix needs to change, add a script; do not edit this one. That is exactly what
Phase 1 did with `realistic.js`, rather than correcting the 25%-auth mix in place and
invalidating the committed v0 matrix.

## Adding a phase

```bash
mkdir -p benchmarks/vN-<name>/results
PHASE=vN ./benchmarks/scripts/run-phase.sh
node benchmarks/scripts/report.mjs --phase vN \
  --dir benchmarks/vN-<name>/results \
  --out benchmarks/vN-<name>/SUMMARY.md \
  --compare benchmarks/v0-baseline/results
```

`run-phase.sh` maps `v0` and `v1` to their directories and falls back to
`benchmarks/<PHASE>` otherwise; `RESULTS_DIR` overrides it.

## Known limitations

Stated rather than hidden:

- The load generator runs on the same host as the app, so k6 competes for CPU with
  the thing being measured. A separate machine would be better.
- Client-side timings only. Server-side histograms arrive in Phase 6 and will
  separate queue time from service time — which is what would have identified the
  15 s RST below immediately.
- No p99.9 — too few samples at these volumes for it to mean anything.
- `.env.bench` raises `SESSION_TTL_MS` above the 15-minute application default.
  k6's `setup()` authenticates once per invocation, and while no level in the matrix
  runs longer than four minutes, a future long-running level would see the token
  expire mid-run and produce a wave of 401s that looks like a regression.
- The v1 open-model rows are **not** comparable to the v0 open-model rows. v0's
  probe hit a static route with security bypassed and its `RATE` was requests per
  second; v1's drives the real mix and `RATE` is iterations per second. Same file
  name, different question (finding F-17).
- In the v0 runs the abandoned requests split into an RST from the server at
  15001 ms (k6 `error_code` 1220) and k6's own 60 s timeout (1050) — see
  `failure-attribution.txt`. Connection setup is ruled out
  (`http_req_connecting` peaks at 10 ms) and so is Arcjet (the 15 s cluster is
  present in the bypassed variant). The remaining question is which server-side
  timer sends that RST; `1+2+4+8 = 15` s is the cumulative SYN-ACK retransmission
  backoff, so an overflowing accept queue on a blocked event loop is the leading
  candidate. Confirm or kill it in one run with, inside the app container during
  load: `nstat -az | grep -Ei 'ListenOverflow|ListenDrop|TCPAbort'`.
