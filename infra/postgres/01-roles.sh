#!/usr/bin/env bash
# docker-entrypoint-initdb.d script: creates the application login role.
#
# Runs once, on first initialisation of the data directory, as POSTGRES_USER.
# The role's table and function privileges come from migration 0004_grants;
# this script only gives it LOGIN, its password and CONNECT on the database.
# The password is read from $APP_DB_PASSWORD and never stored in the repo.
#
# Idempotent: when kinote_app already exists (re-run by hand, or created
# NOLOGIN by 0004_grants before this script ran) it is reset to LOGIN,
# NOSUPERUSER, NOBYPASSRLS with the current password, so it can never keep a
# privilege that would bypass row-level security.
#
# The password reaches psql through `\getenv` (psql 15+) rather than a `-v`
# argument, so it never appears in the process list.
set -euo pipefail

if [[ -z "${APP_DB_PASSWORD:-}" ]]; then
  echo "01-roles.sh: APP_DB_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "${POSTGRES_DB:-$POSTGRES_USER}" \
  -v db_name="${POSTGRES_DB:-$POSTGRES_USER}" <<'SQL'
\getenv app_password APP_DB_PASSWORD
SELECT 'CREATE ROLE kinote_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kinote_app')
\gexec
ALTER ROLE kinote_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db_name" TO kinote_app;
SQL
