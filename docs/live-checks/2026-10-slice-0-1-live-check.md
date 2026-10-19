# Slice 0/1 live check, 2026-10-19

What was run, what it printed, and what is still owed. Only output that was really
observed is recorded as passed; every item that needs Docker is marked
`NOT RUN — needs Docker` with the exact command owed.

## Environment

| | |
| --- | --- |
| Date | 2026-10-19 |
| Code | branch `remediation/slice-0-1`, base commit `31454e5` plus the Task 5.10 commit (`git log -1 -- docs/live-checks`) |
| Host | macOS (Darwin 25.6.0), node v22.23.2, pnpm 9.12.0 |
| Browser | Playwright 1.64.1, Chromium headless shell 156.0.8078.4 |
| Stack | **PGlite harness, not Docker**: `e2e/harness/local-stack.ts` runs the api, collab and worker in one Node process on an in-memory PGlite database (real migration chain, role `living_wiki_app`, RLS forced), deterministic embeddings (1536 dimensions), the console as a production build behind `vite preview`. api 18787, collab 11234, console 15173, worker poll 250 ms, collab store debounce 300 ms. |
| Not the environment | real Postgres 17 + pgvector, MinIO, the container images, the compose network. Docker cannot start containers on this machine. |

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | Two tenants cannot see each other: api calls with each tenant's session | PASSED on the PGlite harness (output below) |
| 2 | Two tenants cannot see each other: the SQL check of `rls.pg.test.ts` | NOT RUN — needs Docker |
| 3 | Co-edit in a review space; a snapshot is held until approved | PASSED on the PGlite harness (`pnpm e2e:local`, output below) |
| 4 | Search and Ask cite v1 only after approval | PASSED on the PGlite harness (`pnpm e2e:local`, output below) |
| 5 | Withdraw removes results at once | PASSED on the PGlite harness (output below) |
| 6 | A restart of every container loses nothing | NOT RUN — needs Docker |
| 7 | `pnpm stack:up` | NOT RUN — needs Docker |
| 8 | `pnpm test:pg` | NOT RUN — needs Docker |
| 9 | `bookkeepingLock.pg.test.ts`, positive and negative run | NOT RUN — needs Docker |
| 10 | `pnpm e2e` against the compose stack | NOT RUN — needs Docker |

The PGlite harness runs one transaction at a time and has no network between
services, so a pass there says the application logic and the screens are right; it
does not say anything about row locks, the pool, MinIO or the images. Items 2, 6 to
10 are those.

## 1. Two tenants cannot see each other (api calls)

Setup: the harness is running (`node --import tsx e2e/harness/local-stack.ts`).
Two users each sign up and create their own workspace, space ("Docs") and page. The
page text is written through the collab internal endpoint and indexed with
`POST /pages/:id/snapshot`; both pages reach `Indexed · v1`. Tenant one's page says
"Falcon protocol: tenant one confidential launch checklist."; tenant two's says
"Heron protocol: tenant two unrelated notes." Every call below was made with the
bearer token of the user named first and the `x-tenant-id` named second. The
script is `check.mjs` (a plain `fetch` script; its output is below, long
search and Ask replies are shortened to the page ids and citations they name).

```
tenant one page indexed; badge: Indexed · v1
tenant two page indexed; badge: Indexed · v1
tenant1=a9259b5a-ff07-43a8-8877-a9ff1ef6ea8f page1=860404f8-9839-4ea8-aef0-4e6ce2a6e381 space1=d1e28afc-3644-4aec-b6b3-672c0a100b65
tenant2=4e58a62e-60a8-4b35-8c18-7fe1d37c02d7 page2=35b2c02f-b48a-47e3-8cc7-65815b8705f5
-- positive control: tenant one finds its own text
user1 / tenant1  POST /search {query: "falcon protocol"}
    -> 200 {"passages":[{"documentId":"860404f8-9839-4ea8-aef0-4e6ce2a6e381","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
-- user2 acting in tenant2 reaches for tenant1 data
user2 / tenant2  POST /search {query: "falcon protocol"}
    -> 200 {"passages":[{"documentId":"35b2c02f-b48a-47e3-8cc7-65815b8705f5","versionTitle":"two page","citeAs":"two page (v1, updated 2026-10-19)"}]}
user2 / tenant2  POST /ask {question: "falcon protocol"}
    -> 200 {"foundRelevant":true,"answer":"Based on indexed wiki sources (two page (v1, updated 2026-10-19)): # two page\n\nHeron protocol: tenant two unre","citations":[{"documentId":"35b2c02f-b48a-47e3-8cc7-65815b8705f5","citeAs":"two page (v1, updated 2026-10-19)"}]}
user2 / tenant2  GET /pages/<tenant1 page>
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  GET /pages/<tenant1 page>/versions
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  POST /pages/<tenant1 page>/collab-token
    -> 404 {"error":"page_not_found","message":"The requested page could not be found."}
user2 / tenant2  GET /spaces/<tenant1 space>/tree
    -> 404 {"error":"space_not_found","message":"The requested space could not be found."}
user2 / tenant2  GET /spaces (own list only)
    -> 200 [{"tenantId":"4e58a62e-60a8-4b35-8c18-7fe1d37c02d7","name":"Inbox","myRole":"admin"},{"tenantId":"4e58a62e-60a8-4b35-8c18-7fe1d37c02d7","name":"Docs","myRole":"admin"}]
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
    -> 200 {"passages":[{"documentId":"860404f8-9839-4ea8-aef0-4e6ce2a6e381","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
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

## 2. Two tenants, SQL check (`rls.pg.test.ts`) — NOT RUN — needs Docker

```sh
pnpm stack:up
TEST_DATABASE_URL=postgres://living_wiki_app:$APP_DB_PASSWORD@127.0.0.1:55543/living_wiki \
TEST_DATABASE_MIGRATE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:55543/living_wiki \
  pnpm test:pg
```

Expected: every `*.pg.test.ts` passes, `packages/db/test/rls.pg.test.ts` among them.

## 3 and 4. Co-edit, held until approval, v1 cited after approval — `pnpm e2e:local`

`e2e/co-edit.spec.ts` drives three browser contexts through the console: A (Ada) signs
up, creates a workspace and a review-required space "Docs"; invites B (Bea) and R (Rae)
and opens their accept links in their own contexts (each signs up on the way); A grants
B editor and R reviewer; A creates a page; A and B type into it at the same time
(different blocks, key by key with a delay) and both editors show both texts; A clicks
**Submit for review**; the badge reads `Saved · not indexed (awaiting approval)`; on the
Reviews screen A sees version 1 as "Awaiting review" with **Approve** disabled and the
reason "You can't approve this change…"; A's search for the new text answers "No passages
matched."; R approves (the item leaves the queue); after the worker has run the badge
reads `Indexed · v1`, a search shows the passage with `(v1, updated YYYY-MM-DD)`, Ask lists
the source `Leave policy (v1, updated YYYY-MM-DD)`, and clicking it opens the page.

Output of the three consecutive runs (command: `pnpm e2e:local`; each run starts the
harness, runs the specs, stops it, and leaves no process behind):

```
Running 5 tests using 1 worker

  ✓  1 [chromium] › e2e/co-edit.spec.ts:38:1 › two editors and a reviewer: co-edit, hold until approval, index, cite v1 (3.8s)
  ✓  2 [chromium] › e2e/console.spec.ts:50:1 › review queue: Approve and Reject states, lazy diff (1.4s)
  ✓  3 [chromium] › e2e/console.spec.ts:117:1 › history drawer: compare two versions, restore with confirmation, Escape returns focus (1.1s)
  ✓  4 [chromium] › e2e/console.spec.ts:178:1 › citations link to the cited page (539ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › a viewer sees the page read-only, without Submit (966ms)

  5 passed (13.4s)

  ✓  1 [chromium] › e2e/co-edit.spec.ts:38:1 › … (5.7s)
  ✓  2 [chromium] › e2e/console.spec.ts:50:1 › … (1.6s)
  ✓  3 [chromium] › e2e/console.spec.ts:117:1 › … (931ms)
  ✓  4 [chromium] › e2e/console.spec.ts:178:1 › … (519ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › … (860ms)

  5 passed (16.2s)

  ✓  1 [chromium] › e2e/co-edit.spec.ts:38:1 › … (5.7s)
  ✓  2 [chromium] › e2e/console.spec.ts:50:1 › … (1.6s)
  ✓  3 [chromium] › e2e/console.spec.ts:117:1 › … (979ms)
  ✓  4 [chromium] › e2e/console.spec.ts:178:1 › … (636ms)
  ✓  5 [chromium] › e2e/viewer.spec.ts:4:1 › … (919ms)

  5 passed (17.4s)
```

Also run, as a flakiness check: `playwright test --repeat-each 6` on the co-edit and
viewer specs, 12 passed (38.9 s), all green.

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

The review-held snapshot is shown by the Reviews screen (version 1, "Awaiting review",
Approve off for A) and the empty search before approval, with the badge
`Saved · not indexed (awaiting approval)` in between; the indexed side by the badge
`Indexed · v1` and the `(v1, updated …)` citations only after R's approval.

## 5. Withdraw removes results at once

Same harness, same script (`check.mjs`), tenant one's page from item 1, indexed as v1:

```
== Withdraw removes results at once ==
before: user1 searches "falcon protocol"
    -> 200 {"passages":[{"documentId":"860404f8-9839-4ea8-aef0-4e6ce2a6e381","versionTitle":"one page","citeAs":"one page (v1, updated 2026-10-19)"}]}
POST /pages/<page>/withdraw
    -> 200 {"id":"860404f8-9839-4ea8-aef0-4e6ce2a6e381","spaceId":"d1e28afc-3644-4aec-b6b3-672c0a100b65","parentId":null,"position":"a0","title":"one page","archivedAt":null,"indexedVersionId":null}
after (immediately): user1 searches "falcon protocol"
    -> 200 {"passages":[]}
after (immediately): user1 asks "falcon protocol"
    -> 200 {"foundRelevant":false,"answer":"No relevant indexed information was found in your accessible spaces.","citations":[]}
page badge after withdraw: Withdrawn
```

The search and the Ask follow the withdraw call directly, without waiting for the worker.

## 6. Restart of every container loses nothing — NOT RUN — needs Docker

```sh
pnpm stack:up && docker compose up -d --build            # whole stack
pnpm e2e                                                 # leaves its three accounts, pages and v1 indexing in the stack
API=http://127.0.0.1:8787/api/v1
# before: a fresh account with a workspace
curl -s -X POST $API/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"restart@example.test","name":"Restart","password":"correct-horse-battery"}'   # note session.token as TOKEN
curl -s -X POST $API/tenants -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Restart Co","slug":"restart-co"}'                                              # note tenant.id as TENANT_ID
docker compose restart
# after: the session, the account and the workspace are still there
curl -s $API/me -H "authorization: Bearer $TOKEN"
curl -s -X POST $API/auth/sign-in -H 'content-type: application/json' \
  -d '{"email":"restart@example.test","password":"correct-horse-battery"}'
# and indexed content still answers: open the console on a page of the e2e run, or search its tenant
```

Expected: `/me` lists the workspace, sign-in succeeds, and a page of the e2e run still shows
`Indexed · v1`, its history and its text. Data lives in anonymous volumes, which `restart` keeps (docs/operations.md).

## 7 to 10. Also owed (Docker)

```sh
pnpm stack:up                                            # 7: postgres + minio come up, migrations apply
TEST_DATABASE_URL=postgres://living_wiki_app:$APP_DB_PASSWORD@127.0.0.1:55543/living_wiki \
TEST_DATABASE_MIGRATE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:55543/living_wiki \
  pnpm test:pg                                           # 8: every *.pg.test.ts
S3_ENDPOINT=http://127.0.0.1:59000 pnpm vitest run packages/shared/test/objectStorage.test.ts   # S3 case, MinIO
pnpm e2e                                                 # 10: the same specs against the compose stack
```

9. `apps/collab/test/bookkeepingLock.pg.test.ts`, positive and negative run (Task 4.3,
   ruling R25): with the TEST_DATABASE_* variables above,
   `pnpm vitest run -c vitest.pg.config.ts apps/collab/test/bookkeepingLock.pg.test.ts`
   must pass (positive); then remove the explicit `FOR KEY SHARE` lock (the `.for('key share')` select in
   `apps/collab/src/recorder.ts`), run the same command and it must FAIL (negative: without
   the lock the write commits while the snapshot holds the document row); then restore
   `recorder.ts`.

## Other checks run for this task

| Command | Result |
| --- | --- |
| `pnpm vitest run` | 53 files passed; 572 tests passed, 30 skipped (the env-gated `*.pg.test.ts` and the S3 case) |
| `pnpm typecheck` | exit 0 (includes `e2e/**` and `playwright.config.ts`) |
| `pnpm --filter @living-wiki/web build` | exit 0 |
| `pnpm install --frozen-lockfile` | up to date |
