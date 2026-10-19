# Slice 0/1 live check, 2026-10-19

What was run, what it printed, and what is still owed. Only output that was really
observed is recorded as passed; every item that needs Docker is marked
`NOT RUN — needs Docker` with the exact command owed. Items 2 and 6 to 10 were later run
on real Postgres (2026-10-19, second session; the section for each says what ran).

## Environment

| | |
| --- | --- |
| Date | 2026-10-19 |
| Code | branch `remediation/slice-0-1`. PGlite runs (items 1, 3, 4, 5): commit `bf20a90` (the fix-round code commit, clean tree). The first-session run of the earlier spec: `0d8f2e4`. Docker runs: see the sections below. |
| Host | macOS (Darwin 25.6.0), node v22.23.2, pnpm 9.12.0 |
| Browser | Playwright 1.64.1, Chromium headless shell 156.0.8078.4 |
| Stack | **PGlite harness, not Docker**: `e2e/harness/local-stack.ts` runs the api, collab and worker in one Node process on an in-memory PGlite database (real migration chain, role `living_wiki_app`, RLS forced), deterministic embeddings (1536 dimensions), the console as a production build behind `vite preview`. api 18787, collab 11234, console 15173, worker poll 250 ms, collab store debounce 300 ms. |
| Not the environment (first session) | real Postgres 17 + pgvector, MinIO, the container images, the compose network. Docker could not start containers then. |
| Docker session (items 2, 6 to 10) | Docker Desktop 29.5.2, Compose v5.1.3, `pgvector/pgvector:pg17`, `pgsty/minio`, the repo's images. Host ports 55543, 59000, 59001, 8787 and 1234 were held by stale listeners of `com.docker.backend` with no container behind them, so the stack ran with local, untracked host-port overrides: postgres 55643, MinIO 59100/59101, api 58787, collab 51234. Details: `.superpowers/sdd/2026-10-18-slice-0-1-remediation/docker-verify-report.md`. |

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | Two tenants cannot see each other: api calls with each tenant's session | PASSED on the PGlite harness (output below) |
| 2 | Two tenants cannot see each other: the SQL check of `rls.pg.test.ts` | PASSED on real Postgres 17 (11 tests, output below) |
| 3 | Co-edit in a review space; the snapshot is held until approved | PASSED on the PGlite harness (`pnpm e2e:local`, output below): the held version is `pending_review`, nothing is indexed for the page, and search and Ask return an indexed decoy page but not the held one |
| 4 | Search and Ask cite v1 only after approval | PASSED on the PGlite harness (`pnpm e2e:local`, output below): the held page's link is absent from search and Ask before approval and present, cited `(v1, updated …)`, after R approves and the worker has indexed it |
| 5 | Withdraw removes results at once | PASSED on the PGlite harness (output below) |
| 6 | A restart of every container loses nothing | PASSED on the compose stack (`docker compose restart`, output below) |
| 7 | `pnpm stack:up` | PARTIAL: postgres and minio start healthy; the host migration FAILS on the default port 55543 (stale Docker listener); migrations apply (11) on a remapped port |
| 8 | `pnpm test:pg` | PASSED: 4 files, 20 tests (and the S3 case, 65 tests, against MinIO) |
| 9 | `bookkeepingLock.pg.test.ts`, positive and negative run | PASSED: passes with the lock, FAILS without it, passes again after restore |
| 10 | `pnpm e2e` against the compose stack | `pnpm e2e` itself NOT RUN (needs the held ports 55543, 8787, 1234); the same 5 specs PASSED against the compose containers on remapped ports |

The PGlite harness runs one transaction at a time and has no network between
services, so a pass there says the application logic and the screens are right; it
does not say anything about row locks, the pool, MinIO or the images. Items 2, 6 to
10 are those; they have since been run on Docker (sections below).

## 1. Two tenants cannot see each other (api calls)

Setup: the harness is running (`node --import tsx e2e/harness/local-stack.ts`).
Two users each sign up and create their own workspace, space ("Docs") and page. The
page text is written through the collab internal endpoint and indexed with
`POST /pages/:id/snapshot`; both pages reach `Indexed · v1`. Tenant one's page says
"Falcon protocol: tenant one confidential launch checklist."; tenant two's says
"Heron protocol: tenant two unrelated notes." Every call below was made with the
bearer token of the user named first and the `x-tenant-id` named second. The
script is `docs/live-checks/tenants-and-withdraw.mjs` (a plain `fetch` script, committed with
this document); run it as

```sh
node --import tsx e2e/harness/local-stack.ts &    # wait for the line READY
node docs/live-checks/tenants-and-withdraw.mjs
kill %1
```

Its output is below (ids and dates differ per run); long search and Ask replies are shortened
to the page ids and citations they name.

```
== Tenant isolation ==
tenant one page indexed; badge: Indexed · v1
tenant two page indexed; badge: Indexed · v1
tenant1=6cf73c72-abe4-4fe9-b245-75028194be96 page1=d4bc6a46-1224-496e-8dc9-06906f811240 space1=67ab91bb-1337-486e-b74d-4413b9138a11
tenant2=12e9f737-c518-429d-988b-4c125c2aae2d page2=e31b826d-1513-495f-9197-f16581c072d5
-- positive control: tenant one finds its own text
user1 / tenant1  POST /search {query: "falcon protocol"}
    -> 200 {"passages":[{"documentId":"d4bc6a46-1224-496e-8dc9-06906f811240","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
-- user2 acting in tenant2 reaches for tenant1 data
user2 / tenant2  POST /search {query: "falcon protocol"}
    -> 200 {"passages":[{"documentId":"e31b826d-1513-495f-9197-f16581c072d5","versionTitle":"two page","citeAs":"two page (v1, updated 2026-10-19)"}]}
user2 / tenant2  POST /ask {question: "falcon protocol"}
    -> 200 {"foundRelevant":true,"answer":"Based on indexed wiki sources (two page (v1, updated 2026-10-19)): # two page\n\nHeron protocol: tenant two unre","citations":[{"documentId":"e31b826d-1513-495f-9197-f16581c072d5","citeAs":"two page (v1, updated 2026-10-19)"}]}
user2 / tenant2  GET /pages/<tenant1 page>
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  GET /pages/<tenant1 page>/versions
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  POST /pages/<tenant1 page>/collab-token
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  GET /spaces/<tenant1 space>/tree
    -> 404 {"error":"space_not_found","message":"The requested space could not be found."}
user2 / tenant2  GET /spaces (own list only)
    -> 200 [{"tenantId":"12e9f737-c518-429d-988b-4c125c2aae2d","name":"Inbox","myRole":"admin"},{"tenantId":"12e9f737-c518-429d-988b-4c125c2aae2d","name":"Docs","myRole":"admin"}]
-- user2 names tenant1 in x-tenant-id
user2 / tenant1  GET /spaces
    -> 404 {"error":"tenant_not_found","message":"The requested organisation could not be found."}
user2 / tenant1  POST /search
    -> 404 {"error":"tenant_not_found","message":"The requested organisation could not be found."}
user2 / tenant1  GET /members
    -> 404 {"error":"tenant_not_found","message":"The requested organisation could not be found."}
-- and the other way round
user1 / tenant2  GET /pages/<tenant2 page>
    -> 404 {"error":"tenant_not_found","message":"The requested organisation could not be found."}
user1 / tenant1  GET /pages/<tenant2 page>
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user1 / tenant1  POST /search {query: "heron protocol"}
    -> 200 {"passages":[{"documentId":"d4bc6a46-1224-496e-8dc9-06906f811240","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
no token         GET /spaces
    -> 401 {"error":"unauthenticated","message":"Please sign in to continue."}
```

Reading it: every search and Ask a user makes names only pages of their own
workspace (user2's "falcon protocol" search returns tenant two's page, the nearest
passage of its own tenant; the deterministic embedding is not lexical, so a query
that matches nothing still returns the nearest own passage). Pages, versions, collab
tokens and trees of the other tenant answer 404, and naming a tenant the user does
not belong to answers 404 `tenant_not_found`.
What this does not show: the database policies themselves. The harness runs as the
non-superuser `living_wiki_app` with RLS forced, but PGlite is not Postgres 17; item 2
is the check on real Postgres.

## 2. Two tenants, SQL check (`rls.pg.test.ts`) — PASSED on real Postgres 17

Stack: `postgres` (pgvector/pgvector:pg17 plus `01-roles.sh`) and `minio` from
docker-compose.yml, migrations applied (11 rows in `drizzle.__drizzle_migrations`; role
`living_wiki_app|t|f|f` = LOGIN, not superuser, not BYPASSRLS; extension `vector`).
Host port 55643 instead of 55543 (see Environment).

```
$ pnpm test:pg      (TEST_DATABASE_URL = living_wiki_app, TEST_DATABASE_MIGRATE_URL = postgres superuser)
 ✓ apps/api/test/search.pg.test.ts (6 tests) 7337ms
 ✓ apps/worker/test/claim.pg.test.ts (2 tests) 76ms
 ✓ packages/db/test/rls.pg.test.ts (11 tests) 62ms
 ✓ apps/collab/test/bookkeepingLock.pg.test.ts (1 test) 568ms
 Test Files  4 passed (4)
      Tests  20 passed (20)
```

S3 case against MinIO: `S3_ENDPOINT=http://127.0.0.1:59100 pnpm vitest run packages/shared/test/objectStorage.test.ts`
-> `Test Files 1 passed (1)`, `Tests 65 passed (65)`, none skipped.

## 3 and 4. Co-edit, held until approval, v1 cited after approval — `pnpm e2e:local` (spec as of `bf20a90`)

`e2e/co-edit.spec.ts` drives three browser contexts through the console: A (Ada) signs
up, creates a workspace and a review-required space "Docs"; invites B (Bea) and R (Rae)
and opens their accept links in their own contexts (each signs up on the way); A grants
B editor and R reviewer. A then creates and indexes a decoy page "Holiday calendar" in
the Inbox (a space without review), so that search has something to return. A creates the
page "Leave policy" in Docs; A and B type into it at the same time (different blocks, key
by key with a delay) and both editors show both texts; A clicks **Submit for review**.

What is demonstrated before approval (item 3):
- the badge reads `Saved · not indexed (awaiting approval)`;
- the Reviews screen shows version 1 "Awaiting review" with **Approve** disabled for A and
  the reason "You can't approve this change…";
- the api, asked with A's session, says the page has no indexed version (`indexedVersion`
  null) and its latest version is number 1, status `pending_review`;
- A's search and Ask return the decoy "Holiday calendar" (so the results are not empty) and
  no link to the held page (checked by `href`, not by text).

What is demonstrated after R approves (item 4): the item leaves R's queue; the api shows an
indexed version and the latest version `indexed`; the badge reads `Indexed · v1`; search
shows the passage and a link to the page with `(v1, updated YYYY-MM-DD)`; Ask lists the
source `Leave policy (v1, updated YYYY-MM-DD)` next to the decoy, and clicking it opens the page.

Caveat: the deterministic embedding is not lexical (any query returns the nearest passages of
the tenant), so "the new text is not found" cannot be shown by an empty result or by matching
the text. That is why the proof is the decoy plus the held page's absence by link, together
with the api state; it shows the review hold, not retrieval quality.

Output of the three consecutive runs at `bf20a90` (command: `pnpm e2e:local`; each run starts
the harness, runs the specs, stops it, and leaves no process behind; the lines are the real
list-reporter lines, nothing abridged):

```
Running 5 tests using 1 worker

  ✓  1 [chromium] › e2e/co-edit.spec.ts:53:1 › two editors and a reviewer: co-edit, hold until approval, index, cite v1 (6.7s)
  ✓  2 [chromium] › e2e/console.spec.ts:51:1 › review queue: Approve and Reject states, lazy diff (1.4s)
  ✓  3 [chromium] › e2e/console.spec.ts:118:1 › history drawer: compare two versions, restore with confirmation, Escape returns focus (1.1s)
  ✓  4 [chromium] › e2e/console.spec.ts:179:1 › citations link to the cited page (492ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › a viewer sees the page read-only, without Submit (918ms)
  5 passed (17.3s)

  ✓  1 [chromium] › e2e/co-edit.spec.ts:53:1 › two editors and a reviewer: co-edit, hold until approval, index, cite v1 (6.9s)
  ✓  2 [chromium] › e2e/console.spec.ts:51:1 › review queue: Approve and Reject states, lazy diff (1.3s)
  ✓  3 [chromium] › e2e/console.spec.ts:118:1 › history drawer: compare two versions, restore with confirmation, Escape returns focus (870ms)
  ✓  4 [chromium] › e2e/console.spec.ts:179:1 › citations link to the cited page (595ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › a viewer sees the page read-only, without Submit (945ms)
  5 passed (17.1s)

  ✓  1 [chromium] › e2e/co-edit.spec.ts:53:1 › two editors and a reviewer: co-edit, hold until approval, index, cite v1 (5.0s)
  ✓  2 [chromium] › e2e/console.spec.ts:51:1 › review queue: Approve and Reject states, lazy diff (1.3s)
  ✓  3 [chromium] › e2e/console.spec.ts:118:1 › history drawer: compare two versions, restore with confirmation, Escape returns focus (846ms)
  ✓  4 [chromium] › e2e/console.spec.ts:179:1 › citations link to the cited page (470ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › a viewer sees the page read-only, without Submit (753ms)
  5 passed (15.0s)
```

A `--repeat-each 6` flakiness run of the co-edit and viewer specs (12 passed, 38.9 s) was made
on the earlier spec (`0d8f2e4`) and not repeated for the changed one.

The other specs cover the screens the Task 5.9 reviews asked for: Approve disabled for
the reviewer's own change (with the reason), Reject disabled until the note is 1 to 300
characters (empty, blanks, 301, 300 and a padded valid note), the block diff fetched
only when an item is expanded (0 requests before, 1 after), approve removing the item
from the queue; the History drawer (focus moves into it, versions listed, compare the
default pair and a reversed pair, the same-version guard, restore with a confirm that
Cancel leaves untouched and Restore turns into version 3, Escape closes it and focus
returns to the History button); search results, Ask sources and answer markers linking to
the cited page; the viewer's read-only page (not editable, no Submit, no Page actions,
typed text never reaches the owner).

## 5. Withdraw removes results at once

Same harness, same script (`docs/live-checks/tenants-and-withdraw.mjs`, second half of its output, the same run as item 1), tenant one's page from item 1, indexed as v1. Here the "before" call shows the page is returned, so the empty "after" is not the empty index of a tenant that never had a page:

```
== Withdraw removes results at once ==
before: user1 searches "falcon protocol"
    -> 200 {"passages":[{"documentId":"d4bc6a46-1224-496e-8dc9-06906f811240","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
POST /pages/<page>/withdraw
    -> 200 {"id":"d4bc6a46-1224-496e-8dc9-06906f811240","spaceId":"67ab91bb-1337-486e-b74d-4413b9138a11","parentId":null,"position":"a0","title":"one page","archivedAt":null,"indexedVersionId":null}
after (immediately): user1 searches "falcon protocol"
    -> 200 {"passages":[]}
after (immediately): user1 asks "falcon protocol"
    -> 200 {"foundRelevant":false,"answer":"No relevant indexed information was found in your accessible spaces.","citations":[]}
page badge after withdraw: Withdrawn
```

The search and the Ask follow the withdraw call directly, without waiting for the worker.

## 6. Restart of every container loses nothing — PASSED on the compose stack

Whole stack up with `docker compose up -d --build` (migrate exited 0; api, collab, worker,
postgres, minio up). Before the restart, through the api (api on host port 58787):

```
sign-up             -> 201   restart-mvetwuav@example.test
create tenant       -> 201   383ea41f-abf0-4a8a-be93-79f025631ba1
create space, page  -> 201   page text "Quokka protocol: data must survive a restart."
snapshot            -> 201   status "indexing"
page after worker   -> 200   badge "Indexed · v1"
search              -> 200   the page's passage, versionNumber 1
```

`docker compose restart` (all six containers of the project). The postgres volume
(`1152b19e…`) and the minio volume (`c6822d04…`) were the same before and after. After:

```
GET /me with the pre-restart token -> 200 user + membership "Restart Co mvetwuav"
POST /auth/sign-in                 -> 200
GET /pages/<id>                    -> 200 badge "Indexed · v1", liveMarkdown "Quokka protocol: data must survive a restart."
GET /pages/<id>/versions           -> 200 [number 1, status "indexed"]
POST /search "quokka protocol"     -> 200 the page's passage, v1
```

Nothing was lost. Anonymous volumes survive `restart`; `down` without `-v` keeps them on
disk unreferenced, `down -v` deletes them.

## 7 to 10. Stack, tests, lock, e2e

7. `pnpm stack:up` as written: both containers reach healthy, then the host migration fails
   because 127.0.0.1:55543 is held by a stale `com.docker.backend` listener with no container
   (the compose postgres shows `5432/tcp` published to nothing):

   ```
    Container living-wiki-postgres-1 Healthy
    Container living-wiki-minio-1 Healthy
   > tsx packages/db/src/migrate.ts
   migration failed: DrizzleQueryError: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
     cause: Error: Connection terminated unexpectedly
   ```

   With postgres on 127.0.0.1:55643 the same `pnpm db:migrate` prints
   `migrations applied from …/packages/db/migrations`. Still owed: `pnpm stack:up` unmodified
   once those host ports are free (needs a Docker Desktop restart, not done).

8. `pnpm test:pg` and the S3 case: see item 2 (20 and 65 tests passed).

9. `apps/collab/test/bookkeepingLock.pg.test.ts`, with the `.for('key share')` select in
   `apps/collab/src/recorder.ts` removed:

   ```
    FAIL  … > a repeat contributor's write started under the snapshot lock commits wholly after it
   AssertionError: expected true to be false // Object.is equality
    ❯ apps/collab/test/bookkeepingLock.pg.test.ts:145:20
       145|     expect(landed).toBe(false);
    Test Files  1 failed (1)   Tests  1 failed (1)
   ```

   (its `afterAll` also hit the 60 s hook timeout because the failed case left its
   transaction open). After `git checkout -- apps/collab/src/recorder.ts` (tree clean):
   `✓ apps/collab/test/bookkeepingLock.pg.test.ts (1 test) 589ms`, `Tests 1 passed (1)`.

10. `pnpm e2e` as written was NOT run: it needs host ports 55543, 8787 and 1234 (see 7).
    The same specs against the compose containers (api, collab and worker started with
    `AUTH_RATE_LIMIT_MAX=1000 EMBEDDING_PROVIDER=deterministic`, as infra/e2e.sh does; Playwright
    with `API_URL=http://127.0.0.1:58787 COLLAB_URL=http://127.0.0.1:51234`, `vite dev` on 5173):

    ```
      ✓  1 [chromium] › e2e/co-edit.spec.ts:38:1 › two editors and a reviewer: co-edit, hold until approval, index, cite v1 (7.1s)
      ✓  2 [chromium] › e2e/console.spec.ts:50:1 › review queue: Approve and Reject states, lazy diff (1.7s)
      ✓  3 [chromium] › e2e/console.spec.ts:117:1 › history drawer: compare two versions, restore with confirmation, Escape returns focus (1.4s)
      ✓  4 [chromium] › e2e/console.spec.ts:178:1 › citations link to the cited page (838ms)
      ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › a viewer sees the page read-only, without Submit (1.0s)
      5 passed (13.7s)
    ```

    (These five lines are from the first-session spec, `0d8f2e4`, before the decoy page was added to
    co-edit; the changed spec has not been run on compose.)

    The dev proxy logs `ws proxy socket error: write EPIPE` lines while sockets close; no
    test is affected. Still owed: `pnpm e2e` unmodified on the default ports.

## Other checks run for this task

| Command | Result |
| --- | --- |
| `pnpm vitest run` | 53 files passed; 572 tests passed, 30 skipped (the env-gated `*.pg.test.ts` and the S3 case) |
| `pnpm typecheck` | exit 0 (includes `e2e/**` and `playwright.config.ts`) |
| `pnpm --filter @living-wiki/web build` | exit 0 |
| `pnpm install --frozen-lockfile` | up to date |
