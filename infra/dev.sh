#!/usr/bin/env bash
# pnpm dev: the whole local app in one command. Starts postgres, MinIO, the one-shot
# migration and the api, collab and worker in Docker (`docker compose up -d --build
# --wait`), then serves the console with `vite dev` (http://localhost:5173), which
# proxies /api and /collab to the stack's host ports (API_HOST_PORT / COLLAB_HOST_PORT
# in .env; defaults 8787 and 1234). Ctrl+C stops the console; the stack keeps running
# (`docker compose stop` pauses it, `pnpm stack:down` deletes it and its data).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "dev: no .env here. Copy .env.example to .env and fill in the secrets (docs/operations.md)." >&2
  exit 1
fi

docker compose up -d --build --wait --wait-timeout 180

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
api_port="$(env_value API_HOST_PORT)"
collab_port="$(env_value COLLAB_HOST_PORT)"
echo "dev: stack is up (api on :${api_port:-8787}, collab on :${collab_port:-1234}). Starting the console on http://localhost:5173"

exec pnpm --filter @living-wiki/web exec vite
