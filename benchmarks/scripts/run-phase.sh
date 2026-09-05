#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase measurement runner.
#
#   PHASE=v0 ./benchmarks/scripts/run-phase.sh      # the frozen baseline matrix
#   PHASE=v1 ./benchmarks/scripts/run-phase.sh      # Phase 1, correctness+security
#
# Generalised from run-baseline.sh in Phase 1. Three things changed and each one
# is a consequence of what Phase 0 found:
#
#   * PHASE / RESULTS_DIR are parameters, so a second phase does not need the k6
#     scripts edited. baseline.js is frozen (see BENCHMARKING.md) and its only
#     post-Phase-0 change is reading its output directory from the environment.
#
#   * The as-built/bypassed variant loop is GONE, along with BENCH_BYPASS_SECURITY
#     and Arcjet. Phase 0 needed two variants because a third-party dependency sat
#     in the request path and attributing its cost to application code would have
#     inflated every later improvement (F-16). The replacement limiter is ours, so
#     there is nothing to attribute away — one run per level.
#
#   * A post-run guardrail asserts the limiter never rejected. The limiter is now
#     in the request path on every run, and every VU shares one source IP, so a
#     production-shaped limit would turn the matrix into 429s and the report would
#     show a flattering latency drop that was really just rejections. Configured
#     limits are raised in .env.bench and this check confirms the outcome rather
#     than trusting the configuration — the same reasoning as the in-container flag
#     check it replaces.
#
# Runtime, extrapolated from the Phase 0 run (~4.4 min per closed-model run
# including cool-down): 7 baseline levels ~31 min, plus REALISTIC_LEVELS and
# SAT_RATES. Defaults below come to roughly 50 minutes. Trim with, e.g.:
#   REALISTIC_LEVELS="" VU_LEVELS="5 10 20 50" ./benchmarks/scripts/run-phase.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PHASE="${PHASE:-v0}"
case "$PHASE" in
  v0) PHASE_DIR="benchmarks/v0-baseline" ;;
  v1) PHASE_DIR="benchmarks/v1-correctness" ;;
  *) PHASE_DIR="benchmarks/${PHASE}" ;;
esac

COMPOSE_FILE="docker-compose.bench.yml"
ENV_FILE=".env.bench"
RESULTS_DIR="${RESULTS_DIR:-$PHASE_DIR/results}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

# Frozen-instrument levels. Both sides of the knee: 5-50 are uncensored and give a
# quotable number, 100-1000 show what happens past capacity. Reproducing the
# committed v0 SUMMARY.md needs all seven, so this default matches it.
VU_LEVELS="${VU_LEVELS:-5 10 20 50 100 500 1000}"

# Realistic-mix levels (benchmarks/k6/realistic.js). A separate, smaller set: this
# instrument starts its series at v1, so there is no earlier matrix to reproduce,
# and its purpose is to find its own knee rather than to match v0's.
REALISTIC_LEVELS="${REALISTIC_LEVELS:-10 50 100}"

# Open-model probe rates, in ITERATIONS per second. v0 probed 50/200/500 against a
# static route and absorbed all of it; against the real mix (F-17) capacity is in
# the low tens, so probing there is what can actually drop an iteration.
SAT_RATES="${SAT_RATES:-5 10 20}"

SEED_USERS="${SEED_USERS:-1000}"
# Cool-down between runs. Without it the previous run's TIME_WAIT sockets and a
# still-warm Postgres cache leak into the next measurement.
COOLDOWN="${COOLDOWN:-45}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# ---- preflight -------------------------------------------------------------
info "preflight (phase=$PHASE -> $PHASE_DIR)"

for bin in docker k6 node curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    red "missing required tool: $bin"
    case "$bin" in
      k6) echo "  install: https://grafana.com/docs/k6/latest/set-up/install-k6/" ;;
      docker) echo "  install: https://docs.docker.com/engine/install/" ;;
      curl) echo "  install: apt-get install curl  (used for the health gate)" ;;
    esac
    exit 1
  fi
done

if [ ! -f "$ENV_FILE" ]; then
  red "$ENV_FILE not found"
  echo "  run: cp .env.bench.example $ENV_FILE"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  red "docker daemon not reachable"
  exit 1
fi

# Refuse to benchmark a dirty tree. A result that cannot be tied to an exact commit
# is not evidence, which is the whole premise of this harness.
if [ -n "$(git status --porcelain -- src/ package.json Dockerfile 2>/dev/null)" ]; then
  red "working tree has uncommitted changes in src/, package.json or Dockerfile"
  echo "  commit or stash first — results must be attributable to a single commit"
  echo "  override with ALLOW_DIRTY=1 if you know what you are doing"
  [ "${ALLOW_DIRTY:-0}" = "1" ] || exit 1
fi

COMMIT="$(git rev-parse HEAD)"
COMMIT_SHORT="$(git rev-parse --short HEAD)"
mkdir -p "$RESULTS_DIR"

# ---- environment fingerprint ----------------------------------------------
# Captured because "p95 was 40ms" is meaningless without knowing on what.
info "recording environment fingerprint"
FINGERPRINT="$PHASE_DIR/environment.json"
node -e "
const os = require('os');
const { execSync } = require('child_process');
const sh = (c) => { try { return execSync(c, {stdio:['ignore','pipe','ignore']}).toString().trim(); } catch { return 'unavailable'; } };
const fp = {
  phase: '$PHASE',
  captured_at: new Date().toISOString(),
  git: {
    commit: '$COMMIT', short: '$COMMIT_SHORT',
    tag: sh('git describe --tags --exact-match 2>/dev/null') || null,
    // Tree hash of src/ alone. HEAD moves whenever the harness or the docs change,
    // which would make two comparable runs look incomparable. What determines app
    // behaviour is the content of src/, so results with a matching src_tree can be
    // compared across different commits — and a differing src_tree invalidates the
    // comparison no matter what HEAD says. Finding F-19 is why this is recorded.
    src_tree: sh('git rev-parse HEAD:src'),
  },
  host: {
    platform: process.platform, arch: process.arch,
    cpu_model: (os.cpus()[0]||{}).model || 'unknown',
    cpu_count: os.cpus().length,
    total_mem_mb: Math.round(os.totalmem()/1048576),
    load_avg: os.loadavg(),
  },
  tooling: { node: process.version, k6: sh('k6 version'), docker: sh('docker --version') },
  limits_note: 'container cpu/memory limits are pinned in .env.bench — see APP_CPUS / PG_CPUS',
};
require('fs').writeFileSync('$FINGERPRINT', JSON.stringify(fp, null, 2));
console.log(JSON.stringify(fp.host));
"
grn "wrote $FINGERPRINT"

# ---- bring up the stack ----------------------------------------------------
info "starting bench stack (postgres + app)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

info "waiting for app health"
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    grn "app healthy after ${i}s"
    break
  fi
  if [ "$i" = 60 ]; then
    red "app never became healthy — dumping logs"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail 50 app
    exit 1
  fi
  sleep 1
done

# ---- verify resource limits actually applied -------------------------------
# The whole "pinned resources" claim rests on this and it is NOT safe to assume.
# `deploy.resources.limits` is honoured by Compose V2 but was silently IGNORED by
# Compose V1, where the equivalent keys were top-level `cpus`/`mem_limit`. If the
# limits did not apply, the benchmark measures the host machine and every
# comparison against it is void (finding F-11). So read them back out of the
# container's HostConfig and refuse to continue if unset.
info "verifying container resource limits were applied"
verify_limits() {
  local svc="$1" cid nanocpus memory
  cid="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$svc")"
  if [ -z "$cid" ]; then
    red "cannot resolve container id for service '$svc'"
    exit 1
  fi
  nanocpus="$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$cid")"
  memory="$(docker inspect -f '{{.HostConfig.Memory}}' "$cid")"
  if [ "$nanocpus" = "0" ] || [ "$memory" = "0" ]; then
    red "resource limits were NOT applied to '$svc' (NanoCpus=$nanocpus Memory=$memory)"
    echo "  Your Compose implementation ignored deploy.resources.limits."
    echo "  Check 'docker compose version' — V2 is required. On V1, results would"
    echo "  reflect unconstrained host resources and would not be comparable."
    exit 1
  fi
  grn "  $svc: cpus=$(node -e "process.stdout.write((${nanocpus}/1e9).toString())") memory=$(node -e "process.stdout.write((${memory}/1048576)+'MB')")"
}
verify_limits postgres
verify_limits app

# ---- verify the limiter cannot fire during the matrix ----------------------
# NEW IN PHASE 1, and the direct successor to the in-container variant check.
#
# The rate limiter is ours now and runs on every request. Every VU shares one
# source IP, so a production-shaped per-IP limit would reject most of the matrix —
# and rejections are fast, so the report would show a dramatic latency improvement
# that was really the limiter refusing to work. That is precisely the F-16
# corollary: "supplying a working key would not have improved these runs, it would
# have ended them."
#
# The configured ceilings are read back out of the running container rather than
# from .env.bench, because what matters is what the process has, not what the file
# says.
info "verifying rate limits are raised for load testing"
read_limit() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
    sh -c "printf %s \"\$$1\"" 2>/dev/null || echo ""
}
AUTH_MAX="$(read_limit RATE_LIMIT_AUTH_MAX)"
ADMIN_MAX="$(read_limit RATE_LIMIT_ADMIN_MAX)"
for pair in "RATE_LIMIT_AUTH_MAX:$AUTH_MAX:2000" "RATE_LIMIT_ADMIN_MAX:$ADMIN_MAX:2000000"; do
  name="${pair%%:*}"
  rest="${pair#*:}"
  value="${rest%%:*}"
  floor="${rest##*:}"
  if [ -z "$value" ] || [ "$value" -lt "$floor" ] 2>/dev/null; then
    red "$name is '${value:-unset}' in the container; needs >= $floor for a load test"
    echo "  All VUs share one source IP. At a production limit the matrix becomes 429s"
    echo "  and the resulting latency drop would be rejections, not an improvement."
    echo "  Raise it in .env.bench — the limiter still runs on every request, so its"
    echo "  CPU cost is still measured; only the rejection is taken out of the way."
    exit 1
  fi
  grn "  $name=$value"
done

# ---- seed ------------------------------------------------------------------
info "seeding $SEED_USERS users"
set -a
. "./$ENV_FILE"
set +a
DATABASE_URL="postgresql://${POSTGRES_USER:-bench}:${POSTGRES_PASSWORD}@localhost:${PG_HOST_PORT:-5433}/${POSTGRES_DB:-benchdb}" \
  node benchmarks/scripts/seed.mjs --users "$SEED_USERS"

# The load scripts authenticate as the admin in setup() so GET /api/users reaches
# the database instead of being rejected by authorize() (finding F-10). Confirm
# that works now rather than discovering it 30 minutes into the matrix.
info "verifying admin sign-in works (required for users_list measurements)"
ADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/api/auth/sign-in" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${SEED_ADMIN_EMAIL:-bench_admin@example.test}\",\"password\":\"${SEED_PASSWORD:-BenchPassword123!}\"}")"
if [ "$ADMIN_STATUS" != "200" ]; then
  red "admin sign-in returned $ADMIN_STATUS (expected 200)"
  if [ "$ADMIN_STATUS" = "429" ]; then
    echo "  Rate limited. Raise RATE_LIMIT_AUTH_MAX in .env.bench."
  else
    echo "  Without an admin session, GET /api/users returns 403 from authorize()"
    echo "  before the controller runs, so the list query is never measured."
  fi
  exit 1
fi
grn "  admin sign-in OK"

# Confirm the endpoint under test is actually paginated in v1. Cheap, and it is the
# one assertion that distinguishes "the fix shipped" from "the response happens to
# be smaller". v0 shipped 167 KiB and 1001 rows per response.
if [ "$PHASE" != "v0" ]; then
  info "verifying GET /api/users returns a bounded page"
  COOKIE="$(curl -s -i -X POST "$BASE_URL/api/auth/sign-in" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${SEED_ADMIN_EMAIL:-bench_admin@example.test}\",\"password\":\"${SEED_PASSWORD:-BenchPassword123!}\"}" |
    grep -i '^set-cookie:' | sed -e 's/^[Ss]et-[Cc]ookie: //' -e 's/;.*$//')"
  BODY_BYTES="$(curl -s -o /dev/null -w '%{size_download}' -H "Cookie: $COOKIE" "$BASE_URL/api/users")"
  if [ "$BODY_BYTES" -gt 32768 ]; then
    red "GET /api/users returned $BODY_BYTES bytes — that is not a bounded page"
    echo "  v0 shipped ~167 KiB (1001 rows). Check PAGINATION_DEFAULT_LIMIT."
    exit 1
  fi
  grn "  users list response: $BODY_BYTES bytes"
fi

# ---- warm-up ---------------------------------------------------------------
# Discarded on purpose: the first ~30s of a Node process is JIT warm-up and cold
# Postgres cache. Including it inflates p99 and, worse, makes every LATER phase look
# artificially better because by then you have learned to warm up.
info "warm-up (20s, results discarded)"
RESULTS_DIR="$RESULTS_DIR" k6 run --quiet \
  -e VUS=50 -e DURATION=20s -e RAMP_UP=5s -e RAMP_DOWN=5s \
  -e RUN_TAG=warmup -e BASE_URL="$BASE_URL" \
  -e RESULTS_DIR="$RESULTS_DIR" \
  -e SEED_USER_COUNT="$SEED_USERS" \
  benchmarks/k6/baseline.js >/dev/null 2>&1 || true
rm -f "$RESULTS_DIR/warmup-vus50.json" "$RESULTS_DIR/warmup-vus50.samples.json.gz"
grn "warm-up done"

# ---- post-run assertion ----------------------------------------------------
# Reads the result file back and refuses to accept a run where the limiter fired.
# Checking the OUTCOME rather than the configuration is the same discipline as
# reading resource limits out of HostConfig instead of trusting the compose file.
assert_clean_run() {
  local file="$1"
  node -e "
    const fs = require('fs');
    const doc = JSON.parse(fs.readFileSync('$file', 'utf8'));
    const m = doc.metrics || {};
    const val = (n, s) => (m[n] && m[n].values && m[n].values[s]) || 0;
    const r429 = val('rejected_rate_limited', 'rate');
    const c403 = val('forbidden_403', 'count');
    const r5xx = val('server_errors', 'rate');
    if (r429 > 0 || c403 > 0) {
      console.error('REJECTED RUN: the rate limiter fired during measurement');
      console.error('  429 rate: ' + (r429 * 100).toFixed(2) + '%   403 count: ' + c403);
      console.error('  Rejections are fast, so this would show up as a latency improvement.');
      console.error('  Raise RATE_LIMIT_* in .env.bench and re-run.');
      process.exit(1);
    }
    if (r5xx > 0) {
      console.error('WARNING: 5xx rate ' + (r5xx * 100).toFixed(2) + '% — a real defect, not capacity.');
    }
  "
}

run_closed() {
  local script="$1" tag="$2" vus="$3"
  info "run: $tag vus=$vus ($script)"
  curl -fsS "$BASE_URL/health" >/dev/null || {
    red "app unhealthy before run"
    exit 1
  }

  # --out json captures PER-REQUEST samples including `error_code` on failures. The
  # aggregate output cannot distinguish "the server reset the connection" from "the
  # client stopped waiting", which is the whole question a high failure rate raises
  # (F-14). Gzipped and gitignored; distil with `npm run bench:attribute`.
  k6 run \
    -e VUS="$vus" \
    -e RUN_TAG="$tag" \
    -e BASE_URL="$BASE_URL" \
    -e RESULTS_DIR="$RESULTS_DIR" \
    -e SEED_USER_COUNT="$SEED_USERS" \
    --out "json=$RESULTS_DIR/$tag-vus$vus.samples.json.gz" \
    "$script"

  assert_clean_run "$RESULTS_DIR/$tag-vus$vus.json"
  grn "recorded $RESULTS_DIR/$tag-vus$vus.json"
  info "cooling down ${COOLDOWN}s"
  sleep "$COOLDOWN"
}

# ---- the matrix ------------------------------------------------------------
# FROZEN INSTRUMENT first. baseline.js is the script the v0 numbers came from, so
# these are the only rows that may be compared against the committed v0 matrix —
# and only at levels where neither row was timeout-censored (F-13).
info "closed model, frozen instrument (benchmarks/k6/baseline.js)"
for vus in $VU_LEVELS; do
  run_closed benchmarks/k6/baseline.js "$PHASE-baseline" "$vus"
done

# NEW INSTRUMENT. Realistic read-heavy mix; its series starts at this phase and
# must never be compared against a v0 row (F-17, and INTERVIEW_PHASE_0 §14).
if [ -n "${REALISTIC_LEVELS// /}" ]; then
  info "closed model, realistic mix (benchmarks/k6/realistic.js)"
  for vus in $REALISTIC_LEVELS; do
    run_closed benchmarks/k6/realistic.js "$PHASE-realistic" "$vus"
  done
fi

# ---- saturation probe (open model) ----------------------------------------
# Now pointed at the real mix rather than a static route (F-17), so
# dropped_iterations finally means what BENCHMARKING.md says it means.
info "open model saturation probe (realistic mix)"
for rate in $SAT_RATES; do
  curl -fsS "$BASE_URL/health" >/dev/null || {
    red "app unhealthy before probe"
    exit 1
  }
  k6 run -e RATE="$rate" -e DURATION=45s -e RUN_TAG="$PHASE-saturation" \
    -e BASE_URL="$BASE_URL" -e RESULTS_DIR="$RESULTS_DIR" \
    -e SEED_USER_COUNT="$SEED_USERS" \
    benchmarks/k6/saturation.js || true
  sleep 20
done

# ---- capture server-side evidence -----------------------------------------
# Client-side timings cannot separate queue time from service time, so the
# database is measured from the database. This is what exonerated Postgres in
# Phase 0: ~11.9 s of total query time across runs reporting 15-60 second
# requests.
info "capturing pg_stat_statements + query plans"
psql_capture() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
    psql -U "${POSTGRES_USER:-bench}" -d "${POSTGRES_DB:-benchdb}" -c "$1"
}

psql_capture "
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  SELECT calls, round(total_exec_time::numeric,2) AS total_ms,
         round(mean_exec_time::numeric,2) AS mean_ms, rows, left(query, 90) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;
" >"$PHASE_DIR/pg_stat_statements.txt" 2>&1 || true

# Both shapes, deliberately. The paginated query is what the app now issues; the
# unbounded one is kept alongside it so the plans can be compared directly in one
# artifact. Phase 0 measured the unbounded scan at 0.335 ms execution with 21
# shared-buffer hits, entirely cached — which is why an index would have achieved
# nothing here and pagination is the fix.
{
  echo '=== v1 paginated query (what the application now issues) ==='
  psql_capture "
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT id, email, name, role, created_at, updated_at
    FROM users ORDER BY id LIMIT ${PAGINATION_DEFAULT_LIMIT:-20} OFFSET 0;
  " || true
  echo
  echo '=== count(*) issued alongside it for pagination metadata ==='
  psql_capture "EXPLAIN (ANALYZE, BUFFERS) SELECT count(*)::int FROM users;" || true
  echo
  echo '=== v0 unbounded query, for comparison only — no longer issued ==='
  psql_capture "
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT id, email, name, role, created_at, updated_at FROM users;
  " || true
} >"$PHASE_DIR/explain-users-list.txt" 2>&1 || true

grn "server-side evidence captured"

# ---- teardown --------------------------------------------------------------
info "tearing down"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down -v

grn ""
grn "$PHASE measurement complete at commit $COMMIT_SHORT"
grn "  results:     $RESULTS_DIR/"
grn "  environment: $FINGERPRINT"
grn ""
echo "Next:"
echo "  node benchmarks/scripts/report.mjs --phase $PHASE \\"
echo "       --dir $RESULTS_DIR --out $PHASE_DIR/SUMMARY.md \\"
if [ "$PHASE" != "v0" ]; then
  echo "       --compare benchmarks/v0-baseline/results"
fi
echo "  node benchmarks/scripts/attribute-failures.mjs --dir $RESULTS_DIR"
