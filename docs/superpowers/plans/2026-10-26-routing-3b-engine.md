# Routing 3b — The routing engine (captures to edits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a capture (any text a person sends) into cited, undoable edits on the right live pages. Facts the engine
may not apply become suggestions; facts it cannot place go to Needs a home. All of it is served by API routes the
console (plan 3c) will use.

**Architecture:**
- **Entry:** a capture is a row plus a `capture.route` worker job.
- **Planning** (`planCapture`, dry-run, model calls only):
  1. split the capture into facts;
  2. resolve the names it mentions (asking the sender when a name is ambiguous);
  3. gather candidate pages from passage search, page cards and the entity graph (3a), fused by reciprocal rank fusion;
  4. ask the model for block operations;
  5. check every operation against the spec's rules.
- **Applying** (`applyCapturePlan`): per page, one call to a new collab endpoint `apply-block-ops`, then one snapshot
  with reason `capture`, then the citations and change records.
- **Gates:** removals, protected blocks, blocks that cite another source, and pages the sender can't edit become
  suggestions. A tenant-wide lease keeps routing to one capture at a time per tenant.

**Tech Stack:** TypeScript, Fastify, Drizzle, Hocuspocus 4 / Yjs / BlockNote server-util, Zod, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-26-routing-engine-design.md`. Plan 3a (merged) built the retrieval layer:
`searchPageCards`, `findEntities`, `pagesForEntities`, `PlacementModel`, `chatJson`. Plan 3c (next) is the console.

## Global Constraints

- **R1:** review follows the space for every agent edit. A snapshot needs review only when `spaces.review_required` is set.
  This replaces "agent changes always need approval" everywhere: snapshot, badge, file and connector paths unchanged otherwise.
- **R2:** the engine never applies a removal that nothing replaces; it becomes a suggestion in every space.
- **R3:** the engine never removes text because a source stopped mentioning it.
- **R4:** a block citing a still-valid *version* is never replaced or removed by the engine. Blocks cited only by captures can be.
- **R8:** the engine edits as the tenant's built-in **Routing engine** agent (`agents.kind = 'router'`), on behalf of the sender. It reads only spaces the sender can read and edits only spaces the sender can edit.
- **R9 / R10:** update before inventing. Each operation must reach a confidence threshold:
  - `APPLY_THRESHOLD = 0.6` for insert and replace;
  - `CREATE_THRESHOLD = 0.85` for create_page;
  - `MARGIN = 0.1`: two different target pages for the same fact within this margin send the fact to Needs a home.
  Thresholds are settings to be tuned by the evaluation set.
- **R12:** every inserted or replaced block gets a `citations` row with `source_kind = 'capture'`. Captures are never indexed.
- **R13:** one routing job at a time per tenant, enforced by a lease row, not by worker count.
- **R16:** a change on a page the sender can read but not edit becomes a suggestion with `blocked_by = 'no_edit_access'`.
- **R17:** the Inbox is never a candidate or a target.
- **Rule 5:** a block a person changed within the space's `human_protection_seconds` is never replaced or removed by the engine; that becomes a suggestion with `blocked_by = 'protection'`.
- **Rule 6:** nothing is rewritten. Undo, move and accept are new edits through collab.
- **Collab timing:** never call collab while holding `lockDocument` on that page (the collab client's documented deadlock).
- Capture text is at most **20 000 characters** (`capture_too_long`, 400).
- A follow-up question unanswered after **7 days** sends its waiting facts to Needs a home.
- The candidate count per fact is 8 (`ROUTING_CANDIDATES`), and each candidate shows the model at most 40 live blocks.
- Capture text, page text and model output are untrusted data; the model has no tool that changes access, status or settings.
- New error codes and statuses:
  - `capture_too_long` 400;
  - `capture_not_found` 404;
  - `capture_not_waiting` 409;
  - `change_already_undone` 409;
  - `suggestion_not_open` 409;
  - `block_not_found` 404 (it already exists; collab now uses it too).
  Pin each one in `apps/api/test/errors.test.ts`. That step was missed in 3a.
- **Audit events:**
  - `capture.created`, `capture.routed`, `capture.question_asked`, `capture.answered`;
  - `capture.change_undone`, `capture.change_moved`, `capture.fact_placed`;
  - `suggestion.accepted`, `suggestion.declined`.
- Fold in two deferred minors from 3a's review wherever this plan touches entity lookups:
  - `findCandidates`' exact match prefers the same kind, then the oldest;
  - `entities.user_id` becomes `ON DELETE SET NULL`.

## Review Focus

1. **A person edits the target block between planning and applying.** The engine must not overwrite it. Pinned by Task 8's `a block a person changed after planning becomes a suggestion, not an overwrite`.
2. **One capture touches a review-off and a review-on space.** One part must apply and index; the other must wait. The receipt must show both. Pinned by Task 8's `splits outcomes by the target space's review setting`.
3. **The same capture sent twice, or a fact already on the page.** No duplicate block may be added. Pinned by Task 7's `a fact the page already states is already_known` and `an operation matching an open suggestion is dropped`.
4. **Undo after someone changed the routed block.** That block must be left alone and reported, and the rest undone. Pinned by Task 10's `undo skips blocks changed since and reports them`.
5. **Two workers pick up two captures of the same tenant.** The second must wait for the lease, not plan against stale content. Pinned by Task 8's `a second capture waits for the tenant lease`.

---

### Task 1: Move passage search and the collab client into packages

The worker runs the engine and may not import `apps/api` (`packages/core/test/layering.test.ts`).

**Files:**
- Move: `apps/api/src/search/hybridSearch.ts` → `packages/core/src/search/hybridSearch.ts`. Re-export from `packages/core/src/index.ts`; `apps/api` imports it from `@living-wiki/core`.
- Move: `apps/api/src/collab/client.ts` → `packages/shared/src/collabClient.ts`. Export `CollabClient`, `HttpCollabClient` and `COLLAB_CALL_TIMEOUT_MS` from `@living-wiki/shared`. Update api imports and `apps/api/test/support/inProcessCollab.ts`.
- Test: the existing suites, unchanged in behaviour.

**Interfaces:**
- Produces:
  - `searchWiki`, `chunkFilterFor` and `vectorBranchSql` from `@living-wiki/core`, with the same signatures as today;
  - `CollabClient` and `HttpCollabClient` from `@living-wiki/shared`.

- [ ] **Step 1:** Move both files with `git mv`, fix the imports, and keep `apps/api/src/search/ask.ts` where it is (it now imports from core).
- [ ] **Step 2: Run** `pnpm typecheck && pnpm vitest run`. Expected: the same pass and skip counts as `main` (1226 / 31).
- [ ] **Step 3: Commit** `refactor: passage search and the collab client live in packages`

### Task 2: Block operations on live pages through collab

**Files:**
- Modify: `apps/collab/src/internal.ts` (new handler and path), `packages/contracts/src/index.ts` (request schema), `packages/shared/src/collabClient.ts` (`applyBlockOps`), `apps/api/test/support/inProcessCollab.ts`
- Create: `apps/collab/src/blockOps.ts`
- Test: `apps/collab/test/blockOps.test.ts`

**Interfaces:**
- `CollabApplyBlockOpsRequestSchema`:
  ```ts
  { documentName: string; actor: { type: 'user'|'agent'; id: string }; source: 'agent'|'human';
    ops: Array<
      | { op: 'insert_after'; after: string | null; blocks: unknown[] }   // after null = at the start
      | { op: 'replace'; blockId: string; blocks: unknown[] }            // first new block keeps blockId
      | { op: 'remove'; blockId: string }
    > }
  ```
- `applyBlockOps(fragment: Y.XmlFragment, ops): void` in `blockOps.ts`:
  - walks the top-level `blockGroup` > `blockContainer` (by `id`) as described in `attribution.ts`;
  - builds new containers with `blockNote.blocksToYXmlFragment` into a scratch `Y.Doc`, then inserts their `.clone()`s;
  - throws `AppError('block_not_found')` before touching anything if any `after` or `blockId` is missing;
  - handles top-level blocks only (nested children travel with their parent).
- `POST /internal/apply-block-ops`: validates every op's blocks off-document first (as `replaceDocumentBlocks` does), then applies all ops in **one** `session.transact({ source, actorId })`.
- `CollabClient.applyBlockOps(a: { tenantId; pageId; actor; source; ops }): Promise<void>`. A collab 404 maps to `AppError('block_not_found')`.

- [ ] **Step 1: Write failing tests** in `apps/collab/test/blockOps.test.ts`, on a `Y.Doc` seeded from markdown "A\n\nB\n\nC" (use `test/support/blocks.ts`):
  - `insert_after B` → texts `[A, B, new, C]`, and the new block keeps the id given in `blocks[0].id`;
  - `insert_after null` → the new block comes first;
  - `replace B` with two blocks → `[A, B', extra, C]` where B' keeps B's id;
  - `remove B` → `[A, C]`;
  - an unknown id throws `block_not_found` and leaves the fragment unchanged;
  - over a real collab server (`startCollabServer`), one call with two ops produces one transaction attributed to the given agent (`block_activity` rows for both blocks carry `actor_type 'agent'`).
- [ ] **Step 2: Run** `pnpm vitest run apps/collab/test/blockOps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `blockOps.ts`, the handler, the schema and the client method. Add `applyBlockOps` to `InProcessCollabClient`, calling the handler directly.
- [ ] **Step 4: Run** `pnpm vitest run apps/collab`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(collab): block operations on live pages`

### Task 3: Capture, suggestion and citation tables

**Files:**
- Create: `packages/db/src/schema/routing.ts`; export it from `packages/db/src/index.ts` and add it to `schema` in `client.ts`
- Modify: `packages/db/src/schema/foundations.ts` (`agents.kind` enum gains `'router'`), `pages_and_index.ts` (`versions.reason` gains `'capture'`), `placement.ts` (`entities.user_id` → `onDelete: 'set null'`)
- Create: migrations via `pnpm db:generate`, plus an RLS custom migration from `gen-rls.mjs --tables captures,capture_messages,capture_facts,capture_changes,suggestions,citations,routing_examples,routing_leases`
- Test: `packages/db/test/routingSchema.test.ts`

**Interfaces** (columns exactly as the spec's "Data model" section, plus the items below):
- `captures.status`: `queued | routing | waiting_for_answer | done | failed`.
- `capture_facts.outcome`: `pending | applied | waiting_review | suggested | needs_home | already_known | dismissed | undone`.
  Also `waiting_question_id` (nullable, references `capture_messages`), `names` (text[], from splitting) and `kind`.
- `capture_changes`: as specced. `before_markdown` is null for inserts; `op` is `insert | replace | create_page`.
- `suggestions`: as specced, with `kind` `remove | replace | insert`. Also `after_block_id` (for an insert) and `proposed_blocks` (jsonb).
- `citations`:
  - `id`, `tenant_id`, `page_id`, `block_id`, `source_kind` (`version | capture`);
  - `source_document_id`, `source_version_id`, `chunk_id` (all nullable);
  - `capture_id`, `fact_id` (nullable);
  - `quote`, `state` (`ok | source_changed | source_removed`), `created_by_type`, `created_by`, `created_at`.
  - Index `(tenant_id, page_id, block_id)`.
- `routing_examples`: as specced. `statement_embedding` is `halfvec(2560)`, with an HNSW index.
- `routing_leases`: `tenant_id` primary key, `holder` text, `expires_at` timestamptz.
- Helper in `packages/db/src/routingLease.ts`:
  - `acquireRoutingLease(tx, tenantId, holder, seconds): Promise<boolean>`: an upsert that takes the row only when it is free or expired;
  - `releaseRoutingLease(tx, tenantId, holder): Promise<void>`.

- [ ] **Step 1: Write failing tests:**
  - `acquireRoutingLease` gives true, a second holder gets false, and after `expires_at` passes the second holder gets true;
  - releasing frees the lease;
  - inserting a `citations` row with `source_kind 'capture'` and no version id succeeds;
  - an agent with `kind 'router'` inserts.
- [ ] **Step 2: Run** `pnpm vitest run packages/db/test/routingSchema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, migrations and lease helper.
- [ ] **Step 4: Run** `pnpm vitest run packages/db`. Expected: PASS, and the RLS-everywhere test covers the 8 new tables.
- [ ] **Step 5: Commit** `feat(db): captures, suggestions, citations and the routing lease`

### Task 4: Review follows the space (R1)

**Files:**
- Modify: `packages/core/src/snapshot.ts` (`needsReview = spaceRow.reviewRequired`; `reason` gains `'capture'`), `apps/api/src/pages/badge.ts:49` (same rule)
- Modify: every existing test that asserts "an agent change needs approval in a review-off space". Find them with `grep -rn "agent" apps/api/test packages/core/test | grep -i "pending_review\|awaiting"` and flip their expectation, in the same commit, citing R1 in each changed test's name.
- Test: `packages/core/test/snapshot.test.ts` (extend)

**Interfaces:** `takePageSnapshot` params `reason: 'quiet' | 'submit' | 'agent' | 'restore' | 'capture'`. Nothing else changes signature.

- [ ] **Step 1: Write failing tests:**
  - `an agent's snapshot in a space with review off goes straight to indexing (R1)`;
  - `an agent's snapshot in a review space waits`;
  - `a capture snapshot is recorded with reason capture`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/snapshot.test.ts`. Expected: the first fails.
- [ ] **Step 3: Implement** the rule change and update the flipped tests.
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: PASS, with every flipped test listed in the commit message.
- [ ] **Step 5: Commit** `feat: review follows the space for agent edits (R1)`

### Task 5: The routing model

**Files:**
- Modify: `packages/core/src/placement/model.ts` (it gains the two methods below; the type is renamed `RoutingModel`, and `PlacementModel` stays as an alias), `packages/core/src/index.ts`
- Test: `packages/core/test/routingModel.test.ts`

**Interfaces:**
```ts
export interface CaptureFact { statement: string; kind: 'new' | 'change' | 'removal'; names: string[]; date: string | null }
export interface PlanCandidate {
  documentId: string; title: string; summary: string; outline: string[];
  blocks: Array<{ id: string; text: string }>;   // live, top-level, at most 40
}
export type PlannedOp =
  | { op: 'insert_after'; documentId: string; after: string | null; markdown: string }
  | { op: 'replace'; documentId: string; blockId: string; markdown: string }
  | { op: 'remove'; documentId: string; blockId: string }
  | { op: 'create_page'; spaceId: string; parentId: string | null; title: string; markdown: string }
  | { op: 'already_known'; documentId: string; blockId: string };
export interface PlannedEdit { op: PlannedOp; confidence: number; reason: string }
splitCapture(input: { text: string }): Promise<{ facts: CaptureFact[] }>;
planEdits(input: { fact: CaptureFact; candidates: PlanCandidate[]; examples: Array<{ statement: string; chosenTitle: string }>;
                   writableSpaces: Array<{ id: string; name: string }> }): Promise<{ edits: PlannedEdit[] }>;
```
- The OpenAI versions use `chatJson`, with schemas lenient per item (as in 3a's `extractEntities`): invalid edits are dropped, and `confidence` is clamped to [0, 1]. At most 20 facts and 6 edits per fact.
- **Deterministic rules** (tests depend on them):
  - **`splitCapture`:** one fact per sentence (same splitter as `extractEntities`).
    - `kind`: `removal` when the sentence matches `/^(we )?no longer\b/i`; `change` when it matches `/\b(moved|changed|now|replaced|instead)\b/i`; otherwise `new`.
    - `names`: the deterministic entity names of the sentence. `date`: null.
  - **`planEdits`**, in order:
    1. A block whose normalised text equals the statement → `already_known`, confidence 1.
    2. `removal`: take the phrase after "no longer " without the final period; the first candidate block containing it (case-insensitive) → `remove`, confidence 0.9.
    3. `change`: the first block containing any of the fact's names → `replace` with the statement, confidence 0.9.
    4. `new`: the first block containing any name → `insert_after` that block, confidence 0.8.
    5. Otherwise, with candidates → `insert_after` the last block of the first candidate, confidence 0.5. With no candidates → no edits.
  - The deterministic model never proposes `create_page`.

- [ ] **Step 1: Write failing tests** for every deterministic rule above, plus the OpenAI path with a fake fetch: an edit with an unknown op is dropped, and a confidence of 1.7 is clamped to 1.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/routingModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `packages/core/test/placementModel.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): capture splitting and edit planning in the routing model`

### Task 6: Capture API

**Files:**
- Create: `apps/api/src/routes/captures.ts`, contracts in `packages/contracts/src/index.ts`
- Modify: `apps/api/src/server.ts` (register the routes)
- Test: `apps/api/test/captures.test.ts`

**Interfaces:**
- `POST /api/v1/captures` `{ text, scope_space_id?, scope_page_id? }` → 201 `CaptureSummary`.
  - Any member with editor on at least one non-Inbox space may call it; otherwise 403.
  - A scope the sender can't read → 404. An Inbox scope → 404 `space_not_found`.
  - It inserts the capture (`channel 'console'`, `status 'queued'`), enqueues `capture.route` with key `capture:{id}`, and audits `capture.created`.
- `GET /api/v1/captures` (the sender's captures, newest first, at most 50; `?before=` cursor) and `GET /api/v1/captures/:id` → `CaptureDetail` = the capture, the thread (`capture_messages`) and the receipt. Who can read:
  - the sender, or tenant admins;
  - anyone else gets 404 `capture_not_found`.
- `POST /api/v1/captures/:id/answer` `{ message_id, choice }`. Only the sender may call it.
  - 409 `capture_not_waiting` when no question is open.
  - Records the answer, puts the waiting facts back to `pending`, re-enqueues `capture.route`, and audits `capture.answered`.
- **Receipt shape** (`CaptureReceiptSchema`): groups by space, then by page. Each page entry has:
  - `outcome`: `applied | waiting_review | suggestion | already_known`;
  - `changes[]`: `{ id, op, blockId, beforeMarkdown, afterMarkdown, status, reason }`;
  - `suggestions[]`.
  
  Pages in spaces the viewer can't read collapse into `{ hiddenChanges: number }` (spec "Receipt").
  `needsHome[]` lists facts with outcome `needs_home`.

- [ ] **Step 1: Write failing tests** through `app.inject`:
  - create gives 201 and one queued `capture.route` job;
  - 20 001 characters gives 400 `capture_too_long`;
  - a viewer-only member gets 403;
  - an Inbox scope gives 404;
  - another member's `GET /captures/:id` gives 404;
  - answering with no open question gives 409;
  - the receipt hides a page in an unreadable space (seed `capture_changes` directly).
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/captures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): captures, their thread and receipt`

### Task 7: Planning a capture (dry run)

**Files:**
- Create: `packages/core/src/routing/plan.ts`, `packages/core/src/routing/access.ts`, `packages/core/src/routing/liveBlocks.ts`
- Test: `packages/core/test/routingPlan.test.ts`

**Interfaces:**
```ts
// access.ts
export interface SenderAccess { actor: Actor; readable: string[]; editable: string[] } // Inbox removed from both
export async function senderAccess(tx: DbTransaction, sender: { type: 'user'|'agent'; id: string; tenantId: string }): Promise<SenderAccess>;
// liveBlocks.ts — top-level blocks of the live Y.Doc stored in pages.ydoc_state
export async function readLiveBlocks(tenantId: string, pageId: string): Promise<{ title: string; blocks: BlockLike[] }>;
export function blockMarkdown(block: BlockLike): Promise<string>;   // blocksToMarkdownLossy([block]).trim()
// plan.ts
export type FactPlan =
  | { status: 'question'; names: string[]; question: string; options: Array<{ entityId: string; label: string }> }
  | { status: 'needs_home'; reason: string }
  | { status: 'already_known'; documentId: string; blockId: string }
  | { status: 'planned'; edits: CheckedEdit[] };
export interface CheckedEdit {
  edit: PlannedEdit; spaceId: string;
  gate: null | 'removal' | 'protection' | 'conflict' | 'no_edit_access';   // non-null → becomes a suggestion
  beforeMarkdown: string | null;
}
export async function planCapture(
  params: { tenantId: string; captureId: string },
  deps: { model: RoutingModel; embedder: EmbeddingProvider; now?: Date }
): Promise<Array<{ fact: CaptureFact; ordinal: number; plan: FactPlan }>>;
export const ROUTING = { candidates: 8, blocksPerCandidate: 40, apply: 0.6, create: 0.85, margin: 0.1 } as const;
```
- **Facts.** Split the capture, or on a re-run after an answer, reuse the stored facts that are still `pending`.
- **Questions.** A name whose `findEntities` returns two or more hits whose scores are within `ROUTING.margin` → `question`, listing those hits as options. An answered question pins the chosen entity id.
- **Candidates per fact:**
  - passage search: `searchWiki` restricted to pages in `readable`, with the fact statement as the query;
  - cards: `searchPageCards` with the embedded statement;
  - graph: `pagesForEntities` for the resolved entities, 1 hop.
  
  Fuse by RRF (k = 60, the same constant as search) and take the top `ROUTING.candidates`. A capture scope limits all three. Load each candidate's live blocks.
- **Checks**, in order:
  1. Unknown page or block ids → drop the edit.
  2. Confidence below `apply` (or `create` for create_page) → drop.
  3. Two remaining target pages within `margin` → `needs_home`.
  4. `remove` → gate `removal`.
  5. `replace` or `remove` on a block whose `block_activity` row is a user's within `human_protection_seconds` of `now` → gate `protection`.
  6. A block with a `citations` row (`source_kind 'version'`, `state 'ok'`) → gate `conflict`.
  7. A page outside `editable` → gate `no_edit_access`.
  8. An edit whose target and text match an open suggestion or a pending `capture_changes` row → drop as a duplicate.
- **Outcome.** No edits left → `needs_home`. A fact with only an `already_known` op → `already_known`.

- [ ] **Step 1: Write failing tests** (seeded with 3a's placement fixture, cards and entities built, plus a `pages` row with `ydoc_state` from `encodePageYDoc`):
  - `a change lands on the page that already states it` (Billing service says Stripe; "Billing moved to Adyen" plans `replace` on that block);
  - `a removal is gated` → gate `removal`;
  - `a block a person edited a minute ago is gated as protection`;
  - `a block citing a valid version is gated as conflict`;
  - `a page in a read-only space is gated as no_edit_access`;
  - `a fact the page already states is already_known`;
  - `an operation matching an open suggestion is dropped`;
  - `two close candidates send the fact to needs_home` (model stub returning two pages at 0.8 and 0.75);
  - `an ambiguous name asks a question` (two "Aisha" entities in readable spaces);
  - `Inbox pages are never candidates`;
  - `a scope limits candidates to that space`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/routingPlan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `access.ts`, `liveBlocks.ts` and `plan.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): plan a capture into checked edits`

### Task 8: Applying a capture and the `capture.route` job

**Files:**
- Create: `packages/core/src/routing/apply.ts`, `packages/core/src/routing/routerAgent.ts`
- Modify: `apps/worker/src/registry.ts` (the `capture.route` handler; `JobContext` gains `collab: CollabClient`), `apps/worker/src/runner.ts`, `apps/worker/src/main.ts` (`new HttpCollabClient(config.COLLAB_INTERNAL_URL, config.INTERNAL_SECRET)`)
- Test: `apps/worker/test/captureRoute.test.ts`, run over a real in-process collab server (as `apps/api/test/restore.test.ts` does)

**Interfaces:**
```ts
export async function ensureRouterAgent(tx: DbTransaction, tenantId: string): Promise<string>; // agents row, kind 'router', name 'Routing engine'
export async function routeCapture(
  params: { tenantId: string; captureId: string; holder: string },
  deps: { model: RoutingModel; embedder: EmbeddingProvider; collab: CollabClient; now?: Date }
): Promise<'done' | 'waiting_for_answer' | 'busy'>;
```
`routeCapture` steps:
1. `acquireRoutingLease` for 300 s, or return `busy`.
2. `planCapture`.
3. Write `capture_facts` and their outcomes. For a question: a `capture_messages` row from the `engine`, `status = 'waiting_for_answer'`, and audit `capture.question_asked`.
4. For each page with ungated edits:
   - re-check protection right before applying, by reading `block_activity` again. A block changed since is gated and becomes a suggestion.
   - `collab.applyBlockOps` as the router agent with source `agent`. New blocks get `randomUUID()` ids, and their markdown is converted with `tryParseMarkdownToBlocks`.
   - `collab.flush`, then `takePageSnapshot({ reason: 'capture', actorType: 'agent', actorId: routerId, manual: false })`.
   - Write `capture_changes` (before and after markdown from `blockMarkdown`, plus the version id) and one `citations` row per new or replaced block.
   - The fact's outcome is `applied` when the version is `indexing` or `indexed`, and `waiting_review` when it is `pending_review`.
5. Gated edits → `suggestions` rows, with the proposed blocks stored and outcome `suggested`.
6. `create_page` → create it with the api's page-creation core (move `createPage`'s insert logic into `packages/core/src/pages/createPage.ts` if needed), then insert into it.
7. Audit `capture.routed`, set `status = 'done'` (or `'waiting_for_answer'`), and release the lease in a `finally`.

The handler: `busy` → re-enqueue the same key with `runAt` +10 s (the running-job rerun path in `enqueueJob`). An unanswered question older than 7 days → its facts go to `needs_home` the next time any capture of the tenant is routed.

- [ ] **Step 1: Write failing tests:**
  - `applies a change and cites the capture`: the live page now reads Adyen, one `capture_changes` row with the before text, one capture citation, and the version reason is `capture`;
  - `splits outcomes by the target space's review setting`: Engineering (review off) → `applied`, version `indexing`; Clients (review on) → `waiting_review`;
  - `a removal becomes a suggestion and the text stays`;
  - **`a block a person changed after planning becomes a suggestion, not an overwrite`**: a hook between plan and apply writes a user `block_activity` row;
  - **`a second capture waits for the tenant lease`**: hold the lease, run, get `busy`, and the job is re-queued;
  - `a question pauses only the facts that need the answer`.
- [ ] **Step 2: Run** `pnpm vitest run apps/worker/test/captureRoute.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: route captures into cited edits on live pages`

### Task 9: Suggestions

**Files:**
- Create: `apps/api/src/routes/suggestions.ts`
- Modify: `apps/api/src/server.ts`, contracts
- Test: `apps/api/test/suggestions.test.ts`, over in-process collab

**Interfaces:**
- `GET /api/v1/pages/:id/suggestions` (readers of the page) → open suggestions, with the reason, `blocked_by` and the conflict citation's cite-as text.
- `POST /api/v1/suggestions/:id/accept`:
  - **Who:** in a review-off space, an editor; in a review space, a reviewer who is not the sender unless `allow_self_approval`. Otherwise 403.
  - **What:** applies the proposed op through `collab.applyBlockOps` as the router agent with source `agent`, then snapshots with reason `capture`.
  - **Review spaces:** if the new version is `pending_review` and the page had no other waiting version before, approve it in the same request with the existing approval code, actor = the accepter.
  - **Bookkeeping:** records `resolved_by`, sets `status 'accepted'`, and audits `suggestion.accepted`.
  - **Refusals:** 409 `suggestion_not_open` when the suggestion is not open. A missing block → the suggestion becomes `stale` and the call answers 409 `suggestion_not_open`.
- `POST /api/v1/suggestions/:id/decline` (same roles) → `status 'declined'`, and audit `suggestion.declined`.

- [ ] **Step 1: Write failing tests:**
  - an editor accepts a removal in a review-off space: the block is gone and the version is indexing;
  - a reviewer accepts in a review space: the version is indexed in the same request;
  - the sender can't accept their own in a review space without self-approval (403);
  - a viewer gets 403;
  - accepting twice gives 409;
  - a deleted block makes the suggestion stale.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/suggestions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): accept and decline suggestions`

### Task 10: Undo, wrong page, and Needs a home

**Files:**
- Create: `apps/api/src/routes/captureChanges.ts`, `packages/core/src/routing/place.ts`
- Modify: `apps/worker/src/registry.ts` (the `capture.place` handler), `apps/api/src/server.ts`, contracts
- Test: `apps/api/test/captureChanges.test.ts`, `apps/worker/test/capturePlace.test.ts`

**Interfaces:**
- `POST /api/v1/capture-changes/:id/undo` and `POST /api/v1/captures/:id/undo` (all applied changes):
  - **Who:** the sender, or an editor of the page's space.
  - For each change, compare the live block's `blockMarkdown` with `after_markdown`:
    - equal → `replace` the block back to the before blocks (keeping the block id), or `remove` an insert;
    - different → leave it alone and report it.
  - Apply through collab as the **person**, with source `human`, then snapshot.
  - **Reply:** `{ undone: string[], changedSince: string[] }`. A change already undone → 409 `change_already_undone`. Audit `capture.change_undone`.
- `POST /api/v1/capture-changes/:id/move` `{ target_page_id }`:
  - **Who:** an editor of both spaces.
  - Undoes that change as above, marks it `moved`, writes a `routing_examples` row (statement, embedding, chosen = target, wrong = old page), and enqueues `capture.place` `{ factId, documentId: target }` with key `place:{factId}`.
  - Audit `capture.change_moved`.
- `GET /api/v1/needs-home`: facts with outcome `needs_home` that are the actor's own or that have a candidate in a space the actor edits.
- `POST /api/v1/capture-facts/:id/place` `{ document_id }` → enqueues `capture.place` and writes a `routing_examples` row.
- `POST /api/v1/capture-facts/:id/dismiss` → outcome `dismissed`.
- Who may place or dismiss: the sender, or an editor of the target space. Audit `capture.fact_placed`.
- `placeFact(params: { tenantId; factId; documentId; holder }, deps)` (`capture.place` job): runs the plan step with `candidates = [that page]` and the confidence floor waived (a person chose the page). Every gate still applies, then the result is applied as in Task 8. It takes the same tenant lease.
- `planCapture` passes up to 5 most similar `routing_examples` of the candidate spaces (by `statement_embedding`) to `planEdits` (R11).

- [ ] **Step 1: Write failing tests:**
  - `undo restores the before text as a new version`;
  - **`undo skips blocks changed since and reports them`**;
  - undoing twice gives 409;
  - `move removes the block from the wrong page, places it on the chosen page and records an example`;
  - `placing a needs-home fact applies it to the chosen page`;
  - `the planner is shown the space's routing examples` (recording model stub);
  - dismiss.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/captureChanges.test.ts apps/worker/test/capturePlace.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: undo, wrong page and needs a home for captures`

### Task 11: Review bundles and "changes from this capture" (API)

**Files:**
- Modify: `apps/api/src/routes/reviews.ts`, `ReviewItemSchema`
- Create: the `GET /api/v1/pages/:id/capture-changes` handler in `captureChanges.ts`
- Test: `apps/api/test/reviewBundles.test.ts`

**Interfaces:**
- `ReviewItemSchema` gains:
  - `capture: { id, senderName, excerpt (first 280 chars), alsoApplied: Array<{ pageId, title }> } | null`;
  - `suggestions: SuggestionSummary[]`.
  
  `alsoApplied` lists only pages the reviewer can read.
- `GET /api/v1/reviews` keeps its order but places the items of one capture next to each other.
- `GET /api/v1/pages/:id/capture-changes?capture=<id>` (readers of the page) → that capture's `capture_changes` for the page, with block ids and before/after markdown (powers 3c's highlight mode).

- [ ] **Step 1: Write failing tests:**
  - two pages waiting from one capture come back adjacent with the same `capture.id`;
  - `alsoApplied` hides an unreadable page;
  - capture-changes for a page lists only that page's changes;
  - a non-reader gets 404.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/reviewBundles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): review bundles and per-capture changes`

### Task 12: Routing evaluation

**Files:**
- Create: `packages/core/eval/routing/corpus.json` (spaces and pages as markdown), `packages/core/eval/routing/captures.json` (each capture with expected `{ factIndex, documentTitle, op }`), `scripts/routing-eval.ts`
- Modify: `package.json` (`"routing:eval": "tsx scripts/routing-eval.ts"`), `docs/operations.md`
- Test: `packages/core/test/routingEval.test.ts`

**Interfaces:**
- `runRoutingEval(model: RoutingModel, embedder: EmbeddingProvider): Promise<{ facts: number; placed: number; hits: number; hitRate: number; needsHome: number; wrongRemovals: number; duplicates: number }>`
  - Seeds a fresh PGlite with the corpus.
  - Indexes it and builds cards and entities.
  - Calls `planCapture` (dry run) for each capture.
  - Scores the results:
    - `hitRate = hits / placed`;
    - a `wrongRemovals` entry is any ungated remove (it must be 0 by R2);
    - `duplicates` are edits whose text the page already contains.
- The CLI uses the configured `ROUTER_*` and `EMBEDDING_*` and prints the numbers. It exits non-zero when `hitRate < 0.9` or `wrongRemovals > 0`.
- The fixture is at least 20 captures across at least 3 spaces, covering every rule in Task 5's deterministic list.

- [ ] **Step 1: Write the failing test** `the deterministic model meets the bar on the fixture`: `hitRate >= 0.9`, `wrongRemovals === 0`, `duplicates === 0`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/routingEval.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the fixture, the runner and the CLI, then document `pnpm routing:eval` next to `placement:rebuild`.
- [ ] **Step 4: Run** the same command plus `pnpm vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: routing evaluation set and runner`

---

## Not in this plan (by design)

- Any console UI: the Capture page, receipts, highlight mode and the bundle view (plan 3c).
- Capture over MCP (the MCP rework); the data model already allows agent senders.
- Notifications to reviewers (Phase A).
- WhatsApp and Drive feeding captures (the last slice).
