#!/usr/bin/env bash
# docker-entrypoint-initdb.d script: creates the application login role.
#
# Runs once, on first initialisation of the data directory, as POSTGRES_USER.
# The role's table and function privileges come from migration 0004_grants;
# this script only gives it LOGIN, its password and CONNECT on the database.
# The password is read from $APP_DB_PASSWORD and never stored in the repo.
set -euo pipefail

if [[ -z "${APP_DB_PASSWORD:-}" ]]; then
  echo "01-roles.sh: APP_DB_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "${POSTGRES_DB:-$POSTGRES_USER}" \
  -v app_password="$APP_DB_PASSWORD" \
  -v db_name="${POSTGRES_DB:-$POSTGRES_USER}" <<'SQL'
SELECT 'CREATE ROLE living_wiki_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'living_wiki_app')
\gexec
ALTER ROLE living_wiki_app WITH LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO living_wiki_app;
SQL
