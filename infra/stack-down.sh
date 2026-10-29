#!/usr/bin/env bash
# pnpm stack:down: stops the kinote compose project and deletes its
# containers, network and volumes (named pgdata/miniodata: all local data). Compose parses
# the whole file even to tear down, so unset required variables get inert
# placeholders here; nothing is started with them.
set -euo pipefail
cd "$(dirname "$0")/.."
for v in POSTGRES_PASSWORD APP_DB_PASSWORD COLLAB_TOKEN_SECRET INTERNAL_SECRET S3_ACCESS_KEY S3_SECRET_KEY; do
  if [[ -z "${!v:-}" ]] && ! grep -qs "^${v}=." .env; then export "$v=unused-for-teardown"; fi
done
docker compose down -v --remove-orphans
