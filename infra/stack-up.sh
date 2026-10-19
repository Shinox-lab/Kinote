#!/usr/bin/env bash
# pnpm stack:up: starts postgres and minio from docker-compose.yml and applies
# the migration chain from the host with `pnpm db:migrate`, connected as the
# postgres superuser (see docs/operations.md). Needs the variables listed in
# .env.example, exported or in .env (compose reads .env itself).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${POSTGRES_PASSWORD:-}" && -f .env ]]; then
  POSTGRES_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tail -n 1)
fi
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD (see .env.example)}"

# The host port postgres is published on (POSTGRES_HOST_PORT in .env, default 55543).
if [[ -z "${POSTGRES_HOST_PORT:-}" && -f .env ]]; then
  POSTGRES_HOST_PORT=$(sed -n 's/^POSTGRES_HOST_PORT=//p' .env | tail -n 1)
fi
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-55543}"

docker compose up -d --wait --wait-timeout 180 postgres minio
DATABASE_MIGRATE_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/living_wiki" \
  pnpm db:migrate
