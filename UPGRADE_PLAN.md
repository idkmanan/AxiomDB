# Upgrade Plan — from CRUD API to benchmarked distributed service

Audit date: 2026-09-01. Baseline commit: `c1c0707`.

Every finding below cites a file and line, or a command whose output I checked. Claims I could not verify are marked as such.

---

## Part 1 — What the codebase actually is today

15 source files, 13 commits, one table. The shape is competent: layered `routes → controllers → services → models`, Zod validation at the edge, subpath import aliases in `package.json`, a genuinely good multi-stage `Dockerfile` with a non-root user and `tini`, and three CI workflows. That is above-average for a portfolio API.

The problem is not the layering. It is that nothing in the repo is distributed, nothing is measured, and there are four correctness bugs sitting in the code that an interviewer reading it would find.

### Blocking defects (verified)

**1. Privilege escalation on signup.** `src/validations/auth.validation.js:7` declares `role: z.enum(['user','admin']).default('user')`, and `src/controllers/auth.controller.js:19-20` destructures `role` straight out of the validated body into `createUser`. Any anonymous caller can `POST /api/auth/sign-up` with `"role":"admin"` and receive an admin JWT. That token then satisfies `authorize('admin')` at `src/routes/users.routes.js:15`, which is the only thing guarding the list-all-users endpoint. The entire RBAC layer is bypassable by one JSON field.

**2. The logger drops timestamps and stack traces.** `src/config/logger.js:7` reads `winston.format.combine((a, b, c))`. The extra parens make that a comma expression, so `combine` receives exactly one argument — `json()` — and `timestamp()` and `errors({stack:true})` are discarded. I confirmed this by constructing both variants against the installed winston:

```
--- BAD (current code, extra parens) ---
{"a":1,"level":"info","message":"hello"}
--- GOOD (no extra parens) ---
{"a":1,"level":"info","message":"hello","timestamp":"2026-09-01T11:06:33.849Z"}
```

Same bug again at `src/config/logger.js:20` for the console transport. So "structured logging" is currently structured JSON with no time field — unusable for the observability phase, and it means `logs/combined.log` cannot be correlated with anything.

**3. `cookies.get` is a comma-expression bug.** `src/utils/cookies.js:18` is `return req,cookies[name];` — it evaluates `req`, throws it away, then dereferences the module's own `cookies` object. It happens to be harmless only because nothing calls it; `src/middleware/auth.middleware.js:6` reads `req.cookies?.token` directly.

**4. Session lifetime is internally contradictory.** `src/utils/cookies.js:6` sets `maxAge: 15*60*1000` (15 minutes) while `src/utils/jwt.js:5` sets `JWT_EXPIRES_IN = '1d'`. The browser discards the cookie after 15 minutes but the token stays cryptographically valid for a day. Anyone who captured it has 24 hours, and there is no revocation path — `grep -rn "SIGTERM\|revoke\|denylist" src/` returns nothing.

### Structural gaps (verified by grep)

- **No global error handler.** `grep -rn "err, req, res, next" src/` → no matches. Every `next(e)` in the controllers falls through to Express's default handler. In `NODE_ENV=development` that returns the stack trace in the HTTP body.
- **No graceful shutdown.** `grep -rn "SIGTERM\|SIGINT\|server.close" src/` → no matches. `src/server.js` is 7 lines: `app.listen` and a `console.log`. Under a Kubernetes rolling deploy, every in-flight request is severed. This has to be fixed before any multi-replica claim is credible.
- **No transactions anywhere.** `grep -rn "transaction" src/` → no matches. `src/services/auth.service.js:42-46` does a `SELECT` for an existing email and then an `INSERT` as two separate statements. Two concurrent signups for the same address both pass the check; only the unique constraint from `drizzle/0000_dapper_hedge_knight.sql:10` saves you, and it surfaces as an unhandled 500 rather than the 409 that `auth.controller.js:32` intends. This is a real race, and it is the perfect exhibit for your isolation-level discussion.
- **Read-modify-write races in the user service.** `src/services/users.service.js:39-40` and `:75-76` both call `getUserById` and then act on the result outside any transaction. Classic lost update.
- **`getAllUsers` is unbounded.** `src/services/users.service.js:6-14` selects every row with no `LIMIT`, no `OFFSET`, no ordering. At 1M rows this is the single easiest before/after number in the whole project.
- **Zero indexes beyond the defaults.** The only migration, `drizzle/0000_dapper_hedge_knight.sql`, creates a serial PK and `users_email_unique`. `src/services/auth.service.js:26` filters on `users.email`, which the unique constraint's implicit index covers, so — worth being honest with yourself here — there is currently *no* slow indexed lookup to fix. The index story has to be built on the new entity, not on `users`.
- **The Neon HTTP driver makes half your plan impossible.** `src/config/database.js:8-19` uses `pg.Pool` only when `NODE_ENV === 'development'`; otherwise it uses `neon()` over HTTP. The HTTP driver is stateless request-per-query: no connection pool to tune, no `BEGIN`/`COMMIT`, no advisory locks, no `SET TRANSACTION ISOLATION LEVEL`. Your items 2 and 3 cannot be built on it. Hence the decision to drop it.
- **Rate limiting is not distributed and never fires.** `src/middleware/security.middleware.js` calls Arcjet, so limit state lives in Arcjet's cloud — you cannot show the mechanism. Two further bugs: `src/config/arcjet.js:17-19` sets a base `slidingWindow` of `interval: 2, max: 5`, and `security.middleware.js:29` layers a second sliding window on top via `withRule`, so the effective limit is the intersection of two rules, not the per-role limit the switch statement suggests. And `securityMiddleware` is mounted at `src/app.js:20` *before* the routers, which means `req.user` is always `undefined` at that point (it is only set by `authenticate`, `src/middleware/auth.middleware.js:13`, which runs later at `users.routes.js:12`). So `role` at `security.middleware.js:7` is permanently `'guest'` and admins and users silently get the 5/min guest limit. Your role-based rate limiting has never worked.
- **Rate-limit rejections return the wrong status.** `security.middleware.js:41` returns `403` for rate limiting. It should be `429` with a `Retry-After` header.
- **`morgan` and `winston` are logging the same requests twice**, `app.js:18`, one as an unstructured Apache-combined string inside a JSON `message` field. That defeats structured logging.
- **Test suite is three smoke tests.** `tests/app.test.js` covers `/health`, `/api`, and a 404. Nothing touches auth, RBAC, or the services. `jest.config.mjs` is the untouched scaffold — 200 lines of comments, `collectCoverage: true` with no thresholds. Meanwhile `coverage/` is committed to git (`git ls-files | grep coverage` returns 30+ files) and shows as modified on every local run.
- **`logs/` is committed too**, despite `.gitignore` listing `logs/*` — they were tracked before the rule was added, so the rule does nothing.
- **CI lint is decorative.** `.github/workflows/lint-and-format.yml:24,28` set `continue-on-error: true` on both lint and format, then the `Annotate lint failures` step is gated on `if: failure()` which can never be reached. The workflow always passes.
- **`docker-compose.dev.yml:23-27` hardcodes `POSTGRES_PASSWORD=npg`** and `docker-compose.prod.yml` has no Postgres at all, because prod assumes Neon. Both need reworking.
- **Both compose files still carry `version: '3.8'`**, obsolete in Compose v2.
- **The `.env` leak.** `git log --all -- .env` shows it was added in `4d0ae6e` and removed in `fdc5df3`, and `git show 4d0ae6e:.env` still prints a live-format Neon connection string with password for `ep-calm-mode-az6e0iqx-pooler.c-3.ap-southeast-1.aws.neon.tech`. You've told me the credential was rotated, so the exposure is closed — but the string is still readable in history, and a reviewer who clones the repo will see it. Since we're dropping Neon anyway, the pragmatic close-out is a secrets-scanning CI step (gitleaks) plus a note; history rewriting is optional.
- **The Docker image name is wrong.** `.github/workflows/docker-build-and-push.yml:9` pushes to `${DOCKER_USERNAME}/local-kube-api` — a different project's name, per commit `c1c0707 fix: Docker github action image name`.

### One thing to keep

`Dockerfile` is genuinely good: four stages, `npm ci --only=production --ignore-scripts`, uid/gid 1001 non-root, `tini` as PID 1, a `HEALTHCHECK`. And `docker-build-and-push.yml` already emits provenance and SBOM with multi-arch builds. Don't rewrite these; extend them.

---

## Part 2 — Verdict on your five ideas

**Redis — keep, but reorder.** Rate-limit state and the token/session layer are the high-value uses because they are *correctness* problems in a multi-replica world, not performance problems. Caching is the weakest of the four: with `users` at a few thousand rows and every query hitting an index, a cache in front of it improves a number that was never slow, and cache invalidation on write is where portfolio projects quietly go wrong. Build caching last, on the new entity's list endpoint where it actually earns its keep. Distributed locks are worth building but say plainly in the README that a Redis lock is not a correctness guarantee without fencing tokens — that single sentence signals more depth than the lock itself.

**PostgreSQL performance — keep, with a caveat you need to hear.** As shown above, `users` has no missing index to add. If you benchmark index-vs-no-index on a 3,000-row table you will measure noise and an interviewer will catch it. This item only becomes real once the new entity exists with 1M+ rows, and the honest wins there are: composite index for the list query's filter+sort, keyset pagination replacing `OFFSET`, and pool sizing. Transaction isolation is the strongest sub-item because you have a genuine anomaly to demonstrate — the signup race at `auth.service.js:42-46`.

**Async processing — keep, and this is the centrepiece.** Your flow is right but incomplete as written. `POST → persist → publish` has a dual-write problem: if the DB commit succeeds and the Kafka publish fails, the event is lost forever. The fix is the **transactional outbox** — write the row and the event to an `outbox` table in one transaction, then a separate poller publishes and marks sent. That single pattern is the most senior-signalling thing in this entire plan, and it's the answer to the interview question "what happens if the broker is down when the request arrives?" Pair it with idempotent consumers keyed on event ID and a real DLQ topic.

**Observability — keep, but scope it down.** OpenTelemetry tracing plus Prometheus metrics plus structured logs with a propagated correlation ID is the whole job. Skip Datadog (costs money, adds nothing to the story), and skip building custom Grafana dashboards from scratch beyond one — the value is in having a trace that spans HTTP → Postgres → Kafka → consumer, because that visually proves the system is distributed. That screenshot is worth more than the dashboard.

**Load testing — keep, and yes, it's the highest-value item.** One methodology point: run it *before* anything changes, on a tag, from committed scripts, with raw output committed. A p95 number you can regenerate on demand is a different class of claim from a number in a README.

## What I'd add

**Idempotency keys on POST.** An `Idempotency-Key` header, first-write-wins in Redis, replaying the stored response on retry. Short to build, and it's the thing that makes the async pipeline safe to retry. Stripe-style, immediately recognisable.

**Graceful shutdown and readiness gating.** Non-negotiable before any replica claim: SIGTERM → stop accepting new connections → drain in-flight → close pool and Kafka producer. Readiness must fail as soon as SIGTERM lands so the load balancer stops routing. This is the difference between "I ran three containers" and "I ran three containers and deploys don't drop requests."

**A demonstrated failure drill.** Kill Redis mid-load-test and show the rate limiter fails *closed or open* by explicit policy rather than 500ing. Kill a Kafka consumer and show offset lag recover. Two or three of these documented in the README are what separate a system that was built from a system that was operated.

**Migration and seed discipline.** A seeder generating 1M+ rows, because none of the Postgres claims are measurable without volume, and migrations that run as an init container rather than from `scripts/dev.sh` (currently `scripts/dev.sh:37` runs `npm run db:migrate` on the host *before* the container's Postgres is up — it races and will fail on a clean machine).

**Real tests.** Testcontainers-backed integration tests for auth, RBAC, the outbox, and the rate limiter, with coverage thresholds that actually fail CI. Coupled with fixing `continue-on-error: true` in the lint workflow.

## What I'd cut

**Cut Datadog.** Costs money, duplicates Prometheus, adds no signal.

**Cut caching from the early phases** and treat it as an optional final layer, for the reason above.

**Cut Terraform/cloud deploy** unless you have a specific target. It's real work that reinforces IaC, not distributed systems, and it burns budget.

**Cut Locust and Artillery.** Pick k6 and go deep — thresholds, custom metrics, staged ramps, scenario mixes. Three load-testing tools is framework-collecting, which is exactly what you said you don't want.

**Don't build a service mesh, gRPC layer, or split into microservices.** A single well-instrumented service with an async worker *is* a distributed system. Splitting it prematurely gives you distributed-systems problems without distributed-systems benefits, and you'd spend the remaining time debugging networking.

## Positioning note

The market signal is consistent with your instinct: cloud skills appear in roughly 75% of backend postings and SQL/database in about 70%, with observability and security now called out as distinct expectations rather than nice-to-haves. Kafka specifically shows up as a differentiator in streaming-platform roles. What none of those postings reward is breadth of framework names — they reward being able to say what you measured and what broke.

The reusable-template goal and the resume goal pull in slightly different directions in exactly one place: a template should be easy to stand up, and Kafka plus Redis plus Postgres plus Prometheus plus Grafana is not easy to stand up. Resolve it with profiles — `docker compose --profile core up` gives Postgres + Redis + API for someone who just wants the auth boilerplate; `--profile full` adds Kafka and the observability stack. That way the template stays adoptable and the resume claim stays intact.

## Phasing

Nine phases, ordered so that each one ends with something you can point at.

**Phase 0 — Baseline.** Fix nothing. Add a k6 script and a compose file that runs the current code against local Postgres, tag `v0-baseline`, run 100/500/1000 VUs, commit raw JSON to `benchmarks/v0/`. Also: untrack `coverage/` and `logs/`, add gitleaks to CI. Deliverable: a p50/p95/p99/throughput/error-rate table for the unimproved system.

**Phase 1 — Correctness and security.** Fix the six defects from Part 1 (the `role` escalation, both logger bugs, `cookies.get`, the expiry mismatch), add the global error handler, add graceful shutdown, drop `morgan`, make CI lint blocking, fix the Docker image name. Deliverable: a baseline that is correct rather than merely fast.

**Phase 2 — TypeScript migration.** Strict mode, keep ESM and the `#` aliases, typed config loader that fails fast on missing env vars, typed Drizzle schema. Do this before the feature work so events and config are typed from birth, not retrofitted.

**Phase 3 — Postgres foundation.** Remove the Neon HTTP branch from `src/config/database.js`, `pg.Pool` everywhere with tuned sizing, Postgres 16 in compose, the new write-heavy entity with FK to `users`, the 1M-row seeder, keyset pagination, composite indexes, `EXPLAIN (ANALYZE, BUFFERS)` output committed for each query before and after, a transaction wrapping the signup check-then-insert, `SELECT ... FOR UPDATE` or a version column on updates, and a written isolation-level section demonstrating the anomaly at each level. Deliverable: before/after plans and the second benchmark run.

**Phase 4 — Redis: limits and tokens.** Sliding-window rate limiter in a Lua script for atomicity, per-role and per-route limits, correct `429` plus `Retry-After` and `RateLimit-*` headers, mounted *after* `authenticate` so `req.user` exists. Refresh-token rotation with reuse detection, JTI denylist, idempotency keys, distributed lock with the fencing caveat documented. Deliverable: rate limiting proven correct across 3 replicas — which is the claim Arcjet could never support.

**Phase 5 — Kafka and the outbox.** KRaft single node, `outbox` table written in the same transaction as the domain write, poller publishing with keyed partitioning for per-entity ordering, consumer group doing the async work, idempotent handlers, retry with backoff, DLQ topic, consumer lag exposed as a metric. Deliverable: the full `POST → persist+outbox → publish → consume → notify` path, and a demo of the broker being down at write time without data loss.

**Phase 6 — Observability.** OpenTelemetry auto-instrumentation for HTTP/pg/Kafka plus manual spans, correlation ID propagated from ingress through to the consumer, Prometheus metrics (RED per route, pool saturation, queue depth, consumer lag), Grafana with one dashboard that matters, structured logs carrying trace and span IDs. Deliverable: a single trace screenshot spanning all four hops.

**Phase 7 — Kubernetes and scale-out.** Manifests, readiness/liveness/startup probes wired to real dependency checks, HPA on CPU and a custom metric, PDB, resource requests and limits, migrations as an init container, kind script for one-command local cluster. Deliverable: the final benchmark at 100/500/1000 VUs across 3 replicas, plus the failure drills.

**Phase 8 — Hardening and docs.** Testcontainers integration tests with enforced coverage thresholds, optional response caching with explicit invalidation, an ADR directory recording why each decision was made, README rewritten around the profiles, and a `BENCHMARKS.md` with the full v0-vs-final table and the exact commands to reproduce it.

## The claim this produces

Not "reduced p95 from X to Y" as a bare assertion, but: *here is the k6 script, here is the raw JSON from both runs, here is the commit that changed it, and here is the trace showing where the time went.* Phase 0 is what makes that sentence available to you, which is why it comes before everything else and why it has to happen before we touch a single line.

