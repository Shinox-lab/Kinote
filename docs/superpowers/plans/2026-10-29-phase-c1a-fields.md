# Phase C1a: collection fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page can be turned into a collection with typed fields, and each direct sub-page (row) shows, edits,
snapshots, reviews, restores and indexes its field values.

**Architecture:** Field definitions are Postgres rows (`collections`, `collection_fields`). Values live in a `fields`
Y.Map in each row's page Y.Doc, so co-editing, attribution, snapshots, review and restore reuse the page machinery.
Collab mirrors raw values into a `page_field_values` projection on every store (for C1b views). Readers validate values
against the current definitions and ignore what doesn't fit. Indexing writes a `Field: value` header into the row's
first chunk and page card.

**Tech Stack:** TypeScript, zod (contracts), drizzle + RLS (db), Yjs/Hocuspocus (collab), Fastify (api), React +
TanStack Query + BlockNote's Y.Doc (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-phase-c-collections-design.md` (C1–C5, C9 first part, C11 except rows,
C12; delivery part C1a).

## Global Constraints

- Field types exactly: `text`, `number`, `date`, `select`, `multi_select`, `person`, `checkbox`, `page`.
- Value shapes: text string; number number; date `{ start: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }` (no time); select option
  id; multi_select option id[]; person user id[]; checkbox boolean; page document id[]. Empty = key absent.
- Number `format`: `plain | decimal | percent | currency` (currency carries `code`, e.g. `USD`).
- Choices: `{ id, name, color }`. At most 50 fields per collection (`field_limit`).
- No field type changes after creation. No collections in the Inbox.
- Rows are direct sub-pages (kind `page`, not archived) of a collection page. Files and grandchildren are not rows.
- Index header line: `Field name: value`; dates `2026-12-01 (1 December 2026)`, a range `2026-12-01 to 2026-12-05 (1–5
  December 2026)`; choices and people by name; pages by title; checkbox `Yes`/`No`.
- Removing a field or choice never writes row documents; rows are re-indexed instead.
- New errors: `collection_not_found` 404, `field_not_found` 404, `field_invalid_value` 400, `field_limit` 400,
  `field_name_taken` 409, `collection_in_inbox` 400.
- Audit types: `collection.created`, `collection.removed`, `collection.field_added`, `collection.field_changed`,
  `collection.field_removed`.
- Copy: "Turn into collection", "Turn back into a page", "Add a field", "Fields", "N empty fields", confirmation
  "Launch date will be removed from 24 pages." (field name and count filled in).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `docker-compose.yml` or other
  sessions' uncommitted files.

## Review Focus

1. Existing pages with no `fields` map: snapshot content hash is byte-for-byte unchanged, so deploying this makes no
   new versions (Task 3 test `pages without fields keep their content hash`).
2. A client writes a value of the wrong shape (a string in a number field, an unknown choice id): projection, snapshot
   header, diff and UI ignore it; nothing throws (Task 1 `fieldValueFits` tests; Task 3 `ill-typed values are left out
   of the header`).
3. A row with an empty body but non-empty fields gets a version; a non-row empty page still gets none (Task 3).
4. A viewer can't change fields: PATCH is 403 and the UI shows values without editors (Task 4, Task 6 e2e).
5. A version restored after a field was removed brings the stale value back but it stays out of the header and UI
   (Task 5 `restore brings back fields; removed ones stay hidden`).

**Plan note (deviation from spec C4):** the projection stores raw values per page, independent of its parent, so a
move needs no projection rebuild; views (C1b) pick rows by parent and validate against the collection's fields. A
move only re-indexes (Task 4).

---

### Task 1: Field contracts and value logic

**Files:**
- Create: `packages/contracts/src/collections.ts`; export from `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/errors.ts` (codes, sentences, statuses above); `packages/contracts/src/index.ts`
  (audit types)
- Test: `packages/contracts/test/collections.test.ts`; update `apps/api/test/errors.test.ts` pins

**Interfaces:**
- Produces:
  - `FIELD_TYPES`, `type FieldType`, `FieldDefSchema` / `type FieldDef = { id, name, type, options, position }`,
    `options: { format?, code?, choices?: Choice[] }`
  - `FIELDS_MAP = 'fields'`, `FIELD_BLOCK_PREFIX = 'field:'`, `MAX_FIELDS = 50`
  - `fieldValueFits(def: FieldDef, value: unknown): boolean`
  - `validFields(defs: FieldDef[], raw: Record<string, unknown>): Record<string, unknown>` (only defined, fitting values)
  - `formatFieldValue(def, value, names: { users: Map<string,string>; pages: Map<string,string> }): string | null`
    (null when nothing printable, e.g. a person no longer a member)
  - `fieldLines(defs, raw, names): string[]` → `['Launch date: 2026-12-01 (1 December 2026)', …]` in `position` order
  - Request schemas: `CreateFieldRequestSchema { name, type, options? }`, `UpdateFieldRequestSchema { name?, options?,
    position? }`, `SetFieldsRequestSchema = record(uuid, unknown | null)`, `CollectionSchema { id, title, fields }`,
    `PageCollectionInfoSchema { collection: Collection | null, rowOf: Collection | null }`

- [ ] **Step 1: Write the failing tests**

```ts
test('values fit their type', () => {
  expect(fieldValueFits(date, { start: '2026-12-01' })).toBe(true);
  expect(fieldValueFits(date, { start: '2026-12-01T10:00' })).toBe(false);
  expect(fieldValueFits(date, { start: '2026-12-05', end: '2026-12-01' })).toBe(false); // end before start
  expect(fieldValueFits(num, '3')).toBe(false);
  expect(fieldValueFits(status, 'opt-active')).toBe(true);
  expect(fieldValueFits(status, 'opt-gone')).toBe(false);
  expect(fieldValueFits(tags, ['opt-a', 'opt-a'])).toBe(false); // no duplicates
  expect(fieldValueFits(owner, [USER_ID])).toBe(true);
  expect(fieldValueFits(done, 'yes')).toBe(false);
});
test('validFields drops unknown and ill-typed values', () => {
  expect(validFields([num], { [num.id]: 'x', other: 1 })).toEqual({});
});
test('fieldLines prints in field order, in words', () => {
  expect(fieldLines([status, launch, done], raw, names)).toEqual([
    'Status: Active', 'Launch date: 2026-12-01 (1 December 2026)', 'Done: No',
  ]);
  expect(formatFieldValue(launch, { start: '2026-12-01', end: '2026-12-05' }, names))
    .toBe('2026-12-01 to 2026-12-05 (1–5 December 2026)');
  expect(formatFieldValue(owner, [GONE_USER], names)).toBeNull();
  expect(formatFieldValue(price, 12.5, names)).toBe('USD 12.50');
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/contracts/test/collections.test.ts` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement** `packages/contracts/src/collections.ts` and the error/audit additions. Date words use
  `Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })`; a range in one
  month collapses to `1–5 December 2026`, otherwise `30 November – 2 December 2026`. Checkbox `false` prints `No`
  (an absent checkbox prints nothing).
- [ ] **Step 4: Run** the test file and `pnpm vitest run apps/api/test/errors.test.ts` — Expected: PASS
- [ ] **Step 5: Commit** `feat(contracts): collection field types and values`

### Task 2: Tables and migrations

**Files:**
- Create: `packages/db/src/schema/collections.ts` (export from the schema index)
- Modify: `packages/db/src/schema/pages_and_index.ts` (`versions.fields jsonb` nullable)
- Create: migrations `0032_c1a_collections.sql` (`pnpm db:generate`), `0033_c1a_collections_rls.sql`
  (`drizzle-kit generate --custom` + `node packages/db/scripts/gen-rls.mjs --tables collections,collection_fields,page_field_values`)
- Test: existing Postgres suite (`pgtest.sh`) and `pnpm vitest run packages/db`

**Interfaces:**
- Produces:
  - `collections { documentId pk → documents.id cascade, tenantId, createdBy, createdAt }`
  - `collectionFields { id, tenantId, collectionId → collections.documentId cascade, name, type, options jsonb default
    {}, position text, createdAt }`, unique index on `(tenant_id, collection_id, lower(name))`
  - `pageFieldValues { tenantId, pageId → documents.id cascade, fieldId uuid (no FK: stale ids allowed), value jsonb,
    updatedAt }`, unique `(tenant_id, page_id, field_id)`, index `(tenant_id, field_id)`

- [ ] **Step 1:** Write the schema; generate both migrations; check the SQL by eye (RLS policies on all three tables).
- [ ] **Step 2: Run** `bash <scratchpad>/pgtest.sh` and `pnpm typecheck` — Expected: all pass, 0 errors
- [ ] **Step 3: Commit** `feat(db): collections, fields and field value tables`

### Task 3: Collab and snapshot carry fields

**Files:**
- Modify: `apps/collab/src/attribution.ts` (`changesPage` counts the `fields` root; `changedBlockIds` adds
  `field:<key>` for each key changed in it), `apps/collab/src/server.ts` (`store` rewrites the page's
  `page_field_values` from the stored state's `fields` map in the same transaction), `apps/collab/src/internal.ts`
  (new `/internal/set-fields`; `replace-blocks` takes optional `fields`), `packages/shared/src/collabClient.ts`
  (`setFields`, `replaceBlocks({…, fields?})`), `packages/contracts/src/index.ts` (collab request schemas), test
  in-process client `apps/api/test/support/inProcessCollab.ts`
- Create: `packages/core/src/collections/fields.ts`
- Modify: `packages/core/src/snapshot.ts`
- Test: `apps/collab/test/fields.test.ts`, `packages/core/test/snapshot.fields.test.ts`

**Interfaces:**
- Consumes: Task 1 `FIELDS_MAP`, `validFields`, `fieldLines`; Task 2 tables.
- Produces:
  - `CollabClient.setFields({ tenantId, pageId, values: Record<string, unknown | null>, actor, source: 'human' |
    'agent' })` — one transaction; null deletes the key
  - core `rowCollectionOf(tx, tenantId, pageId): Promise<{ collectionId: string; fields: FieldDef[] } | null>`
  - core `collectionFieldDefs(tx, tenantId, collectionId): Promise<FieldDef[]>`
  - core `fieldNames(tx, tenantId, defs, raw): Promise<{ users; pages }>` (members' display names; readable-agnostic
    page titles, archived → absent)
  - `takePageSnapshot` writes `versions.fields` = the raw map (null when empty)

- [ ] **Step 1: Write the failing tests**
  - collab: `a fields change is a page change attributed to field:<id>` — a human transaction setting
    `fields.<id>` makes `block_activity` row `field:<id>` and a pending contributor; `store mirrors the fields map
    into page_field_values` (set two, delete one, store → exactly one row); `set-fields applies values and null clears`.
  - core: `pages without fields keep their content hash` (hash equals `sha256('# T\n\n' + markdown)` as before);
    `a field change makes a new version with fields`; `a row with only fields is snapshotted; a plain empty page is
    not`; `ill-typed values are left out of the header` (via `fieldLines` on the version).
- [ ] **Step 2: Run** `pnpm vitest run apps/collab/test/fields.test.ts packages/core/test/snapshot.fields.test.ts` —
  Expected: FAIL
- [ ] **Step 3: Implement.** Snapshot: read `ydoc.getMap(FIELDS_MAP).toJSON()`; when non-empty, hash
  `indexedPayload + '\n\n' + canonicalJson(fields)` (sorted keys); when empty, hash exactly as today. The empty-body
  rule becomes: no markdown AND (not a row OR no valid fields) → today's behaviour.
- [ ] **Step 4: Run** the two test files, then `pnpm vitest run apps/collab packages/core` — Expected: PASS
- [ ] **Step 5: Commit** `feat(collab): page field values live in the page document`

### Task 4: Collections API

**Files:**
- Create: `apps/api/src/routes/collections.ts`; wire in `apps/api/src/server.ts`; client methods in
  `apps/web/src/lib/api.ts`
- Modify: `apps/api/src/routes/pages.ts` (`getPageDetails` adds `collection`/`rowOf`; `movePage` re-indexes a page
  whose row-ness changed), `packages/core/src/indexing/` (new `reindexDocument`), worker registry (`document.reindex`)
- Test: `apps/api/test/collections.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas, Task 3 `setFields`, `rowCollectionOf`, `collectionFieldDefs`.
- Produces (routes, all under `/api/v1`):
  - `POST /pages/:id/collection` → 201 `Collection`; `DELETE /pages/:id/collection` → 204 (editor of the space;
    `collection_in_inbox` in the Inbox; audit `collection.created`/`removed`; DELETE enqueues re-index of every row)
  - `GET /collections/:id` → `Collection` (viewer)
  - `POST /collections/:id/fields` → 201 `FieldDef`; `PATCH /collections/:id/fields/:fieldId`; `DELETE …` → 204.
    PATCH that removes choices and DELETE enqueue `document.reindex` for every row; GET
    `/collections/:id/fields/:fieldId/usage` → `{ pages: number }` for the confirmation copy
  - `PATCH /pages/:id/fields` body `SetFieldsRequest` → 200 `{ fields }` (valid values after the write); editor of a
    live row; each value checked with `fieldValueFits` (`field_invalid_value`), unknown field `field_not_found`
  - core `reindexDocument(tenantId, documentId, provider)`: re-chunks and re-embeds the document's indexed version in
    place (status unchanged) and rebuilds its page card; job `document.reindex { documentId }` with idempotency key
    `reindex:<documentId>:<epoch ms>`

- [ ] **Step 1: Write the failing tests** — `turn a page into a collection and back`; `fields: add, rename, reorder,
  remove; names unique case-insensitively; 51st field is field_limit`; `no collections in the Inbox`; `a viewer reads
  but can't change fields or values (403)`; `PATCH values: valid ones stored, wrong shape is field_invalid_value, null
  clears`; `a sub-page shows rowOf; a grandchild and a file don't`; `removing a choice re-indexes rows and Search no
  longer finds its name`; `moving a row out of its collection drops its header from Search`.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/collections.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** the routes and `reindexDocument`.
- [ ] **Step 4: Run** the file, then `pnpm vitest run apps/api apps/worker` — Expected: PASS
- [ ] **Step 5: Commit** `feat(api): collections and field values`

### Task 5: Index header, diffs, history and restore

**Files:**
- Modify: `packages/core/src/indexing/chunkPage.ts` (`chunkPageBlocks(title, blocks, opts?, header?: string[])`: the
  header lines go at the top of the first chunk's text), `packages/core/src/indexing/indexVersion.ts`,
  `packages/core/src/placement/pageCard.ts` (header joins the embedded text and the summary input),
  `apps/api/src/pages/diff.ts` (new `withFieldLines(blocks, lines: Array<{ fieldId, text }>)` appends paragraph
  blocks with id `field:<fieldId>` so `diffBlocks` diffs them), `apps/api/src/routes/pages.ts` (changes, compare,
  version diff use it; `restorePageVersion` passes `version.fields` to `replaceBlocks`)
- Test: `packages/core/test/indexVersion.fields.test.ts`, `apps/api/test/diff.test.ts`, `apps/api/test/restore.test.ts`

**Interfaces:**
- Consumes: Task 1 `fieldLines`, Task 3 `rowCollectionOf`, `fieldNames`, `replaceBlocks({ fields })`.

- [ ] **Step 1: Write the failing tests** — `a row's first chunk starts with its field lines and Search finds
  "December"`; `a review space keeps the approved value in Search until approval`; `the changes diff shows "Status:
  Lead" → "Status: Active" as changed`; `restore brings back fields; removed ones stay hidden`.
- [ ] **Step 2: Run** those files — Expected: FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm vitest run` — Expected: PASS
- [ ] **Step 5: Commit** `feat(index): field values are indexed, diffed and restored`

### Task 6: Fields on the page (web)

**Files:**
- Create: `apps/web/src/components/fields/FieldsPanel.tsx` (row values, bound to `live.ydoc.getMap(FIELDS_MAP)`),
  `apps/web/src/components/fields/FieldEditor.tsx` (one editor per type), `apps/web/src/components/fields/FieldSetup.tsx`
  (collection page: add, rename, reorder, remove fields; edit choices with confirmation), `apps/web/src/lib/fields.ts`
  (pure helpers: display text, empty count, next choice color)
- Modify: `apps/web/src/routes/page.tsx` (panel under the header), `apps/web/src/components/PageActions.tsx` (menu items
  "Turn into collection" / "Turn back into a page"), `apps/web/src/lib/queries.ts`
- Test: `apps/web/test/fields.test.ts`, `e2e/collections.spec.ts`

**Interfaces:**
- Consumes: Task 4 API (`createCollection`, `removeCollection`, `addField`, `updateField`, `removeField`,
  `fieldUsage`), page details `collection` / `rowOf`.
- Rules: editors write the Y.Map directly (live, attributed by collab); readers see values only. Person picker uses the
  existing mentionable list; page picker uses `listLinkTargets`. Choices can be added from the select menu by an
  editor. Empty fields collapse behind "N empty fields".

- [ ] **Step 1: Write the failing tests** — unit: display text per type and the empty count. e2e: `turn Clients into a
  collection, add Status and Launch date; a sub-page fills them; another browser sees them live; Search finds the
  launch month after snapshot`; `a viewer sees values without editors`; `removing a field asks "Launch date will be
  removed from 1 page."` (plural "pages" from 2).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/fields.test.ts` and `pnpm e2e:local collections` — Expected: FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm typecheck`, `pnpm --filter @living-wiki/web build`, `pnpm vitest run`, full
  `pnpm e2e:local` — Expected: all pass
- [ ] **Step 5: Commit** `feat(web): collection fields on pages`
