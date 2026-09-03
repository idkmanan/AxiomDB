#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase 0 baseline runner.
#
#   ./benchmarks/scripts/run-baseline.sh
#
# Executes the full v0 measurement matrix and writes every artifact under
# benchmarks/v0-baseline/. Deliberately opinionated about ordering and rest
# periods, because those are what make the numbers reproducible.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.bench.yml"
ENV_FILE=".env.bench"
RESULTS_DIR="benchmarks/v0-baseline/results"
BASE_URL="${BASE_URL:-http://localhost:3000}"
# All seven levels are run because the story needs both sides of the knee: 5-50
# are uncensored and give a quotable before-number, 100-1000 show what happens
# past capacity. Reproducing the committed SUMMARY.md needs all of them, so this
# default matches the committed matrix rather than being a convenient subset.
# Budget ~75 minutes. Override for a quick probe: VU_LEVELS="5 10" ...
VU_LEVELS="${VU_LEVELS:-5 10 20 50 100 500 1000}"

SEED_USERS="${SEED_USERS:-1000}"
# Cool-down between runs. Without it, the previous run's TIME_WAIT sockets and
# a still-warm Postgres cache leak into the next measurement.
COOLDOWN="${COOLDOWN:-45}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

# ---- preflight -------------------------------------------------------------
info "preflight"

for bin in docker k6 node curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    red "missing required tool: $bin"
    case "$bin" in
      k6)     echo "  install: https://grafana.com/docs/k6/latest/set-up/install-k6/" ;;
      docker) echo "  install: https://docs.docker.com/engine/install/" ;;
      curl)   echo "  install: apt-get install curl  (used for the health gate)" ;;
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

# Refuse to benchmark a dirty tree. A result that cannot be tied to an exact
# commit is not evidence, and the whole point of Phase 0 is defensible evidence.
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
FINGERPRINT="benchmarks/v0-baseline/environment.json"
node -e "
const os = require('os');
const { execSync } = require('child_process');
const sh = (c) => { try { return execSync(c, {stdio:['ignore','pipe','ignore']}).toString().trim(); } catch { return 'unavailable'; } };
const fp = {
  captured_at: new Date().toISOString(),
  git: {
    commit: '$COMMIT', short: '$COMMIT_SHORT',
    tag: sh('git describe --tags --exact-match 2>/dev/null') || null,
    // Tree hash of src/ alone. HEAD moves whenever the harness or the docs
    // change, which would make two comparable runs look incomparable. What
    // actually determines app behaviour is the content of src/, so results with
    // a matching src_tree can be compared even across different commits — and a
    // differing src_tree invalidates the comparison no matter what HEAD says.
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
# The whole "pinned resources" claim rests on this, and it is NOT safe to assume.
# `deploy.resources.limits` is honoured by Compose V2 (the `docker compose`
# plugin) but was silently IGNORED by Compose V1 (`docker-compose`, the Python
# implementation), where the equivalent keys were the top-level `cpus`/`mem_limit`.
# If the limits did not apply, the benchmark measures the host machine rather than
# a pinned environment, and every comparison against it is void. So read the
# limits back out of the container's HostConfig and refuse to continue if unset.
info "verifying container resource limits were applied"
verify_limits() {
  local svc="$1"
  local cid
  cid="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$svc")"
  if [ -z "$cid" ]; then
    red "cannot resolve container id for service '$svc'"
    exit 1
  fi

  local nanocpus memory
  nanocpus="$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$cid")"
  memory="$(docker inspect -f '{{.HostConfig.Memory}}' "$cid")"

  if [ "$nanocpus" = "0" ] || [ "$memory" = "0" ]; then
    red "resource limits were NOT applied to '$svc' (NanoCpus=$nanocpus Memory=$memory)"
    echo "  Your Compose implementation ignored deploy.resources.limits."
    echo "  Check 'docker compose version' — V2 is required. On V1, results would"
    echo "  reflect unconstrained host resources and would not be comparable."
    echo "  Refusing to produce numbers that cannot be reproduced."
    exit 1
  fi

  grn "  $svc: cpus=$(node -e "process.stdout.write((${nanocpus}/1e9).toString())") memory=$(node -e "process.stdout.write((${memory}/1048576)+'MB')")"
}
verify_limits postgres
verify_limits app

# ---- seed ------------------------------------------------------------------
info "seeding $SEED_USERS users"
set -a; . "./$ENV_FILE"; set +a
DATABASE_URL="postgresql://${POSTGRES_USER:-bench}:${POSTGRES_PASSWORD}@localhost:${PG_HOST_PORT:-5433}/${POSTGRES_DB:-benchdb}" \
  node benchmarks/scripts/seed.mjs --users "$SEED_USERS"

# The load test authenticates as the admin in setup() so GET /api/users reaches
# the database instead of being rejected by authorize(). Confirm that works now,
# rather than discovering it 30 minutes into the matrix.
info "verifying admin sign-in works (required for users_list measurements)"
ADMIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/api/auth/sign-in" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${SEED_ADMIN_EMAIL:-bench_admin@example.test}\",\"password\":\"${SEED_PASSWORD:-BenchPassword123!}\"}")"
if [ "$ADMIN_STATUS" != "200" ]; then
  red "admin sign-in returned $ADMIN_STATUS (expected 200)"
  echo "  Without an admin session, GET /api/users returns 403 from authorize()"
  echo "  before the controller runs, so the unbounded scan is never measured."
  exit 1
fi
grn "  admin sign-in OK"

# ---- warm-up ---------------------------------------------------------------
# Discarded on purpose: the first ~30s of any Node process is JIT warm-up and
# cold Postgres cache. Including it inflates p99 and makes later phases look
# better than they are.
info "warm-up (30s, results discarded)"
k6 run --quiet -e VUS=50 -e DURATION=20s -e RAMP_UP=5s -e RAMP_DOWN=5s \
  -e RUN_TAG=warmup -e BASE_URL="$BASE_URL" \
  -e SEED_USER_COUNT="$SEED_USERS" \
  benchmarks/k6/baseline.js >/dev/null 2>&1 || true
rm -f "$RESULTS_DIR/warmup-vus50.json" "$RESULTS_DIR/warmup-vus50.samples.json.gz"
grn "warm-up done"

# ---- the matrix ------------------------------------------------------------
# Two variants per VU level:
#   as-built  — Arcjet middleware inline (what the code actually does today)
#   nolimit   — middleware bypassed, isolating app + DB cost
# Both are recorded. Reporting only one would be selective.
run_one() {
  local variant="$1" vus="$2" bypass="$3"
  info "run: variant=$variant vus=$vus (BENCH_BYPASS_SECURITY=$bypass)"

  # `docker compose up` has no -e flag. The compose file declares
  # BENCH_BYPASS_SECURITY under `environment:` with a shell default, so exporting
  # it here is what varies the app config between runs. Recreate is forced because
  # compose will not restart a container whose image and config it considers
  # unchanged.
  BENCH_BYPASS_SECURITY="$bypass" \
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d --no-deps --force-recreate app

  # Confirm the flag actually took effect inside the container. Silently
  # benchmarking the wrong variant would corrupt the whole comparison.
  local actual
  actual="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
    sh -c 'printf %s "$BENCH_BYPASS_SECURITY"' 2>/dev/null || echo "?")"
  if [ "$actual" != "$bypass" ]; then
    red "flag mismatch: expected BENCH_BYPASS_SECURITY=$bypass, container reports '$actual'"
    exit 1
  fi
  grn "  verified in-container BENCH_BYPASS_SECURITY=$actual"

  sleep 8
  curl -fsS "$BASE_URL/health" >/dev/null || { red "app unhealthy before run"; exit 1; }

  # No --summary-export: it writes a near-duplicate of what baseline.js's own
  # handleSummary() already produces, minus the `meta` block that report.mjs needs
  # to know which run and VU level a file belongs to. Nothing consumed those files,
  # so they were 168 KB of committed noise.
  #
  # --out json captures PER-REQUEST samples, including the `error_code` field on
  # failures. The aggregate output cannot distinguish "the server reset the
  # connection" from "the client stopped waiting" — which is the whole question a
  # high failure rate raises. Gzipped and gitignored; distil with
  # `npm run bench:attribute` into a committed artifact before deleting them.
  k6 run \
    -e VUS="$vus" \
    -e RUN_TAG="v0-$variant" \
    -e BASE_URL="$BASE_URL" \
    -e SEED_USER_COUNT="$SEED_USERS" \
    --out "json=$RESULTS_DIR/v0-$variant-vus$vus.samples.json.gz" \
    benchmarks/k6/baseline.js

  grn "recorded $RESULTS_DIR/v0-$variant-vus$vus.json"
  info "cooling down ${COOLDOWN}s"
  sleep "$COOLDOWN"
}

for vus in $VU_LEVELS; do
  run_one "asbuilt" "$vus" "0"
  run_one "nolimit" "$vus" "1"
done

# ---- saturation probe (open model) ----------------------------------------
info "saturation probe (open model, finds the capacity wall)"
for rate in 50 200 500; do
  BENCH_BYPASS_SECURITY=1 docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    up -d --no-deps --force-recreate app
  sleep 8
  k6 run -e RATE="$rate" -e DURATION=45s -e RUN_TAG=v0-saturation \
    -e BASE_URL="$BASE_URL" benchmarks/k6/saturation.js || true
  sleep 20
done

# ---- capture server-side evidence -----------------------------------------
info "capturing pg_stat_statements + query plans"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  psql -U "${POSTGRES_USER:-bench}" -d "${POSTGRES_DB:-benchdb}" -c "
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  SELECT calls, round(total_exec_time::numeric,2) AS total_ms,
         round(mean_exec_time::numeric,2) AS mean_ms, rows, left(query, 90) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;
" > benchmarks/v0-baseline/pg_stat_statements.txt 2>&1 || true

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  psql -U "${POSTGRES_USER:-bench}" -d "${POSTGRES_DB:-benchdb}" -c "
  EXPLAIN (ANALYZE, BUFFERS) SELECT id, email, name, role, created_at, updated_at FROM users;
" > benchmarks/v0-baseline/explain-users-list.txt 2>&1 || true

grn "server-side evidence captured"

# ---- teardown --------------------------------------------------------------
info "tearing down"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down -v

grn ""
grn "Phase 0 baseline complete at commit $COMMIT_SHORT"
grn "  results:     $RESULTS_DIR/"
grn "  environment: $FINGERPRINT"
grn ""
echo "Next: node benchmarks/scripts/report.mjs   # builds the comparison table"
