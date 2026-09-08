#!/usr/bin/env bash
# =============================================================================
# FAILURE DRILLS against the running cluster.
#
#   bash scripts/k8s/drills.sh            # all of them
#   bash scripts/k8s/drills.sh replica    # one by name
#
# WHY DRILLS RATHER THAN A PARAGRAPH. Every claim in this project about resilience is a claim
# about what happens during a failure, and failures do not happen while you are looking. Each
# drill below breaks something specific, asserts what the system did, and exits non-zero if the
# answer is wrong — so "requests are not dropped during a deploy" is a command somebody else can
# run rather than a sentence they have to believe.
#
# Each drill states its EXPECTED outcome before it runs. That ordering matters: a script that
# only prints what happened is a log, not a test.
# =============================================================================
set -uo pipefail

NAMESPACE="${NAMESPACE:-acquisitions}"
BASE_URL="${BASE_URL:-http://localhost:30080}"
DRILL="${1:-all}"

pass=0
fail=0

log() { printf '\n\033[1;34m── %s\033[0m\n' "$*"; }
say() { printf '   %s\n' "$*"; }
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "true" ]]; then
    printf '   \033[1;32mok  \033[0m %s%s\n' "$name" "${detail:+ — $detail}"
    pass=$((pass + 1))
  else
    printf '   \033[1;31mFAIL\033[0m %s%s\n' "$name" "${detail:+ — $detail}"
    fail=$((fail + 1))
  fi
}

k() { kubectl -n "$NAMESPACE" "$@"; }

# Hammer the API in the background and count non-2xx responses. This is the instrument for every
# drill that claims requests are not dropped.
start_load() {
  local out="$1"
  : >"$out"
  (
    while :; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/health" || echo 000)
      echo "$code" >>"$out"
      sleep 0.1
    done
  ) &
  echo $!
}

summarise_load() {
  local out="$1"
  local total ok bad
  total=$(wc -l <"$out" | tr -d ' ')
  ok=$(grep -c '^200$' "$out" || true)
  bad=$((total - ok))
  echo "$total $ok $bad"
}

# ---------------------------------------------------------------------------
# 1. Kill a replica under load.
# ---------------------------------------------------------------------------
drill_replica() {
  log "1. delete an API pod while traffic is flowing"
  say "expected: zero failed requests. Three replicas, a Service that removes the endpoint, and"
  say "          a drain (src/server.js) that finishes in-flight work before the listener closes."

  local pid out; out=$(mktemp)
  pid=$(start_load "$out")
  sleep 3

  local victim; victim=$(k get pods -l app=api -o jsonpath='{.items[0].metadata.name}')
  say "deleting $victim"
  k delete pod "$victim" --wait=false >/dev/null
  k rollout status deployment/api --timeout=180s >/dev/null

  sleep 3
  kill "$pid" 2>/dev/null || true
  read -r total ok bad <<<"$(summarise_load "$out")"
  say "requests $total, 200s $ok, non-200 $bad"
  check "no request failed while a replica was replaced" "$([[ $bad -eq 0 ]] && echo true || echo false)" "$bad failures"
  rm -f "$out"
}

# ---------------------------------------------------------------------------
# 2. Rolling restart under load.
# ---------------------------------------------------------------------------
drill_rollout() {
  log "2. rolling restart of all three replicas while traffic is flowing"
  say "expected: zero failed requests. maxUnavailable=0 keeps three pods ready throughout, and"
  say "          each terminating pod fails readiness before it stops accepting connections."

  local pid out; out=$(mktemp)
  pid=$(start_load "$out")
  sleep 2

  k rollout restart deployment/api >/dev/null
  k rollout status deployment/api --timeout=300s >/dev/null

  sleep 2
  kill "$pid" 2>/dev/null || true
  read -r total ok bad <<<"$(summarise_load "$out")"
  say "requests $total, 200s $ok, non-200 $bad"
  check "no request failed during a rolling restart" "$([[ $bad -eq 0 ]] && echo true || echo false)" "$bad failures"
  rm -f "$out"
}

# ---------------------------------------------------------------------------
# 3. Redis down.
# ---------------------------------------------------------------------------
drill_redis() {
  log "3. delete Redis"
  say "expected: reads keep working (the limiter fails OPEN, ADR 0002) and /ready still reports"
  say "          READY, because readiness is 'can I serve', not 'is every optional dependency up'."
  say "          Failing readiness here would take all three replicas out at once — a cache blip"
  say "          escalated into a total outage by the health check."

  k scale deployment/redis --replicas=0 >/dev/null
  sleep 5

  local read_code ready_code
  read_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/api" || echo 000)
  ready_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/ready" || echo 000)
  say "GET /api → $read_code, GET /ready → $ready_code"
  check "reads survive a Redis outage" "$([[ "$read_code" == "200" ]] && echo true || echo false)" "status $read_code"
  check "the pod stays READY" "$([[ "$ready_code" == "200" ]] && echo true || echo false)" "status $ready_code"

  # The auth endpoints are the other half of ADR 0002: they fail CLOSED, because a brute-force
  # window is worse than a 503. A 503 here is the CORRECT answer, not a failure.
  local auth_code
  auth_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
    -H 'Content-Type: application/json' \
    -d '{"email":"drill@example.test","password":"wrong-password"}' \
    "$BASE_URL/api/auth/sign-in" || echo 000)
  say "POST /api/auth/sign-in → $auth_code (503 expected: the auth policy fails CLOSED)"
  check "auth fails closed" "$([[ "$auth_code" == "503" ]] && echo true || echo false)" "status $auth_code"

  k scale deployment/redis --replicas=1 >/dev/null
  k rollout status deployment/redis --timeout=120s >/dev/null
  say "Redis restored"
}

# ---------------------------------------------------------------------------
# 4. Kafka down — the outbox drill, in the cluster.
# ---------------------------------------------------------------------------
drill_kafka() {
  log "4. delete Kafka, write deals, restore Kafka"
  say "expected: writes keep succeeding, the outbox backlog grows, and it drains once the broker"
  say "          returns. This is the dual-write claim: no lost events, no failed requests."

  k scale statefulset/kafka --replicas=0 >/dev/null
  sleep 5

  # The drill script does the writing and the assertions; running it inside the cluster means it
  # uses the same DATABASE_URL and the same code path as the API.
  k exec deploy/api -- node scripts/events/outbox-drill.mjs write --deals 5
  local write_rc=$?
  check "writes succeed and events queue with no broker" "$([[ $write_rc -eq 0 ]] && echo true || echo false)"

  k scale statefulset/kafka --replicas=1 >/dev/null
  k rollout status statefulset/kafka --timeout=300s >/dev/null

  # The publisher drains on its own — that is the point. Give it a few poll cycles, then read the
  # backlog out of the metrics endpoint rather than trusting a log line.
  sleep 15
  local pending
  pending=$(curl -s --max-time 5 "$BASE_URL/metrics" | awk '/^outbox_pending /{print $2}')
  say "outbox_pending after recovery: ${pending:-unknown}"
  check "the backlog drained without intervention" "$([[ "${pending:-1}" == "0" ]] && echo true || echo false)" "pending=${pending:-unknown}"
}

# ---------------------------------------------------------------------------
# 5. Scale out, and prove the limiter is shared.
# ---------------------------------------------------------------------------
drill_limiter() {
  log "5. the rate limit is shared across replicas"
  say "expected: /ready reports RedisSlidingWindowStore on every replica. With the in-process"
  say "          store the effective limit would be replicas x configured, which is the defect"
  say "          scripts/redis/limiter-proof.mjs measures directly."

  local stores; stores=$(for i in 1 2 3; do curl -s --max-time 5 "$BASE_URL/ready" | grep -o '"rateLimitStore":"[^"]*"'; done | sort -u)
  say "observed: $(echo "$stores" | tr '\n' ' ')"
  check "the Redis store is live" "$(echo "$stores" | grep -q RedisSlidingWindowStore && echo true || echo false)" "$stores"

  # And the limit actually rejects: 12 rapid sign-in attempts against RATE_LIMIT_AUTH_MAX=10.
  local codes=""
  for _ in $(seq 1 12); do
    codes+="$(curl -s -o /dev/null -w '%{http_code} ' --max-time 5 -X POST \
      -H 'Content-Type: application/json' \
      -d '{"email":"nobody@example.test","password":"wrong-password"}' \
      "$BASE_URL/api/auth/sign-in")"
  done
  say "statuses: $codes"
  check "a 429 appears within 12 attempts across 3 replicas" "$(echo "$codes" | grep -q 429 && echo true || echo false)"
}

case "$DRILL" in
  replica) drill_replica ;;
  rollout) drill_rollout ;;
  redis) drill_redis ;;
  kafka) drill_kafka ;;
  limiter) drill_limiter ;;
  all)
    drill_replica
    drill_rollout
    drill_redis
    drill_kafka
    drill_limiter
    ;;
  *)
    echo "unknown drill '$DRILL' — use: replica | rollout | redis | kafka | limiter | all"
    exit 1
    ;;
esac

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
