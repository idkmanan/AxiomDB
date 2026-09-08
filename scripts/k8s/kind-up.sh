#!/usr/bin/env bash
# =============================================================================
# One command, one local cluster, three replicas.
#
#   bash scripts/k8s/kind-up.sh
#   bash scripts/k8s/kind-up.sh --down
#
# WHAT THIS EXISTS TO MAKE TRUE. The Phase 7 claim is "the final benchmark at 3 replicas,
# plus the failure drills". A claim like that is only checkable if somebody else can stand
# the cluster up, so every step that would otherwise be a paragraph of README is a line of
# script here: cluster creation with a mapped port, image build and load, ordered apply,
# migrations before rollout, topics before workers, and a wait on each.
#
# kind rather than minikube: it runs Kubernetes in Docker containers, needs no VM, and
# `kind load docker-image` puts a locally built image into the cluster without a registry —
# which is the step that otherwise turns "try this locally" into "set up a registry first".
# =============================================================================
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-acquisitions}"
IMAGE="acquisitions:local"
MIGRATOR_IMAGE="acquisitions-migrator:local"
NAMESPACE="acquisitions"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\033[1;34m[kind-up]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[kind-up] FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

for tool in kind kubectl docker; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

if [[ "${1:-}" == "--down" ]]; then
  log "deleting cluster $CLUSTER"
  kind delete cluster --name "$CLUSTER"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Cluster
# ---------------------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "cluster $CLUSTER already exists"
else
  log "creating cluster $CLUSTER"
  # The port mapping is what lets k6 drive the cluster from the host. NodePort 30080 →
  # localhost:30080; without it the only way in is `kubectl port-forward`, which is a single
  # proxy process that becomes the bottleneck being measured.
  cat <<'EOF' | kind create cluster --name "$CLUSTER" --config -
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 30080
        hostPort: 30080
        protocol: TCP
EOF
fi

# ---------------------------------------------------------------------------
# 2. metrics-server, because an HPA without it reports <unknown> forever
# ---------------------------------------------------------------------------
log "installing metrics-server"
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# kind's kubelet serves its metrics endpoint with a self-signed certificate that
# metrics-server will not trust by default. Without this patch the deployment never becomes
# ready and the HPA has no metrics — the single most common reason a local HPA "does not work".
kubectl -n kube-system patch deployment metrics-server \
  --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
  >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 3. Images
# ---------------------------------------------------------------------------
log "building $IMAGE (production target)"
docker build -t "$IMAGE" --target production "$ROOT"
log "building $MIGRATOR_IMAGE (migrator target)"
docker build -t "$MIGRATOR_IMAGE" --target migrator "$ROOT"
log "loading images into the cluster"
kind load docker-image "$IMAGE" --name "$CLUSTER"
kind load docker-image "$MIGRATOR_IMAGE" --name "$CLUSTER"

# ---------------------------------------------------------------------------
# 4. Namespace, config, and REAL secrets
# ---------------------------------------------------------------------------
log "applying namespace and config"
kubectl apply -f "$ROOT/k8s/00-namespace-config.yaml"

# The committed Secret holds placeholders on purpose (this repository has already had one real
# credential committed and rotated). Generate a working one here instead.
log "generating secrets"
PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 16)}"
kubectl -n "$NAMESPACE" create secret generic acquisitions-secrets \
  --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --from-literal=DATABASE_URL="postgresql://acq:${PG_PASSWORD}@postgres:5432/acquisitions" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 32)" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---------------------------------------------------------------------------
# 5. Datastores, then schema, then topics, then the application
# ---------------------------------------------------------------------------
log "applying datastores"
kubectl apply -f "$ROOT/k8s/10-datastores.yaml" -f "$ROOT/k8s/11-kafka.yaml"

log "waiting for postgres and redis"
kubectl -n "$NAMESPACE" rollout status statefulset/postgres --timeout=180s
kubectl -n "$NAMESPACE" rollout status deployment/redis --timeout=120s
log "waiting for kafka (its readiness probe asks for topic metadata, not just a port)"
kubectl -n "$NAMESPACE" rollout status statefulset/kafka --timeout=300s

log "running migrations"
# Delete first: a completed Job is immutable, so re-applying an unchanged one silently does
# nothing — which on a second run would leave the new schema unapplied.
kubectl -n "$NAMESPACE" delete job db-migrate --ignore-not-found
kubectl -n "$NAMESPACE" delete job kafka-topics --ignore-not-found
kubectl apply -f "$ROOT/k8s/20-api.yaml"
kubectl -n "$NAMESPACE" wait --for=condition=complete job/db-migrate --timeout=180s

log "creating topics"
kubectl apply -f "$ROOT/k8s/11-kafka.yaml"
kubectl -n "$NAMESPACE" wait --for=condition=complete job/kafka-topics --timeout=180s

log "applying workers"
kubectl apply -f "$ROOT/k8s/30-workers.yaml"

log "waiting for rollouts"
kubectl -n "$NAMESPACE" rollout status deployment/api --timeout=300s
kubectl -n "$NAMESPACE" rollout status deployment/publisher --timeout=180s
kubectl -n "$NAMESPACE" rollout status deployment/consumer --timeout=180s

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------
log "cluster ready"
kubectl -n "$NAMESPACE" get pods -o wide
echo
kubectl -n "$NAMESPACE" get hpa
echo
log "API:      http://localhost:30080/health"
log "readiness (shows which limiter store is live): curl -s http://localhost:30080/ready | jq"
log "metrics:  curl -s http://localhost:30080/metrics | head -40"
echo
log "next:"
log "  seed:     kubectl -n $NAMESPACE exec deploy/api -- node benchmarks/scripts/seed.mjs --users 1000"
log "  benchmark: BASE_URL=http://localhost:30080 PHASE=v7 bash benchmarks/scripts/run-phase.sh"
log "  drills:   bash scripts/k8s/drills.sh"
log "  teardown: bash scripts/k8s/kind-up.sh --down"
