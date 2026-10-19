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

## Behind a reverse proxy

The api keys the sign-up and sign-in rate limit on the client IP. Behind a
proxy that IP comes from `X-Forwarded-For`, and `TRUST_PROXY` says how much of
that header to believe:

| `TRUST_PROXY` | Client IP | Use |
| --- | --- | --- |
| `false` (default) | the TCP peer; the header is ignored | no proxy in front. Behind a proxy every user shares the proxy's bucket. |
| `1`, `2`, ... (hop count) | the address that many hops from the right of the header | **recommended** behind a proxy: the number of proxies in front of the api. The api must then be reachable only through them (a direct client would count as a proxy). |
| `true` | the leftmost address | avoid: a client-supplied `X-Forwarded-For` is trusted, so a client can pick a fresh rate-limit bucket per request and evade the limit. |

The edge proxy must overwrite `X-Forwarded-For` or append the address it saw
(nginx `proxy_add_x_forwarded_for`, Caddy and most load balancers do), never
pass a client's header through unchanged as the last entry.

The edge must also not expose the collab server's internal endpoints: block
`/internal/*` on the public collab host (only the api calls them, over the
internal network: flush, replace-blocks and revoke, which closes live editing
sockets after a member, grant or group change), and never hand `INTERNAL_SECRET` to anything outside the
api and collab services. The secret is the only barrier on those paths.

## End-to-end specs

`playwright.config.ts` runs the specs in `e2e/` (Chromium; install it once with
`pnpm exec playwright install chromium`). Two ways to run them:

```sh
pnpm e2e         # compose stack (infra/e2e.sh), then playwright test
pnpm e2e:local   # no Docker: e2e/harness/local-stack.ts, stopped again afterwards
```

`pnpm e2e` exports `EMBEDDING_PROVIDER=deterministic` (the only provider
`loadConfig` accepts, passed through to the containers by docker-compose.yml) and
`AUTH_RATE_LIMIT_MAX=1000` (the specs sign up more accounts than the default 10 a
minute allows), runs `pnpm stack:up`, starts `api`, `collab` and `worker` with
`docker compose up -d --build --no-deps`, waits for them, and runs the specs;
Playwright serves the console with `vite dev` on 5173 against 8787 and 1234. The
stack stays up afterwards (`pnpm stack:down` deletes it and its data).

`pnpm e2e:local` runs the api, collab and worker in one Node process on an
in-memory PGlite database, builds the console and serves it with `vite preview`.
Ports and timings come from the environment: `E2E_API_PORT` (18787),
`E2E_COLLAB_PORT` (11234), `E2E_WEB_PORT` (15173), `E2E_WORKER_POLL_MS` (250),
`E2E_COLLAB_DEBOUNCE_MS` (300) and `E2E_COLLAB_MAX_DEBOUNCE_MS` (1000). Nothing
is left running after the run. The specs submit pages explicitly, so they do not
wait for a space's quiet window (a space setting, 10 s at least).

## Database client

`initDb({ url })` creates one pool per process. Calling it again replaces the
instance and closes the previous pool in the background. Errors on idle pool
connections (for example a database restart) are logged with their message
and SQLSTATE only, never the connection string, and do not crash the process.
