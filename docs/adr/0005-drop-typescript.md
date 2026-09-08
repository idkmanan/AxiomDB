# ADR 0005 — TypeScript is dropped, not deferred

**Status:** accepted
**Date:** 2026-09-05
**Phase:** decided before phases 3-7
**Supersedes the Phase 2 entry in UPGRADE_PLAN.md.**

## Context

The plan had Phase 2 as a TypeScript migration: strict mode, ESM and `#alias/*`
preserved, a typed config loader, typed Drizzle schema. It was scheduled before the
feature work so that events and config were "typed from birth, not retrofitted".

Then phases 3, 4, 5 and 7 were brought forward and Phase 2 was skipped. That leaves a
choice that is easy to leave unmade: does the migration still happen, later?

## Decision

No. Phase 2 is struck from the plan.

The reasoning is arithmetic rather than aesthetic:

- Migrating grows more expensive with the codebase, and phases 3-7 roughly tripled
  `src/`. Deferring made the migration worse, not cheaper — so "later" was already the
  wrong answer at the moment it was chosen.
- It produces no measurable claim. Every other phase in this project ends in a number
  or a scripted demonstration; a migration ends in the same behaviour with different
  syntax, and this project's whole value is defensible measurement.
- The defects it would have prevented are not the defects this codebase actually had.
  Of F-21 to F-50, the ones a type system would have caught are close to none: the
  winston `combine((a,b,c))` bug is type-correct (F-22), the comma-expression in
  `cookies.get` returns a valid type, drizzle's error wrapping (F-36) is a runtime
  shape, `DESC NULLS LAST` (F-47) is SQL semantics, and F-41 is a misunderstanding of
  isolation levels. Types are valuable; they were not what was wrong here.

## Consequences

**Given up.** No compile-time guarantee on the event envelope, the config object or the
service signatures — the three places where a wrong shape would be most annoying. No
editor-level refactoring safety, and a fork that wants TypeScript inherits the
migration.

**Mitigated, narrowly.** JSDoc typedefs are used where they prevent a real bug and
nowhere else: `LimitDecision` (the store contract two implementations must satisfy),
the event envelope, and the transaction options. Editors read them, so the payoff at
call sites is most of the benefit at none of the toolchain cost.

**Gained.** `jest.config.mjs` needs no transform and there is no build step, which is
why the offline test suite runs the actual source rather than a compiled copy of it —
directly useful given that the sandbox this was built in has no npm registry.

**Reversible, at a price.** If a fork wants TypeScript, the boundaries are already
clean: config, models, services, and one interface per swappable component. The
migration would be mechanical and large. That is a decision to take deliberately, in
its own branch, with its own justification — not something to leave "not started" in a
timeline table for a year.
