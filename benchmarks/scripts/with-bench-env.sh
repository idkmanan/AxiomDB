#!/usr/bin/env bash
# =============================================================================
# Run a command against the BENCH stack, explicitly.
#
#   bash benchmarks/scripts/with-bench-env.sh npx drizzle-kit migrate
#   bash benchmarks/scripts/with-bench-env.sh node benchmarks/scripts/explain.mjs
#
# WHY THIS EXISTS. `npm run db:migrate` reads `DATABASE_URL` from `.env`, because
# drizzle.config.js calls `import 'dotenv/config'`. For anybody whose `.env` points at a
# real database — a Neon branch, a staging instance — that means the obvious command
# migrates the wrong database and says nothing about it. It happened: the first run of
# `npm run db:migrate && npm run db:seed:deals` created the Phase 3-5 schema in Neon and
# then failed on the bench database, which had no tables.
#
# The seeder's guard caught it (`deals table is missing`) but could not explain it, because
# the two halves of that command line disagreed about which database they meant and neither
# said so out loud. This is the same family as F-32 (a local environment differing from CI
# in a way nobody enumerated) and F-38 (the driver chosen invisibly by NODE_ENV): the
# failure is not that the value was wrong, it is that the choice was implicit.
#
# So the bench stack gets a named entry point. Every address here is a HOST-facing one,
# matching the published ports in docker-compose.bench.yml — these commands run on the
# host, not inside the compose network, so `postgres:5432` and `kafka:9092` would not
# resolve.
#
# An address already exported by the caller wins, so a one-off override is still possible
# without editing anything.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-.env.bench}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[with-bench-env] $ENV_FILE not found — copy it first: cp .env.bench.example .env.bench" >&2
  exit 1
fi

# `set -a` exports everything the file defines, which is what the compose stack reads too.
# Sourced in a subshell-safe way: this script execs the command at the end, so nothing here
# leaks into an interactive shell.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${POSTGRES_USER:=bench}"
: "${POSTGRES_DB:=benchdb}"
: "${PG_HOST_PORT:=5433}"
: "${REDIS_HOST_PORT:=6380}"
: "${KAFKA_HOST_PORT:=29092}"

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[with-bench-env] POSTGRES_PASSWORD is not set in $ENV_FILE" >&2
  exit 1
fi

# Only set what the caller has not. `DATABASE_URL` in particular: someone pointing this at a
# second bench stack should not have to edit the file.
export DATABASE_URL="${DATABASE_URL_OVERRIDE:-${BENCH_DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${PG_HOST_PORT}/${POSTGRES_DB}}}"
export REDIS_URL="${REDIS_URL_HOST:-redis://localhost:${REDIS_HOST_PORT}}"
export KAFKA_BROKERS="${KAFKA_BROKERS_HOST:-localhost:${KAFKA_HOST_PORT}}"

# Redacted, but printed: every one of these commands writes to or measures a database, and
# "which one" is the question this script exists to answer. Silence here would reintroduce
# the problem in a different shape.
printf '[with-bench-env] database: %s\n' "$(printf '%s' "$DATABASE_URL" | sed 's/:[^:@]*@/:***@/')" >&2
printf '[with-bench-env] redis:    %s\n' "$REDIS_URL" >&2
printf '[with-bench-env] kafka:    %s\n' "$KAFKA_BROKERS" >&2

if [ "$#" -eq 0 ]; then
  echo "[with-bench-env] nothing to run — pass a command, e.g. npx drizzle-kit migrate" >&2
  exit 1
fi

exec "$@"
