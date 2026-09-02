# ADR 0002 — Own the failure policy for request-path dependencies

**Status:** Accepted
**Date:** 2026-09-01
**Phase:** 0 (finding), implemented in Phase 4

## Context

The as-built security layer delegates rate limiting, bot detection, and WAF-style
shielding to Arcjet, a hosted service called on every request from
`src/middleware/security.middleware.js`.

While preparing the Phase 0 baseline, the middleware was probed with no API key and
no network egress:

```
decision.conclusion = ERROR | isDenied = false | isErrored = true
error reason: Failed to establish tunnel to decide.arcjet.com:443
```

`@arcjet/node` returns a third outcome beyond allow and deny: when it cannot reach
its API, the decision's conclusion is `ERROR`. The middleware only inspects
`decision.isDenied()` and the `reason.*` predicates, so an `ERROR` decision falls
through to `next()`.

The request is served with no rate limiting, no bot detection, and no shield. There
is no log line and no metric on that path, so the degradation is invisible in
production. Recorded as finding F-07.

Two further defects were found in the same middleware: it is mounted at
`src/app.js:20` before any authentication runs, so `req.user` is always undefined
and the per-role limit is permanently the guest limit; and rate-limit rejections
return HTTP 403 instead of 429 with no `Retry-After` header (F-08).

## Decision

Replace Arcjet with a self-built limiter on Redis, and make the failure policy an
explicit, per-route, logged decision rather than an emergent property of a client
library.

## Rationale

The problem is not the dependency. Any component in the request path can be
unavailable, and a well-built system decides in advance what happens then. The
decision here is not "avoid third-party services" but "never let a library's
default determine your security posture."

Fail-open and fail-closed are both correct in different places. A login or
password-reset endpoint should fail closed — refusing service is better than
serving unlimited credential-stuffing attempts. A read-only health or catalogue
endpoint should probably fail open, because a Redis outage taking down reads is a
worse outcome than a temporarily unenforced limit.

Because that choice is per-route, it has to live in the application, which means
the limiter state has to be somewhere the application controls. Redis provides
that, and it makes the limiting genuinely distributed across replicas — which the
hosted version could demonstrate but not expose.

## Consequences

- Phase 4 implements a sliding-window limiter as a Redis Lua script (atomicity
  without a round-trip per operation).
- Every route declares its failure mode. The default is fail-closed for
  authentication endpoints and fail-open for reads.
- Every fail-open event increments a counter and emits a warning log. A silent
  degradation is treated as a defect in its own right.
- The limiter is mounted *after* authentication so `req.user` exists and per-role
  limits work — fixing the ordering bug at `src/app.js:20`.
- Rejections return 429 with `Retry-After` and `RateLimit-*` headers.
- Any future request-path dependency needs a timeout, a circuit breaker, and a
  documented failure mode before it ships.
