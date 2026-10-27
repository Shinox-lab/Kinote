# Routing 3d: Documents Get Their Own Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A capture that is a document (meeting notes, minutes, a report) becomes one new page placed where pages like it live. Its facts still update the pages that hold standing facts. Updates keep today's flow. The work also commits this session's routing fixes.

**Architecture:**
- The split call also returns the capture's shape.
- `routeCapture` now stores facts and shape first (`ensureSplit`).
- For a document, it then plans and creates the page (new `routing/document.ts`).
- Facts are planned in a "from document" mode: the new page is excluded, and anything unsure is filed on the new page.
- Every planner call sees the page tree around its candidates.
- The API and console gain the document receipt header, Needs a home for documents, and the "File as" control.

**Tech Stack:** TypeScript pnpm monorepo: Drizzle and Postgres (PGlite in tests), Zod contracts, Fastify, React 19, TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-routing-documents-design.md` (addendum to `docs/superpowers/specs/2026-10-26-routing-engine-design.md`).

## Global Constraints

- Shape threshold: a capture is a document only when the model's shape confidence is ≥ 0.6 (`ROUTING.document = 0.6`), or when the sender chose **New page**.
- Placement uses the edit threshold `ROUTING.apply` (0.6) and the margin `ROUTING.margin` (0.1). It never uses `ROUTING.create`. R9 is unchanged for updates.
- Every capture is split into facts. The shape only decides whether the note *also* gets a page.
- The document page holds the capture text as written. Only the title is added. Every block cites the capture (R12).
- The page tree shown to the model has, per candidate: the titles of its ancestors (`path`), and up to 10 sibling titles and 10 child titles, newest first.
- A parent is chosen only in spaces the sender can edit. The Inbox is never a parent or a candidate (R17).
- A duplicate title among live siblings gets a suffix `" (2)"`, `" (3)"`, … (compared case-insensitively).
- In document mode, standing facts may insert, replace, propose a removal (a suggestion, R2) or be already known. They never create pages and never ask questions. Anything unsure is `filed_in_document`.
- Copy, exactly:
  - "New page: {title} under {parent}", or "New page: {title} in {space}" at the top of a space
  - "Also updated"
  - "1 fact kept on the new page" / "{n} facts kept on the new page"
  - "On the new page" (fact outcome label)
  - "Where should “{title}” go?", "Create page", "Route as updates instead"
  - "File as": "Auto", "New page", "Updates only"
- New error: 409 `document_not_waiting` — "This capture's page is not waiting for a place."
- New audit types: `capture.document_created`, `capture.document_placed`, `capture.document_moved`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage the owner's `docker-compose.yml` port change (`WEB_HOST_PORT:-8081`).

## Review Focus

1. **A retried run after the page was created makes no second page.** The page id is stored in the same transaction that creates the page (Task 6 test).
2. **No editable space for the best parent.** The note waits in Needs a home with a reason; it is never created in a random writable space (Task 5 test).
3. **"Updates only" on a note that looks like a document makes no page, and "New page" on a one-line note does** (Task 6 test).
4. **Undo all after a person edited the new page** leaves the page alone and reports it as "changed since" (Task 7 test).
5. **A document longer than 3,000 characters** takes its shape from the first part, and its facts come from every part (Task 6 test).

---

### Task 1: Commit this session's routing fixes

**Files:** already modified in the working tree:
- `.env.example`, `docker-compose.yml` (ROUTER_* lines only), `infra/e2e.sh`
- `apps/worker/src/main.ts`
- `packages/core/src/llm/chatJson.ts`, `packages/core/src/placement/model.ts`
- `packages/core/test/placementModel.test.ts`, `packages/core/test/routingModel.test.ts`
- `packages/shared/src/config.ts`, `packages/shared/src/index.ts`, `packages/shared/test/config.test.ts`
- `docs/superpowers/specs/2026-10-27-routing-documents-design.md`, this plan.

- [ ] **Step 1: Branch.** `git checkout -b routing-3d`
- [ ] **Step 2: Verify.** Run `pnpm typecheck && pnpm vitest run packages/core/test/placementModel.test.ts packages/core/test/routingModel.test.ts packages/shared/test/config.test.ts`. Expected: 0 type errors, 48 passed.
- [ ] **Step 3: Stage `docker-compose.yml` without the port hunk.**
  1. `git diff docker-compose.yml > /tmp/dc.patch`
  2. Delete the `@@ -192,7` hunk (the `8081` change) from the patch.
  3. `git apply --cached /tmp/dc.patch`
  4. Check: `git diff --cached docker-compose.yml` shows only `ROUTER_*`, and `git diff docker-compose.yml` still shows `8081`.
- [ ] **Step 4: Commit.** Stage the other files by name:
  ```
  fix(routing): real router config, flat model edits, reasoning off

  - docker-compose passes ROUTER_*; the worker refuses the deterministic router
    beside real embedding or Ask models and logs its router
  - the planner reads the flat edit shape and asks again when no edit is readable
  - ROUTER_REASONING=off; an answer cut off at max_tokens fails at once with the reason
  - spec addendum and plan 3d
  ```

### Task 2: Schema, migration and contracts

**Files:**
- Modify: `packages/db/src/schema/routing.ts`
- Create: `packages/db/migrations/0027_routing_documents.sql`, via `pnpm db:generate` or by hand in the existing style. Add the journal entry in `meta`.
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`
- Test: `packages/db/test/routingSchema.test.ts`, `packages/contracts/test/` (the existing contracts test file for captures, or a new `routingDocuments.test.ts`)

**Interfaces — Produces:**

`captures` gains these columns:
- `shape_mode` text enum `['auto','document','updates']`, not null, default `'auto'`
- `shape` text enum `['document','updates']`, null until split
- `subject` text, null
- `document_title` text, null
- `document_page_id` uuid, references `documents.id` on delete set null
- `document_outcome` text enum `['pending','needs_home','created']`, null
- `document_reason` text, null
- `document_options` jsonb, null: `[{ pageId, title, spaceId, spaceName }]`, at most 3
- `document_parent_choice` uuid, null
- `document_space_choice` uuid, null

Other tables:
- `FACT_OUTCOMES` gains `'filed_in_document'`.
- `capture_changes.fact_id` becomes nullable. Changes of the document page have no fact.
- `routing_examples` gains `kind` text enum `['fact','document']`, not null, default `'fact'`.

Contracts:
- `CreateCaptureRequestSchema` gains `shape: z.enum(['auto','document','updates']).default('auto')`.
- `CaptureSummarySchema` gains `shapeMode` and `shape` (nullable).
- `CaptureChangeSchema.factId` becomes `.nullable()`.
- `FactStatusSchema.outcome` gains `filed_in_document`.
- `CaptureReceiptSchema` gains:
  - `document: z.object({ pageId: uuid.nullable(), title: z.string(), outcome: z.enum(['pending','needs_home','created']), parentTitle: z.string().nullable(), spaceName: z.string().nullable(), reason: z.string().nullable(), changeIds: z.array(uuid) }).nullable()`
  - `filedInDocument: z.array(z.object({ factId: uuid, statement: z.string() }))`
- `NeedsHomeDocumentSchema`: `{ captureId, title, subject: nullable, reason: nullable, options: [{ pageId, title, spaceId, spaceName }], createdAt }`, plus `NeedsHomeDocumentListSchema`.
- `PlaceDocumentRequestSchema = z.object({ parent_page_id: uuid.optional(), space_id: uuid.optional(), title: z.string().trim().min(1).max(200).optional() }).refine(exactly one of parent_page_id / space_id)`
- `MoveDocumentRequestSchema = z.object({ parent_page_id: uuid })`
- Error code `document_not_waiting` (409) with the copy from Global Constraints. The three audit types.

- [ ] **Step 1: Write the failing tests.**
  - `routingSchema.test.ts`, test "a capture keeps its shape and document fields; a document change has no fact": insert a capture with `shape: 'document'`, `documentOutcome: 'created'`, `documentOptions: [{…}]`; insert a fact with outcome `'filed_in_document'`; insert a `capture_changes` row with `factId: null`; insert a routing example with `kind: 'document'`. Read them back equal.
  - Contracts test:
    - `CreateCaptureRequestSchema.parse({ text: 'x' }).shape === 'auto'`
    - `PlaceDocumentRequestSchema` refuses both ids at once, and refuses neither.
    - `CaptureChangeSchema` accepts `factId: null`.
- [ ] **Step 2: Run them.** Run `pnpm vitest run packages/db/test/routingSchema.test.ts packages/contracts`. Expected: FAIL (unknown columns or properties).
- [ ] **Step 3: Implement the schema, the migration and the contracts above.** The migration only adds columns, so RLS needs no change. Update `toCaptureSummary` in `apps/api/src/routes/captures.ts` for the two new summary fields, so typecheck stays green.
- [ ] **Step 4: Check.**
  1. Run the Step 2 command. Expected: PASS.
  2. Run `pnpm typecheck`. Expected: 0 errors.
  3. Run `bash /private/tmp/claude-501/-Users-desmondfoo-Downloads-living-wiki/9fb567f7-0b77-4fba-99d7-69dc2e0e0d40/scratchpad/pgtest.sh`. Expected: all pass. The migration must apply on real Postgres.
- [ ] **Step 5: Commit.** `feat(db): capture shape and document fields`

### Task 3: Model — shape in the split, the subject in every fact, page tree, document placement

**Files:**
- Modify: `packages/core/src/placement/model.ts`
- Test: `packages/core/test/routingModel.test.ts`

**Interfaces — Produces:**
```ts
export interface CaptureShape { shape: 'document' | 'updates'; confidence: number; subject: string | null; title: string | null }
// splitCapture now returns the shape too (null only when the model's answer has none):
splitCapture(input: { text: string }): Promise<{ facts: CaptureFact[]; shape: CaptureShape | null }>;
// PlanCandidate gains the page tree:
interface PlanCandidate { /* existing */ spaceId: string; parentId: string | null; path: string[]; siblings: string[]; children: string[] }
// PlanEditsInput gains:
fromDocument: { title: string } | null;
export interface DocumentPlacement { spaceId: string; parentId: string | null; title: string; confidence: number; reason: string }
export interface PlaceDocumentInput {
  title: string; subject: string | null; text: string; // text: the capture's first part (≤ 3,000 chars)
  candidates: PlanCandidate[]; examples: Array<{ statement: string; chosenTitle: string }>;
  writableSpaces: Array<{ id: string; name: string }>;
}
// RoutingModel gains:
placeDocument(input: PlaceDocumentInput): Promise<{ placements: DocumentPlacement[] }>; // best first, at most 3
```

Deterministic rules (exact, so the e2e and eval runs are predictable):
- **Shape.**
  - A capture is a `document` (confidence 0.8) when it has at least 4 non-empty lines and at least 3 of them start with `-`, `*`, `#` or `\d+\.`.
  - Its `title` is the first non-empty line, stripped of leading `#`, `*` and `-` marks and of surrounding `**`, and cut to 120 characters.
  - Its `subject` is the first `NAME_RE` match in the title that is not a stop word, or `null`.
  - Otherwise the capture is `updates` (confidence 0.9) with `subject` and `title` null.
- **Split.**
  - Leading list and heading markers (`-`, `*`, `#`, `\d+.`) are stripped from each statement.
  - For a document, the title line is not a fact.
  - A non-null subject is added to a fact's `names` when it is missing there.
- **`placeDocument`.**
  - Look at candidates whose title includes the subject (case-insensitive) first, then the rest, in order.
  - The first candidate with children becomes the parent.
  - Otherwise, the first candidate with a `parentId` and at least one sibling: its parent becomes the parent.
  - The placement uses `title` from the input, confidence 0.8 and reason "Pages like this live here."
  - If nothing qualifies, return no placements.
- **`planEdits` with `fromDocument`.** Skip the final "closest page at 0.5" fallback, so it plans nothing when no block is named.

OpenAI model:
- **Split prompt** also asks for `"shape"`, `"confidence"`, `"subject"` and `"title"` at the top level.
  - A document is self-contained notes such as meeting notes, minutes, a report or a call summary. Updates are statements about things the wiki already holds.
  - Each statement must carry the note's subject, e.g. "On the RYKO website, …".
- **`FactsSchema`** reads the shape leniently. An unknown shape is `updates`, and confidence is clamped to 0–1.
- **`planEdits` prompt:**
  - For each candidate, add a line `Path: A > B | Siblings: … | Children: …`.
  - When `fromDocument` is set, add: "This fact comes from the document "{title}", which is already filed as its own page. Propose an edit only where the fact changes or adds to what another page states as standing information; otherwise return no edits. Never create a page."
- **`placeDocument` prompt:**
  - Return `{"placements":[{"spaceId","parentId","title","confidence","reason"}]}`, flat, best first, at most 3.
  - Choose the parent where pages like this already live, and title the page like its siblings.
  - Use only page and space ids shown.
  - Parse leniently, like `EditsSchema`: an empty list when items are unreadable, and ask again when no item was readable at all.

- [ ] **Step 1: Write the failing tests** in `routingModel.test.ts`:
  - `'a note with a title line and a list is a document; its title line is not a fact'`:
    - Input: `'Oct 14 meeting with Ryko\n1. Hero video swap.\n2. Shop The Look.\n3. Launch end of December.'`
    - Expect `shape` to be `{ shape: 'document', confidence: 0.8, subject: 'Ryko', title: 'Oct 14 meeting with Ryko' }`.
    - Expect statements `['Hero video swap.', 'Shop The Look.', 'Launch end of December.']`.
    - Expect each fact's `names` to contain `'Ryko'`.
  - `'one sentence is updates'`: `'George video cost is RM200.'` → `{ shape: 'updates', confidence: 0.9, subject: null, title: null }`.
  - `'placeDocument picks the candidate with children, subject first'`:
    - Candidates: `29Sep` (`parentId: george`, `siblings: ['Meeting 1']`) and `Client - George` (`children: ['29Sep','Meeting 1']`). Subject `'George'`.
    - Expect `placements[0]` to be `{ parentId: 'george', spaceId, title: 'Oct 14 meeting', confidence: 0.8 }`.
    - With no tree on either candidate, expect `placements` to be `[]`.
  - `'fromDocument skips the low-confidence fallback'`: `plan(fact('Lunch is at noon.','new',[]), [runbook])` with `fromDocument: { title: 'X' }` → `edits` is `[]`.
  - `'the OpenAI split reads the shape leniently'`:
    - Reply `{ shape: 'memo', confidence: 3, subject: 'Ryko', title: 'T', facts: [...] }` → `shape` is `{ shape: 'updates', confidence: 1, subject: 'Ryko', title: 'T' }`.
    - A reply without shape fields → `shape: null`.
  - `'the OpenAI planner sees each candidate's page tree and the document rule'`: capture the request body. Expect the user message to contain `'Path: Clients > Client - George'` and `'Children: 29Sep'`. With `fromDocument`, expect it to contain `'already filed as its own page'`.
  - `'the OpenAI placement reads flat placements and asks again when none is readable'`: same pattern as the existing flat-edits test.
- [ ] **Step 2: Run.** Run `pnpm vitest run packages/core/test/routingModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces and rules above in `model.ts`.
  - Existing deterministic tests that build `PlanCandidate` need the new fields. Add `spaceId: 's'`, `parentId: null`, `path: []`, `siblings: []`, `children: []` to the fixtures in `routingModel.test.ts`.
  - Existing callers of `splitCapture` keep reading `.facts`.
- [ ] **Step 4: Check.** Run the Step 2 command, then `pnpm typecheck`. Expected: PASS, 0 errors. Typecheck may flag `plan.ts`, which must set the new `PlanCandidate` fields. Task 4 fills them; for now set `parentId: doc.parentId`, `spaceId: doc.spaceId` and empty arrays.
- [ ] **Step 5: Commit.** `feat(core): capture shape, subject in facts, page tree and document placement in the routing model`

### Task 4: Page tree for every planner call

**Files:**
- Modify: `packages/core/src/routing/plan.ts` (`gatherCandidates`)
- Test: `packages/core/test/routingPlan.test.ts`
- Modify: `packages/core/test/fixtures/routingSeed.ts`. `livePage` gains an optional 5th argument `opts: { parentId?: string }`, which sets `documents.parent_id`.

**Interfaces — Produces:** `pageTree(tx, tenantId, doc: { id, parentId, spaceId }): Promise<{ path: string[]; siblings: string[]; children: string[] }>`, exported from `plan.ts`.
- `path` is the ancestors' titles, root first. Use a recursive query, at most 10 levels.
- `siblings` and `children` are live (not archived) page titles, newest `created_at` first, at most 10 each. The page itself is excluded from its siblings.

- [ ] **Step 1: Write the failing test** `'the planner sees each candidate's path, siblings and children'`:
  - Space `Clients`. Page `Client - George` (`'George is a client.'`). Children `Meeting 1` and `29Sep` (`'George hero video notes.'`).
  - Record `planEdits` input with the `Object.assign(Object.create(model), …)` wrapper used in `capturePlace.test.ts`.
  - Capture `'George hero video moved to Friday.'`.
  - Expect the `29Sep` candidate to have `path: ['Client - George']`, `siblings: ['Meeting 1']`, `children: []`.
  - Expect `Client - George` to have `children: ['29Sep', 'Meeting 1']` (newest first: create 29Sep last).
- [ ] **Step 2: Run.** Run `pnpm vitest run packages/core/test/routingPlan.test.ts -t "path, siblings"`. Expected: FAIL (empty arrays).
- [ ] **Step 3: Implement** `pageTree` and call it per candidate in `gatherCandidates`.
- [ ] **Step 4: Check.** Run `pnpm vitest run packages/core/test/routingPlan.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit.** `feat(core): planner sees the page tree around candidates`

### Task 5: Document placement plan

**Files:**
- Create: `packages/core/src/routing/document.ts`. Export from `packages/core/src/index.ts`.
- Test: `packages/core/test/routingDocument.test.ts`

**Interfaces:**
- Consumes:
  - `RoutingModel.placeDocument` (Task 3), `pageTree` (Task 4);
  - `gatherCandidates`. Export it from `plan.ts` with an optional `exclude?: string` page id;
  - `senderActor`, `senderAccess`, and `captureParts` from `plan.ts`.
- Produces:
```ts
export type DocumentPlan =
  | { status: 'place'; spaceId: string; parentId: string | null; title: string; confidence: number; reason: string }
  | { status: 'needs_home'; reason: string; options: Array<{ pageId: string; title: string; spaceId: string; spaceName: string }> };
export async function planDocument(
  params: { tenantId: string; captureId: string; title: string; subject: string | null; names: string[] },
  deps: { model: RoutingModel; embedder: EmbeddingProvider }
): Promise<DocumentPlan>;
export async function uniqueChildTitle(tx: DbTransaction, tenantId: string, spaceId: string, parentId: string | null, title: string): Promise<string>;
export async function similarDocumentExamples(tx, tenantId, spaceIds: string[], vector: number[]); // kind = 'document', up to 5
```

Rules:
1. **A page scope** (`capture.scopePageId`) is the parent at confidence 1. No model call. It must be live and in an editable space; otherwise the result is needs home, "You can't add pages here."
2. **Candidates.** Gather with a fact `{ statement: first captureParts part, kind: 'new', names, date: null }`, limited to the scope space when one is set. Names are resolved like `planFact` does, with ambiguous names skipped and never asked about.
3. **Model call.** Call `placeDocument` with the candidates and their trees, document examples (`kind = 'document'`), and the writable spaces.
4. **Valid placements:**
   - the space is editable by the sender;
   - the parent is null, or a live non-Inbox page in that space;
   - confidence ≥ `ROUTING.apply`.

   When the best placement by confidence sits in a space the sender can only read, the result is needs home, "The best place is in a space you can't edit."
5. **Margin.** If the top two valid placements have different parents and are within `ROUTING.margin` of each other, the result is needs home, "Two places fit this page about equally well."
6. **No valid placement:** needs home, "No place fits this page well enough."
7. **Options** on needs home: up to 3 distinct candidate parents in editable spaces, in this order: the model's placements, then candidates that have children.
8. **The title** of a `place` result goes through `uniqueChildTitle`.
9. **`ROUTING`** gains `document: 0.6`.

- [ ] **Step 1: Write the failing tests.** Seed: `Clients` with `Client - George` plus children `29Sep` and `Meeting 1`; a meeting-note capture (the Task 3 text, with George in the title).
  - `'a meeting note goes under the client page, titled as given'` → `place` with `parentId` = Client - George and `title: 'Oct 14 meeting with George'`.
  - `'a taken title gets a suffix'`: a child `'Oct 14 meeting with George'` already exists → title `'Oct 14 meeting with George (2)'`.
  - `'a page scope is the parent without asking the model'`: the recording model sees no `placeDocument` call → `place` under the scope page.
  - `'the best place in a read-only space waits'`: Client - George's space is viewer-only for the sender, and the sender edits another space → `needs_home` with reason `"The best place is in a space you can't edit."`.
  - `'two parents within the margin wait, with options'`: a stub model returns two placements at 0.8 and 0.75 under different parents → `needs_home` with both in `options`.
  - `'document examples teach placement'`: record a `kind: 'document'` example → the recording model receives it in `examples`. A `kind: 'fact'` example is not passed.
- [ ] **Step 2: Run.** Run `pnpm vitest run packages/core/test/routingDocument.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `document.ts`.
  - `recordRoutingExample` in `place.ts` gains an optional `kind: 'fact' | 'document'` (default `'fact'`).
  - `similarExamples` in `plan.ts` filters `kind = 'fact'`.
- [ ] **Step 4: Check.** Run `pnpm vitest run packages/core/test/routingDocument.test.ts packages/core/test/routingPlan.test.ts apps/worker/test/capturePlace.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(core): plan where a document's page goes`

### Task 6: Route documents: split once, create the page, file standing facts

**Files:**
- Modify: `packages/core/src/routing/apply.ts`, `packages/core/src/routing/plan.ts`
- Test: `apps/worker/test/captureRoute.test.ts`

**Interfaces:**
- Consumes: `planDocument` and `uniqueChildTitle` (Task 5); `splitCapture` returning the shape (Task 3).
- Produces:
```ts
// plan.ts
export async function splitCaptureText(text: string, model: RoutingModel, guard?: () => Promise<void>): Promise<{ facts: CaptureFact[]; shape: CaptureShape | null }>; // shape from the first part
export function decideShape(mode: 'auto' | 'document' | 'updates', shape: CaptureShape | null): 'document' | 'updates'; // auto: document iff shape.shape==='document' && confidence >= ROUTING.document
// FactPlan gains { status: 'filed_in_document'; reason: string }
// PlanDeps gains fromDocument?: { pageId: string | null; title: string }
// apply.ts
export async function ensureSplit(tenantId: string, captureId: string, deps: RouteDeps): Promise<CaptureRow>;
export async function createEnginePage(
  tenantId: string,
  page: { spaceId: string; parentId: string | null; title: string; markdown: string },
  ctx: { captureId: string; factId: string | null; quote: string; routerId: string; onCreated?: (tx: DbTransaction, pageId: string) => Promise<void> }
): Promise<{ pageId: string; state: 'pending_review' | 'indexing' }>;
```

The `routeCapture` flow, after taking the lease and setting the status to `routing`:
1. **`ensureSplit`.**
   - If the capture has no stored facts: run `splitCaptureText` on the capture text.
   - In one transaction: insert the facts (outcome `pending`), and set `shape = decideShape(shapeMode, shape)`, `subject`, and `document_title`. The title is the model's title, or else the first non-empty line cut to 120 characters.
   - An `updates` capture whose split is empty stores one `needs_home` fact, as today. A `document` capture with no facts still gets its page.
   - The function returns the capture row.
2. **When `shape === 'document'` and `document_outcome` is not `created` or `needs_home`:**
   1. **Placement.** If `document_parent_choice` or `document_space_choice` is set (a person chose), use it. Otherwise call `planDocument` with the stored `document_title` and `subject`, and with `names` set to the union of the stored facts' names.
   2. **Needs home.** Set `document_outcome = 'needs_home'`, `document_reason` and `document_options`, then `finishCapture` and stop. The facts stay pending.
   3. **Create.** Call `createEnginePage` with the capture text and `factId: null`. Its `onCreated` hook sets `document_page_id` and `document_outcome = 'created'` in the **same transaction** as the page insert. Then audit `capture.document_created`.
3. **When `shape === 'document'` and `document_outcome === 'needs_home'`:** `finishCapture` and stop.
4. **Plan the facts.** Call `planCapture` with `fromDocument: { pageId: document_page_id, title: document_title }` when the shape is document. In that mode:
   - `gatherCandidates` excludes the page;
   - ambiguous names are skipped rather than asked about;
   - `create_page` edits are dropped;
   - every `needs_home` result becomes `filed_in_document` with the same reason;
   - `planEdits` receives `fromDocument: { title }`.
5. **Apply.** `applyPlannedFacts` stores `filed_in_document` facts with their reason. In document mode, its "page changed while filing" fallback is `filed_in_document`.

Other changes:
- **`createPageFor`** (a fact's `create_page`) is rebuilt on `createEnginePage`. It writes the same rows as before.
- **Document page changes:** one `capture_changes` row per block (the first `op: 'create_page'`, the rest `'insert'`), with `fact_id` null. Citations are written with `factId` null and `quote` set to the block's Markdown, cut to 280 characters.
- **The fresh-split path in `planCapture`** stays for dry runs (`deps.facts` unset and no stored facts). It now uses `splitCaptureText`.

- [ ] **Step 1: Write the failing tests** in `captureRoute.test.ts`, with the deterministic model. Seed `Clients` with `Client - George` (`'George is a client. Launch is in November.'`) and its children `29Sep` and `Meeting 1`.
  - `'a meeting note becomes a page under the client page and its facts update standing pages'`:
    - Capture: `'Oct 14 meeting with George\n- George hero video swap.\n- Shop the look.\n- George launch moved to December.'`
    - Expect one new live page titled `Oct 14 meeting with George` under Client - George. Its live blocks hold the three list items. `capture.documentOutcome` is `'created'`.
    - Expect the fact `George launch moved to December.` to be `applied`, with a replace on Client - George.
    - Expect `Shop the look.` (no name, no edit) to be `filed_in_document`.
  - `'a retried run makes no second page'`:
    - Run `route` once.
    - Reset the capture status to `queued` and set every `applied` fact back to `pending`. This simulates the crash after the page was created.
    - Run `route` again. Exactly one page has that title.
  - `'Updates only on a list makes no page; New page on one line does'`:
    - The same list with `shapeMode: 'updates'` → no new page, and the facts are routed as updates.
    - `'George video cost is RM200.'` with `shapeMode: 'document'` → a page under Client - George.
    - `addCapture` gains an optional `shapeMode` in its scope argument.
  - `'a document with no clear parent waits with its facts'`: no client pages in the world, only an unrelated page → `documentOutcome: 'needs_home'`, a non-empty reason, every fact `pending`, capture status `done`.
  - `'a chosen parent creates the page and routes the waiting facts'`:
    - Continuing the previous test, set `document_parent_choice` to an existing page and `document_outcome = 'pending'`, then route.
    - Expect the page to be created under it, and no fact left `pending`.
  - `'a long document takes its shape from the first part and its facts from all parts'`:
    - A title line plus 3 list lines, then a paragraph break and filler sentences, so the text passes 3,000 characters.
    - Expect a page to be created, and some facts to come from the second part (a sentence from the tail is stored).
- [ ] **Step 2: Run.** Run `pnpm vitest run apps/worker/test/captureRoute.test.ts`. Expected: the new tests FAIL. The existing ones pass.
- [ ] **Step 3: Implement** the flow above.
- [ ] **Step 4: Check.**
  1. Run `pnpm vitest run apps/worker packages/core`. Expected: all PASS.
  2. Run `pnpm typecheck`. Expected: 0 errors.
- [ ] **Step 5: Commit.** `feat(core): documents get their own page; their facts update standing pages`

### Task 7: API — receipt, Needs a home for documents, place, route as updates, move, undo

**Files:**
- Modify: `apps/api/src/routes/captures.ts`, `apps/api/src/routes/captureChanges.ts`, `apps/api/src/routes/pages.ts`, and the route registration file where the capture routes are mounted (find it with `grep -rn "captures/:id/undo" apps/api/src`)
- Test: `apps/api/test/captures.test.ts`, `apps/api/test/captureChanges.test.ts`

**Interfaces — Produces** (HTTP):
- **`POST /api/v1/captures`** takes `shape` and stores it as `shape_mode`.
- **`GET /api/v1/captures/:id`:** the receipt gains `document` and `filedInDocument` (contracts from Task 2).
  - `document` is null for updates.
  - A document page in a space the viewer cannot read is left out and counted in `hiddenChanges`.
  - The document page's changes go in `document.changeIds` and never into `spaces`.
- **`GET /api/v1/needs-home/documents`:** captures with `document_outcome = 'needs_home'`. The sender's own captures; a tenant admin sees all. Newest first, at most 200.
- **`POST /api/v1/captures/:id/document/place`** (`PlaceDocumentRequestSchema`):
  - Allowed for the sender or an admin, and only while `document_outcome === 'needs_home'` (otherwise 409 `document_not_waiting`).
  - The parent must be a page the actor can edit (`targetPage(…, 'editor')`), or the space must be one the actor can edit.
  - Stores the choice and the optional title, sets `document_outcome = 'pending'`, and re-enqueues `capture.route` with the same idempotency key `capture:${id}`. Audits `capture.document_placed`.
  - When a parent was chosen, records a routing example `{ kind: 'document', statement: `${subject ?? ''} ${title}`.trim(), chosenDocumentId: parent }`.
- **`POST /api/v1/captures/:id/document/as-updates`:** same access and 409 rule. Sets `shape = 'updates'`, clears `document_outcome`, re-enqueues.
- **`POST /api/v1/captures/:id/document/move`** (`MoveDocumentRequestSchema`):
  - Requires `document_outcome === 'created'` (otherwise 409 `document_not_waiting`).
  - Calls `movePage(actor, pageId, { target_space_id: parent.spaceId, target_parent_id })`.
  - Records the document example with `wrongDocumentId` = the old parent. Audits `capture.document_moved`.
- **Undo:**
  - Extract `archivePageTx(tx, actor, pageId)` from `archivePage` in `pages.ts`: everything except the admin role check, which stays in `archivePage`.
  - In `undoChanges`, changes on the capture's `document_page_id` are undone as one unit:
    - if every one of their blocks still equals its `after_markdown` and the page has no live children, call `archivePageTx` and mark them undone;
    - otherwise list them all in `changedSince` and leave the page.
  - Who may undo: the same `mayUndo` (an editor of the page's space).
  - `undoCapture` (Undo all) and per-change undo both use this. Undoing a document change with `fact_id` null updates no fact outcome.

- [ ] **Step 1: Write the failing tests.** Route captures in the API tests the way the existing capture tests do (run the worker's pending jobs).
  - `captures.test.ts`:
    - `'the receipt leads with the new page and lists facts kept on it'`: `document` is `{ title: 'Oct 14 meeting with George', outcome: 'created', parentTitle: 'Client - George', spaceName: 'Clients' }` with `changeIds` non-empty. `spaces` does not include the new page. `filedInDocument` has `Shop the look.`.
    - `'a viewer who cannot read the page's space sees it only as hidden'`.
    - `'shape is stored from the request'`.
  - `captureChanges.test.ts`:
    - `'Needs a home lists a waiting document with its options; placing it creates the page'`: `GET /needs-home/documents` returns the item, then `POST …/document/place` with `parent_page_id` → after the jobs run, the receipt `document.outcome` is `'created'`. A second place call is 409 `document_not_waiting`.
    - `'route as updates files the facts without a page'`.
    - `'move puts the page under another parent and saves a document example'`.
    - `'undo all archives the new page and reverses standing edits'`.
    - `'undo all leaves the new page alone after a person edited it'`: edit one of its blocks through collab as a user first → that page's changes are listed in `changedSince`, the page stays live, and the standing edits are still undone.
- [ ] **Step 2: Run.** Run `pnpm vitest run apps/api/test/captures.test.ts apps/api/test/captureChanges.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the endpoints and changes above.
- [ ] **Step 4: Check.**
  1. Run `pnpm vitest run apps/api`. Expected: all PASS.
  2. Run `pnpm typecheck`. Expected: 0 errors.
- [ ] **Step 5: Commit.** `feat(api): document receipts, needs a home for documents, place, move and undo`

### Task 8: Evaluation set with documents

**Files:**
- Modify: `packages/core/eval/routing/corpus.json`, `captures.json`, `runEval.ts`, `cli.ts`
- Test: `packages/core/test/routingEval.test.ts`

**Interfaces — Produces:**
- Corpus pages may carry `children: [{ title, markdown }]`, seeded with `parent_id`.
- A labelled capture may carry `document: { parent: string }`. Its `expect` then lists standing edits matched as a set: each expected `{ documentTitle, op }` must be met by some planned edit of any fact; `fact` is ignored.
- `RoutingEvalResult` gains `documents` (labelled documents), `documentHits` (planned parent title equals the label) and `shapeMisses` (a labelled updates capture got a page, or a labelled document did not).
- A document placement counts as one placed fact, and a hit when its parent matches.
- The CLI prints `documents ${documentHits}/${documents}, shape misses ${shapeMisses}`. It fails when `shapeMisses > 0` or under the existing bar.
- The run is still a dry run: split with `splitCaptureText`, place with `planDocument`, then `planCapture` with `deps.facts` and `fromDocument: { pageId: null, title }`.

Corpus additions:
- `Acme account` gets children `Acme call 2 Sep` and `Acme call 16 Sep`.
- `Search team` gets `Search standup 30 Sep`.
- `Deploy runbook` gets `Deploy review 28 Sep`.
- Each child has one or two lines of meeting-style Markdown.

Labelled documents:
1. `"Acme call 30 Sep\n- Acme now pays monthly.\n- Priya Shah asked for the March report.\n- Next call in two weeks."` → `document.parent: "Acme account"`, `expect: [{ documentTitle: "Acme account", op: "replace" }]`.
2. `"Search standup 7 Oct\n- Daniel Okoro is on leave until May.\n- The search index rebuilds hourly now.\n- Nothing blocked."` → parent `"Search team"`, `expect: [{ documentTitle: "Search service", op: "replace" }]`.
3. `"Deploy review 5 Oct\n- Deploys now go out through Flux.\n- Rollbacks need two approvals.\n- Review again next month."` → parent `"Deploy runbook"`, `expect: [{ documentTitle: "Deploy runbook", op: "replace" }]`.

- [ ] **Step 1: Write the failing test** in `routingEval.test.ts` (deterministic model): `'documents are placed under their expected parent and updates stay updates'` → `documents === 3`, `documentHits === 3`, `shapeMisses === 0`, `hitRate >= 0.9`, `wrongRemovals === 0`.
- [ ] **Step 2: Run.** Run `pnpm vitest run packages/core/test/routingEval.test.ts`. Expected: FAIL (`documents` undefined).
- [ ] **Step 3: Implement** the corpus, labels, seeding of children and scoring. If a deterministic rule makes one standing label unreachable, change the label's text, not the rule, and ledger it.
- [ ] **Step 4: Check.**
  1. Run the Step 2 command. Expected: PASS.
  2. Run `pnpm routing:eval`. Expected: `PASS`.
- [ ] **Step 5: Commit.** `test(eval): labelled documents in the routing evaluation`

### Task 9: Console — File as, the document receipt, Needs a home for documents

**Files:**
- Modify:
  - `apps/web/src/lib/capture.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`
  - `apps/web/src/components/capture/CaptureBox.tsx`, `Receipt.tsx`, `NeedsHome.tsx`
- Test: `apps/web/test/capture.test.ts`, `e2e/capture.spec.ts`

**Interfaces — Produces:**
- **`lib/capture.ts`:**
  - `SHAPE_OPTIONS = [{ value: 'auto', label: 'Auto' }, { value: 'document', label: 'New page' }, { value: 'updates', label: 'Updates only' }]`
  - `documentHeadline(d: NonNullable<CaptureReceipt['document']>): string` gives:
    - `created` with a parent → `New page: ${title} under ${parentTitle}`;
    - `created` at the top of a space → `New page: ${title} in ${spaceName}`;
    - `needs_home` → `Where should “${title}” go?`;
    - `pending` → `Creating ${title}…`.
  - `keptText(n: number): string | null`: 0 → null; 1 → `'1 fact kept on the new page'`; n → `'${n} facts kept on the new page'`.
  - `outcomeLabel('filed_in_document') === 'On the new page'`.
- **`api.ts`:**
  - `createCapture` body gains `shape`;
  - `needsHomeDocuments()`;
  - `placeDocument(id, body)`, `routeAsUpdates(id)`, `moveDocument(id, body)`.
- **`queries.ts`:** `useNeedsHomeDocuments()`, keyed through `useTenantKey` and refreshed when captures finish, the same way `useNeedsHome` is.
- **`CaptureBox`:** a "File as" select bound to `shape`, next to "Limit to". The default is Auto.
- **`Receipt`:** when `receipt.document` is set, the card leads with the headline. For a created page:
  - the headline links to the page with `?capture=`;
  - `keptText` under it;
  - **Undo** (undoes `document.changeIds` through `undoChange`, sharing the receipt's pending state);
  - **Move to…** (the PagePicker; calls `moveDocument`).

  The existing space and page list follows under an "Also updated" heading. The heading shows only when there are standing changes or suggestions.
- **`NeedsHome`:** documents come first. Each shows the headline:
  - one button per option ("{title}", in its space);
  - a PagePicker for any other page;
  - a title input prefilled with the title;
  - **Create page** (calls `placeDocument` with the chosen parent and the title);
  - **Route as updates instead**.

- [ ] **Step 1: Write the failing tests.**
  - `capture.test.ts`:
    - `documentHeadline` for all four cases (exact copy above);
    - `keptText(0|1|3)`;
    - `outcomeLabel('filed_in_document')`;
    - `SHAPE_OPTIONS` labels.
  - `e2e/capture.spec.ts` (the deterministic model). Seed through the API: Client - George with child pages `29Sep` and `Meeting 1`.
    - `'a meeting note becomes its own page and the receipt leads with it'`: send the Task 6 meeting note → the receipt shows `New page: Oct 14 meeting with George under Client - George` and `Also updated`. The link opens the page.
    - `'Undo on the new page archives it'`: click Undo in the document header → the page is gone from the sidebar.
    - `'File as Updates only makes no page'`.
    - `'a document with no clear home is placed from Needs a home'`: a world with no parent pages → Needs a home shows `Where should “…” go?`. Pick a page, click **Create page** → the receipt shows `New page:`.
  - Update the `linkSites` test allow-list if the new link is in a new component.
- [ ] **Step 2: Run.**
  1. Run `pnpm vitest run apps/web/test/capture.test.ts`. Expected: FAIL.
  2. Run `pnpm e2e:local -- e2e/capture.spec.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the console changes.
- [ ] **Step 4: Check.**
  1. Run `pnpm vitest run apps/web`. Expected: PASS.
  2. Run `pnpm e2e:local -- e2e/capture.spec.ts`. Expected: all PASS.
  3. Run `pnpm typecheck`. Expected: 0 errors.
- [ ] **Step 5: Commit.** `feat(web): file as, document receipts and needs a home for documents`

### Finish

- [ ] **Full verification.**
  - Run `pnpm typecheck`, `pnpm vitest run`, `bash …/scratchpad/pgtest.sh`, `pnpm e2e:local` and `pnpm routing:eval`. Expected: all green.
  - Run once more with the owner's router: `ROUTER_REASONING=off` and the OpenRouter settings from the worker's environment, then `pnpm routing:eval`. Report the numbers; this run is not a gate.
- [ ] **Final review** per executing-plans, then finishing-a-development-branch.
- [ ] **Remind the owner** of the stack steps: add `ROUTER_REASONING=off` to `.env`, run `docker compose up -d --build`, and the migration runs on start. Their earlier 14 Oct capture can be undone from its receipt and sent again.

Out of scope (spec "Not in scope", plus a gap noted in the spec's status section): links and backlinks between the meeting page and the standing pages (Phase A); appending to an existing meeting page; per-tenant token usage.
