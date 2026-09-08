# ADR 0004 — One database driver, chosen by nothing

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 3 (Postgres foundation)
**Supersedes the driver branch introduced before v0. Recorded as finding F-38.**

## Context

`src/config/database.js` selected a driver by environment:

```js
if (nodeEnv === 'development') { pg.Pool + drizzle/node-postgres }
else                          { neon(DATABASE_URL) + drizzle/neon-http }
```

The Neon HTTP driver is request-per-query over HTTPS. It holds no session, which
means no `BEGIN`/`COMMIT`, no `SET TRANSACTION ISOLATION LEVEL`, no
`SELECT … FOR UPDATE`, no advisory locks, and nothing for `closeDatabase()` to drain
on SIGTERM.

Two consequences, and the second is worse than the first. Every Phase 3 deliverable —
transactions, isolation levels, row locking — was impossible in production while that
branch existed. And development and production ran different code at the driver
boundary, so no amount of local testing could exercise what production would do. That
is the same root cause as F-06 (the driver switch was silent) and F-32 (a local
environment that differs from CI is a test that has not run), met for a third time in
a third disguise.

## Decision

Delete the branch. `pg.Pool` + `drizzle-orm/node-postgres` in every environment.
`@neondatabase/serverless` is removed from `package.json`.

Neon stays a viable deploy target: it speaks the Postgres wire protocol, so `pg.Pool`
connects to it directly. What is gone is the idea that the driver is an environment
detail.

## Consequences

**Gained.** Transactions and isolation levels work everywhere, so `withTransaction`,
the outbox, `FOR UPDATE` and the isolation demonstrations are all possible. Graceful
shutdown now actually drains connections, which makes the Phase 7 rolling-deploy claim
supportable. Pool pre-warming becomes meaningful (F-39), and `db.execute()` has one
result shape rather than two (an array under neon-http, `QueryResult` under
node-postgres — code written for one silently returned `undefined` under the other).

**Given up.** Neon's HTTP driver is genuinely better for one deployment shape:
short-lived serverless functions, where a connection pool cannot be reused between
invocations and a pooler is an extra hop. This project is a long-running container, so
the trade does not apply — but a fork targeting Lambda or Cloudflare Workers should
reintroduce the branch deliberately, with the capability loss in front of it.

**Cost.** The v0 and v1 benchmarks ran under the pg driver in the bench stack (
`NODE_ENV=development`), so the v1 → v7 comparison is not contaminated by this change.
Anything measured against a *deployed* v0 would have been measuring a different
driver, which is one more reason the benchmark harness pinned `NODE_ENV` from the
start.
