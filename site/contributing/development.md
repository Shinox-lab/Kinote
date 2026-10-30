# Development

## Set up

You need **Node.js 22 or later**, **pnpm 9** and **Docker**.

```sh
git clone https://github.com/Shinox-lab/Kinote.git
cd Kinote
pnpm install
cp .env.example .env    # fill in the six secrets, see Self-hosting → Quick start
```

## Run the app

| Command | What it does |
|---|---|
| `pnpm dev` | Builds and starts the whole stack with Docker Compose and waits until it's healthy. The app is then at `http://localhost:8081`. |
| `pnpm web` | Serves just the web app with Vite and hot reload, against a running stack. Use it for UI work. |
| `pnpm stack:up` | Starts only Postgres and MinIO, then runs the migrations from your machine. |
| `pnpm stack:down` | Stops the stack **and deletes its data**. |

## Tests

| Command | What it runs | What it needs |
|---|---|---|
| `pnpm test` | The unit and service tests (Vitest), with an in-memory Postgres (PGlite) and an in-process live-editing server | Nothing else |
| `pnpm typecheck` | TypeScript across the repo | Nothing else |
| `pnpm test:pg` | Tests against a real Postgres: row-level security and the job queue | `pnpm stack:up`, then `TEST_DATABASE_URL` and `TEST_DATABASE_MIGRATE_URL` set as in `.env.example`. It fails, rather than skipping, when they're missing. |
| `pnpm e2e` | The Playwright specs against the Compose stack | Docker, port 5173 free, and Chromium (`pnpm exec playwright install chromium`) |
| `pnpm e2e:local` | The same specs without Docker: the services run in one Node process on an in-memory database | Chromium |

The end-to-end runs use the `deterministic` model providers and a fake file reader, so they need no API keys. `pnpm e2e`
leaves the stack running afterwards.

## This website

```sh
pnpm site:dev     # live preview
pnpm site:build   # build into site/.vitepress/dist
pnpm site:check   # look for wording that shouldn't be on public pages
pnpm --filter @kinote/site test:site   # the site's own browser tests
```

Next: [How we work](./how-we-work).
