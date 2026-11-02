# Live-editing load harness

Seeds separate workspaces, each with at least two people and a shared page, then connects
real Hocuspocus clients that type into the page and measure edit round trips. Every edit goes
through the same path a browser does: the collab token endpoint, the WebSocket, Yjs, the
authorship bookkeeping, and the debounced `ydoc_state` store.

The point is to find the knee in Postgres writes, not to benchmark the generator. Run it on a
disposable stack.

## Prerequisites

- The stack is running (`docker compose up -d`) and the api/collab ports are reachable.
- `pnpm install` has been run.
- Raise the auth rate limit for seeding. The default is 10 sign-ups a minute; the harness
  waits out 429s but that makes a 100-workspace seed slow. Set it on the api and restart it:

  ```bash
  AUTH_RATE_LIMIT_MAX=100000 docker compose up -d api
  ```

  Or put `AUTH_RATE_LIMIT_MAX=100000` in `.env` and `docker compose up -d`.

## Resource-limited stack

`compose-stress-test.yaml` includes the normal compose file and limits every container to
1 CPU and 256 MiB by default:

```bash
docker compose -p kinote-stress -f compose-stress-test.yaml up -d --build
```

The limits are per container, not a total host budget. To approximate a single small host,
run the stack on a 1 vCPU/256M VM or use cgroup-level limits; these caps only apply to each
container. Set `STRESS_CPUS`/`STRESS_MEMORY` for every service, or
`<SERVICE>_CPUS`/`<SERVICE>_MEMORY` for one (`POSTGRES`, `MINIO`, `MIGRATE`, `API`, `COLLAB`,
`WORKER`, `EXTRACTOR`, `GRIDCRAFT`, `WEB`):

```bash
STRESS_CPUS=2 STRESS_MEMORY=512M \
POSTGRES_MEMORY=512M API_MEMORY=1G COLLAB_MEMORY=512M \
docker compose -p kinote-stress -f compose-stress-test.yaml up -d --build
```

For a collab-only run, skip the worker and extractor (the lean stack is enough for this
harness):

```bash
docker compose -p kinote-stress -f compose-stress-test.yaml up -d --build \
  postgres minio migrate api collab gridcraft web
```

Postgres at 256M is tight because `shared_buffers` alone is 128M; use `POSTGRES_MEMORY=512M`
when the database is the component under test. The Docling extractor needs about 2G; set
`EXTRACTOR_MEMORY=2G` if you start it. Use `-p kinote-stress` so the stress containers and
volumes stay separate from the normal stack, and remove them with
`docker compose -p kinote-stress -f compose-stress-test.yaml down -v`.

Stop the normal stack first, or give the stress stack different host ports (`API_HOST_PORT`,
`COLLAB_HOST_PORT`, `POSTGRES_HOST_PORT`, ...) and point the harness at them with `API_URL`,
`COLLAB_URL`, and the metrics `DATABASE_URL`.

## Run

Smoke test, two workspaces:

```bash
WORKSPACES=2 STEP_SECONDS=30 HOLD_SECONDS=30 pnpm load:collab
```

Ramp to 50 workspaces (100 editors), one page each, with a page read every 5 seconds:

```bash
RAMP=10,25,50 STEP_SECONDS=120 HOLD_SECONDS=120 READ_MS=5000 pnpm load:collab
```

Read/write run with page navigation: three pages per workspace, two editors on each
page (six editor tabs per workspace), a switch every 20 seconds, and 5 seconds of
reading before typing resumes:

```bash
WORKSPACES=10 PAGES=3 EDITORS=2 NAVIGATE_MS=20000 NAV_READ_MS=5000 \
STEP_SECONDS=60 HOLD_SECONDS=60 pnpm load:collab
```

Seed only, to check the API path without starting editors:

```bash
RAMP=100 SEED_ONLY=1 pnpm load:collab
```

The defaults point at the compose ports: `API_URL=http://127.0.0.1:8787` and
`COLLAB_URL=ws://127.0.0.1:1234`. Through the web nginx use
`API_URL=http://127.0.0.1:8081` and `COLLAB_URL=ws://127.0.0.1:8081/collab`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `API_URL` | `http://127.0.0.1:8787` | api base, without `/api/v1` |
| `COLLAB_URL` | `ws://127.0.0.1:1234` | collab WebSocket |
| `WORKSPACES` | `10` | flat run: workspaces to seed and start |
| `RAMP` | — | comma-separated workspace counts, increasing; wins over `WORKSPACES` |
| `EDITORS` | `2` | people per workspace (minimum 2) |
| `PAGES` | `1` | pages per workspace; every page gets `EDITORS` editors |
| `STEP_SECONDS` | `60` | hold each ramp step |
| `HOLD_SECONDS` | `60` | hold after the last step |
| `TYPING_MS` | `250` | one character inserted per editor per interval |
| `PING_MS` | `2000` | round-trip probe interval |
| `READ_MS` | `0` | page `GET` interval per editor; `0` disables reads |
| `NAVIGATE_MS` | `0` | page-switch interval per editor; `0` disables navigation |
| `NAVIGATE_JITTER_MS` | `0` | spread each switch by up to this many extra ms; `0` keeps the synchronized stress test |
| `NAV_READ_MS` | `5000` | read time after opening a page before typing resumes |
| `SEED_CONCURRENCY` | `5` | workspaces seeded at once |
| `SEED_ONLY` | — | `1` seeds and exits |
| `RUN_ID` | timestamp | makes emails and slugs unique per run |
| `LOAD_PASSWORD` | `correct-horse-battery` | password of the seeded users |
| `MARKDOWN_PARAGRAPHS` | `20` | initial page size |

## Page navigation

With `NAVIGATE_MS` set, every editor periodically:

1. fetches the space tree with `GET /api/v1/spaces/:id/tree`,
2. picks a random other page in the same workspace (files are skipped),
3. closes the old Hocuspocus connection and opens a fresh one on the new page,
4. reads the page metadata with `GET /api/v1/pages/:id?meta=1` (the live content
   arrives over the collab socket, as it does in the web client),
5. waits `NAV_READ_MS` with typing paused, then resumes typing.

`NAVIGATE_MS` requires `PAGES >= 2`. Navigation counts are reported as `navs`; the tree
and page `GET`s both count in `reads`. This adds HTTP read load and WebSocket/document
reconnection churn on top of the edit writes. Set `NAVIGATE_JITTER_MS` to spread the
switches across a window and model independent users instead of a synchronized herd.

The harness deliberately does not call `GET /api/v1/pages/:id` without `?meta=1`. That
endpoint decodes the stored Yjs document and converts every block to Markdown on each
request; the live editor never needs that work because the page content already comes
over the collab socket. Use the endpoint benchmark to load the full-page path separately.

## What it reports

Every step prints:

```
[load] 50 editors · 12000 edits (4.0/s) · 500 reads · 12 navs · 0 errors · rtt p50=8ms p95=35ms p99=120ms · read p50=8ms p95=12ms p99=20ms
```

`rtt` is a ping over Hocuspocus awareness: it measures the full
client → collab → peer → collab → client path without touching the page fragment, so it
creates no authorship rows and no `ydoc_state` stores. Pongs older than 1 second are
ignored, so a peer's navigation pause is not reported as network latency.

## Postgres during the run

From the host, the compose database is on `127.0.0.1:55543`:

```bash
export DATABASE_URL='postgres://kinote_app:APP_DB_PASSWORD@127.0.0.1:55543/kinote'
psql "$DATABASE_URL" -f apps/collab/load/metrics.sql
```

Run it at the start and end of each step. For a time series:

```bash
while true; do
  psql "$DATABASE_URL" -Atc "select now(), pg_current_wal_lsn(), (select count(*) from pg_stat_activity where datname = current_database())"
  sleep 5
done
```

Also watch `docker stats` for the `collab`, `api`, and `postgres` containers. Event-loop lag
and RSS on `collab` are the other ceiling besides Postgres.

## Reading the result

- **Postgres CPU near 70%** before the WebSocket layer struggles: the database is the knee.
  Look at `pg_stat_statements` (if enabled) for `block_activity`, `pages`, and `jobs`; the
  per-keystroke `writeAttribution` is the usual suspect.
- **API CPU near 100% while edit RTT stays low**: the page tree/page read path is the knee.
  Navigation adds two HTTP reads per switch (`reads`), and a new WebSocket per switch (`navs`).
- **`read p95` climbing while `rtt p99` is flat**: the API read path is saturated, not the
  edit WebSocket. Check the API container and the tree/page queries before adding collab CPU.
- **`n_dead_tup` climbing on `pages`** and WAL bytes/s high: the full `ydoc_state` rewrite is
  the cost. Check the average page size and the store debounce before scaling the disk.
- **`granted = false` locks on `pages`**: the store and bookkeeping are contending on the same
  row. That is per-page serialization, not a global lock.
- **`rtt p99` climbing while Postgres is idle**: the collab process or the generator is the
  bottleneck. Run the generator on another machine before blaming the server.
- **`errors` above zero**: the run is invalid for capacity purposes. Check the first five
  messages, usually auth rate limits or a restarted service.

## Limits

- One generator process. For hundreds of editors, run several with distinct `RUN_ID`s from
  separate machines; the generator's own event loop and network are then part of the result.
- No worker, indexing, search, or Ask traffic. Add separate load for those; the live path is the
  focus. Page creation still enqueues jobs, so run the worker too if the queue should be part of
  the measurement.
- One collab instance. The server has no shared document state, so do not point a plain load
  balancer at two replicas.
- Seeded workspaces stay in the database. Use a disposable database or `docker compose down -v`
  when done; never run this against production.
