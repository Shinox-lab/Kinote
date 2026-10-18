# Operations

## Database roles

Two roles, two connection strings:

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `living_wiki_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS | api, collab, worker at runtime |
| `DATABASE_MIGRATE_URL` | the schema owner: a superuser, or a role with BYPASSRLS | `pnpm db:migrate` only |

`DATABASE_MIGRATE_URL` must be a superuser or a BYPASSRLS role. Row-level
security is enabled and FORCED on every tenant table (and on `tenants`), so it
applies to the table owner too; the migration chain creates those tables and
policies, and the SECURITY DEFINER functions `my_tenants` and
`tenants_with_due_jobs` run as the migration owner and must read across
tenants. A migration owner without BYPASSRLS would make those functions return
nothing. Never run a service with this URL.

`DATABASE_URL` is always `living_wiki_app`. It is created by
`infra/postgres/01-roles.sh` (baked into the postgres image by
`infra/postgres/Dockerfile`) on first initialisation of the data directory,
with the password from `APP_DB_PASSWORD`. The script is idempotent: re-running
it resets the role to LOGIN, NOSUPERUSER, NOBYPASSRLS and the current
password. If the migrations run first, `0004_grants` creates the role NOLOGIN;
run the script afterwards to give it a login. `packages/db/test/rls.pg.test.ts`
asserts the role has neither superuser nor BYPASSRLS and that every policy
compares the tenant column with `current_tenant_id()`.

## Local stack

`docker-compose.yml` (project `living-wiki`) runs postgres (Postgres 17 +
pgvector), MinIO, a one-shot `migrate`, and the `api`, `collab` and `worker`
services built from the root `Dockerfile` (one build; each service runs its
TypeScript entry point with tsx). Host ports, all on 127.0.0.1: postgres
55543, MinIO 59000 (S3) and 59001 (console), api 8787, collab 1234.

Secrets have no defaults. Copy `.env.example` to `.env` (untracked) and fill
in `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `COLLAB_TOKEN_SECRET`,
`INTERNAL_SECRET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`, or export them.

```sh
pnpm stack:up                  # postgres + minio, then pnpm db:migrate from the host
TEST_DATABASE_URL=postgres://living_wiki_app:$APP_DB_PASSWORD@127.0.0.1:55543/living_wiki \
TEST_DATABASE_MIGRATE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:55543/living_wiki \
  pnpm test:pg                 # real-Postgres RLS and job-claim tests
S3_ENDPOINT=http://127.0.0.1:59000 pnpm vitest run packages/shared/test/objectStorage.test.ts
docker compose up -d --build   # the whole stack (migrate runs before the services)
pnpm stack:down                # docker compose down -v: containers and data are deleted
```

Database and object data live in anonymous volumes: they survive
`docker compose restart` and `stop`/`start`, and `down -v` deletes them.

## Database client

`initDb({ url })` creates one pool per process. Calling it again replaces the
instance and closes the previous pool in the background. Errors on idle pool
connections (for example a database restart) are logged with their message
and SQLSTATE only, never the connection string, and do not crash the process.
