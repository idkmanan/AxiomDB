# Kubernetes manifests

Plain YAML, applied in filename order. No Helm and no Kustomize: this deployment has one
environment, and a template engine would add indirection to seven files that are read far
more often than they are parameterised.

```
bash scripts/k8s/kind-up.sh      # cluster, images, migrations, topics, rollout
bash scripts/k8s/drills.sh       # five failure drills, each asserting an outcome
bash scripts/k8s/kind-up.sh --down
```

| file | what it decides |
|---|---|
| `00-namespace-config.yaml` | namespace; the ConfigMap/Secret split (does a leak grant access?); `RATE_LIMIT_STORE=redis`, which is what makes the 3-replica claim true; `TRUST_PROXY=1` rather than `true` |
| `10-datastores.yaml` | Postgres and Redis for a throwaway cluster — `emptyDir`, one replica, `noeviction` so memory pressure is an error rather than a silent correctness change |
| `11-kafka.yaml` | single-node KRaft, replication factor 1 (stated, because `acks: all` then means one copy); advertised listener as the pod's DNS name; topics created by a Job, not by auto-creation |
| `20-api.yaml` | migrations as a Job with an init container that waits for the *result*; three probes answering three questions; `maxUnavailable: 0` + PDB; `preStop` sleep; read-only root filesystem; HPA on CPU |
| `30-workers.yaml` | publisher at 1 replica (ordering), consumer at 3 (the partition count); `Recreate` for the publisher, one-at-a-time rolling for the consumer |

## What this is not

Production-grade stateful infrastructure. Postgres, Redis and Kafka here exist so the
benchmark and the drills are reproducible in one command. In a real deployment they are
managed services or operator-managed StatefulSets, and the only thing that changes in the
application is three connection strings in the Secret — that the app cannot tell the
difference is the useful property, not the YAML.

Also absent, deliberately: no Ingress (a NodePort keeps k6 out of a `port-forward`
bottleneck), no NetworkPolicy, no ServiceMonitor, no custom-metric HPA (ADR 0008), no TLS
between components.

## The two things most likely to go wrong

**The HPA reports `<unknown>` and never scales.** `metrics-server` is missing, or it is
present and not ready because kind's kubelet serves metrics with a self-signed
certificate. `kind-up.sh` installs it and patches `--kubelet-insecure-tls`.

**The workers crash-loop against Kafka.** The broker accepts connections well before it
can serve metadata, which is why its readiness probe asks for a topic list rather than a
port. If the advertised listener is wrong, clients connect and are then handed an address
they cannot resolve — check `KAFKA_ADVERTISED_LISTENERS`.
