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
55543, MinIO 59000 (S3) and 59001 (console), api 8787, collab 1234. Each can be
changed in `.env` (`POSTGRES_HOST_PORT`, `MINIO_HOST_PORT`,
`MINIO_CONSOLE_HOST_PORT`, `API_HOST_PORT`, `COLLAB_HOST_PORT`) when a default
is taken on your machine; `pnpm dev`, `pnpm web` and `pnpm e2e` follow them.

To run the whole app, fill in `.env` and run `pnpm dev`: it starts the Docker
stack and then the console at http://localhost:5173.

If Docker Desktop shows a port as in use although no container holds it (a
leftover forward of `com.docker.backend`), restarting Docker Desktop clears it;
until then set another host port in `.env`.

MinIO comes from `pgsty/minio`, a community build (the official `minio/minio`
image is no longer published on Docker Hub), pinned by tag and digest. It is
for this development stack only: use a vetted object store in production.

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
pnpm stack:down                # docker compose down -v: containers and data volumes are deleted
```

`pnpm test:pg` fails with a message naming `TEST_DATABASE_URL` and
`TEST_DATABASE_MIGRATE_URL` when either is unset, so a run that would have
skipped every real-Postgres test never reports success.

Database and object data live in the named volumes `living-wiki_pgdata` and
`living-wiki_miniodata`: they survive `docker compose restart`, `stop`/`start`
and a plain `docker compose down`; `docker compose down -v` (`pnpm stack:down`)
deletes them.

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
stack stays up afterwards (`pnpm stack:down` deletes it and its data). Port 5173
must be free: Playwright never adopts a dev server already running there (it
could proxy to another stack); `E2E_WEB_PORT=<port> pnpm e2e` uses another.

`pnpm e2e:local` runs the api, collab and worker in one Node process on an
in-memory PGlite database, builds the console and serves it with `vite preview`.
Ports and timings come from the environment: `E2E_API_PORT` (18787),
`E2E_COLLAB_PORT` (11234), `E2E_WEB_PORT` (15173), `E2E_WORKER_POLL_MS` (250),
`E2E_COLLAB_DEBOUNCE_MS` (300) and `E2E_COLLAB_MAX_DEBOUNCE_MS` (1000). Nothing
is left running after the run. The specs submit pages explicitly, so they do not
wait for a space's quiet window (a space setting, 10 s at least).

## Files

Uploads are limited by `MAX_UPLOAD_BYTES` (default 50 MB). The worker reads TXT, MD and CSV itself; PDF, Office files and
images go to the extractor service. `EXTRACTOR_MODE` is `off` by default: a file that needs the extractor then waits and
fails with a plain sentence after its retries, and **Retry** recovers it once the extractor is up. `EXTRACTOR_MODE=http`
with `EXTRACTOR_URL` points the worker at the Docling service (compose profile `extractor`). `EXTRACTOR_TIMEOUT_MS`
(default 240 s, at most 270 s) stays below the worker's 300 s job lease. Extracted text above `MAX_EXTRACTED_CHARS`
fails the file with a sentence; it is never truncated. The api and worker create the S3 bucket at start when it is missing.

To read PDFs, Office files and images, start the extractor (Docling, `apps/extractor`; its models are baked into the
image at build time, so the first build downloads several gigabytes) and point the worker at it:

```sh
EXTRACTOR_MODE=http docker compose --profile extractor up -d --build extractor worker
```

`EXTRACTOR=1 pnpm dev` does the same for the local app (stack and console in one command; off by default). It needs about
2 GB of memory for the extractor while it reads a file (about 1 GB at rest) and a 5 GB image; see
`docs/live-checks/2026-10-slice-2-live-check.md` for measured numbers.

The console's viewers (Markdown, DOCX, XLSX, PDF) load on demand. `pnpm web:build && pnpm bundle:report` prints the
size of every chunk and fails if a viewer library is in the entry chunk (set `BUNDLE_BASELINE_KB` to also guard its size).

The extractor shares an internal network with the worker only: no internet, no database, no object storage. The worker
sends the bytes and gets text back. Without the profile everything still works for TXT, MD and CSV, audio and video are
stored for download, and other files wait for the extractor and fail with a plain sentence after their retries (Retry
recovers them). `EXTRACTOR_MODE=fake` (tests and `pnpm e2e:local`) reads the text a test file carries after a
`FAKE-EXTRACT` line instead.

## Sources (the upload API)

A *source* lets a script keep files in a space without a person in the loop. A tenant owner or admin creates one
(`POST /api/v1/sources`: a name and one target space, never the Inbox), then issues it a token
(`POST /api/v1/sources/:id/tokens`). The token is shown **once**, in that reply; only its hash is stored. Anyone who
holds it can send files into that one space as "System · {source name}" and nothing else: it opens no other route.

```sh
API=https://wiki.example.com
TOKEN=lwsrc_...            # from the reply of POST /api/v1/sources/:id/tokens

# Create or replace a file. The external id is yours (1 to 256 characters). A slash may be sent as it is
# or as %2F; characters such as ? and # must be URL-encoded.
curl -X PUT -H "Authorization: Bearer $TOKEN" -F "file=@report.pdf" "$API/api/v1/source/files/reports/2026-q3"

# Remove it. It leaves search at once.
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$API/api/v1/source/files/reports/2026-q3"
```

- **Sending the same bytes again** does nothing (`200`, `"unchanged": true`). Different bytes add a new version; the
  old one keeps answering until the new one is read and, where review applies, approved.
- **Review.** A source's files wait for a reviewer unless the source is **trusted** (`PATCH /api/v1/sources/:id` with
  `"trusted": true`). A trusted source still waits for review in a space that requires it. The switch applies to files
  read from then on; a file already waiting stays waiting.
- **Removed at source.** After a `DELETE` the file is withdrawn and stays listed with "Removed at source" until an editor
  dismisses it (`POST /api/v1/files/:id/dismiss-removal`, which archives it). A file someone moved by hand stays where
  they put it, withdrawn, and is archived like any file; if a person uploads a corrected copy of such a file they take it
  over (it is no longer marked removed). Sending the id again brings the file back as a new version.
- **A file a person archived on purpose** is not touched by a `PUT`: the script gets `409` until the file is restored.
- **Pausing** a source (`"status": "paused"`) makes every one of its tokens answer `401` until it is resumed. A source
  is never deleted.
- **Rotating a token:** issue a new token, switch the script to it, then revoke the old one
  (`DELETE /api/v1/sources/:id/tokens/:tokenId`). Tokens can carry an expiry (`expires_in_days`); by default they do not
  expire. A revoked, expired or paused source's token, a token for another organisation and a malformed token all get the
  same `401`, so a failed call says nothing about why.

## Database client

`initDb({ url })` creates one pool per process. Calling it again replaces the
instance and closes the previous pool in the background. Errors on idle pool
connections (for example a database restart) are logged with their message
and SQLSTATE only, never the connection string, and do not crash the process.
