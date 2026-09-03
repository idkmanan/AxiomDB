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
| 1 — Correctness & security | Next | — | — | Defect-free baseline |
| 2 — TypeScript migration | Not started | — | — | Strict-typed source |
| 3 — Postgres foundation | Not started | — | — | Pooling, indexes, pagination, isolation |
| 4 — Redis: limits & tokens | Not started | — | — | Distributed rate limiting, refresh rotation |
| 5 — Kafka & outbox | Not started | — | — | Async pipeline, no dual-write loss |
| 6 — Observability | Not started | — | — | Cross-hop trace |
| 7 — Kubernetes & scale-out | Not started | — | — | 3-replica benchmark + failure drills |
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
