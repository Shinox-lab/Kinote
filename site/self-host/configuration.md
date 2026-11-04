# Configuration

All settings live in `.env` at the root of the repository. `.env.example` lists them with comments; this page groups
them the same way. After a change, run `docker compose up -d` again to apply it.

## Postgres

| Setting | Default | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | *(required)* | Password of the database's administrator. |
| `APP_DB_PASSWORD` | *(required)* | Password of `kinote_app`, the restricted user the app runs as. |
| `DATABASE_URL` | built by Compose | The app's connection. Always the `kinote_app` user. Set it only when you run the services outside Compose. |
| `DATABASE_MIGRATE_URL` | built by Compose | Used only to set up and upgrade the database. Must be an administrator. Never give it to a running service. |
| `TEST_DATABASE_URL`, `TEST_DATABASE_MIGRATE_URL` | empty | Only for the database test suite. See [Development](../contributing/development). |

## Secrets

| Setting | Default | What it does |
|---|---|---|
| `COLLAB_TOKEN_SECRET` | *(required)* | Signs live-editing tokens. At least 32 random characters. |
| `INTERNAL_SECRET` | *(required)* | Protects calls between the app's own services. At least 32 random characters. Never expose it. |

## Services

| Setting | Default | What it does |
|---|---|---|
| `WEB_HOST_PORT` | `8081` | Where the app is published on your machine. |
| `POSTGRES_HOST_PORT`, `MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT` | `55543`, `59000`, `59001` | Ports for local tools. |
| `API_HOST_PORT`, `COLLAB_HOST_PORT`, `GRIDCRAFT_HOST_PORT` | `8787`, `1234`, `8082` | Used by the test suites and UI development only. |
| `TRUST_PROXY` | `1` | How many proxies sit in front of the API, counting Kinote's own web service. Set `2` behind one more proxy, such as Coolify. See [Ports and reverse proxies](./proxy). |
| `COLLAB_MAX_MESSAGE_BYTES` | `8388608` (8 MiB) | The largest single message a live-editing client may send, at most 64 MiB. A bigger one disconnects that client. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Sign-up and sign-in attempts allowed per minute from one address. Separately, five failed sign-ins to one account within 15 minutes lock that account for a minute, then longer each time, up to 15 minutes. |
| `ASK_RATE_LIMIT_PER_MIN` | `10` | Questions one person may Ask per minute. |
| `SEARCH_RATE_LIMIT_PER_MIN` | `60` | Searches one person may run per minute. |
| `CAPTURE_RATE_LIMIT_PER_MIN` | `20` | Captures one person may send per minute. |
| `UPLOAD_RATE_LIMIT_PER_MIN` | `30` | Files one person, or one source token, may upload per minute. |
| `SIGNUP_MODE` | `auto` | Who may create an account. `auto`: anyone until the first account exists, then only someone with an invitation link. `open`: anyone. `invite`: only from an invitation link. `closed`: no new accounts. An account made from an invitation always uses the invited email. |
| `MAX_TENANTS_PER_USER` | `5` | Workspaces one person may own. Creating workspaces is also limited to 5 an hour. |
| `TENANT_DAILY_AI_ACTIONS` | `2000` | AI actions one workspace may use per UTC day: each Ask, and each capture routed or placed, page card or entity extraction. Search and indexing aren't counted. Past it, Ask and new captures are refused until midnight UTC and background AI work waits. `0` turns it off. |
| `LOG_LEVEL` | `info` | How much the API logs: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. At `debug` or `trace`, collab also logs each live-editing connection. |

Every host port is bound to `127.0.0.1` only.

## Models

Kinote uses three kinds of model, each set separately. Every one can point at any OpenAI-compatible server, and they
can use different providers.

| Group | Used for | Provider setting |
|---|---|---|
| **Embeddings** | Search and Ask: turning text into vectors | `EMBEDDING_PROVIDER` |
| **Ask** | Writing answers with citations | `ASK_PROVIDER` |
| **Routing** | Filing captures, and the summaries and links it uses to do so | `ROUTER_PROVIDER` |

Each provider setting is either `openai` (any OpenAI-compatible server) or `deterministic`.

**`deterministic` is for tests.** It needs no network or key and gives the same output every time, but it doesn't
understand language: search becomes rough, Ask quotes passages instead of answering, and routing can't file
anything sensibly. The background worker refuses to start with deterministic routing while embeddings or Ask use a
real model.

| Setting | Default | What it does |
|---|---|---|
| `EMBEDDING_BASE_URL`, `ASK_BASE_URL`, `ROUTER_BASE_URL` | empty | The server's API root, ending at `/v1` or similar. Kinote adds `/embeddings` or `/chat/completions`. |
| `EMBEDDING_API_KEY`, `ASK_API_KEY`, `ROUTER_API_KEY` | empty | The key, if the server needs one. |
| `EMBEDDING_MODEL`, `ASK_MODEL`, `ROUTER_MODEL` | empty | The model's id on that server. |
| `EMBEDDING_BATCH_SIZE` | `64` | Texts per embeddings request. |
| `EMBEDDING_TIMEOUT_MS` | `30000` | How long to wait for an embeddings request. |
| `EMBEDDING_QUERY_INSTRUCTION` | empty | An instruction added to search queries, for models that use one (such as Qwen3 embeddings). |
| `ASK_TIMEOUT_MS`, `ASK_MAX_TOKENS` | `60000`, `800` | Limits for answers. |
| `ROUTER_TIMEOUT_MS`, `ROUTER_MAX_TOKENS` | `60000`, `2000` | Limits for routing. |
| `ROUTER_REASONING` | empty | Set to `off` to ask a reasoning model not to think first, so its thinking doesn't use up `ROUTER_MAX_TOKENS`. |

Kinote's search index holds **2560-dimensional** vectors, and Kinote asks the embeddings server for that size (the
`dimensions` request option). Pick a model that can return 2560 dimensions, such as `Qwen/Qwen3-Embedding-8B`; a server
that returns another size is refused with an error. The routing
model must be able to answer in JSON (`response_format: {"type": "json_object"}`).

::: tip Choose your embeddings model before the first start
The search index is built with whichever embeddings model is configured when it's first filled. Switching models later
means rebuilding the index.
:::

### Example: OpenRouter

```sh
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_API_KEY=<your-key>
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B

ASK_PROVIDER=openai
ASK_BASE_URL=https://openrouter.ai/api/v1
ASK_API_KEY=<your-key>
ASK_MODEL=<a chat model id>

ROUTER_PROVIDER=openai
ROUTER_BASE_URL=https://openrouter.ai/api/v1
ROUTER_API_KEY=<your-key>
ROUTER_MODEL=<a chat model id that supports JSON output>
ROUTER_REASONING=off
```

::: warning Your text goes to the model provider
Indexing sends page and file text to the embeddings server, Ask sends the question and the passages it found to the
chat server, and routing sends page text to the routing model. For sensitive content, use a provider you trust or
run the models yourself.
:::

## Object storage

| Setting | Default | What it does |
|---|---|---|
| `S3_ENDPOINT` | empty (bundled MinIO) | An external S3-compatible endpoint. Leave empty to use the MinIO that comes with Compose. |
| `S3_BUCKET` | `kinote` | The bucket. Created at start if it's missing. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | *(required)* | The credentials. With the bundled MinIO they are also its admin login. |
| `S3_REGION` | `us-east-1` | The region. |

See [Object storage](./storage).

## Email (optional)

Without email, Kinote sends none: new accounts can't confirm their address, and nobody can reset a forgotten
password except through the operator's command below.

| Setting | Default | What it does |
|---|---|---|
| `SMTP_URL` | *(unset)* | Your mail server, such as `smtps://user:password@smtp.example.com:465`. With it set, someone who signs up without an invitation confirms their address from an emailed link, entering their password on that page; until then they can't sign in or accept invitations, and signing in with the right password emails a fresh link. "Forgot your password?" emails a reset link, which also confirms the address, so the owner of an inbox can take over an account someone else registered with it. |
| `MAIL_FROM` | *(required with `SMTP_URL`)* | The From address, such as `Kinote <wiki@example.com>`. |
| `PUBLIC_URL` | *(required with `SMTP_URL`)* | The address people open Kinote at, such as `https://wiki.example.com`. Links in emails start with it. |

### Resetting a password without email

As the operator, print a one-time link that sets a new password for an account. It also signs that account out
everywhere:

```sh
docker compose exec api node_modules/.bin/tsx apps/api/src/cli/resetPassword.ts someone@example.com
```

The link works once, for an hour. Opening it also counts as confirming the email address, so give it only to the
person who owns that inbox.

## Files

| Setting | Default | What it does |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) | The largest upload, at most 500 MB. |
| `MAX_CONCURRENT_UPLOADS` | `4` | Uploads the API reads at once; others are asked to retry a few seconds later. Give the API container about this many times `MAX_UPLOAD_BYTES` of memory for uploads. |
| `MAX_EXTRACTED_CHARS` | `2000000` | The most text one file may produce. A file with more fails; it's never cut short. |
| `EXTRACTOR_MODE` | `http` | `http` uses the bundled file reader. `off` reads only text, Markdown and CSV files. `fake` is for tests. |
| `EXTRACTOR_URL` | `http://extractor:8000` | Where the file reader is. |
| `EXTRACTOR_TIMEOUT_MS` | `240000` | How long one file may take to read, at most 270000. |
