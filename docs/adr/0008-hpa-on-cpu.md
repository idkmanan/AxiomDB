# ADR 0008 — The HPA scales on CPU, not on a custom metric

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 7 (Kubernetes & scale-out)
**Related: ADR 0006 (hand-written metrics).**

## Context

The plan called for "HPA on CPU and a custom metric". A custom metric — requests per
second per pod, or outbox backlog age — is the more interesting autoscaler, because CPU
is a proxy for load rather than load itself.

Scaling on one in Kubernetes needs a metrics pipeline: Prometheus scraping the pods, then
`prometheus-adapter` translating a PromQL query into the custom-metrics API the HPA reads.
That is two more deployments and a `ServiceMonitor`, in a phase whose deliverable is a
benchmark and a set of drills.

## Decision

HPA on CPU (70% of request) and memory (80%), `minReplicas: 3`, `maxReplicas: 9`, with
asymmetric behaviour: scale up immediately, scale down one pod at a time after five
minutes.

`/metrics` exposes what a custom-metric HPA would need, so the door is open. The HPA
target is the only line that changes.

## Consequences

**Why CPU is a defensible target *for this workload* specifically.** bcrypt at cost 10
measures 54.8 ms per compare (F-05), and every request path here is either bcrypt or a
short indexed query. CPU is therefore the binding constraint long before memory or
connections, and CPU utilisation tracks real load closely. That is not true in general —
for an I/O-bound service, CPU stays flat while latency degrades, and a CPU HPA never
fires. The reason this decision is acceptable is a measured property of this application,
not a general preference.

**What is given up.** Two things a custom metric would do better. Scaling on
requests-per-second reacts before CPU rises, which matters when new pods take seconds to
become ready (pool pre-warm, F-39). And scaling the *consumer* on outbox backlog age is
the correct signal for a worker whose CPU is near zero while its queue grows — a CPU HPA
on the consumer would be actively wrong, which is why the consumer has no HPA at all and
a fixed replica count equal to the partition count.

**Asymmetric behaviour, and why.** `stabilizationWindowSeconds: 0` on the way up: a
traffic spike should be answered immediately. Five minutes and one pod at a time on the
way down: removing capacity raises utilisation on what remains, which triggers a
scale-up — an autoscaler oscillating against itself is worse than one that is slow to
shrink.

**Operational trap, recorded.** An HPA without `metrics-server` reports `<unknown>` and
never scales, silently. `scripts/k8s/kind-up.sh` installs it and patches
`--kubelet-insecure-tls`, because kind's kubelet serves metrics with a self-signed
certificate that metrics-server will not trust by default. That is the single most common
reason a local HPA appears not to work.
