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

## The app

`docker-compose.yml` (project `living-wiki`) is the whole app: postgres
(Postgres 17 + pgvector), MinIO, the one-shot `migrate`, the `api`, `collab` and
`worker` services built from the root `Dockerfile` (each runs its TypeScript
entry point with tsx), the Docling `extractor`, and the `web` console (the Vite
build served by nginx, which proxies `/api`, `/mcp` and `/collab`).

```sh
cp .env.example .env   # fill in the six secrets
docker compose up -d   # app on http://localhost:8080 (WEB_HOST_PORT)
```

This is the only app start; there is no host Vite process in the path. `pnpm
dev` is a thin wrapper that checks `.env`, builds every image, waits for the
healthchecks and prints the URL. The first `up` builds the Docling extractor
(several GB; about 2 GB RAM while it reads a file), so give it time. `pnpm web`
still serves only the console with Vite, for UI development against the stack;
`pnpm e2e` uses it as its test harness.

Host ports, all on 127.0.0.1: postgres 55543, MinIO 59000 (S3) and 59001
(console), api 8787, collab 1234, web 8080. Each can be changed in `.env`
(`POSTGRES_HOST_PORT`, `MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`,
`API_HOST_PORT`, `COLLAB_HOST_PORT`, `WEB_HOST_PORT`). Coolify does not use
these host mappings: its proxy routes the domain to the web container's port
80. API and collab stay published for `pnpm e2e` and UI dev only.

If Docker Desktop shows a port as in use although no container holds it (a
leftover forward of `com.docker.backend`), restarting Docker Desktop clears it;
until then set another host port in `.env`.

MinIO comes from `pgsty/minio`, a community build (the official `minio/minio`
image is no longer published on Docker Hub), pinned by tag and digest. It is
the bundled default; in production set `S3_ENDPOINT` to a vetted external store
if you prefer one.

Secrets have no defaults. Copy `.env.example` to `.env` (untracked) and fill
in `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `COLLAB_TOKEN_SECRET`,
`INTERNAL_SECRET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`, or export them.

```sh
pnpm stack:up                  # postgres + minio, then pnpm db:migrate from the host
TEST_DATABASE_URL=postgres://living_wiki_app:$APP_DB_PASSWORD@127.0.0.1:55543/living_wiki \
TEST_DATABASE_MIGRATE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:55543/living_wiki \
  pnpm test:pg                 # real-Postgres RLS and job-claim tests
S3_ENDPOINT=http://127.0.0.1:59000 pnpm vitest run packages/shared/test/objectStorage.test.ts
docker compose up -d            # the whole app; migrate runs before the services
pnpm stack:down                # docker compose down -v: containers and data volumes are deleted
```

`pnpm test:pg` fails with a message naming `TEST_DATABASE_URL` and
`TEST_DATABASE_MIGRATE_URL` when either is unset, so a run that would have
skipped every real-Postgres test never reports success.

Database and object data live in the named volumes `living-wiki_pgdata` and
`living-wiki_miniodata`: they survive `docker compose restart`, `stop`/`start`
and a plain `docker compose down`; `docker compose down -v` (`pnpm stack:down`)
deletes them.

## Coolify (Docker Compose)

The root `docker-compose.yml` is the deployment; no Coolify-specific compose
override is needed.

1. Create a Docker Compose resource from this repository, compose path
   `docker-compose.yml`, branch `main`.
2. In Environment Variables set `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`,
   `COLLAB_TOKEN_SECRET`, `INTERNAL_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
   (the two token secrets need at least 32 random characters), and
   `TRUST_PROXY=2` (Coolify's proxy plus the web nginx). Do not set
   `DATABASE_URL` or `DATABASE_MIGRATE_URL`; the compose builds the internal
   ones. Set `S3_ENDPOINT` only for an external object store; otherwise the
   bundled MinIO is used. `AUTH_RATE_LIMIT_MAX`, `MAX_UPLOAD_BYTES` and the
   extractor settings can stay at their defaults.
3. Add the public domain to the **web** service with internal port **80**
   (Coolify can also generate one from `SERVICE_URL_WEB_80`). Do not add domains
   for `api`, `collab`, `postgres` or `minio`, and do not publish their ports.
4. Deploy. The first build includes the extractor (several GB; about 2 GB RAM
   while it reads a file). `migrate` runs once; `web` starts after the api and
   collab are healthy. Open the domain.

The browser reaches the api, MCP and the editing WebSocket through the web
nginx on one origin, so there is no CORS or second domain. The web blocks
`/collab/internal/*`; never publish `INTERNAL_SECRET`.

Data lives in the named volumes `living-wiki_pgdata` and
`living-wiki_miniodata` (or your external S3). A deploy keeps them; `docker
compose down -v` deletes them. Back them up like any database. Upgrade with
`docker compose up -d --build`; the migration is idempotent.

The compose publishes the internal services on 127.0.0.1 for local tools and
the e2e suite; Coolify routes only the web domain to container port 80. For a
hard split, remove the `ports:` entries from `postgres`, `minio`, `api` and
`collab`; the web does not need them.

## Model providers

The index is fixed at **2560 dimensions**. There is no `EMBEDDING_DIMENSIONS`
setting in this release: `chunks.embedding` and `embedding_cache.embedding`
are both `halfvec(2560)`.

Set `EMBEDDING_PROVIDER=openai` with an OpenAI-compatible embeddings server:

```sh
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://your-host/v1
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
# Optional Qwen query-side instruction:
EMBEDDING_QUERY_INSTRUCTION=Given a wiki search query, retrieve relevant passages that answer the query
```

Set `ASK_PROVIDER=openai` for a generated answer from an OpenAI-compatible
chat server:

```sh
ASK_PROVIDER=openai
ASK_BASE_URL=https://your-host/v1
ASK_API_KEY=...
ASK_MODEL=...
```

Each base URL ends at the API root: the embedding client appends
`/embeddings`, the Ask client appends `/chat/completions`. The two providers
may use different hosts. A key is optional for a local endpoint without auth.
`EMBEDDING_BATCH_SIZE` (default 64), `EMBEDDING_TIMEOUT_MS` (30000),
`ASK_TIMEOUT_MS` (60000) and `ASK_MAX_TOKENS` (800) are the other bounds.

The routing model is set the same way with `ROUTER_PROVIDER=openai`,
`ROUTER_BASE_URL`, `ROUTER_API_KEY` and `ROUTER_MODEL` (bounds
`ROUTER_TIMEOUT_MS`, 60000, and `ROUTER_MAX_TOKENS`, 2000). It must support
`response_format: {"type": "json_object"}`. After a page or file is indexed it
writes the page's card and extracts the entity graph; a failure retries as a job
and never changes the version's status.

Migration `0022` queues cards and entity extraction once for everything already
indexed, using whichever router model the workers have when they pick the jobs
up. Configure `ROUTER_PROVIDER=openai` before upgrading, and roll the workers to
this release before or together with the api. Whenever the router model is set
or changed later, rebuild with the schema owner's connection:

```sh
DATABASE_MIGRATE_URL=postgres://postgres:...@host/living_wiki pnpm placement:rebuild
```

It only queues `version.card` and `version.entities` jobs (the same keys
indexing uses, so nothing is duplicated); the workers do the work.

Before a routing model files real captures, score it on the labelled set:

```sh
ROUTER_PROVIDER=openai ROUTER_BASE_URL=... ROUTER_MODEL=... \
EMBEDDING_PROVIDER=openai EMBEDDING_BASE_URL=... EMBEDDING_MODEL=... pnpm routing:eval
```

It seeds `packages/core/eval/routing/corpus.json` into a throwaway in-process
database, plans every capture in `captures.json` without changing anything,
and prints how many facts landed on the expected page and operation. It exits
non-zero below 90% or on any removal that would apply without a person (R2).
Add a labelled capture whenever routing gets something wrong in use.

**Data egress:** indexing sends each chunk's text to the embedding endpoint,
and Ask sends the question plus the retrieved passages to the chat endpoint;
the routing model receives indexed page text and chunk text.
Use a self-hosted or approved provider for sensitive wiki content.

The local stack and `pnpm e2e` keep `deterministic` for both providers, so no
network credentials are needed for tests.

### The 2560 migration

Migrations `0016`–`0018` drop the old HNSW index, truncate the derived
`chunks` and `embedding_cache`, change both columns to `halfvec(2560)`,
recreate the index, mark every indexed version `indexing`, and enqueue one
`version.index` job for it. Pages, files, versions and audit history are kept;
search is empty for a document until its reindex job completes. **Configure
the final embedding provider before the migrate service runs**, or the index
will be rebuilt with the deterministic provider. Changing the model after
that requires rebuilding the derived index again; this release has no
automatic model-switch command.

This migration is a maintenance window, not an online migration. Stop the old
writers first, then let the one-shot `migrate` service finish before the new
api and worker start:

```sh
docker compose stop api worker
docker compose up -d --build
```

The migration locks `versions` before the chunks table, the same order an
index job uses, so an in-flight writer cannot deadlock it. The worker—not the
one-shot `migrate` service—drains the reindex jobs. Do not run an old 1536
api or worker during the window.

Search and Ask make a synchronous query-embedding call. If it fails, both
return `503 search_unavailable`. If the Ask model itself fails, Ask returns
`503 llm_unavailable`; there is no extractive fallback. Search results remain
available beside the error.

The real Qwen endpoint and chat model need the deployment's own base URLs,
model IDs and keys. The fake-HTTP provider tests cover request shape,
batching, dimensions, timeouts and error mapping; the deployment live check
is a paraphrase search plus an Ask answer with the passage citation.

## Behind a reverse proxy

The api keys the sign-up and sign-in rate limit on the client IP. Behind a
proxy that IP comes from `X-Forwarded-For`, and `TRUST_PROXY` says how much of
that header to believe:

| `TRUST_PROXY` | Client IP | Use |
| --- | --- | --- |
| `false` (default) | the TCP peer; the header is ignored | no proxy in front. Behind a proxy every user shares the proxy's bucket. |
| `1`, `2`, ... (hop count) | the address that many hops from the right of the header | **recommended** behind a single proxy: the number of proxies in front of the api. The api must then be reachable only through them (a direct client would count as a proxy). |
| `true` | the leftmost address | avoid: a client-supplied `X-Forwarded-For` is trusted, so a client can pick a fresh rate-limit bucket per request and evade the limit. |

The edge proxy must overwrite `X-Forwarded-For` or append the address it saw
(nginx `proxy_add_x_forwarded_for`, Caddy and most load balancers do), never
pass a client's header through unchanged as the last entry.

Behind Coolify there are two proxies — Coolify's own proxy and the web nginx —
so set `TRUST_PROXY=2` there. Locally the web is reached directly on 8080, so
`false` is right unless another proxy is in front. Only count proxies that
append to the header; the web nginx does.

The edge must also not expose the collab server's internal endpoints: block
`/internal/*` on the public collab host (only the api calls them, over the
internal network: flush, replace-blocks and revoke, which closes live editing
sockets after a member, grant or group change), and never hand `INTERNAL_SECRET` to anything outside the
api and collab services. The web nginx blocks `/collab/internal/*`; the collab
service has no public host port. The secret is the only barrier on those paths.

## End-to-end specs

`playwright.config.ts` runs the specs in `e2e/` (Chromium; install it once with
`pnpm exec playwright install chromium`). Two ways to run them:

```sh
pnpm e2e         # compose stack (infra/e2e.sh), then playwright test
pnpm e2e:local   # no Docker: e2e/harness/local-stack.ts, stopped again afterwards
```

`pnpm e2e` exports `EMBEDDING_PROVIDER=deterministic` and
`ASK_PROVIDER=deterministic` (passed through to the containers by
docker-compose.yml), `AUTH_RATE_LIMIT_MAX=1000` (the specs sign up more accounts
than the default 10 a minute allows) and `EXTRACTOR_MODE=fake` (the suite's files
carry a `FAKE-EXTRACT` line), runs `pnpm stack:up`, starts `api`, `collab` and `worker`
with `docker compose up -d --build --no-deps`, waits for them, and runs the
specs; Playwright serves the console with `vite dev` on 5173 against 8787 and
1234. This is the one place Vite serves the console; the production app is the
web service. The stack stays up afterwards (`pnpm stack:down` deletes it and its
data). Port 5173 must be free: Playwright never adopts a dev server already
running there (it could proxy to another stack); `E2E_WEB_PORT=<port> pnpm e2e`
uses another.

`pnpm e2e:local` runs the api, collab and worker in one Node process on an
in-memory PGlite database, builds the console and serves it with `vite preview`.
Ports and timings come from the environment: `E2E_API_PORT` (18787),
`E2E_COLLAB_PORT` (11234), `E2E_WEB_PORT` (15173), `E2E_WORKER_POLL_MS` (250),
`E2E_COLLAB_DEBOUNCE_MS` (300) and `E2E_COLLAB_MAX_DEBOUNCE_MS` (1000). Nothing
is left running after the run. The specs submit pages explicitly, so they do not
wait for a space's quiet window (a space setting, 10 s at least).

## Files

Uploads are limited by `MAX_UPLOAD_BYTES` (default 50 MB). The worker reads TXT, MD and CSV itself; PDF, Office files and
images go to the extractor service. The compose stack includes the Docling extractor and `EXTRACTOR_MODE=http` is the
default, with `EXTRACTOR_URL=http://extractor:8000`. `off` is a deliberate text/CSV-only run; `fake` is for tests. If the
extractor is stopped (or set off), a file that needs it waits and fails with a plain sentence after its retries, and
**Retry** recovers it once the extractor is up. `EXTRACTOR_TIMEOUT_MS` (default 240 s, at most 270 s) stays below the
worker's 300 s job lease. Extracted text above `MAX_EXTRACTED_CHARS` fails the file with a sentence; it is never
truncated. The api and worker create the S3 bucket at start when it is missing.

The extractor (Docling, `apps/extractor`) is part of `docker compose up -d`; its models are baked into the image at build
time, so the first build downloads several gigabytes. It needs about 2 GB of memory while it reads a file (about 1 GB at
rest) and a 5 GB image; see `docs/live-checks/2026-10-slice-2-live-check.md` for measured numbers.

The console's viewers (Markdown, DOCX, XLSX, PDF) load on demand. `pnpm web:build && pnpm bundle:report` prints the
size of every chunk and fails if a viewer library is in the entry chunk (set `BUNDLE_BASELINE_KB` to also guard its size).

The XLSX preview uses `@extend-ai/react-xlsx` 0.18.1 (MIT). It is still a lazy chunk, but a cold first open downloads
about 2.3 MB gzip (viewer JS, the Duke WASM, the worker and a font fallback) before the workbook. The web nginx must
gzip `.js`, `.mjs`, `.css` and `.wasm` and serve `.wasm` as `application/wasm`; without that the WASM is 4.4 MB instead
of 1.66 MB. The preview is capped at the existing 25 MB `PREVIEW_LIMIT_BYTES`; a larger file is a download card and its
bytes are never fetched. A corrupt or timed-out workbook also falls back to the download card. The DOM renderer is the
accessibility choice: a 10k × 20 workbook is about 1.6 s and 33 MB JS heap on the benchmark machine, and a 50k × 20
workbook about 6.5 s and 120 MB. The 25 MB cap bounds the input; it is not a hard heap cap.

The extractor shares an internal network with the worker only: no internet, no database, no object storage. The worker
sends the bytes and gets text back. With the extractor stopped, TXT, MD and CSV still work, audio and video are stored
for download, and other files wait for it and fail with a plain sentence after their retries (Retry recovers them).
`EXTRACTOR_MODE=fake` (tests, `pnpm e2e` and `pnpm e2e:local`) reads the text a test file carries after a
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
