# Benchmarking

How to reproduce every latency number this project claims.

## Prerequisites

- Docker with Compose v2 (`docker compose version`)
- k6 — https://grafana.com/docs/k6/latest/set-up/install-k6/
- Node 22+

## Run the baseline

```bash
cp .env.bench.example .env.bench
npm run bench:baseline
npm run bench:report
node benchmarks/scripts/attribute-failures.mjs
```

Takes roughly 75 minutes: 14 load runs (7 concurrency levels × 2 variants), 3
saturation probes, plus warm-up and cool-down periods. Output lands in
`benchmarks/v0-baseline/`.

Individual steps, if you'd rather drive it manually:

```bash
npm run bench:up            # postgres + app, resource-pinned
npm run bench:seed          # 1000 users + 1 admin, idempotent
npm run bench:smoke         # 10 VUs / 20s — verifies the harness works
npm run bench:attribute     # distil --out json streams into failure-attribution.txt
npm run bench:down          # tear down, removes the volume
```

## What gets measured

| Script | Executor | Question it answers |
|---|---|---|
| `benchmarks/k6/baseline.js` | `ramping-vus` (closed) | What do N concurrent clients experience? |
| `benchmarks/k6/saturation.js` | `constant-arrival-rate` (open) | At what arrival rate does it fall over? |

Concurrency levels: 5, 10, 20, 50, 100, 500, 1000 VUs. Each level runs twice —
`v0-asbuilt` (Arcjet middleware in the request path) and `v0-nolimit` (bypassed).
Both are committed; see the attribution table in the generated summary for why.

Per-endpoint latency is tracked separately (`benchmarks/k6/lib/metrics.js`)
because `/health` does no I/O, `POST /sign-in` is bcrypt-bound at roughly 75ms per
compare, and `GET /api/users` scans the whole table. A blended p95 across those
describes no real user.

Errors are split by cause: 429 (correct throttle), 403 (the as-built throttle
status, which is wrong — see F-08), 5xx (defects), and status 0 (network failures,
which are not HTTP errors and must not be counted as 5xx).

## Choosing concurrency levels, and reading a censored run

The matrix spans both sides of the knee on purpose. Measured: `v0-nolimit` is
clean through 100 VUs and starts abandoning requests at 500; `v0-asbuilt` is clean
through 50 and starts at 100. Throughput is flat across the clean levels — around
2.2 iterations/s as-built and 3.9–6.8 bypassed — which is the signature of a
server already at capacity: extra concurrency buys latency, not work. One
iteration is `/health` + sign-in + users-list + user-by-id. The hard ceiling is
bcrypt: cost 10 measures 55ms per compare on this hardware, one compare per
iteration, one core (`APP_CPUS=1.0`).

Past the knee the consequences show up in two places that are easy to misread:

- **`failed` is abandonment, not errors.** Across the whole matrix there are zero
  4xx, 5xx, 429 and 403. Nothing in the application failed. `failure-attribution.txt`
  splits the status-0 failures by k6 `error_code`: **1220** (`read: connection
  reset by peer`, clustered at 15001 ms — the RST comes from the server side, so
  the request was never answered) and **1050** (`request timeout`, k6 giving up at
  60 s). At 1000 VUs as-built, 83% of all requests ended in 1220.
- **Latency quantiles are censored.** Once requests are being abandoned, every
  quantile past the abandonment point equals the timeout, not a response time.
  Rows in that state are flagged `†` and must not be quoted as latency. Use
  `p95 served`, computed over `http_req_duration{expected_response:true}`.

Quote the knee row. A level above it partly measures how long k6 was willing to
wait, and it will happily show an "improvement" that is really just a shift in
where the queue overflows.

## Requirements

Compose **V2** (`docker compose`, the plugin) is required, not V1
(`docker-compose`, the Python script). V1 silently ignores
`deploy.resources.limits`, which would leave containers unconstrained and make the
results a measurement of your host machine. `run-baseline.sh` reads the applied
limits back via `docker inspect` and aborts if they are unset, rather than trusting
the compose file.

## Rules that keep the numbers honest

1. **Tag before measuring.** `run-baseline.sh` refuses to start if `src/`,
   `package.json`, or `Dockerfile` have uncommitted changes. Override with
   `ALLOW_DIRTY=1` only if you know why.
2. **Pinned everything, then verified.** Exact image tags, explicit CPU and memory
   limits in `.env.bench`, and a `docker inspect` check that they actually applied.
   Changing those values invalidates comparison with previously committed runs —
   record any change in `PROJECT_LIFECYCLE.md`.
3. **Warm-up discarded.** 20s of throwaway load before the first real run; JIT and
   cold cache otherwise inflate p99.
4. **45s cool-down between runs.** Otherwise `TIME_WAIT` sockets and a warm page
   cache bleed into the next measurement.
5. **`ANALYZE` after seeding.** Stale planner statistics mean you benchmark a bad
   plan rather than the schema.
6. **Raw JSON is committed.** Summary tables are generated by
   `benchmarks/scripts/report.mjs`, never hand-written.
7. **Fingerprint every run.** `environment.json` records commit, CPU model and
   count, memory, and tool versions.
8. **The variant is verified in-container.** Before each run the script reads
   `BENCH_BYPASS_SECURITY` back out of the running container and aborts on a
   mismatch, so a run can never be mislabelled.
9. **Admin session is checked before the matrix starts.** `GET /api/users` requires
   an admin; without one, `authorize()` returns 403 before the controller runs and
   the unbounded scan is never measured. The runner probes sign-in, the k6
   `setup()` throws on failure, and the k6 check asserts 200 rather than tolerating
   403.

## Known limitations

Stated rather than hidden:

- The load generator runs on the same host as the app, so k6 competes for CPU with
  the thing being measured. A separate machine would be better.
- v0 has only client-side timings. Server-side histograms arrive in Phase 6 and
  will separate queue time from service time.
- No p99.9 — too few samples at these volumes for it to mean anything.
- `saturation.js` hits `GET /api`, a static response, and the runner starts those
  probes with `BENCH_BYPASS_SECURITY=1`. So the open-model rows measure Express
  routing throughput on the pinned CPU, not the capacity of the real endpoint mix,
  which is why they never drop an iteration even at 500 rps. Treat that section as
  a floor for framework overhead, not as the knee.
- In the v0 runs the abandoned requests split into an RST from the server at
  15001 ms (k6 `error_code` 1220) and k6's own 60 s timeout (1050) — see
  `failure-attribution.txt`. Connection setup is ruled out (`http_req_connecting`
  peaks at 10 ms) and so is Arcjet (the 15 s cluster is present in the bypassed
  variant). The remaining question is which server-side timer sends that RST;
  `1+2+4+8 = 15` s is the cumulative SYN-ACK retransmission backoff, so an
  overflowing accept queue on a blocked event loop is the leading candidate.
  Confirm or kill it in one run with, inside the app container during load:
  `nstat -az | grep -Ei 'ListenOverflow|ListenDrop|TCPAbort'`.

## Adding a phase

```bash
mkdir -p benchmarks/vN-<name>/results
# run the SAME k6 scripts, only RUN_TAG changes
k6 run -e VUS=500 -e RUN_TAG=vN-<name> benchmarks/k6/baseline.js
node benchmarks/scripts/report.mjs --dir benchmarks/vN-<name>/results \
                                   --out benchmarks/vN-<name>/SUMMARY.md
```

Never edit the k6 scripts between phases. If a script must change, re-run the
earlier phases with the new version or the comparison is void.
