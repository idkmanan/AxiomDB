# ADR 0001 — Measure the unmodified system before changing it

**Status:** Accepted
**Date:** 2026-09-01
**Phase:** 0

## Context

The project's goal is to support claims of the form "reduced p95 latency from X to
Y at N concurrent clients." The credibility of such a claim rests entirely on how X
was obtained.

Two options were considered:

1. **Baseline first** — tag the unmodified code, measure it, commit the raw output,
   then optimise.
2. **Retro-baseline** — build the improvements behind feature flags, then measure
   with them disabled to reconstruct a "before."

Option 2 is faster and avoids an early phase that produces no functional
improvement.

## Decision

Baseline first.

## Rationale

A retro-baseline is not falsifiable. Flags do not fully revert a change — the
schema, connection handling, and code paths differ from what actually existed
before — so the reconstructed "before" is an estimate presented as a measurement.
An interviewer who asks "was that number measured or derived?" gets an answer that
undermines the claim.

Baseline-first also surfaces problems while they are still cheap. It produced nine
recorded findings, including one genuine security defect (F-07, fail-open security
middleware) that would likely have been deleted along with Arcjet in Phase 1 and
never understood.

The cost is one phase with no user-visible improvement. That is acceptable because
the phase's output — a reproducible harness — is reused by every later phase.

## Consequences

- `benchmarks/scripts/run-baseline.sh` refuses to run on a dirty working tree.
  Results must be attributable to exactly one commit.
- The k6 scripts are frozen. Changing them between phases voids the comparison; if
  a change is unavoidable, earlier phases must be re-run.
- Container resource limits and image tags are pinned in `.env.bench`. Changes must
  be recorded in `PROJECT_LIFECYCLE.md`.
- Raw k6 JSON is committed. Summary tables are generated, never typed.
