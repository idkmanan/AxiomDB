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
| 0 — Baseline measurement | Harness complete & verified; **awaiting benchmark run on a Docker host** | 2026-09-01 | — | Reproducible benchmark harness + v0 numbers |
| 1 — Correctness & security | Not started | — | — | Defect-free baseline |
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
- [ ] `v0-baseline` tag pushed
- [ ] Benchmark matrix executed on Docker host
- [ ] `SUMMARY.md` generated from real results

**Verdict: harness complete, numbers pending.** Phase 0 is code-complete and
verified as far as this environment allows. It is not *finished*, because its
deliverable is a measurement and no measurement exists yet. Phase 1 must not start
until the matrix has run — otherwise the baseline describes code that no longer
exists, and the entire before/after comparison is lost.

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
