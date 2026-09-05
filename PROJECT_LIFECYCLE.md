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
| 1 — Correctness & security | **Code complete** — defects fixed, Arcjet removed, findings F-21..F-31 recorded; v1 matrix pending on the Docker host | 2026-09-04 | — | Defect-free baseline + measured v0→v1 delta |
| 2 — TypeScript migration | Not started | — | — | Strict-typed source |
| 3 — Postgres foundation | Not started — **rescoped**, see the Phase 1 section | — | — | New entity, 1M-row seeder, keyset pagination, indexes, isolation |
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
- `npm test` → **68 tests across 6 suites**, all passing, process exits cleanly.
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
- [x] Findings F-21..F-31 recorded with evidence
- [x] `docs/INTERVIEW_PHASE_1.md` written
- [ ] `v1-correctness` tag pushed
- [ ] v1 matrix executed on the Docker host
- [ ] `SUMMARY.md` generated, including the v0→v1 comparison

**Verdict: code complete, numbers pending.** The same honest position Phase 0 held
for two days. The deliverable of this phase is a measured delta, and no measurement
exists yet — so the correct statement today is "the defects are fixed and the tests
prove it", not "throughput tripled".




