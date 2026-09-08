# ADR 0006 — A hand-written metrics registry

**Status:** accepted
**Date:** 2026-09-05
**Phase:** reduced Phase 6
**Related: ADR 0002 (own the failure policy).**

## Context

Phases 3-5 each make a claim that is invisible without in-process measurement: pool
saturation preceding the 503s (F-33), event-loop lag explaining connect timeouts
against a healthy database (F-37), limiter rejections proving a fail-open policy ran
(F-07), and outbox backlog age showing whether publishing is keeping up.

`prom-client` is the obvious way to expose those. Phase 6 as planned went much further —
OpenTelemetry, Grafana, prometheus-adapter — and was cut.

## Decision

Write the registry: counters, gauges, histograms, and the Prometheus text exposition
format, in about 150 lines with no dependencies. Expose `/metrics` on the API and on
both workers.

Two reasons, and the first is the honest one:

1. **The sandbox this was built in has no npm registry access.** A dependency added here
   could not be installed, imported or tested before being committed. A metrics layer
   nobody has executed is worse than 150 lines that can be unit-tested — and those unit
   tests are worth having anyway, because the format has traps: cumulative buckets, a
   mandatory `+Inf` equal to `_count`, escaped label values, and label sets that must be
   order-insensitive or one measurement becomes two series.
2. **The exposition format is stable and documented.** Owning it removes a dependency
   from the request path and puts the cardinality rules in the open, where they can be
   argued with. `route` is always a route PATTERN; anything unmatched collapses to one
   bucket. That rule is the difference between a metrics endpoint and an
   out-of-memory incident in the monitoring system, and in a library it is a paragraph
   somebody has to find.

## Consequences

**Given up.** No exemplars, no native histograms, no summary quantiles, no cluster
aggregation, and `prom-client`'s default process metrics had to be picked by hand. If
this project later wants any of that, `registry.render()` is the only surface the HTTP
layer touches, so the swap is contained.

**Gained.** `tests/metrics.test.js` asserts the format itself — including that a request
path never reaches a label value, which is the failure mode that takes down Prometheus
rather than the application. Event-loop lag comes from `perf_hooks`, which is built in,
so the metric that explains F-37 costs nothing.

**Not done, deliberately.** No HPA on a custom metric (see ADR 0008), no tracing, no
dashboards. Kafka-side consumer lag is read from the broker with
`kafka-consumer-groups.sh` rather than re-implemented here; what the consumer exposes is
what it knows about itself (handled, duplicates, retries, dead-lettered), and
`outbox_oldest_pending_age_seconds` is the signal that actually pages.
