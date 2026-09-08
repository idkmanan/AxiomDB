#!/usr/bin/env bash
# =============================================================================
# The final matrix, against a cluster.
#
#   BASE_URL=http://localhost:30080 bash benchmarks/scripts/run-cluster.sh
#   VU_LEVELS="5 50 100" bash benchmarks/scripts/run-cluster.sh
#
# WHY THIS IS NOT run-phase.sh. That script owns the compose stack: it recreates containers
# between levels, reads the limiter's ceilings out of the running container, and seeds through a
# published Postgres port. None of those apply to Kubernetes, where isolation between levels is a
# `rollout restart`, configuration comes from a ConfigMap and the database has no host port. Two
# runners with one shared k6 instrument is the honest split; one runner with a mode flag would be
# a script whose every line asks which environment it is in.
#
# WHAT IT RECORDS BESIDES LATENCY, and why each one is here rather than in a screenshot:
#   * pods and HPA state before and after every level — so a throughput number can be attributed
#     to a replica count rather than assumed to belong to three
#   * /metrics before and after — the in-process view (pool saturation F-33, event-loop lag F-37,
#     outbox depth) that a client-side tool cannot see
#   * a rate-limit assertion after each level: a run with 429s is measuring the limiter, not the
#     application (finding F-16's corollary)
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PHASE="${PHASE:-v7}"
PHASE_DIR="${PHASE_DIR:-benchmarks/${PHASE}-final}"
RESULTS_DIR="${RESULTS_DIR:-$PHASE_DIR/results}"
BASE_URL="${BASE_URL:-http://localhost:30080}"
NAMESPACE="${NAMESPACE:-acquisitions}"
VU_LEVELS="${VU_LEVELS:-5 10 20 50 100 500 1000}"
DURATION="${DURATION:-60s}"
RAMP_UP="${RAMP_UP:-15s}"
RAMP_DOWN="${RAMP_DOWN:-10s}"
COOLDOWN="${COOLDOWN:-30}"
SCRIPT="${SCRIPT:-benchmarks/k6/full.js}"

info() { printf '\033[1;34m[run-cluster]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run-cluster]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[run-cluster] FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

k() { kubectl -n "$NAMESPACE" "$@"; }

for tool in k6 kubectl curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

# A dirty tree means the artifacts cannot be attributed to a commit — the same guard run-phase.sh
# applies, and the reason the v0 tag/commit mismatch (F-19) was a finding rather than a footnote.
if [ -n "$(git status --porcelain src/ 2>/dev/null)" ]; then
  die "src/ has uncommitted changes; commit or stash before measuring"
fi

mkdir -p "$RESULTS_DIR"

curl -fsS "$BASE_URL/health" >/dev/null 2>&1 || die "no healthy API at $BASE_URL — run scripts/k8s/kind-up.sh"

READY="$(curl -fsS "$BASE_URL/ready")" || die "readiness probe failed"
STORE="$(printf '%s' "$READY" | grep -o '"rateLimitStore":"[^"]*"' | cut -d'"' -f4)"
info "rate-limit store in use: ${STORE:-unknown}"
if [ "$STORE" != "RedisSlidingWindowStore" ]; then
  # Not fatal, but it changes what the run means: with the in-process store, N replicas enforce N
  # times the configured limit, and the "distributed rate limiting" claim does not hold for this run.
  warn "expected RedisSlidingWindowStore — the limiter is NOT shared across replicas in this run"
fi

REPLICAS="$(k get deployment api -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo '?')"
COMMIT="$(git rev-parse --short HEAD)"
TAG="$(git describe --tags --exact-match 2>/dev/null || echo 'unavailable')"

# ---------------------------------------------------------------------------
# Environment fingerprint. Same shape as the compose runner's, so report.mjs can read either.
# ---------------------------------------------------------------------------
cat >"$PHASE_DIR/environment.json" <<EOF
{
  "phase": "$PHASE",
  "captured_at": "$(date -u +%FT%TZ)",
  "target": "kubernetes",
  "base_url": "$BASE_URL",
  "git": { "short": "$COMMIT", "tag": "$TAG" },
  "cluster": {
    "api_ready_replicas": "$REPLICAS",
    "rate_limit_store": "${STORE:-unknown}",
    "kubectl_version": "$(kubectl version --client -o json 2>/dev/null | tr -d '\n' | sed 's/"/\\"/g' | cut -c1-200)"
  },
  "k6": "$(k6 version 2>/dev/null | head -1)",
  "levels": "$VU_LEVELS",
  "script": "$SCRIPT"
}
EOF
info "wrote $PHASE_DIR/environment.json (api replicas: $REPLICAS)"

snapshot() {
  local label="$1"
  {
    echo "=== $label ==="
    date -u +%FT%TZ
    echo "--- pods ---"
    k get pods -o wide 2>&1
    echo "--- hpa ---"
    k get hpa 2>&1
    echo "--- top pods ---"
    k top pods 2>&1 || echo '(metrics-server unavailable)'
  } >>"$PHASE_DIR/cluster-snapshots.txt"
}

capture_metrics() {
  local label="$1"
  {
    echo "=== $label ==="
    curl -fsS "$BASE_URL/metrics" 2>&1 | grep -vE '^#' | grep -E 'http_requests_total|http_request_duration_seconds_count|pg_pool_connections|nodejs_eventloop_lag_seconds|rate_limit_|outbox_|events_consumed_total|auth_denylist' || true
  } >>"$PHASE_DIR/app-metrics.txt"
}

: >"$PHASE_DIR/cluster-snapshots.txt"
: >"$PHASE_DIR/app-metrics.txt"

# ---------------------------------------------------------------------------
# Warm-up. Discarded: the first run of any level pays JIT, pool fill and page cache, and a
# benchmark that reports that as steady state is measuring its own cold start.
# ---------------------------------------------------------------------------
info "warm-up (discarded)"
RESULTS_DIR="$RESULTS_DIR" k6 run --quiet \
  -e VUS=20 -e DURATION=20s -e RAMP_UP=5s -e RAMP_DOWN=5s \
  -e RUN_TAG=warmup -e BASE_URL="$BASE_URL" -e RESULTS_DIR="$RESULTS_DIR" \
  "$SCRIPT" >/dev/null 2>&1 || warn "warm-up failed; continuing"
rm -f "$RESULTS_DIR/warmup-vus20.json"

FAILED_LEVELS=""

for VUS in $VU_LEVELS; do
  info "level ${VUS} VUs"
  snapshot "before vus=$VUS"
  capture_metrics "before vus=$VUS"

  RUN_TAG="${PHASE}-full"
  RESULTS_DIR="$RESULTS_DIR" k6 run \
    -e VUS="$VUS" -e DURATION="$DURATION" -e RAMP_UP="$RAMP_UP" -e RAMP_DOWN="$RAMP_DOWN" \
    -e RUN_TAG="$RUN_TAG" -e BASE_URL="$BASE_URL" -e RESULTS_DIR="$RESULTS_DIR" \
    "$SCRIPT"
  RC=$?

  snapshot "after vus=$VUS"
  capture_metrics "after vus=$VUS"

  RESULT_FILE="$RESULTS_DIR/${RUN_TAG}-vus${VUS}.json"
  if [ ! -f "$RESULT_FILE" ]; then
    warn "no result file for ${VUS} VUs"
    FAILED_LEVELS="$FAILED_LEVELS $VUS"
  else
    # The validity gate. A run with 429s from our own limiter is measuring the limiter; a run with
    # 500s is measuring a defect. 503s are load shedding and are allowed to be non-zero — that is
    # the system working (F-33).
    LIMITED="$(grep -o '"rejected_rate_limited"[^}]*"rate":[0-9.]*' "$RESULT_FILE" | grep -o '[0-9.]*$' || echo 0)"
    if [ "${LIMITED%%.*}" != "0" ] || [ "$LIMITED" != "0" ] && [ "$LIMITED" != "0.0" ]; then
      warn "level $VUS saw rate-limited responses (rate=$LIMITED) — raise RATE_LIMIT_* in the ConfigMap"
    fi
  fi
  [ $RC -eq 0 ] || FAILED_LEVELS="$FAILED_LEVELS $VUS"

  # Restart the API between levels, which is what the compose runner's --force-recreate did. F-34
  # is the reason it is not optional: 752 abandoned requests from a previous level were still
  # holding pool connections when the next one started, and the level after that aborted in setup.
  info "restarting API to isolate the next level"
  k rollout restart deployment/api >/dev/null 2>&1
  k rollout status deployment/api --timeout=180s >/dev/null 2>&1
  sleep "$COOLDOWN"
done

info "results in $RESULTS_DIR"
if [ -n "$FAILED_LEVELS" ]; then
  warn "levels with problems:$FAILED_LEVELS"
  exit 1
fi
info "all levels completed"
info "next: node benchmarks/scripts/report.mjs --phase $PHASE --dir $RESULTS_DIR --out $PHASE_DIR/SUMMARY.md --compare benchmarks/v0-baseline/results"
