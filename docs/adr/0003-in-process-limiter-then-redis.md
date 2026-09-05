# ADR 0003 — An in-process limiter now, Redis in Phase 4

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 1 (correctness & security)
**Supersedes nothing. Implements [ADR 0002](0002-own-the-failure-policy.md).**

## Context

ADR 0002 decided to replace Arcjet and own the failure policy, and named Redis as
the store. Phase 4 is where Redis arrives. Phase 1 is where Arcjet leaves, because
Phase 0 measured it at roughly 75 ms of CPU per request — 87.39% of p95 at 5 VUs,
and 45–67% of throughput at every level — while enforcing nothing at all
(findings F-07, F-16).

That leaves three phases between the removal and the replacement, and the question
of what guards the API in between.

## Decision

Build the limiter now, in process, behind a store interface that Phase 4 replaces.

Three specific choices, each with a reason that is not "it was easier":

**A sliding window log, not a fixed window.** A fixed window permits a burst of 2×
the limit across a boundary. More importantly, the log maps one-to-one onto a Redis
sorted set — `ZREMRANGEBYSCORE` to expire, `ZADD` to record, `ZCARD` to count —
which is precisely the Lua script Phase 4 needs. Choosing the algorithm that
survives the store swap means Phase 4 changes one file.

**`hit()` is async today although nothing in it awaits.** An interface that is
synchronous now would have to be rewritten when the store becomes a network call,
and "I had to rewrite every caller" is the usual reason a supposedly swappable
component turns out not to be.

**The failure policy is exercised by a test that injects a throwing store.** The
in-process store cannot realistically fail, so the fail-open and fail-closed
branches would otherwise be untested code that merely looks correct — which is an
exact description of the Arcjet middleware. `tests/rate-limit.test.js` passes a
store whose `hit` rejects and asserts 503 on the credential endpoints and 200 on
authenticated reads.

## The limitation, stated rather than discovered later

**This limiter is not distributed.** Three replicas hold three independent Maps, so
the effective limit is 3× the configured one. That is a correctness defect and it is
deliberately shipped.

It is shipped because it is the Phase 4 exhibit. "I replaced a Map with Redis" is a
framework swap. "Here is my limiter holding at one replica, here it is allowing 3×
the configured limit across three replicas, and here is the same test passing once
the state moved to Redis with an atomic Lua script" is a measured correctness claim
— which is the thing Arcjet could never support, because its state lived somewhere
we could not inspect.

## Alternatives considered

**Delete Arcjet and add nothing until Phase 4.** Defensible: F-16 showed Arcjet was
enforcing nothing, so removing it took away no protection that existed. It also
gives the cleanest possible attribution for the v0→v1 delta — exactly one deletion.
Rejected because it leaves the credential endpoints unthrottled for three phases,
and those endpoints run bcrypt at ~55 ms per compare (F-05): about 18 requests per
second saturates a core, so an unthrottled sign-in endpoint is the cheapest denial
of service in the application. Being able to say "the API had no rate limiting for
three phases" is worse than owning a single-node one.

**Keep Arcjet until Phase 4 and only fix the 403 → 429 status.** Rejected: it keeps
75 ms of CPU per request and the fail-open-silently behaviour, and it makes Phase 1
a phase with no measurable win.

**An off-the-shelf `express-rate-limit`.** Rejected for a reason specific to this
project rather than a general one. The point of the phase is to own the failure
policy and be able to explain the algorithm; importing a package returns to the
position ADR 0002 was written to leave, just with the state in local memory instead
of someone else's cloud. It is the right choice in most real codebases and the wrong
one here.

## Consequences

- `RATE_LIMIT_*` become configuration, which the benchmark depends on: every k6 VU
  shares one source IP, so `.env.bench` raises the ceilings far above what the
  matrix can generate. The limiter still runs on every request, so its CPU cost is
  still measured — only the rejection is taken out of the way. `run-phase.sh`
  verifies this twice: it reads the ceilings out of the running container before
  starting, and asserts after every run that zero requests were rejected. Without
  that, a matrix full of fast 429s would report as a dramatic latency improvement.
  This is the same trap Phase 0 recorded as the F-16 corollary.
- Rate-limit state is per process, so it resets on deploy. Acceptable for a
  60-second window.
- `/health` and `/ready` are deliberately unlimited. v0 mounted its limiter
  app-wide, so a liveness probe paid the full check — measured at 404.69 ms p95 on
  an endpoint that does no I/O. A limiter in front of a health check also means a
  saturated service starts failing probes and gets restarted, converting load into
  an outage.
- The limiter is mounted after `authenticate`, which is what makes per-role limits
  work at all. v0 mounted it before, so `req.user` was always undefined and every
  caller — including admins — silently received the guest bucket.
