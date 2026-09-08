# Project Lifecycle

Running record of how this project evolved: what changed, why, what was measured,
and what was learned. Append-only — entries are not edited after the fact, because
the value of this file is that it shows the reasoning as it happened rather than a
tidied-up version.

Format: one section per phase. Findings are numbered `F-nn` and referenced from
commit messages and docs. Every finding cites a file and line or a command output.

---

## Timeline

| Phase | Status | Started | Completed | Deliverable |
|---|---|---|---|---|
| 0 — Baseline measurement | **Complete** — matrix executed, results committed, findings F-01..F-20 recorded | 2026-09-01 | 2026-09-03 | Reproducible benchmark harness + v0 numbers |
| 1 — Correctness & security | **Code complete** — defects fixed, Arcjet removed, findings F-21..F-37 recorded; v1 matrix pending on the Docker host | 2026-09-04 | — | Defect-free baseline + measured v0→v1 delta |
| 2 — TypeScript migration | **Struck** — dropped deliberately, not deferred (ADR 0005) | — | — | — |
| 3 — Postgres foundation | **Code complete** — one driver, deals entity, keyset pagination, indexes, transactions and locking; findings F-38..F-47. Seed/EXPLAIN/isolation scripts pending on the Docker host | 2026-09-05 | — | New entity, 1M-row seeder, keyset pagination, indexes, isolation |
| 4 — Redis: limits & tokens | **Code complete** — shared sliding window in Lua, refresh rotation with reuse detection, JTI denylist, idempotency keys, fenced lock; findings F-48..F-50 | 2026-09-05 | — | Distributed rate limiting, refresh rotation |
| 5 — Kafka & outbox | **Code complete** — outbox in the domain transaction, publisher with SKIP LOCKED, idempotent consumer, DLQ; drill scripted | 2026-09-05 | — | Async pipeline, no dual-write loss |
| 6 — Observability | **Reduced** — no OTel or Grafana; a hand-written `/metrics` endpoint carries the signals the other phases need (ADR 0006) | 2026-09-05 | — | RED, pool saturation, loop lag, outbox depth |
| 7 — Kubernetes & scale-out | **Code complete** — manifests, probes, HPA, PDB, migration Job, kind script, five scripted drills; matrix pending on the cluster | 2026-09-05 | — | 3-replica benchmark + failure drills |
| 8 — Hardening & docs | Not started | — | — | Integration tests, ADRs, BENCHMARKS.md |

---

## Phase 0 — Baseline measurement

**Started:** 2026-09-01
**Baseline commit:** `c1c0707`
**Goal:** produce a defensible "before" number, and make the measurement
reproducible by a third party. Explicitly *not* to improve anything.

### Why baseline-first

Any later claim of the form "reduced p95 from X to Y" is only as good as X. If X
is reconstructed after the optimisations exist — by disabling features or
estimating — the comparison is unfalsifiable and an interviewer is right to
discount it. So Phase 0 changes no application logic, tags the code, measures it,
and commits the raw output.

The one exception is documented under F-07 below, and it was added *because*
leaving it out would have made the baseline misleading rather than more honest.

### Findings

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| F-01 | `coverage/` (38 files) and `logs/` (2 files) were tracked in git, so every local test run produced diff noise | `git ls-files coverage \| wc -l` → 38 | Hygiene |
| F-02 | `.gitignore` rule `logs/*` had no effect — the files were tracked before the rule was added, and gitignore does not apply to tracked paths | `git ls-files logs/` → `logs/combined.log`, `logs/error.log` | Hygiene |
| F-03 | `.gitignore` line `.env.*` also excluded `.env.example`, so the template a new contributor needs could not be committed | `git check-ignore -v .env.example` → `.gitignore:3:.env.*` | Usability |
| F-04 | A live-format Neon connection string with password exists in history | `git show 4d0ae6e:.env` prints it; present in `4d0ae6e` and `0293358` | Security (remediated — credential rotated) |
| F-05 | bcrypt cost 10 caps signin throughput at roughly 13 req/s per core | measured: `hash=113.6ms compare=74.7ms` at cost 10 vs `hash=9.8ms compare=3.7ms` at cost 4 | Expected, must be excluded from "slow endpoint" claims |
| F-06 | `NODE_ENV` must be exactly `development` for the app to use local Postgres — any other value routes to the Neon HTTP driver | `src/config/database.js:8` | Blocks benchmarking |
| F-07 | With no `ARCJET_KEY` and no network egress, `aj.protect()` returns an `ERROR` decision and `security.middleware.js` **allows the request** — it checks `isDenied()` only, never `isErrored()` | verified: `decision.conclusion = ERROR, isDenied = false`; reason `Failed to establish tunnel to decide.arcjet.com:443` | **Security — fails open** |
| F-08 | Rate-limit rejections return HTTP 403, not 429, and carry no `Retry-After` | `src/middleware/security.middleware.js:41` | Correctness |
| F-09 | `scripts/dev.sh:37` runs `npm run db:migrate` from the host *before* `docker compose up`, so migrations race the database container | `scripts/dev.sh:37` precedes `scripts/dev.sh:47` | Reliability |
| F-10 | `authorize('admin')` rejects at `src/middleware/auth.middleware.js:35-40`, before the controller runs — so a load test authenticated as a regular user never reaches the unbounded `SELECT` at `src/services/users.service.js:6-14` | `router.get('/', authorize('admin'), fetchAllUsers)` at `src/routes/users.routes.js:15`; seeder assigns role `'user'` | **Would have invalidated the primary benchmark** |
| F-11 | `deploy.resources.limits` is honoured by Compose V2 but silently ignored by Compose V1, so "pinned resources" cannot be assumed | documented Compose behaviour; mitigated by reading `HostConfig.NanoCpus`/`Memory` back via `docker inspect` | Measurement validity |

**F-07 is the most significant finding of Phase 0.** The current security layer
degrades to no security when its provider is unreachable, silently. There is no
log line, no metric, no alert — the request simply proceeds. This was found by
probing the decision object directly rather than by reading the source, because
the source looks correct until you know that `@arcjet/node` has a third outcome
beyond allow and deny.

It reframes the "remove Arcjet" decision: the replacement is not about avoiding a
dependency, it is about owning the failure policy. A self-built limiter on Redis
must make fail-open vs fail-closed an explicit, logged, per-route choice. Recorded
as [ADR 0002](docs/adr/0002-own-the-failure-policy.md).

**F-10 was caught during self-review and would have silently ruined Phase 0.** The
first version of `baseline.js` signed in as a randomly chosen seeded user, all of
whom have role `'user'`. `GET /api/users` is guarded by `authorize('admin')`, which
returns 403 from middleware *before* `fetchAllUsers` executes. So every
`users_list` sample would have measured the cost of a middleware rejection —
roughly a few hundred microseconds — rather than the unbounded table scan that is
the single most important optimisation target in the project. The run would have
completed, produced plausible-looking numbers, and the Phase 3 pagination
comparison would have been measured against a meaningless baseline.

Fixed by authenticating once as a dedicated admin in k6's `setup()` and sharing
that token across VUs. `setup()` now throws if the admin sign-in fails, the seeder
upserts the admin on every invocation (including the already-seeded early-return
path), the runner probes admin sign-in before starting the matrix, and the k6 check
asserts `status === 200` rather than accepting 403. Four independent guards,
because a benchmark that is quietly measuring the wrong thing is worse than one
that fails.

### What was built

```
.gitignore                              rewritten — negation pattern for templates
.gitleaks.toml                          secret-scan rules incl. custom PG/Redis URI patterns
.github/workflows/secret-scan.yml       gitleaks on full history, non-bypassable
.env.bench.example                      committed template for the bench environment
docker-compose.bench.yml                pinned postgres 16.4-alpine, CPU/mem limits, pg_stat_statements
benchmarks/k6/lib/config.js             shared load shape and thresholds
benchmarks/k6/lib/metrics.js            per-endpoint Trends, error taxonomy
benchmarks/k6/baseline.js               closed model (ramping-vus), 100/500/1000 VUs
benchmarks/k6/saturation.js             open model (constant-arrival-rate), finds capacity wall
benchmarks/scripts/seed.mjs             idempotent seeder, batched inserts, ANALYZE
benchmarks/scripts/run-baseline.sh      full matrix runner incl. fingerprint + warm-up
benchmarks/scripts/report.mjs           generates SUMMARY.md from raw JSON
tests/bench-guard.test.js               asserts the bypass flag cannot fire in production
src/app.js                              +BENCH_BYPASS_SECURITY guard (Phase 1 removes it)
package.json                            +6 bench:* scripts
```

### Measurement design decisions

**Two variants per concurrency level.** `v0-asbuilt` keeps the Arcjet middleware
inline; `v0-nolimit` bypasses it. Reason: with the middleware in path, a
third-party network round-trip sits inside every request, and attributing that
latency to application code would inflate every subsequent improvement. Both
numbers are committed and `report.mjs` prints the delta as an explicit
"how much of the baseline was Arcjet" table. Reporting only the flattering
variant would be selective.

**Per-endpoint metrics, not just blended.** `/health` does no I/O, `POST /sign-in`
runs bcrypt at ~75ms (F-05), and `GET /api/users` scans the whole table
(`src/services/users.service.js:6-14`). A blended p95 across those describes no
real user journey. `lib/metrics.js` gives each its own Trend.

**Both load models.** `baseline.js` is closed-model: VUs wait for a response, so
offered load drops as the server slows — which hides the true breaking point
(coordinated omission). `saturation.js` is open-model: requests are issued on a
schedule regardless, and `dropped_iterations > 0` marks real saturation. Shipping
both, and being able to say why, is the point.

**Warm-up discarded.** The first ~30s is JIT warm-up and cold Postgres cache.
`run-baseline.sh` runs a 20s throwaway load and deletes its output.

**Dirty-tree refusal.** `run-baseline.sh` aborts if `src/`, `package.json`, or
`Dockerfile` have uncommitted changes. A result that cannot be pinned to one
commit is not evidence.

**Environment fingerprint.** Every run writes `environment.json` with commit, CPU
model and count, memory, and tool versions. "p95 was 40ms" means nothing without
the machine it was measured on.

**Pinned image tags and resource limits.** `postgres:16.4-alpine`, not
`16-alpine`. A minor version bump between the v0 and v8 runs would silently
invalidate the comparison. CPU and memory limits are set explicitly in
`.env.bench`, otherwise the baseline measures the host rather than the code.

### Verified in this environment

- All new JS passes `node --check`; `run-baseline.sh` passes `bash -n`;
  `docker-compose.bench.yml` and `secret-scan.yml` parse as valid YAML;
  `.gitleaks.toml` section ordering and quote balance verified.
- ESLint clean across every Phase 0 file. The 27 remaining repo-wide errors are
  all in `tests/app.test.js`, `jest.config.mjs`, `src/utils/jwt.js`,
  `src/services/auth.service.js` and `src/app.js` — pre-existing, confirmed by
  linting `HEAD`'s copy of `src/app.js` in isolation (2 errors, identical). Phase 1
  fixes them when lint becomes blocking.
- App boots and serves `/health` 200, `/api` 200, unknown route 404 with the
  bypass flag on and off.
- Guard verified by test: bypass active removes exactly one Express router layer;
  `NODE_ENV=production` with `BENCH_BYPASS_SECURITY=1` keeps the same layer count
  as the secure config. Also asserted inactive for `'true'`, `'01'`, `' 1'`,
  `'yes'`, numeric `1`, and absent. 15 tests pass across 2 suites.
- `isSecurityBypassed` extracted to `src/utils/bench-flag.js` specifically so the
  test imports the real expression instead of re-implementing it — a test that
  duplicates the logic would keep passing after the guard was loosened.
- Seeder placeholder/parameter alignment verified by replaying its batch loop;
  admin upsert confirmed to run before the already-seeded early return.
- `report.mjs` verified end-to-end against synthetic closed-model and open-model
  result files: closed and open runs render in separate sections, and the
  attribution table computes the as-built-minus-bypassed delta correctly.
- `.env.bench.example` confirmed safe to `set -a; . file; set +a` despite comments,
  empty values, and a URL containing `//`.
- Custom gitleaks Postgres-URI regex verified against 6 cases: the real leaked
  string and a realistic secret both fail the build; the compose placeholder,
  README placeholder, bench template, and `${VAR}` indirection all pass.
- bcrypt cost measured directly rather than assumed (F-05).
- Arcjet fail-open behaviour verified by inspecting the decision object, not by
  reading source (F-07).

### Not verified here — must run on the Docker host

This VM has no Docker, no Postgres, no k6, and no outbound network
(`npm ping` → 403, `apt-get update` → permission denied, `sudo` blocked by
`no-new-privileges`). So the numbers themselves have to be produced on the real
machine:

```bash
cp .env.bench.example .env.bench
git tag v0-baseline && git push origin v0-baseline
npm run bench:baseline      # ~35 min: 6 runs + 3 saturation probes + cooldowns
npm run bench:report
```

Until that runs, `benchmarks/v0-baseline/results/` is empty by design — no
placeholder or estimated figures are committed.

### Phase 0 exit criteria

- [x] Harness committed, syntax-verified, lint-clean
- [x] Secret scanning enforced in CI (non-bypassable, full history)
- [x] `coverage/` and `logs/` untracked; `.gitignore` negation fixed
- [x] Measurement control implemented, extracted, and test-guarded
- [x] Findings F-01..F-11 recorded with evidence
- [x] Self-review pass completed (found F-10 and F-11)
- [x] `v0-baseline` tag pushed
- [x] Benchmark matrix executed on Docker host
- [x] `SUMMARY.md` generated from real results

**Verdict: harness complete, numbers pending.** Phase 0 is code-complete and
verified as far as this environment allows. It is not *finished*, because its
deliverable is a measurement and no measurement exists yet. Phase 1 must not start
until the matrix has run — otherwise the baseline describes code that no longer
exists, and the entire before/after comparison is lost.

> **Superseded 2026-09-03.** The matrix has since run. This verdict and the
> "Not verified here" section above are left unedited per the append-only rule;
> see *Phase 0 — execution and results* at the end of this file for what actually
> happened, including where the plan above turned out to be wrong.

### Guardrails that will catch a bad run

Listed together because they are the reason to trust the eventual numbers:

1. Refuses to start on a dirty working tree (`src/`, `package.json`, `Dockerfile`).
2. Aborts if container CPU/memory limits did not actually apply.
3. Aborts if the in-container `BENCH_BYPASS_SECURITY` value does not match the
   requested variant.
4. Aborts if admin sign-in fails, so `users_list` cannot silently measure a 403.
5. k6 `setup()` throws on an unauthenticated admin.
6. k6 check asserts `users_list` returned 200, surfacing any regression in the
   summary.
7. Warm-up output is deleted, not reported.
8. Every run writes an environment fingerprint alongside the results.

---

## Phase 0 — execution and results

**Ran:** 2026-09-03
**Benchmarked commit:** `d91234b`, `src/` tree `07d128b0`
**Artifacts:** `benchmarks/v0-baseline/{SUMMARY.md, failure-attribution.txt, environment.json, pg_stat_statements.txt, explain-users-list.txt}` + 17 raw result JSONs

Appended rather than merged into the section above, because what the run revealed
was partly that the plan above was wrong about which numbers would be usable.

### What actually ran

Two passes. The first used the planned 100/500/1000 VU levels and produced failure
rates of 70% and 89%, which triggered the investigation recorded in F-12..F-14. The
second added 5/10/20/50 after that investigation showed there was no uncensored
level in the original matrix. Final committed matrix is **7 levels × 2 variants =
14 closed-model runs**, plus 3 open-model probes. ~75 minutes.

### Measured results

The headline is not the one the plan anticipated. **Capacity is ~6.8 iterations/s on
one pinned core**, where an iteration is `/health` + sign-in + users-list +
user-by-id, and the system is at that ceiling by roughly 10 concurrent clients.

| | v0-asbuilt | v0-nolimit |
|---|---|---|
| knee (last level with zero abandonment) | **50 VUs** | **100 VUs** |
| iter/s at the knee | 2.35 | 3.89 |
| p95 at the knee | 6407 ms | 9103 ms |
| best uncensored p95 (5 VUs) | 695 ms | **87.68 ms** |
| `/health` p95 at 5 VUs | 404.69 ms | **4.19 ms** |
| peak iter/s (and where) | 2.35 @ 50 | **6.76 @ 10** |

Throughput is **flat** across every clean as-built level — 2.11, 2.24, 2.22, 2.35
iter/s at 5/10/20/50 — while p95 climbs 695 → 1501 → 2791 → 6407 ms. Bypassed, it
peaks at 10 VUs and then *declines* to 5.42 and 5.14. Flat throughput with linearly
rising latency is a system already at capacity; declining throughput past the peak
is contention. So the original 100/500/1000 levels were measuring queue depth, not
the application.

Per-iteration CPU budget at peak (148 ms of one core), measured rather than
apportioned: bcrypt compare **54.8 ms**, `JSON.stringify` of the 1001-row users
response **7.36 ms** (167 KiB per response), all three Postgres queries combined
**2.33 ms**, Arcjet **~75 ms per request**. The load mix is exactly **25%
sign-ins**, so one request in four runs the KDF.

Framework overhead is not the constraint and this is the cleanest proof: on the same
core, in the same process, `GET /api` absorbed **500 req/s at p95 3.33 ms with zero
dropped iterations** while the real mix managed 27 req/s.

### Findings

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| F-12 | The generated report made a high `failed` rate indistinguishable from server errors: the headline table printed `failed 88.75%` beside `5xx 0.00%` and left the status-0 count in a separate table. The first hypothesis it produced was an expired third-party account — both numbers correct, conclusion wrong | reproduced by reading the first `SUMMARY.md`; fixed by the `†` marker, `p95 served`, and a dedicated failure-attribution table | **Reporting — produced a false diagnosis** |
| F-13 | Latency quantiles past the abandonment point equal the client timeout, not a response time, so `p95 = 60000.64 ms` is not latency. The originally planned 100/500/1000 matrix contained **no uncensored level**, i.e. no quotable baseline existed at all | `http_req_duration` p95/p99 pinned at 60000.xx in every run with abandonment; `http_req_duration{expected_response:true}` diverges sharply | **Measurement validity** |
| F-14 | Status 0 is two failure modes. k6 `error_code` **1220** (`read: connection reset by peer`) clusters at a 15001 ms median — 6,627 samples spanning only 14995–15014 ms in the 1000-VU as-built run — and **1050** (`request timeout`) at k6's 60 s default. 83.05% of all requests at 1000 VUs as-built ended in 1220, i.e. the server reset them and they never reached the app | `benchmarks/v0-baseline/failure-attribution.txt`; corroborated server-side — k6 sent 11,037 users-list requests, `pg_stat_statements` logged 5,090 | **Capacity** |
| F-15 | `new Pool()` is constructed with no `max`, so node-postgres defaults to 10 connections while `PG_MAX_CONNECTIONS=200`; `connectionTimeoutMillis` defaults to 0, so a request waits for a slot indefinitely rather than failing fast | `src/config/database.js:11-13` | Correctness — Phase 3 target |
| F-16 | Arcjet's cost is **CPU, not network**, and it caps throughput rather than only inflating percentiles: ~75 ms per request, 87.39% of p95 at 5 VUs, 45–67% of throughput at every level. Separately, with `ARCJET_KEY` empty it enforced **nothing** — zero 403s across 14 runs while `security.middleware.js:25` configures a `LIVE` 5 req/min window for `guest` | req/s pinned near 9 as-built vs 15–27 bypassed regardless of concurrency, which concurrent I/O waits would not do; `/health` 4.19 ms bypassed vs 404.69 ms as-built | **Performance + security** |
| F-17 | The open-model probe measures the wrong thing. `saturation.js` hits static `GET /api` and the runner starts those runs with `BENCH_BYPASS_SECURITY=1`, so it reports Express routing throughput, not the capacity of the real mix — which is why it never dropped an iteration even at 500 rps | `benchmarks/k6/saturation.js` default fn; `run-baseline.sh` saturation loop | Measurement scope |
| F-18 | `--summary-export` wrote 14 files totalling 168 KB that nothing ever consumed — `report.mjs` explicitly filtered them out while `baseline.js`'s own `handleSummary` already wrote the same aggregates plus the `meta` block the report needs | `report.mjs:31` `!f.endsWith('.summary.json')`; no other reference in the repo | Hygiene |
| F-19 | The `v0-baseline` tag was created two commits *before* the commit that was benchmarked, so `git describe --tags --exact-match` failed and `environment.json` recorded `tag: "unavailable"` — violating this project's own "tag before measuring" rule | tag → `be01992`, run → `d91234b`; `src/` tree identical (`07d128b0`) but the Dockerfile differs by the `/app/logs` mkdir+chown | Process |
| F-20 | The coverage HTML from F-01 made GitHub classify the repo as **HTML 80.8% / JavaScript 14.8%**, and the classification persisted after removal because Linguist caches per repository | `f2cedf5` added 218,208 B of `lcov-report` HTML, `be01992` removed it; slice arithmetic reproduces the bar from `f2cedf5`'s tree exactly | Presentation |

**F-12 and F-13 are the significant pair, and they are about my own work rather than
the application.** No measurement was wrong; the presentation of a correct
measurement produced a false diagnosis, and separately the planned concurrency
levels were all past the point where latency stops meaning anything. Together they
say something worth carrying forward: *a benchmark report is a user interface, and a
number that is technically true but reliably misread is a defect in it.*

**F-16 corrects a reasoning error in the Phase 0 design above.** The "two variants"
rationale recorded earlier justified the split on the grounds that "a third-party
network round-trip sits inside every request". The measurement shows the cost is
serialised CPU, not network wait — which matters because a network round-trip would
overlap across concurrent requests and leave throughput alone, whereas this one caps
it. The decision to run both variants was right; the stated reason was wrong.

### Re-measurements, not corrections

Left as separate entries because the file is append-only and the earlier numbers
were honestly obtained:

- **F-05** recorded `compare=74.7ms` at bcrypt cost 10 and derived a ~13 signin/s
  ceiling. Re-measured on the benchmark host during this run: **54.8 ms**, so ~18/s.
  Same order, and the conclusion — that this is the intended security/throughput
  trade-off and not a defect — is unchanged.
- The server-side captures were regenerated by the second pass, so the figures
  moved: the unbounded scan is now 5,090 calls at **2.20 ms** mean (11.2 s total),
  the lookups 0.07 and 0.06 ms, and `EXPLAIN` execution **0.335 ms**. Anything
  quoting the first pass's 4.09 ms / 1.06 ms is stale. Note that a re-run
  **overwrites these files in place** — commit before re-running.
- Postgres is exonerated either way: ~11.9 s of total database time across runs that
  were reporting 15–60 second requests, so the unbounded `SELECT` is still the right
  Phase 3 target but for the Node-side serialisation cost, not the query. An index
  would achieve nothing here; pagination is what helps.

### Harness changes made in response

None of these touch `src/`, so the baseline remains comparable:

```
benchmarks/scripts/attribute-failures.mjs   NEW — distils --out json streams to a 4 KB artifact (F-14)
benchmarks/scripts/report.mjs               † censoring markers, p95 served, failure-attribution
                                            table, computed Knee section, refuses to diff two
                                            censored rows (F-12, F-13)
benchmarks/scripts/run-baseline.sh          --out json per run; --summary-export dropped (F-18);
                                            VU_LEVELS default now all 7 levels; fingerprint
                                            records `git rev-parse HEAD:src` (F-19)
.gitignore                                  *.samples.json.gz; credential patterns; build output
.gitattributes                              NEW — linguist-vendored/generated, LF enforcement (F-20)
package.json                                +bench:attribute
BENCHMARKING.md                             knee/censoring section, corrected run time and levels
docs/INTERVIEW_PHASE_0.md                   rewritten around the measured results
```

### Artifact retention decision

Committed: 17 raw result JSONs plus 5 derived artifacts, **168 KB** — exactly what
`report.mjs` reads, so the tables are regenerable by anyone. Excluded: **9.8 MB** of
per-request `--out json` streams, distilled first into the 4 KB
`failure-attribution.txt` so the F-14 evidence survives their deletion. Deleted
outright: the 14 `--summary-export` duplicates (F-18).

The rule this settles for later phases: commit what a reviewer needs to reproduce
the claim, distil what is merely large, delete what nothing consumes.

### Revised verdict

**Phase 0 is complete.** A defensible before-number exists at and below the knee,
the failure mode above it is attributed to an error code rather than guessed at, and
every figure in `SUMMARY.md` is regenerable from committed raw output by a script.

One question remains open and is recorded rather than papered over: **which
server-side timer sends the 15 s RST in F-14.** Ruled out — an HTTP 408 (there is no
HTTP response at all), connection setup (`http_req_connecting` peaks at 10 ms), and
Arcjet (the cluster is present in the bypassed variant). Leading hypothesis is
accept-queue overflow on a blocked event loop, since `1+2+4+8 = 15` s is the
cumulative SYN-ACK retransmission backoff. Settled by one command inside the app
container under load: `nstat -az | grep -Ei 'ListenOverflow|ListenDrop|TCPAbort'`.
Phase 6's server-side histograms would have identified it immediately, which is
itself an argument for pulling some of that work forward.

### Phase 1 entry criteria and priorities

Ordered by measured cost, which is the point — the ordering came from the data, not
from instinct, and the largest single win is a deletion:

1. **Remove Arcjet** (F-16) — ~75 ms CPU/request, ~3× throughput, and it was
   enforcing nothing. Replace with a limiter that owns its failure policy explicitly
   per [ADR 0002](docs/adr/0002-own-the-failure-policy.md), and return 429 with
   `Retry-After` rather than 403 (F-08).
2. **Set `max` on the pg pool** (F-15).
3. **Paginate the users list** — 1001 rows, 167 KiB per response.
4. **Fix the benchmark mix and the saturation scenario** (F-17) *before* claiming any
   of the above as an improvement.

Compare against the 5-VU and knee rows only. Any before/after quoted from a censored
row is not a result (F-13).

---

## Phase 1 — Correctness & security

**Started:** 2026-09-04
**Baseline for comparison:** `d91234b`, `src/` tree `07d128b0`, tag `v0-baseline`
**Goal:** a baseline that is correct rather than merely fast — and, because the
ordering came from Phase 0's measurements rather than instinct, one that is also
about three times faster.

### Scope, and the two conflicts that had to be resolved first

`UPGRADE_PLAN.md:108` scoped this phase to correctness and security only.
The *Phase 1 entry criteria* section above, written after the numbers came in,
ordered it by measured cost and pulled in two items the plan had assigned to
Phase 3. Those are not the same phase, so the conflict was settled explicitly
rather than split down the middle:

**Evidence order wins.** Phase 1 is the correctness defects **plus** removing
Arcjet, **plus** sizing the pg pool (F-15), **plus** paginating the users list.
Phase 3 narrows to what actually needs volume to demonstrate: the new write-heavy
entity, the 1M-row seeder, keyset pagination, composite indexes, and the
transaction/isolation work. Offset pagination now and keyset pagination there is
not indecision — at 1,001 rows the difference between them is unmeasurable, and
claiming an improvement that cannot be demonstrated is the thing this project
exists to avoid.

The second conflict was in the harness. `BENCHMARKING.md` freezes the k6 scripts
across phases; F-17 says fix the 25%-authentication mix before claiming any of the
above. Both cannot hold. Resolution: **`baseline.js` stays frozen as the
before/after instrument, and the corrected mix becomes a new script whose own
series starts here.** Changing the mix inside `baseline.js` would have invalidated
the committed v0 matrix and required a ~75 minute re-run of Phase 0 before Phase 1
could claim anything. Two numbers with different meanings, each internally
comparable, beats one number that quietly changed meaning between phases.

One nuance worth stating because it looks like a violation: `baseline.js` **was**
edited, by exactly one line, to read its output directory from the environment. The
freeze protects the *measured behaviour* — the request mix, load shape, thresholds,
tags. Where the resulting file lands is not part of the measurement. Anyone
auditing the comparison should diff the file between the two runs and find only
that line.

### Findings

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| F-21 | Six validation-failure log sites recorded `{ errors: undefined }`. Zod 4 renamed `ZodError.errors` to `.issues`, so every one of them logged *that* a request failed validation and nothing about *why*. `formatValidationError` already used `.issues`, so the HTTP response stayed correct and only the log was blind — which is why it was invisible | `node -e "…safeParse({}).error…"` → `has .issues: true / has .errors: UNDEFINED` on zod 4.4.3; sites at `auth.controller.js:12,:44` and `users.controller.js:30,:60,:69,:110` | Observability |
| F-22 | No lint rule can catch the winston comma-expression bug. `no-sequences` exists for exactly that mistake but treats a sequence wrapped in explicit parentheses as deliberate — and the extra parentheses **are** the bug. `no-unused-expressions` does not fire either, because the construct sits in a call argument rather than an expression statement | both rules run against `f((a(), b(), c()))` in isolation: zero reports | **Tooling blind spot** |
| F-23 | F-09 was worse than an ordering race. `.env.development:11` pointed `DATABASE_URL` at `@postgres:5432`, a compose service hostname, so the host-side migration in `dev.sh` could not reach the dev database at *any* point in the sequence. Separately `drizzle.config.js:1` loads plain `dotenv/config`, i.e. `.env` — not `.env.development` — so which URL a host-side migration used depended on an untracked file | `getent hosts postgres` → no output; `drizzle.config.js:1` | Reliability — blocked a clean clone |
| F-24 | `scripts/prod.sh` printed commands referencing container `acquisition-app-prod` while `docker-compose.prod.yml:39` declares `acquisitions-app-prod`, so every command it suggested would fail with "No such container". It also ran migrations *after* starting the app, and waited with `sleep 5` under the message "Waiting for Neon Local to be ready" — a service this stack does not contain | `grep -n container_name docker-compose.prod.yml` vs `scripts/prod.sh:42,45,46` | Reliability |
| F-25 | `src/utils/jwt.js:4` fell back to a hardcoded secret string committed in this repository. A production deploy that forgot `JWT_SECRET` would start cleanly, behave normally, and sign tokens anyone with the repo could forge — including admin tokens | `const JWT_SECRET = process.env.JWT_SECRET \|\| 'your-secret-key-please-change-in-production'` | **Security — silent total auth bypass** |
| F-26 | eslint and prettier both policed formatting — `indent`, `quotes`, `semi` were set in `eslint.config.js` while `.prettierrc` set the same things — and `eslint-config-prettier` sat in devDependencies unused. Harmless while lint was `continue-on-error`; the moment both gates became blocking, `npm run lint:fix` and `npm run format` could undo each other | `eslint.config.js:23-26` vs `.prettierrc`; `eslint-config-prettier@10.1.8` present, not imported | Process |
| F-27 | winston's File transports held open file descriptors under jest, producing "Jest did not exit one second after the test run has completed" — an open handle that reads as a leak in the code under test. Tests were also appending to the same `logs/error.log` the application writes | reproduced by running the suite with the file transports active; fixed by omitting them when `NODE_ENV=test` | Test hygiene |
| F-28 | My own request-logging middleware read `req.path` from a `'finish'` listener, and Express rewrites `req.url`/`req.baseUrl` as a request descends into a mounted router and restores them as the stack unwinds. So the same route logged `path: '/sign-up'` when the controller answered inside the router and `'/api/auth/sign-in'` when `next(e)` unwound to the app-level error handler first — the field was unstable in a way that depended on whether the request had errored | observed directly in the two log lines during Phase 1 verification; fixed by reading `req.originalUrl`, which is never rewritten | Observability — self-inflicted |
| F-29 | `CORS_ORIGIN` was documented in three env templates and read by nothing. `src/app.js:14` called `cors()` with no options, so the effective policy was `Access-Control-Allow-Origin: *` — a security setting that appeared configured and was not | `grep -rn "CORS_ORIGIN" src/` → no matches, against `.env.example`, `.env.development` and `.env.production` all listing it | **Security — misleading configuration** |
| F-30 | `COOKIE_SECRET` was required by three env templates and checked for by `scripts/prod.sh`, while nothing in `src/` read it: `cookieParser()` is constructed with no secret, so no cookie is signed | `grep -rn "COOKIE_SECRET" src/` → no matches | Usability — a mandatory no-op |
| F-31 | Two defects in my own Phase 1 error path, found by exercising a malformed body against a running server rather than through the test suite. (a) `requestId` was mounted after `express.json()`, so a body-parser failure produced a 400 with **no** correlation id — `JSON.stringify` drops the undefined field silently. (b) `classify()` checked `err.status` before its SyntaxError branch, and body-parser already sets `status = 400`, so the parser's own message went to the client instead of the sanitised one; that text can quote a fragment of the offending body | observed: `{"error":"Unexpected end of JSON input","message":"Unexpected end of JSON input"}` with no `requestId`; now `{"error":"Malformed JSON in request body","requestId":"…"}` | Observability + minor disclosure — self-inflicted |

**F-31 is the most useful finding of the phase to have caught**, because the existing
test asserted the two things that were already right — status 400, no stack frame —
and passed while both defects were live. Booting the process and sending a malformed
body found them in one command. The lesson is narrow and worth keeping: *a test
written from the same mental model as the code inherits its blind spots*, and the
cheapest correction is to exercise the running thing.

It also pairs with F-28: every defect I introduced in this phase was in the
observability layer, where being wrong is silent by construction.

### Post-push corrections, 2026-09-04

Phase 1 was pushed to `main` and two of the four checks failed, and the first v1
matrix aborted at the 1000-VU level. Four further findings, all mine, all in work
this phase added.

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| F-32 | The whole test suite required `DATABASE_URL` to **import**, even though no test issues a query. Both drivers were constructed at module scope and `neon()` throws on `undefined`. Removing the `DATABASE_URL` secret from `tests.yml` — correct on the merits, since the suite has no database — therefore broke CI. It passed locally only because a gitignored `.env` supplied the variable, and because `database.js` itself called `import 'dotenv/config'`, so deleting the variable in a test put it straight back | CI: `No database connection string was provided to \`neon()\``; reproduced locally with `env -u DATABASE_URL … DOTENV_CONFIG_PATH=/nonexistent` | **CI red on main** |
| F-33 | Pool exhaustion surfaced as **500**. `connectionTimeoutMillis` was set — the fail-fast half — but nothing mapped the resulting error, and node-postgres attaches no `code` to it (`pg-pool/index.js:224` constructs a bare `new Error('timeout exceeded when trying to connect')`). So `classify()` fell through to 500 and correct load shedding was indistinguishable from an application bug. `src/config/env.js` had already asserted the intended behaviour in a comment — "a 503 in 5s is a usable signal" — and it was never implemented | v1 500-VU run: `5xx rate 0.07`, users-list p95 **5086 ms** and user-by-id p95 **5004 ms**, both pinned at the 5000 ms `connectionTimeoutMillis` | **Correctness — a 500 that was not a defect** |
| F-34 | The runner stopped restarting the app between runs, so levels were no longer independent. Phase 0 recreated the container before every run because that was how it flipped `BENCH_BYPASS_SECURITY`; the restart was doing two jobs and removing the flag removed the isolation with it. After the 500-VU level, 752 abandoned requests were still being processed server-side holding pool connections, 45 s of cool-down did not drain them, and the 1000-VU `setup()` got a 500 on admin sign-in and aborted the matrix | `git show v0-baseline:benchmarks/scripts/run-baseline.sh \| grep force-recreate` → lines 214, 262; absent from `run_closed` | **Measurement validity** |
| F-35 | `package-lock.json` still declared `@arcjet/inspect`, `@arcjet/node` and `morgan` as root dependencies after they were removed from `package.json`, so `npm ci` kept installing 20 packages the code no longer imports | `node -e` diff of lock root deps vs `package.json` → 3 extra, 17 arcjet + 3 morgan tree entries | Hygiene |
| F-36 | **Drizzle wraps every driver error, so both database-error mappings Phase 1 added were dead.** `DrizzleQueryError` (`node_modules/drizzle-orm/errors.js:10`) rethrows with its own message `"Failed query: …"` and **no** `code`, putting the real pg error in `cause`. So `classify()`'s pool-exhaustion match on `err.message` (F-33) never fired, and `createUser`'s `e?.code === '23505'` never fired — meaning the signup race still returned 500 rather than the 409 Phase 1 claimed to have fixed. Both unit tests passed because both constructed RAW pg-shaped errors rather than the wrapped shape the application actually throws | verified live against an unreachable database: `own .code = undefined`, `cause.code = ECONNREFUSED`, `message = "Failed query: select …"`. The v1 20-VU run reported `8 non-503 5xx, 0 shed` and aborted the matrix | **Correctness — two fixes that were inert** |

**F-36 is the third time the same mistake has produced a finding**, and that
repetition is the finding. F-31, F-32 and F-36 are all: *a test written from the same
mental model as the code inherits its blind spots.* Raw pg errors in the test, wrapped
ones in production; a local `.env` in the test environment, none in CI; the two things
already right asserted and the two wrong ones not.

What changed structurally, rather than just being fixed: `src/utils/db-error.js` walks
the `cause` chain, and `tests/db-error.test.js` constructs the DrizzleQueryError shape
explicitly — stating the contract it depends on, so a drizzle change breaks a test
instead of silently reverting a status code. It also distinguishes SQLSTATE (five
characters of `[0-9A-Z]`) from a Node system code, because `ECONNREFUSED` sitting in
the same `code` property would otherwise be looked up as a Postgres error.

| F-37 | **`connectionTimeoutMillis` produces two different errors, and only one was matched.** `pg-pool/index.js:224` raises `'timeout exceeded when trying to connect'` when the pool is at `max` and a request waits in the queue; `pg-pool/index.js:276` raises `'Connection terminated due to connection timeout'` when the pool is *below* max, opens a new client, and that client's `connect()` does not finish in time. Nothing distinguishes them operationally — both mean the configured timeout expired, both are retryable — but only the first was classified, so which status a request got depended on which path the pool happened to take | v1 20-VU re-run: 7 × 503 (path 1) and 6 × 500 (path 2), the 500s logged with `"cause":"Connection terminated due to connection timeout"` and `"kind":"unknown"`; both strings verified in `node_modules/pg-pool/index.js` | **Correctness — same condition, two statuses** |

**F-37 closes the loop opened by F-33 and F-36, and it took three attempts.** Worth
stating plainly rather than presenting the final version as if it were the first: F-33
set out to map pool exhaustion to 503 and matched one string; F-36 found the match was
looking at the wrong object because drizzle wraps driver errors; F-37 found the string
itself was only one of two the same setting can produce. Each attempt was verified —
and each verification was narrower than the failure mode.

Why `connect()` times out against a healthy Postgres is the interesting part: the event
loop is blocked in bcrypt — sign-in p50 was 2091 ms at that level — so the connect
callback cannot be scheduled inside 5 s. Four of the six were on `POST /sign-in`. The
pool is not too small; increasing `PG_POOL_MAX` would add concurrent queries to a core
that is already saturated. Pool pre-warming is the real mitigation and belongs in
Phase 3.

What changed structurally, so this stops recurring: the matched strings are now a
declarative table in `src/utils/db-error.js`, and `tests/db-error.test.js` asserts
**every needle still appears in the installed pg source**. That converts fragile string
matching into a checked contract — a pg upgrade that rewords one of them fails a test
instead of quietly turning load shedding back into a 500, which is exactly how F-33 and
F-37 stayed hidden until a benchmark tripped over them.

Also added: `benchmarks/scripts/status-histogram.mjs`, and `assert_clean_run` now runs
it on rejection and captures the matching app-side error lines to
`<run>.app-errors.log` before stopping. The previous message — "6 non-503 5xx
response(s)" — was a correct number with no status, no endpoint and no cause, and
container logs vanish on teardown. That is finding F-12 one level down: F-12 was a
failure *rate* that could not be attributed, this was a failure *count* that could not
be attributed, and both are fixed by reading the per-request stream that already had
the answer.

**F-32 is the one worth carrying forward**, and its lesson is narrower and sharper
than "test in CI": *the reason my verification passed was that my environment
differed from CI's in a way I had not enumerated.* A gitignored `.env` plus a library
module that loads dotenv meant the suite could not be made hermetic even
deliberately. Both are fixed — `dotenv` now loads only at the entrypoint, and a
missing `DATABASE_URL` yields a Proxy that throws at the point of use naming the
variable, so the suite imports cleanly with no database anywhere and
`tests/database-config.test.js` runs the import with the variable explicitly deleted.

**F-33 is the more interesting engineering point.** The runner's own assertion caught
it and reported "5xx rate 6.74% — a real defect, not capacity". That was right, and
the defect was in the classifier rather than the pool. Load shedding is now 503 with
`kind: 'saturation'`, and a new `shed_503` counter in the k6 metrics splits it from
500 — so `assert_clean_run` now **fails** on any non-503 5xx and merely notes 503s as
expected saturation past the knee. Adding that counter is additive observation over
the same responses: it changes no request, no load shape and no threshold, so it does
not break the freeze on `baseline.js`, which governs the stimulus rather than the
instrumentation.

Also corrected while auditing this: the hardcoded development JWT secret is gone.
Phase 1's first fix made production throw, but the literal stayed — a
credential-shaped constant in the repository that a forker could come to rely on. The
development fallback is now generated per process, so sessions do not survive a
restart unless `JWT_SECRET` is set, which the startup warning says.


**F-29 and F-30 are the same defect in two directions**, and they were found while
rewriting the README against the code rather than against the previous README — which
is the only reason they surfaced at all. One setting looked enforced and was not; the
other looked mandatory and did nothing. Both mislead in the way that matters: they
teach a reader that the configuration is decorative, and the next variable they skip
is one that counts.

The fixes differ deliberately. `CORS_ORIGIN` is now read, because an origin allow-list
is worth having — with `credentials` enabled only for an explicit list, since a
wildcard plus credentials is rejected by browsers. `COOKIE_SECRET` was **deleted**
rather than wired up: the session cookie holds a JWT, which already carries its own
signature, so signing the cookie would add a second integrity check over the same
bytes. Making a no-op real is not automatically better than removing it.

Worth recording alongside F-29: `sameSite=strict` on the session cookie means a
browser will not send it cross-site regardless of what CORS says. So the allow-list
governs who may *read responses*, not who may *authenticate*. Conflating those is how
CORS gets described as an authentication control.

**F-25 is the most serious finding of Phase 1**, and it is the same shape as F-07
from Phase 0: a security control that degrades to nothing without saying so. Arcjet
failed open when it could not reach its API; the JWT layer failed open when it could
not find its secret. In both cases the application starts, serves traffic, logs
nothing unusual, and provides no protection. `src/config/env.js` now throws in
production and warns loudly elsewhere. The generalisable rule, now stated twice in
this file: **a security control with a working default is a security control that
will eventually run with the default.**

**F-22 is the most interesting one.** The winston bug (`combine((a, b, c))`) is
invisible to review because the code reads correctly, invisible at runtime because
the app starts and logs appear, and — as it turns out — invisible to the linter
whose entire purpose is catching accidental comma expressions, because the syntax
that causes the bug is the syntax the rule accepts as intent. That is the argument
for `tests/logging.test.js` asserting on the **formatted output line** rather than
on `logger.info` having been called: a mock-based test passes identically with the
bug present and absent. The suite now also reproduces the defect deliberately, so
the evidence lives in the tests rather than only in a commit message.

### What was fixed, and what was deliberately left

Every v0 defect from `UPGRADE_PLAN.md` Part 1, plus the four evidence-ordered items:

```
PRIVILEGE ESCALATION       role removed from signupSchema entirely, schema made
                           strict so an attempt is a logged 400 rather than a
                           silent strip, and createUser no longer accepts a role
                           parameter at all — two independent gates
LOGGER                     both combine((a,b,c)) comma expressions fixed; a
                           timestamp and stack now reach every record
SESSION LIFETIME           one SESSION_TTL_MS in src/config/env.js, consumed by
                           both jwt.js and cookies.js; asserted equal by a test
JWT SECRET                 no usable fallback; throws in production (F-25)
GLOBAL ERROR HANDLER       classify() maps AppError / pg SQLSTATE / body-parser
                           errors; 5xx bodies carry a request id and nothing else
GRACEFUL SHUTDOWN          fail readiness -> pause -> close listener -> drain ->
                           release pool and sweeper; SIGINT takes the same path
MORGAN                     dropped; one structured line per response instead of
                           an Apache string wrapped in a JSON message field
ARCJET                     deleted, with @arcjet/node and @arcjet/inspect
RATE LIMITING              src/rate-limit/ — sliding-window log, 429 +
                           Retry-After + RateLimit-*, per-route fail policy,
                           mounted AFTER authenticate (ADR 0003)
PG POOL                    max / connectionTimeoutMillis / idleTimeoutMillis
                           explicit; 'error' listener added so an idle-client
                           error cannot terminate the process (F-15)
PAGINATION                 GET /api/users?limit&offset, ORDER BY id, capped
CI LINT                    continue-on-error removed; 37 pre-existing errors
                           cleared; eslint and prettier responsibilities split
DOCKER IMAGE NAME          local-kube-api -> acquisitions
DEV/PROD SCRIPTS           health-gated waits, migrations in the right order and
                           on the right network (F-23, F-24)
COMPOSE                    obsolete `version:` key removed from both files;
                           dev credentials parameterised; stop_grace_period set
                           so a drain is not SIGKILLed mid-sequence
```

Left in place **on purpose**, each with the phase that owns it:

- **The Neon HTTP driver branch** in `src/config/database.js`. Removing it changes
  what the v1 benchmark measures beyond the four changes being attributed. Phase 3.
  What Phase 1 adds is a loud warning — the driver switch was silent, and F-06
  exists because of it.
- **The signup check-then-insert race.** Phase 1 translates SQLSTATE 23505 so the
  loser of the race gets the 409 the controller always intended instead of a 500,
  but the race is still there. Wrapping it in a transaction is Phase 3's worked
  example for isolation levels; spending the exhibit early would waste it.
- **Read-modify-write in `updateUser`/`deleteUser`.** Same reasoning — it is the
  lost-update demonstration.
- **The sign-in timing oracle.** With no user found, no bcrypt compare runs, so a
  nonexistent address answers measurably sooner than a wrong password. Closing it
  needs a dummy compare against a fixed hash, and it belongs with the Phase 4
  rebuild of the credential path.
- **A single-node rate limiter.** Three replicas would each hold their own state and
  allow 3× the configured limit. That is the Phase 4 exhibit, and it is recorded in
  ADR 0003 rather than left to be discovered.

### Harness changes

```
benchmarks/k6/lib/journey.js        NEW — shared read-heavy journey (realistic + saturation)
benchmarks/k6/realistic.js          NEW — ~0.5% auth mix; its series starts at v1 (F-17)
benchmarks/k6/saturation.js         repointed at the real mix; RATE is now iterations/s and
                                    the useful range drops ~2 orders of magnitude (F-17)
benchmarks/k6/baseline.js           FROZEN — one line changed, the output directory
benchmarks/k6/lib/config.js         +RESULTS_DIR
benchmarks/scripts/run-phase.sh     NEW — PHASE parameter, no variant loop, verifies the
                                    limiter ceilings in-container and asserts after every
                                    run that zero requests were rejected
benchmarks/scripts/run-baseline.sh  now a wrapper, kept because committed artifacts cite it
benchmarks/scripts/report.mjs       --phase, --compare; refuses to pair different instruments
                                    or censored rows
benchmarks/scripts/attribute-failures.mjs  --dir / --out
.env.bench.example                  ARCJET_KEY and BENCH_BYPASS_SECURITY gone; pool,
                                    pagination, session and rate-limit knobs added
docker-compose.bench.yml            BENCH_BYPASS_SECURITY removed; stop_grace_period added
.gitattributes                      results glob generalised to every phase
package.json                        +bench:v1, +bench:report:v1, +bench:attribute:v1
```

The new guardrail is the one worth explaining, because it is the direct successor to
Phase 0's in-container variant check. The limiter is ours now and runs on every
request, and every k6 VU shares one source IP — so a production-shaped per-IP limit
would reject most of the matrix. Rejections are *fast*, so the report would show a
dramatic latency improvement that was really the limiter refusing to work. That is
exactly the trap recorded as the F-16 corollary: supplying a working Arcjet key
would not have improved the v0 runs, it would have ended them. So `.env.bench`
raises the ceilings far above what the matrix can generate — the limiter still
executes, so its CPU cost is still measured, and only the rejection is taken out of
the way — and the runner checks the *outcome* rather than the configuration, reading
the ceilings back out of the running container and refusing any result file with a
non-zero 429 rate.

### Verified in this environment

- `npm run lint` → **0 errors** (from 37). `npm run format:check` → clean. Both are
  now blocking in CI.
- `npm test` → **96 tests across 8 suites**, all passing, process exits cleanly.
  Coverage of the new behaviour rather than the old three smoke tests: the
  escalation attempt, the limiter's status/headers/keying/failure policy, the
  logger's formatted output, `classify()`'s full mapping, no stack in any error
  body, pagination defaults and caps, and the cookie/JWT lifetime agreement.
- App boots under `NODE_ENV=test` with no database and serves `/health` 200,
  `/ready` 200, `/api` 200, unknown route 404 with a request id.
- `POST /api/auth/sign-up` with `"role":"admin"` → **400**, `Unrecognized key:
  "role"`, no `Set-Cookie` issued. The v0 request that returned an admin JWT to an
  anonymous caller.
- Malformed JSON → **400** with body
  `{"error":"Malformed JSON in request body","requestId":"…"}` (was a 500 with a
  body-parser stack trace); a 200 KB body → **413**, also carrying a request id.
  Both verified against a running process, which is how F-31 was found.
- **Graceful shutdown exercised end to end.** SIGTERM against a live process:
  `/ready` was already 503 within 150 ms, `/health` flipped to 503, the drain
  reported `All in-flight requests completed`, `closeDatabase()` returned
  `{closed: true}` — confirming the pool branch ran and `pool.end()` completed — and
  the process exited 0. Every log line carried a timestamp, which is the logger fix
  observable in the one place it matters most.
- **Rate limiter exercised end to end** with `RATE_LIMIT_AUTH_MAX=3`: requests 1-3
  returned `RateLimit-Remaining: 2/1/0`, request 4 returned **429** with
  `Retry-After: 60` and body
  `{"error":"Too Many Requests","message":"Rate limit of 3 requests per 60s exceeded.","retryAfter":60}`.
  Twelve consecutive `/health` hits all returned 200 with no `RateLimit-*` header, so
  probes are genuinely unlimited.
- **CORS allow-list exercised end to end**: a configured origin is reflected with
  `Access-Control-Allow-Credentials: true`; an origin off the list gets no
  `Access-Control-Allow-Origin` header at all.
- A thrown error containing `postgres://user:hunter2@db/app` produces a response
  body of exactly `{error, requestId}` — asserted not to contain the password or a
  stack frame — while the full stack, cause and request id reach the log.
- `report.mjs` regenerated `benchmarks/v0-baseline/SUMMARY.md` from the committed v0
  JSON with **zero changes to any measured figure**; only the Reproduce block moved
  to the new script names. That is the check that the harness rework did not disturb
  the Phase 0 evidence.
- `--compare` exercised against synthetic v1 results: it selected the v0
  `asbuilt` rows as the "before" (695.18 ms p95 at 5 VUs, matching the committed
  matrix), excluded the censored 100-VU level with a stated reason, and excluded the
  realistic-mix row from the frozen-instrument comparison.
- All seven YAML files parse, and the bench app healthcheck command is
  byte-identical in value after reformatting. `bash -n` passes on all four shell
  scripts. `node --check` passes on every JS file including the k6 scripts.
- `.env.production`'s Neon credential was confirmed **not** to be the one leaked in
  `4d0ae6e` — compared by hash rather than by eye, so F-04's remediation is verified
  rather than assumed.

### Not verified here — must run on the Docker host

Same constraint as Phase 0: this VM has no Docker, no Postgres and no k6.

```bash
cp .env.bench.example .env.bench       # note: ARCJET_KEY is gone, RATE_LIMIT_* added
git tag v1-correctness && git push origin v1-correctness
npm run bench:v1                       # ~50 min with the default level sets
npm run bench:report:v1                # SUMMARY.md incl. the v0→v1 delta table
npm run bench:attribute:v1
```

Until that runs, `benchmarks/v1-correctness/results/` is empty by design and this
phase has **no numbers**. The throughput claim implied by removing ~75 ms of CPU per
request is an expectation, not a result, and must not be quoted until the matrix has
run. F-19 applies: tag *before* measuring, and check `environment.json` afterwards
for `tag: "unavailable"`.

### Phase 1 exit criteria

- [x] All v0 correctness and security defects fixed, each with a test
- [x] Arcjet removed; rate limiting owned, with an explicit per-route failure policy
- [x] 429 + `Retry-After` + `RateLimit-*` replace the v0 403 (F-08)
- [x] Limiter mounted after `authenticate`, so per-role limits actually apply
- [x] pg pool `max` and `connectionTimeoutMillis` explicit (F-15)
- [x] Users list paginated and capped
- [x] Global error handler; no stack trace on the wire in any status class
- [x] Graceful shutdown with readiness gating
- [x] CI lint and format blocking; 37 pre-existing errors cleared
- [x] Docker image name corrected
- [x] Harness: frozen instrument preserved, realistic mix added, saturation fixed (F-17)
- [x] Findings F-21..F-37 recorded with evidence
- [x] `docs/INTERVIEW_PHASE_1.md` written
- [ ] `v1-correctness` tag pushed
- [ ] v1 matrix executed on the Docker host
- [ ] `SUMMARY.md` generated, including the v0→v1 comparison

**Verdict: code complete, numbers pending.** The same honest position Phase 0 held
for two days. The deliverable of this phase is a measured delta, and no measurement
exists yet — so the correct statement today is "the defects are fixed and the tests
prove it", not "throughput tripled".

---

## Phases 3, 4, 5 and 7 — executed together, 2026-09-05

### Scope, and the two phases that were struck

Phases 3, 4, 5 and 7 were built in one pass. Phase 2 (TypeScript) and Phase 6
(observability) were **dropped**, not deferred, and both decisions were taken
deliberately rather than by drift:

- **Phase 2 is struck.** Migrating 2,500 lines was already cheaper than migrating the
  ~7,000 that exist now, so deferring it made it worse, and it produces no measurable
  claim. Recorded as ADR 0005. JSDoc is used where it prevents a real bug — the store
  interface, the event envelope, config — and nowhere else.
- **Phase 6 is reduced to what the other phases need to be checkable.** No
  OpenTelemetry, no Grafana, no prometheus-adapter. What exists is a `/metrics`
  endpoint in Prometheus text format with the four signals that have each explained a
  real failure in this project (RED per route, pool saturation, event-loop lag,
  limiter rejections) plus the outbox and consumer counters. ADR 0006 records why it is
  hand-written rather than `prom-client`.

Cadence was also cut on purpose: one focused proof per phase and **one** final
benchmark matrix, rather than a full matrix and an ~880-line interview document per
phase. Phases 0 and 1 each cost more in artifacts than in code, and two aborted v1
matrices were the evidence that the ceremony had started to crowd out the work.

### Findings

| id | finding | evidence | severity |
|---|---|---|---|
| F-38 | **`NODE_ENV` chose the database DRIVER, so production ran code development never executed.** Outside `development` the app used the Neon HTTP driver: request-per-query, no pool, therefore no `BEGIN`/`COMMIT`, no `SET TRANSACTION ISOLATION LEVEL`, no `SELECT … FOR UPDATE`, and nothing for `closeDatabase()` to drain on SIGTERM. Every Phase 3 deliverable was literally impossible in production while that branch existed, and every claim about draining connections on shutdown was false in the only environment that mattered | v1 `src/config/database.js:100-140`; the two drivers' capability difference is why `closeDatabase()` returned `{closed:false, reason:'http-driver-holds-no-connections'}` | **Correctness — dev and prod were different systems** |
| F-39 | **node-postgres has no `min`, so the pool is cold at every deploy.** Each of the first `max` requests pays TCP + auth for a new connection, and the callback that completes it needs the event loop — which under load is busy. This is the mechanism behind F-37's `Connection terminated due to connection timeout` against a healthy database and a pool below `max`; raising `PG_POOL_MAX` would have made it worse | F-37's evidence, re-read: 4 of the 6 failures were on `POST /sign-in`, where the loop was in bcrypt at p50 2,091 ms. Fix: `prewarmPool()` before `app.listen()` | Latency — self-inflicted at every restart |
| F-40 | `users.created_at` and `updated_at` are `timestamp` **without** time zone: a wall-clock reading with no offset, cast from `now()` through the server's local zone. `deals` uses `timestamptz`. The existing columns are deliberately not converted — `ALTER COLUMN … TYPE timestamptz` rewrites the table under an ACCESS EXCLUSIVE lock, which is free at 1,001 rows and an outage at 1M | `drizzle/0000_dapper_hedge_knight.sql:6-7` vs `drizzle/0001_deals.sql:11-13` | Schema — recorded, with the migration cost as the reason |
| F-41 | **A transaction would not have fixed the signup race, and Phase 1 said it would.** At READ COMMITTED each statement takes a fresh snapshot of committed data, so an uncommitted INSERT in another session is invisible: both callers pass the existence check, both INSERT, one fails at COMMIT. `BEGIN` changes the timing and nothing else. The check was therefore **deleted** rather than wrapped, leaving the unique index as the serialization point — which also removes a round trip from every signup | `scripts/db/isolation-demo.mjs` scenario 1 demonstrates both snapshots seeing zero rows; scenario 2 shows SERIALIZABLE turning it into a 40001 that must be retried | **Correctness — the planned fix was the wrong fix** |
| F-42 | Read-modify-write in `updateUser`/`deleteUser`: read the row, decide it exists, then write. The existence check was redundant with the UPDATE (a predicate that matches nothing returns nothing), so it bought nothing and cost a round trip, and the gap between read and write is a lost update. Fixed as one statement each. What that does **not** buy is stated in the code: concurrent updates to the same field remain last-writer-wins, which is conventional partial-update semantics — `deals` carries a version column to show the alternative | `scripts/db/isolation-demo.mjs` scenarios 3-5: two +10 increments produce +10 at READ COMMITTED, a 409 with the version column, and +20 with `SELECT … FOR UPDATE` | **Correctness** |
| F-43 | `POST /api/deals` had no way to be retried safely. A lost response — a proxy timeout, or a deploy severing the socket, which is exactly F-34's 752 abandoned requests — makes a client resend, and the server had no way to recognise it. Fixed with `Idempotency-Key`: a `SET NX` claim, a stored 2xx response replayed with `Idempotent-Replay: true`, and 422 when the same key arrives with a different body | `tests/idempotency-lock.test.js` — the handler counts its own executions, so "did the write happen twice" is answered by the handler rather than inferred | Correctness — a duplicate resource per lost response |
| F-44 | A keyset cursor over a non-unique sort key skips or repeats rows: the next page starts "after the last value seen", and every row sharing that timestamp is on the wrong side of the boundary. The cursor therefore carries `(created_at, id)`, and the index is declared over both | `tests/cursor.test.js` asserts two rows in the same millisecond produce different cursors | Correctness — silent data loss in pagination |
| F-45 | `SELECT count(*)` reads every visible row, because MVCC keeps no authoritative counter — "how many rows are there" has a different answer per snapshot. Trivial at the 1,001 rows of `users` (2.20 ms, F-04) and a full scan per page request at 1M. The deals API returns no exact total; `GET /api/deals/summary` reports `total_estimated` from `pg_class.reltuples`, and `-1` (never analysed) is reported as `null` rather than as 0 | `benchmarks/scripts/explain.mjs` captures the `exact-count-star` plan next to the keyset plans | Performance — and an admitted estimate beats a wrong total |
| F-46 | **A keyset cursor built from a `timestamptz` silently skips rows, because the driver truncates it.** Postgres timestamps default to microsecond precision; a JS `Date` holds milliseconds, and node-postgres returns a `Date`. So the last row of page one comes back truncated, the cursor asks for rows older than the truncated value, and every row inside the microsecond gap is skipped. Fixed by declaring the columns `timestamptz(3)`, so what Postgres stores is what JavaScript can represent | `drizzle/0001_deals.sql:11-13`; the failure mode is invisible below a few thousand writes per second, which is why it survives review | **Correctness — under load only** |
| F-47 | **An index that looks like it matches the ORDER BY and does not.** `ORDER BY x DESC` means `NULLS FIRST` in SQL; drizzle emits indexes as `DESC NULLS LAST`. Postgres compares null placement when matching an index to a requested ordering and does not reason about the columns being NOT NULL, so `orderBy(desc(deals.created_at))` — the obvious drizzle helper — produces a Sort node over a full scan while the "correct" index sits unused. The service spells the ORDER BY out to match the index exactly | `tests/deals.test.js` asserts the rendered SQL contains `desc nulls last` on both columns; `explain-summary.md` has a `Sort node` column so the regression is visible in the plan | **Performance — a 1M-row sort instead of an index scan** |
| F-48 | Using the timestamp as the sorted-set member in the Redis limiter undercounts: `ZADD` with an existing member updates its score rather than adding an entry, so two requests in the same millisecond count once. It fails precisely under the load where the limit matters and is invisible at low rates | `tests/redis-store.test.js` — the clock does not advance in that test, and the count still reaches 2 | Correctness — silent under-limiting |
| F-49 | `enableOfflineQueue` defaults to **true** in ioredis, which turns a Redis outage into latency instead of an error: commands queue and the limiter's fail-open/fail-closed policy (ADR 0002) never runs. Disabled explicitly, with `maxRetriesPerRequest: 1` and a 300 ms command timeout, so an unavailable store produces an error the policy is written to handle | `src/redis/client.js`; `tests/redis-store.test.js` drives both branches through a real Express response | Correctness — a policy that could not execute |
| F-50 | **A Redis lock cannot make an external side effect exclusive, no matter how it is implemented.** A holder paused past its TTL (GC, hypervisor migration, suspended container) resumes believing it still holds the lock while another process legitimately holds it. Redlock adds nodes and does not address this. The fix is a fencing token validated *by the resource* — and `deals.version` already is one, so the Redis lock is used only as an optimisation (one publisher, for ordering) and never for correctness | `src/redis/lock.js` header; `tests/idempotency-lock.test.js` asserts a stale holder's release does not delete the new holder's lock | Design — the honest limit of a distributed lock |

### What was built

**Phase 3 — Postgres foundation.** One driver (`pg.Pool` everywhere, F-38), pool
pre-warming (F-39), and the `deals` entity: `bigserial`, money as `bigint` cents,
`timestamptz(3)` (F-46), a `version` column, an enum stage machine, three CHECK
constraints and an FK with `ON DELETE RESTRICT`. Three indexes, each justified by one
query: `(created_at, id)` for the global page, `(owner_id, created_at, id)` for the
scoped page — which is the hot path, because non-admins are pinned to their own deals
— and a **partial** index over open deals by stage. Keyset pagination with an opaque
cursor beside the OFFSET path, kept deliberately so the comparison can be measured
through the same stack. Optimistic concurrency on `updateDeal` (409 with
`currentVersion`, plus `If-Match`/`ETag`), pessimistic `SELECT … FOR UPDATE` on the
stage transition, and `withTransaction` with retry on 40001/40P01 — because
SERIALIZABLE without a retry loop is an endpoint that randomly 500s.

**Phase 4 — Redis.** The limiter's store swapped and *nothing else changed*, which was
the point of defining the contract as `hit(key, limit, windowMs)` in Phase 1. The
window is a Lua script so read-decide-write is atomic, and it takes its clock from
`redis.call('TIME')` rather than from the application, because three replicas do not
agree about the time. Opaque refresh tokens stored as SHA-256, rotated on every use,
with reuse detection that revokes the whole family and an absolute session cap that
rotation cannot extend. A `jti` denylist gives sign-out real revocation, failing open
with a counter (the exposure is bounded by the 15-minute token; failing closed would
401 every request during a Redis blip). Idempotency keys (F-43) and a distributed lock
whose limits are documented rather than assumed (F-50).

**Phase 5 — Kafka and the outbox.** The event is written to a table in the **same
transaction** as the domain change, so there is no ordering of "write" and "publish"
that can lose or invent an event. A publisher polls with `FOR UPDATE SKIP LOCKED`,
publishes keyed by `deal:<id>` (one partition per aggregate, which is exactly as much
ordering as the domain needs), and expresses backoff as `available_at` rather than as a
sleep. The consumer claims each event by inserting `(consumer_group, event_id)` with
`ON CONFLICT DO NOTHING` **inside the handler's transaction** — at-least-once delivery,
exactly-once effect — retries a failing handler, then produces to a real DLQ topic so
one poison message cannot hold a partition forever. `POST → persist+outbox → publish →
consume → notify` is checkable end to end with `GET /api/notifications`.

**Phase 7 — Kubernetes.** Three API replicas (the number the Phase 4 claim is about),
one publisher (ordering), three consumers (the partition count). Migrations as a Job
with an init container that waits for the *result*, three probes answering three
different questions, `maxUnavailable: 0` plus a PDB, a `preStop` sleep to cover
eventually-consistent endpoint removal, `readOnlyRootFilesystem` with explicit
writable mounts, and an HPA on CPU and memory — ADR 0008 records why not a custom
metric. `scripts/k8s/kind-up.sh` builds both images, loads them, applies everything in
dependency order and waits at each step; `scripts/k8s/drills.sh` breaks five things
and asserts the outcome.

### Verified in this environment

- `npm test` → **268 tests across 17 suites**, no database, no Redis, no broker, clean
  process exit. `npm run lint` → 0 errors. `prettier --check .` → clean.
- The offline suite is the constraint that shaped several designs: `ioredis` and
  `kafkajs` are imported **dynamically**, behind factories, and every consumer takes an
  injected client — so the whole application can be imported and tested with neither
  driver installed. That is also why the metrics registry is hand-written.
- SQL is asserted by rendering it. `tests/helpers/fake-pg.js` puts a fake socket under
  a **real** drizzle instance, so `desc nulls last`, the row-value keyset comparison,
  `for update skip locked` and `version = version + 1` are read out of the statement
  that would have gone to Postgres, not out of a mock's call log.
- Lua is not verified here, and the tests say so. `tests/helpers/fake-redis.js`
  contains a JavaScript transcription of each script and serialises script execution to
  model Redis' single thread; `scripts/redis/*.mjs` run the real scripts against a real
  Redis and assert the same properties. Where the two could disagree, the proof script
  is the authority.

### Not verified here — must run on the Docker host

The sandbox has no npm registry, no Docker, no k6 and no kubectl, so everything below
is a committed script rather than a result:

```
npm install                      # ioredis + kafkajs are new dependencies
npm run db:migrate               # 0001_deals, 0002_outbox, 0003_notifications
npm run bench:seed               # users
npm run db:seed:deals            # 1,000,000 deals, generated by Postgres
npm run db:explain               # → benchmarks/v3-postgres/explain-*.txt + summary
npm run db:isolation             # → benchmarks/v3-postgres/isolation-anomalies.txt
npm run redis:proof:limiter      # 3 replicas: in-process over-admits, Redis is exact
npm run redis:proof:refresh      # rotation, reuse, concurrency, against real Redis
npm run events:topics            # explicit topics, 3 partitions
npm run events:drill -- write    # with Kafka stopped: writes succeed, backlog grows
npm run events:drill -- drain    # with Kafka started: drains, consumes, dedupes
npm run k8s:up                   # kind cluster, 3 replicas, migrations, topics
npm run k8s:drills               # five failure drills, each asserting its outcome
npm run bench:v7                 # the final matrix against the cluster
npm run bench:report:v7          # v0 → v7 comparison table
```

Until those run, the correct statement is "the mechanisms are implemented and the
offline tests prove their logic" — not any number. Two claims in particular are
arithmetic until measured: the keyset-versus-OFFSET ratio at 1M rows, and the
throughput of the full mix at three replicas.

### Exit criteria

- [x] One database driver; transactions, isolation levels and row locking possible in
      every environment (F-38)
- [x] Write-heavy entity with composite and partial indexes, each justified by a query
- [x] Keyset pagination beside the OFFSET path, so the comparison is measurable
- [x] Optimistic concurrency *and* pessimistic locking, both in the codebase, with the
      trade documented rather than argued
- [x] Isolation anomalies demonstrated by script rather than described (F-41, F-42)
- [x] Rate limiting shared across replicas, with the in-process defect measurable on
      demand
- [x] Refresh-token rotation with reuse detection; sign-out that actually revokes
- [x] Idempotency keys on the create path (F-43)
- [x] Transactional outbox; no dual write anywhere in the codebase
- [x] Idempotent consumer, bounded retries, real DLQ topic
- [x] Kubernetes manifests: probes, HPA, PDB, migrations as a Job, one-command cluster
- [x] Failure drills scripted, each asserting an expected outcome
- [x] Findings F-38..F-50 recorded with evidence
- [ ] 1M-row seed, EXPLAIN captures and the isolation transcript committed
- [ ] Redis and outbox proof scripts run against real services
- [ ] v7 matrix executed on the cluster; `SUMMARY.md` with the v0 → v7 table
- [ ] `docs/INTERVIEW_PHASES_3_TO_7.md` reviewed against the measured numbers





