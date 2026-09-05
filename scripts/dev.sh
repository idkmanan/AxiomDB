#!/usr/bin/env bash
# =============================================================================
# Development stack: Postgres + API, with migrations applied in the right order.
# =============================================================================
# FINDING F-09, and it turned out to be worse than first recorded.
#
# v0 scripts/dev.sh:39 ran `npm run db:migrate` from the HOST, while
# `docker compose up` was at line 48. So migrations were applied before the
# database container existed. On a machine with a warm volume it worked; on a
# clean clone it raced and failed — the worst version of a bug, because it works
# for the author and not for anyone who forks the repo.
#
# Fixing the ordering alone would not have been enough. `.env.development:11` set
#
#   DATABASE_URL=postgres://neon:npg@postgres:5432/neondb?sslmode=disable
#
# where `postgres` is the compose SERVICE hostname. That name does not resolve on
# the host, so a host-side migration could not reach the dev database at any point
# in the sequence:
#
#   $ getent hosts postgres
#   (no output — not resolvable from the host)
#
# And `drizzle.config.js:1` loads plain `dotenv/config`, which reads `.env` — not
# `.env.development` — so which URL a host-side migration actually used depended on
# an untracked file that may not exist at all.
#
# So migrations run INSIDE a one-shot container on the compose network, where the
# service hostname resolves and DATABASE_URL is supplied by compose rather than by
# whatever `.env` happens to contain. That is also the direction Phase 7 goes with
# migrations as a Kubernetes init container, so it is the same shape twice rather
# than two different mechanisms.
# =============================================================================
set -euo pipefail

COMPOSE_FILE="docker-compose.dev.yml"
PG_CONTAINER="acquisitions-postgres-dev"
WAIT_TIMEOUT_S="${WAIT_TIMEOUT_S:-90}"

cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
inf() { printf '  %s\n' "$*"; }

echo "Starting Acquisitions in development mode"
echo "========================================="

if [ ! -f .env.development ]; then
  red "Missing .env.development"
  inf "Copy .env.example to .env.development and fill it in."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  red "Docker is not running."
  exit 1
fi

# Compose V2 specifically. V1 silently ignores several keys this project relies on
# — see docker-compose.bench.yml for the resource-limit case, which would have
# invalidated every benchmark — so it is checked rather than assumed.
if ! docker compose version >/dev/null 2>&1; then
  red "Docker Compose V2 is required (the 'docker compose' plugin, not 'docker-compose')."
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Database first, on its own.
# -----------------------------------------------------------------------------
grn "[1/4] Starting Postgres"
docker compose -f "$COMPOSE_FILE" up -d postgres

# -----------------------------------------------------------------------------
# 2. Wait for it to be genuinely ready.
#
# Polling the container's healthcheck rather than `sleep 5` (which is what
# scripts/prod.sh:32 still did). A fixed sleep is a guess that is simultaneously
# too long on a fast machine and too short on a cold one — and when it is too
# short, the failure presents as a migration bug.
# -----------------------------------------------------------------------------
grn "[2/4] Waiting for Postgres to report healthy"
deadline=$(($(date +%s) + WAIT_TIMEOUT_S))
while :; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo 'missing')"
  case "$status" in
    healthy)
      inf "postgres: healthy"
      break
      ;;
    missing)
      red "Container $PG_CONTAINER not found."
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    red "Postgres did not become healthy within ${WAIT_TIMEOUT_S}s (last status: $status)."
    inf "Logs: docker compose -f $COMPOSE_FILE logs postgres"
    exit 1
  fi
  sleep 2
done

# -----------------------------------------------------------------------------
# 3. Migrate from inside the network.
#
# `--no-deps` so this does not start the app service, `--rm` so it leaves nothing
# behind. DATABASE_URL comes from the app service's `environment:` block in the
# compose file, which overrides env_file — the same pattern
# docker-compose.bench.yml already uses for exactly this reason.
# -----------------------------------------------------------------------------
grn "[3/4] Applying migrations (inside the compose network)"
docker compose -f "$COMPOSE_FILE" run --rm --no-deps app npm run db:migrate

# -----------------------------------------------------------------------------
# 4. Application, attached, so Ctrl-C reaches it.
#
# Ctrl-C sends SIGINT, which src/server.js handles through the same drain path as
# SIGTERM. So stopping the dev server exercises the graceful-shutdown code every
# time, rather than that code first running during a production deploy.
# -----------------------------------------------------------------------------
grn "[4/4] Starting the API"
inf "API:      http://localhost:3000"
inf "Health:   http://localhost:3000/health   (liveness)"
inf "Ready:    http://localhost:3000/ready    (readiness — checks Postgres)"
inf "Postgres: postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@localhost:5432/\${POSTGRES_DB}"
echo ""
docker compose -f "$COMPOSE_FILE" up --build app

echo ""
inf "Stopped. Tear down with: docker compose -f $COMPOSE_FILE down -v"
