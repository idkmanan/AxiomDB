# AxiomDB

A secure, benchmarked Express + Drizzle + Postgres backend template. It is a
working JSON API — cookie session auth, RBAC, rate limiting, pagination,
graceful shutdown — and it is being rebuilt in phases, where each phase fixes
one class of problem and then has to produce a measured claim before it counts
as finished. The running record of what changed, why, and what it cost is
[docs/project-management/lifecycle.md](docs/project-management/lifecycle.md); the method behind every number is
[docs/getting-started/benchmarking-guide.md](docs/getting-started/benchmarking-guide.md).

Phase 0 measured the unmodified application. Phase 1 fixed what those
measurements pointed at, in the order the measurements ranked them rather than
the order the defects were noticed. Phases 3, 4, 5 and 7 then built the
distributed half: a write-heavy entity with keyset pagination over a million
rows, transactions and row locking, a rate limiter shared across replicas,
refresh-token rotation with reuse detection, a transactional outbox onto Kafka
with an idempotent consumer, and Kubernetes manifests that run three replicas.

**No performance number here is measured yet.** The environment those phases were
built in has no Docker, no Redis, no Kafka and no npm registry, so every claim
that needs a real service is a committed script rather than a result — see
"Not verified here" in [docs/project-management/lifecycle.md](docs/project-management/lifecycle.md). The only
figures below are labelled v0.

## Status

| Phase | Status | Deliverable |
|---|---|---|
| 0 — Baseline measurement | Complete; F-01..F-20 recorded | Reproducible harness + v0 numbers |
| 1 — Correctness & security | Code complete, v1 matrix pending | Defect-free baseline + measured v0→v1 delta |
| 2 — TypeScript migration | **Struck** ([ADR 0005](docs/adr/0005-drop-typescript.md)) | — |
| 3 — Postgres foundation | Code complete; F-38..F-47 | Deals entity, 1M-row seeder, keyset pagination, indexes, isolation |
| 4 — Redis: limits & tokens | Code complete; F-48..F-50 | Distributed rate limiting, refresh rotation, idempotency |
| 5 — Kafka & outbox | Code complete | Async pipeline, no dual-write loss |
| 6 — Observability | **Reduced** ([ADR 0006](docs/adr/0006-hand-written-metrics.md)) | `/metrics`: RED, pool saturation, loop lag, outbox depth |
| 7 — Kubernetes & scale-out | Code complete; matrix pending | 3-replica benchmark + failure drills |
| 8 — Hardening & docs | Not started | Integration tests, ADRs, BENCHMARKS.md |

Decisions worth reading before the code: [ADR 0004](docs/adr/0004-one-database-driver.md)
(one database driver), [0005](docs/adr/0005-drop-typescript.md) (no TypeScript),
[0006](docs/adr/0006-hand-written-metrics.md) (hand-written metrics),
[0007](docs/adr/0007-outbox-not-dual-write.md) (outbox, not dual writes),
[0008](docs/adr/0008-hpa-on-cpu.md) (HPA on CPU). The reasoning behind each
mechanism, in interview form, is
[docs/interview/phases-3-to-7.md](docs/interview/phases-3-to-7.md).

## Documentation

📚 **[Complete Documentation Hub →](docs/README.md)**

All project documentation is organized in the `docs/` directory:
- [Getting Started Guide](docs/getting-started/) — Quick setup and benchmarking
- [Architecture Decision Records (ADRs)](docs/adr/) — All architectural decisions documented
- [Interview Documentation](docs/interview/) — Development phases and requirements
- [Benchmark Results](docs/benchmarks/) — Performance analysis across versions
- [Kubernetes Deployment](docs/kubernetes/) — Container orchestration guide

## What the phases added, and how to check it

Every claim below has a command that produces the evidence. All of them need
Docker (and `npm install` first, for the two new dependencies).

```bash
npm run db:migrate            # 0001_deals, 0002_outbox, 0003_notifications
npm run db:seed:deals         # 1,000,000 deals, generated inside Postgres
npm run db:explain            # keyset vs OFFSET plans, with and without each index
npm run db:isolation          # lost updates, write skew, and F-41 with two sessions
npm run redis:proof:limiter   # 3 replicas: in-process over-admits, Redis is exact
npm run redis:proof:refresh   # rotation, reuse detection, concurrency, real Lua
npm run events:topics         # explicit topics: 3 partitions, real DLQ
npm run events:drill -- write # with Kafka stopped: writes succeed, backlog grows
npm run events:drill -- drain # with Kafka started: drains, consumes, deduplicates
npm run k8s:up                # kind cluster: 3 API replicas, workers, HPA
npm run k8s:drills            # kill a pod, roll out, drop Redis, drop Kafka
npm run bench:v7              # the final matrix against the cluster
```

The two background workers run as their own processes (`npm run worker:publisher`,
`npm run worker:consumer`), because the API scales with request traffic and they do
not — the publisher is deliberately single-writer for ordering, and the consumer
scales only as far as the topic has partitions.

## Quick start


Docker with Compose V2 (the `docker compose` plugin, not `docker-compose`) and
Node 22+.

```bash
cp .env.example .env.development
npm run dev:docker
```

`dev:docker` runs `bash scripts/dev.sh`, which does four things in an order that
is the fix rather than a formality:

1. starts only the `postgres` service from `docker-compose.dev.yml`
2. polls that container's healthcheck until it reports healthy — not `sleep 5`,
   which is simultaneously too long on a fast machine and too short on a cold
   one, and when it is too short the failure presents as a migration bug
3. applies migrations in a one-shot container **inside** the compose network
4. starts the API attached, so Ctrl-C sends SIGINT down the same drain path as
   SIGTERM and the shutdown code is exercised every time you stop the server

Step 3 is finding F-23. v0 ran `npm run db:migrate` from the host at a point in
the script where the database container did not exist yet, and the URL it would
have used names `postgres` — a compose service hostname that does not resolve on
the host at any point in the sequence. Running migrations inside the network is
also the shape Phase 7 uses (an init container), so it is one mechanism rather
than two.

The API is at http://localhost:3000. Postgres is published on `PG_HOST_PORT`
(5432 by default) using `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`
from `.env.development`, which default to `neon` / `npg` / `neondb`. Containers
are `acquisitions-app-dev` and `acquisitions-postgres-dev`; tear the stack down
with `docker compose -f docker-compose.dev.yml down -v`.

## API

Session auth is an httpOnly cookie named `token`, set by sign-up and sign-in.

| Method | Path | Auth | Rate limit |
|---|---|---|---|
| GET | `/` | none | none |
| GET | `/health` | none | none, deliberately |
| GET | `/ready` | none | none, deliberately |
| GET | `/api` | none | none |
| GET | `/metrics` | none, or `METRICS_TOKEN` | none, deliberately |
| POST | `/api/auth/sign-up` | none | `auth` — 10/min per IP, fails closed |
| POST | `/api/auth/sign-in` | none | `auth` — 10/min per IP, fails closed |
| POST | `/api/auth/refresh` | refresh cookie | `auth` — same bucket, fails closed |
| POST | `/api/auth/sign-out` | none | none |
| GET | `/api/users` | session + role `admin` | `api` — per user id, 100/min (`user`) or 300/min (`admin`), fails open |
| GET | `/api/users/:id` | session | `api`, as above |
| PUT | `/api/users/:id` | session; self, or `admin` for anyone | `api`, as above |
| DELETE | `/api/users/:id` | session; self, or `admin` for anyone | `api`, as above |
| GET | `/api/deals` | session; own deals, `admin` sees all | `api`, as above |
| GET | `/api/deals/summary` | session | `api`, as above |
| POST | `/api/deals` | session | `api`; honours `Idempotency-Key` |
| GET | `/api/deals/:id` | session; owner or `admin` | `api`; returns an `ETag` |
| PUT | `/api/deals/:id` | session; owner or `admin` | `api`; requires `version` or `If-Match` |
| POST | `/api/deals/:id/stage` | session; owner or `admin` | `api`; `SELECT … FOR UPDATE` |
| DELETE | `/api/deals/:id` | session; owner or `admin` | `api`, as above |
| GET | `/api/notifications` | session; own only | `api`, as above |
| POST | `/api/notifications/:id/read` | session; own only | `api`, as above |

Four things in that table are load-bearing rather than cosmetic. `GET /api/deals`
paginates by **cursor** (`?cursor=`), with `?offset=` kept reachable and capped at
100,000 purely so the two strategies can be compared through the same stack.
`PUT /api/deals/:id` refuses to write without an asserted version — 428 if it is
missing, 409 with `currentVersion` if it is stale — because a default would turn a
forgetful client into a last-writer-wins client. A deal belonging to someone else
answers **404, never 403**, since a 403 confirms the row exists and turns an id into an
oracle for another account's pipeline. And `POST /api/deals` with an `Idempotency-Key`
replays the original response rather than creating a second deal, which is the only way
a client can safely retry after a lost response.


`/health` is liveness and answers from in-process state only. `/ready` is
readiness and does a real `SELECT 1` round trip. Neither is rate limited, and
that is a decision rather than an oversight: a limiter in front of a health
check means a saturated service also fails its probes and gets restarted, which
turns a load problem into an outage. v0 mounted its limiter app-wide and
measured 404.69 ms p95 on `/health`, an endpoint that does no I/O, against
4.19 ms with the middleware bypassed (findings F-07, F-16).

On `/api/users*` the router mounts `authenticate` and then the limiter, in that
order, which is also a fix: v0 mounted its limiter at app level ahead of every
route, so `req.user` was undefined when the role was read and every caller —
admins included — silently received the guest bucket. The role switch in that
file never took a branch other than its default.

`POST /api/auth/sign-out` clears the cookie and does nothing else. The token
stays valid until it expires; there is no denylist yet.

### Listing users

`limit` defaults to `PAGINATION_DEFAULT_LIMIT` and is capped at
`PAGINATION_MAX_LIMIT`; `offset` defaults to `0`. The query schema is strict, so
an unrecognised parameter is a 400 naming it rather than a silently ignored one.

```
GET /api/users?limit=2&offset=10
Cookie: token=<admin session>
```

```json
{
  "message": "Successfully retrieved users",
  "users": [
    { "id": 11, "email": "a@b.test", "name": "A", "role": "user",
      "created_at": "2026-09-01T10:00:00.000Z",
      "updated_at": "2026-09-01T10:00:00.000Z" },
    { "id": 12, "email": "c@d.test", "name": "C", "role": "user",
      "created_at": "2026-09-01T10:00:01.000Z",
      "updated_at": "2026-09-01T10:00:01.000Z" }
  ],
  "pagination": {
    "limit": 2,
    "offset": 10,
    "total": 137,
    "returned": 2,
    "hasMore": true
  },
  "count": 2
}
```

`count` is the number of rows in this response. It meant the same thing in v0,
where it happened to equal the table size because the query had no `LIMIT`;
`pagination.total` is the field that now carries that meaning. `?limit=1000000`
is rejected with `limit may not exceed 100` — without the cap, pagination that
looks present hands the caller control of the endpoint's cost.

### Being rate limited

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 60

{
  "error": "Too Many Requests",
  "message": "Rate limit of 10 requests per 60s exceeded.",
  "retryAfter": 60
}
```

429, not v0's 403: 403 says "you may never do this", 429 says "not yet" and is
the only one of the two that carries a documented retry contract (F-08). The
`RateLimit-*` field names follow draft-ietf-httpapi-ratelimit-headers.

## Security posture

Both halves of this are in one table on purpose. What is missing is as much a
part of the current state as what is present, and each gap is the exhibit for
the phase that closes it.

| Control | State | Detail |
|---|---|---|
| Input validation | Enforced | Zod `strictObject` on every request schema, so an unknown key is a logged 400 naming it, not a silent strip |
| Privilege at signup | Enforced | `role` is absent from `signupSchema` and `createUser` accepts no role argument — two independent gates. The v0 schema had `role: z.enum(['user','admin']).default('user')` and the controller destructured it, so `{"role":"admin"}` returned an admin JWT to an anonymous caller |
| RBAC | Enforced | `authorize('admin')` on `GET /api/users`; ownership checks on update and delete; role changes rejected for non-admins on `PUT` |
| Rate limiting | Enforced | Sliding-window log, per-route policy, mounted after `authenticate`; auth endpoints fail **closed**, reads fail **open**, and either outcome is logged and counted ([ADR 0003](docs/adr/0003-in-process-limiter-then-redis.md)) |
| Session cookie | Enforced | `httpOnly`, `sameSite=strict`, `secure` in production, and `maxAge` derived from the same `SESSION_TTL_MS` the JWT is signed with. v0 had 15 minutes on the cookie and `'1d'` on the token |
| Error responses | Enforced | No stack trace on the wire in any status class; a 5xx body is `{error, requestId}` and nothing else, while the full stack and cause go to the log |
| Startup secrets | Enforced | `JWT_SECRET` is required and must be ≥32 chars in production or the process throws. v0 fell back to a literal string committed in this repository, so a deploy that forgot the variable signed forgeable admin tokens and looked healthy (F-25) |
| Transport headers | Enforced | helmet, `x-powered-by` disabled, 100 kb body limit, request id on every response |
| Refresh tokens | Gap — Phase 4 | There are none, so a session genuinely ends 15 minutes after sign-in |
| Token revocation | Gap — Phase 4 | Sign-out clears the cookie; the bearer token remains valid until expiry. A 15-minute window is a mitigation, not a fix |
| Distributed limits | Gap — Phase 4 | The limiter's state is a per-process `Map`, so N replicas allow N× the configured limit |
| Sign-in timing oracle | Gap — Phase 4 | With no user found, no bcrypt compare runs, so an unknown address answers measurably sooner than a wrong password |
| Signup race | Gap — Phase 3 | Check-then-insert with no transaction. SQLSTATE 23505 is translated so the loser gets the intended 409 instead of a 500, but the race is still there |
| Lost update | Gap — Phase 3 | `updateUser` and `deleteUser` read, decide, then write with no transaction and no version column |
| Proxy trust | Gap — Phase 7 | `TRUST_PROXY` is unset, so `req.ip` is the socket address and `X-Forwarded-For` is ignored |

The distributed-limit gap is shipped knowingly. "I replaced a `Map` with Redis"
is a framework swap; "here is the limiter holding at one replica, allowing 3×
the limit across three, and holding again once the state moved to Redis behind
an atomic Lua script" is a measured correctness claim, and it needs the broken
version to exist first.

## Environment variables

`.env.example` is the template and the source of truth; copy it, do not edit it
in place. `.gitignore` excludes `.env.*` and re-includes `.env.example` and
`.env.bench.example` by negation, so a real secret cannot be committed by
accident while the template a forker needs stays available (F-03). Integer
variables throw at startup on a non-integer or out-of-range value rather than
falling back to the default — a typo'd limit should not look like a deliberate
one.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `NODE_ENV` | `development` | `development` selects the node-postgres pool in `src/config/database.js`. Any other value routes through the Neon HTTP driver, which has no pooling, no transactions and no isolation levels; Phase 3 removes the branch |
| `LOG_LEVEL` | `info` | winston level. File transports are omitted entirely when `NODE_ENV=test` (F-27) |
| `DATABASE_URL` | empty | Postgres URL. Can stay empty for `npm run dev:docker`: `docker-compose.dev.yml` sets it in the app service's `environment:` block, which overrides `env_file`. Required for production and for a host-side `npm run db:migrate` |
| `JWT_SECRET` | none | Required, ≥32 chars in production or startup throws. `openssl rand -base64 32` |
| `COOKIE_SECRET` | — | **Removed in Phase 1.** Required by three templates and by `scripts/prod.sh` while nothing in `src/` read it; no cookie is signed and none needs to be (F-30) |
| `SESSION_TTL_MS` | `900000` | One value with two consumers: the JWT `expiresIn` and the cookie `maxAge` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window shared by every policy, so `RateLimit-Reset` means one thing everywhere |
| `RATE_LIMIT_AUTH_MAX` | `10` | Per IP on sign-up and sign-in. Tight because bcrypt at cost 10 measured 54.8 ms per compare (F-05), so ~18 unthrottled requests/s saturates a core |
| `RATE_LIMIT_USER_MAX` | `100` | Per user id for role `user`, and the fallback for any role not in the map |
| `RATE_LIMIT_ADMIN_MAX` | `300` | Per user id for role `admin` |
| `PG_POOL_MAX` | `20` | node-postgres defaults to 10, against a benchmark server started with `max_connections=200` (F-15) |
| `PG_POOL_CONNECTION_TIMEOUT_MS` | `5000` | The driver default of `0` means "queue forever", not "no timeout" |
| `PG_POOL_IDLE_TIMEOUT_MS` | `30000` | Idle client eviction |
| `PAGINATION_DEFAULT_LIMIT` | `20` | `limit` when the caller omits it |
| `PAGINATION_MAX_LIMIT` | `100` | Hard cap on `limit` |
| `SHUTDOWN_READINESS_DELAY_MS` | `2000`, `0` under `NODE_ENV=test` | Pause between failing `/ready` and closing the listener, so the load balancer stops routing first |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `10000` | In-flight drain window. Keep the sum of these two below the orchestrator's grace period |
| `TRUST_PROXY` | **unset, deliberately** | With `trust proxy` on and no trusted proxy actually in front, any client can spoof `X-Forwarded-For` and mint itself unlimited rate-limit buckets — the limiter becomes decorative while still looking present. Set it in Phase 7, once a known ingress terminates traffic |
| `EXPOSE_ERROR_DETAILS` | `false` | Adds name/code/stack to error bodies. Ignored when `NODE_ENV=production`; it cannot be switched on there |
| `CORS_ORIGIN` | `http://localhost:3000` | Comma-separated allow-list. Now actually read: v0 documented it in three templates while `src/app.js` called `cors()` with no options, so the effective policy was `Access-Control-Allow-Origin: *` (F-29). `credentials` is enabled only for an explicit list — a wildcard plus credentials is rejected by browsers |

`src/config/env.js` also reads `PG_POOL_MAX_LIFETIME_S` (default `1800`), which
`.env.example` does not list. `docker-compose.dev.yml` additionally reads
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `PG_HOST_PORT` and
`APP_HOST_PORT` from the same file, each with a default.

## Layout

```
src/
  app.js            Express app: middleware order, /health, /ready, routers
  server.js         listen + the SIGTERM/SIGINT drain sequence
  index.js          entrypoint; loads dotenv, then server.js
  config/           env.js (validated config), database.js (pool), logger.js
  controllers/      HTTP shape: parse, authorize, delegate, respond
  services/         data access; throws AppError with an intended status
  models/           Drizzle table definitions
  middleware/       auth, rate-limit, error, request-id, request-log
  rate-limit/       policy.js (limits, keying, failure policy) + sliding-window.js
  routes/           routers, and the mount order that makes the limiter work
  utils/            jwt.js, cookies.js, format.js
  validations/      Zod schemas, all strict
```

Imports use the Node subpath map in `package.json` rather than relative paths:

```
#src/*  #config/*  #controllers/*  #middleware/*  #models/*
#rate-limit/*  #routes/*  #services/*  #utils/*  #validations/*
```

So `import config from '#config/env.js'` resolves to `./src/config/env.js`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run on the host with `node --watch` |
| `npm start` | Run on the host, no watcher |
| `npm run dev:docker` | `bash ./scripts/dev.sh` — the dev stack, in order |
| `npm run prod:docker` | `bash ./scripts/prod.sh` — the production stack |
| `npm test` | jest under `NODE_ENV=test`, no database needed |
| `npm run lint` / `lint:fix` | eslint; blocking in CI |
| `npm run format` / `format:check` | prettier; also blocking in CI |
| `npm run db:generate` | Generate a migration from the models |
| `npm run db:migrate` | Apply migrations. `drizzle.config.js` loads plain `dotenv/config`, so from the host this reads `.env`, not `.env.development` (F-23) |
| `npm run db:studio` | Drizzle Studio |
| `npm run bench:up` / `bench:down` | Resource-pinned bench stack from `docker-compose.bench.yml` |
| `npm run bench:seed` | 1000 users + 1 admin, idempotent |
| `npm run bench:smoke` | 10 VUs for 20s against `realistic.js` — checks the harness |
| `npm run bench:baseline` | The full matrix with `PHASE=v0` |
| `npm run bench:v1` | The full matrix with `PHASE=v1` (~50 min) |
| `npm run bench:report` / `bench:report:v1` | Generate `SUMMARY.md`; the v1 form adds the v0→v1 comparison |
| `npm run bench:attribute` / `bench:attribute:v1` | Distil per-request streams into a committed failure-attribution artifact |

## Testing

```bash
npm test
```

96 tests across 8 suites, all passing, and no database or Docker required —
`NODE_ENV=test` keeps the app off the pg pool and drops winston's file
transports, which were holding descriptors open and producing jest's "did not
exit one second after the test run" warning (F-27).

| Suite | Covers |
|---|---|
| `tests/app.test.js` | `/health`, `/ready`, `/api`, and an unknown route answering 404 with a request id |
| `tests/auth-hardening.test.js` | The escalation attempt returning 400 with no `Set-Cookie`, `createUser` ignoring a role handed to it, cookie `maxAge` equalling the JWT expiry, and the production secret rule throwing |
| `tests/error-handling.test.js` | `classify()`'s full mapping, and that no error body carries a stack frame or a connection string |
| `tests/logging.test.js` | The **formatted output line**, plus a deliberate reproduction of the v0 `combine((a, b, c))` defect. A mock-based assertion on `logger.info` passes identically with the bug present and absent, and no lint rule catches it either (F-22) |
| `tests/rate-limit.test.js` | Window behaviour, the 429 status/header contract, keying by user id versus IP, and the fail-open/fail-closed branches driven by an injected throwing store |
| `tests/users-pagination.test.js` | Query defaults and the cap, id validation, and that the service applies `limit`/`offset`/`ORDER BY` and never selects the password column |

## Benchmarks

Full method, prerequisites and honesty rules:
[BENCHMARKING.md](BENCHMARKING.md).

```bash
cp .env.bench.example .env.bench
npm run bench:v1
npm run bench:report:v1
```

The one thing to get right before reading any result: **there are two
instruments and they are not interchangeable.**

- `benchmarks/k6/baseline.js` is **frozen**. Its mix (25% authentication), load
  shape, thresholds and tags must not change, because a comparison is only a
  comparison while the instrument is constant. Its rows are the only ones
  comparable across phases.
- `benchmarks/k6/realistic.js` exists because a 25%-auth mix describes no real
  workload — bcrypt made up 37% of the per-iteration CPU budget in the v0 matrix
  and depressed every throughput number in it. It answers "what is capacity",
  and its series starts at v1 (F-17).

`report.mjs` refuses to pair rows from different instruments, and refuses to
compute a delta for any concurrency level that was censored on either side. The
only numbers this repository currently has are the v0 baseline in
`benchmarks/v0-baseline/SUMMARY.md`; `benchmarks/v1-correctness/results/` is
empty by design until the v1 matrix runs on a Docker host.

## Deployment

The image is a multi-stage build on `node:22-alpine`.

| Stage | From | Purpose |
|---|---|---|
| `base` | `node:22-alpine` | `tini`, `dumb-init`, `/app`, and the non-root `nodejs` user (uid/gid 1001) |
| `deps` | `base` | `npm ci --only=production --ignore-scripts` |
| `dev-deps` | `base` | Full `npm ci --ignore-scripts` |
| `builder` | `dev-deps` | Placeholder for a build step; used from Phase 2 |
| `development` | `dev-deps` | `node --watch src/index.js` |
| `production` | `base` | Prod deps only, `npm start`, `HEALTHCHECK` against `/health` |

Both runtime stages run as `nodejs`, not root, and use `tini` as PID 1 so
SIGTERM reaches node and `src/server.js` actually runs its drain sequence
instead of the process dying mid-request.

```bash
npm run prod:docker
```

That runs `bash ./scripts/prod.sh`, which refuses to start without
`.env.production`, greps `JWT_SECRET` for at least 32 characters before building
— the app would otherwise crash-loop rather than say why — applies migrations
**first**, then brings up `docker-compose.prod.yml` and polls the
`acquisitions-app-prod` healthcheck until it is actually serving. Migrations run
from the host here, and that is correct for this stack: the target is a managed
database reachable from anywhere, not a compose service hostname.

Required in `.env.production`:

| Secret | Notes |
|---|---|
| `DATABASE_URL` | Managed Postgres connection string, `sslmode=require` |
| `JWT_SECRET` | ≥32 chars; `openssl rand -base64 32`. Startup throws without it |

`COOKIE_SECRET` was removed in Phase 1: three env templates required it and
`scripts/prod.sh` checked for it while nothing in `src/` read it. No cookie is
signed, and none needs to be — the session cookie holds a JWT that carries its
own signature. A required variable that does nothing trains people to skim the
setup checklist, which is how the entries that matter get missed.

One production setting is easy to get wrong: `stop_grace_period` must exceed
`SHUTDOWN_READINESS_DELAY_MS + SHUTDOWN_DRAIN_TIMEOUT_MS`, which is 12s by
default. Both compose files set 20s. Below that, the orchestrator sends SIGKILL
mid-drain, the graceful shutdown never completes, and Postgres can be left
holding connections — a shutdown path that is present in the code and never
executed is indistinguishable from one that does not exist.

Only port 3000 is published; TLS belongs to a reverse proxy in front (there is a
commented nginx service in `docker-compose.prod.yml`). Note that setting
`TRUST_PROXY` is what makes the rate limiter see real client addresses behind
such a proxy, and that it is unsafe to set until one is genuinely there.

Kubernetes is Phase 7 — 3 replicas, a real readiness probe wired to
`SHUTDOWN_READINESS_DELAY_MS`, migrations as an init container, and the failure
drills that make a scale-out claim mean something. There are no manifests in
this repository yet, and none are implied.

## License

ISC, per `package.json`. There is no `LICENSE` file in the repository yet.
