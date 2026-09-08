# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for the Acquisitions project. Each ADR documents a significant architectural choice, the context behind it, and the consequences.

## ADR Index

| # | Title | Status | Date | Summary |
|---|-------|--------|------|---------|
| [0001](./0001-baseline-before-optimising.md) | Baseline Before Optimising | ✅ Accepted | 2026-09 | Establish baseline metrics before any optimization work |
| [0002](./0002-own-the-failure-policy.md) | Own the Failure Policy | ✅ Accepted | 2026-09 | Build custom rate limiting instead of relying on external services |
| [0003](./0003-in-process-limiter-then-redis.md) | In-Process Limiter Then Redis | ✅ Accepted | 2026-09 | Use in-process rate limiting with Redis as distributed backend |
| [0004](./0004-one-database-driver.md) | One Database Driver | ✅ Accepted | 2026-09 | Consolidate to single database driver (Drizzle ORM) |
| [0005](./0005-drop-typescript.md) | Drop TypeScript | ✅ Accepted | 2026-09 | Migrate from TypeScript to plain JavaScript for simplicity |
| [0006](./0006-hand-written-metrics.md) | Hand-Written Metrics | ✅ Accepted | 2026-09 | Implement custom metrics collection instead of using frameworks |
| [0007](./0007-outbox-not-dual-write.md) | Outbox Not Dual Write | ✅ Accepted | 2026-09 | Use outbox pattern for reliable event publishing |
| [0008](./0008-hpa-on-cpu.md) | HPA on CPU | ✅ Accepted | 2026-09 | Configure Kubernetes HPA based on CPU metrics |

## Writing ADRs

When adding a new ADR:
1. Use the next sequential number (e.g., `0009-title.md`)
2. Include: Context, Decision, Consequences
3. Update this index with a summary
4. Mark status: Proposed, Accepted, Deprecated, or Superseded
