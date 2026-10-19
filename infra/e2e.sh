#!/usr/bin/env bash
# pnpm e2e: brings up the compose stack with the deterministic embedding provider
# (postgres and minio plus the migration through `pnpm stack:up`, then api, collab
# and worker), waits until the api and collab answer, and runs `playwright test`
# against it; playwright.config.ts serves the console with `vite dev` on 5173.
# Needs the variables listed in .env.example, exported or in .env. The stack is
# left running afterwards: `pnpm stack:down` deletes it and its data.
# Port 5173 must be free (Playwright never adopts a running dev server there);
# set E2E_WEB_PORT to use another. Deployment note: never expose the collab
# server's /internal/* paths or INTERNAL_SECRET at the edge (docs/operations.md).
set -euo pipefail
cd "$(dirname "$0")/.."

# The suite signs up more accounts than the default 10 a minute allows.
export EMBEDDING_PROVIDER=deterministic
export AUTH_RATE_LIMIT_MAX="${AUTH_RATE_LIMIT_MAX:-1000}"

pnpm stack:up
docker compose up -d --build --no-deps api collab worker

# Any HTTP answer means the server is listening (a 404 from collab's root is fine).
wait_for() {
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 1
  done
  echo "e2e: $1 did not answer within 90 s" >&2
  return 1
}
wait_for http://127.0.0.1:8787/api/v1/me
wait_for http://127.0.0.1:1234/

exec pnpm exec playwright test "$@"
