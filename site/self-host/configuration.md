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
| `WEB_HOST_PORT` | `8080` | Where the app is published on your machine. |
| `POSTGRES_HOST_PORT`, `MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT` | `55543`, `59000`, `59001` | Ports for local tools. |
| `API_HOST_PORT`, `COLLAB_HOST_PORT`, `GRIDCRAFT_HOST_PORT` | `8787`, `1234`, `8082` | Used by the test suites and UI development only. |
| `TRUST_PROXY` | `false` | How many proxies sit in front of the app. See [Ports and reverse proxies](./proxy). |
| `AUTH_RATE_LIMIT_MAX` | `10` | Sign-up and sign-in attempts allowed per minute from one address. |
| `LOG_LEVEL` | `info` | How much the API logs: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |

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

## Files

| Setting | Default | What it does |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) | The largest upload, at most 500 MB. |
| `MAX_EXTRACTED_CHARS` | `2000000` | The most text one file may produce. A file with more fails; it's never cut short. |
| `EXTRACTOR_MODE` | `http` | `http` uses the bundled file reader. `off` reads only text, Markdown and CSV files. `fake` is for tests. |
| `EXTRACTOR_URL` | `http://extractor:8000` | Where the file reader is. |
| `EXTRACTOR_TIMEOUT_MS` | `240000` | How long one file may take to read, at most 270000. |
