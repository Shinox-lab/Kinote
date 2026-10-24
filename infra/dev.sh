#!/usr/bin/env bash
# pnpm dev: the whole app with docker compose, the same start as production.
# The console is served by the web service at http://localhost:${WEB_HOST_PORT:-8080}.
# The first build also builds the Docling extractor (several GB, ~2 GB RAM while
# it reads a file). `docker compose up -d` is the same start without the
# convenience checks below.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "dev: no .env here. Copy .env.example to .env and fill in the secrets (docs/operations.md)." >&2
  exit 1
fi

docker compose up -d --build --wait --wait-timeout 1800

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
web_port="$(env_value WEB_HOST_PORT)"
echo "dev: app on http://localhost:${web_port:-8080}"
