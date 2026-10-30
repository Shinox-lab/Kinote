# Repo layout and services

Kinote is a TypeScript monorepo managed with pnpm, plus two small services built from other projects. Thanks for
taking a look. Contributions of every size are welcome.

![How Kinote's services fit together](/architecture.svg)

## Services

Each box in the diagram is a container in `docker-compose.yml`.

| Service | Where | What it does |
|---|---|---|
| **web** | `apps/web` | The React app (BlockNote editor), built with Vite and served by nginx. nginx is also the single entry point: it forwards `/api` to the API, `/collab` to live editing and `/gridcraft/` to the spreadsheet editor. |
| **api** | `apps/api` | The REST API under `/api/v1` (Fastify): sign-in, workspaces, pages, files, search, Ask, captures and reviews. Every rule is enforced here or in the worker, never only in the browser. |
| **collab** | `apps/collab` | Live editing (Hocuspocus and Yjs). Checks each connection's access, records who changed each block, and stores the live document. |
| **worker** | `apps/worker` | Runs background jobs from a queue in Postgres: indexing, embedding, reading files, page summaries, and routing captures. Every job is idempotent. |
| **extractor** | `apps/extractor` | A Python service around Docling. File bytes in, structured text out. It can reach only the worker. |
| **gridcraft** | `apps/gridcraft` | A pinned build of the open-source GridCraft spreadsheet editor, served as static files. |
| **migrate** | `packages/db` | A one-shot container that upgrades the database before the others start. |
| **postgres** | `infra/postgres` | PostgreSQL 17 with pgvector. Row-level security keeps workspaces apart. |
| **minio** | | S3-compatible storage for uploaded files (or your own S3). |

## Shared packages

| Package | What's in it |
|---|---|
| `packages/contracts` | The Zod schemas for every API request and response, shared by the API and the web app. |
| `packages/core` | Domain logic with no HTTP: chunking, embeddings, search and Ask, routing, collections, drawings and files. |
| `packages/db` | The Drizzle schema, migrations, row-level security policies and the database helpers. |
| `packages/shared` | Code used by several services: configuration, the editor schema, block conversion, object storage, collab tokens. |

## Other folders

| Folder | What's in it |
|---|---|
| `e2e/` | Playwright end-to-end specs that drive the real app. |
| `infra/` | Scripts for the local stack and the end-to-end runs. |
| `docs/` | Operations notes, design documents, plans and live checks. |
| `site/` | This website. |

Next: [Development](./development).
