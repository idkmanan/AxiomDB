#!/usr/bin/env bash
# =============================================================================
# Production stack: the API against a managed Postgres (Neon).
# =============================================================================
# Three things were wrong here in v0 and are fixed below.
#
# 1. It waited with `sleep 5` and called the message "Waiting for Neon Local to be
#    ready" — but this stack has no local database at all, so the sleep was waiting
#    for nothing and the wait that mattered (the app becoming healthy) never
#    happened. Now it polls the container's healthcheck.
#
# 2. It ran migrations AFTER starting the app, so the app booted against a schema
#    that might not exist yet. Migrations now run first, before anything serves
#    traffic. Unlike the dev stack these do run from the host, and that is correct
#    here: the target is a managed database reachable from anywhere, not a compose
#    service hostname.
#
# 3. The container name it told you to use was wrong — `acquisition-app-prod`,
#    while docker-compose.prod.yml declares `acquisitions-app-prod`. Every command
#    it printed would have failed with "No such container".
#
# This remains a single-node convenience script. The real deployment target is the
# Kubernetes manifests in Phase 7, where migrations become an init container rather
# than a step in a shell script that someone has to remember to run.
# =============================================================================
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
APP_CONTAINER="acquisitions-app-prod"
WAIT_TIMEOUT_S="${WAIT_TIMEOUT_S:-90}"

cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
inf() { printf '  %s\n' "$*"; }

echo "Starting Acquisitions in production mode"
echo "======================================="

if [ ! -f .env.production ]; then
  red "Missing .env.production"
  inf "Required: DATABASE_URL, JWT_SECRET (>= 32 chars). Optional: CORS_ORIGIN, TRUST_PROXY."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  red "Docker is not running."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  red "Docker Compose V2 is required (the 'docker compose' plugin)."
  exit 1
fi

# Fail before building rather than after deploying. src/config/env.js throws on a
# missing or short JWT_SECRET in production, so without this check the failure
# arrives as a crash-looping container instead of a one-line message.
if ! grep -Eq '^[[:space:]]*JWT_SECRET=.{32,}' .env.production; then
  red "JWT_SECRET is missing or shorter than 32 characters in .env.production."
  inf "The app will refuse to start (src/config/env.js). Generate one with:"
  inf "  openssl rand -base64 32"
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Schema first.
# -----------------------------------------------------------------------------
grn "[1/3] Applying migrations"
npm run db:migrate

# -----------------------------------------------------------------------------
# 2. Then the application.
# -----------------------------------------------------------------------------
grn "[2/3] Building and starting the API"
docker compose -f "$COMPOSE_FILE" up --build -d

# -----------------------------------------------------------------------------
# 3. Confirm it is actually serving, rather than assuming.
# -----------------------------------------------------------------------------
grn "[3/3] Waiting for the container to report healthy"
deadline=$(($(date +%s) + WAIT_TIMEOUT_S))
while :; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null || echo 'missing')"
  case "$status" in
    healthy)
      inf "app: healthy"
      break
      ;;
    missing)
      red "Container $APP_CONTAINER not found."
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    red "App did not become healthy within ${WAIT_TIMEOUT_S}s (last status: $status)."
    inf "Logs: docker compose -f $COMPOSE_FILE logs app"
    exit 1
  fi
  sleep 2
done

echo ""
inf "API:    http://localhost:3000"
inf "Health: http://localhost:3000/health   (liveness)"
inf "Ready:  http://localhost:3000/ready    (readiness)"
echo ""
inf "Logs:   docker compose -f $COMPOSE_FILE logs -f app"
inf "Stop:   docker compose -f $COMPOSE_FILE down"
