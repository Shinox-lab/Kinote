# MCP tree tools, page delete and in-client review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors archive and restore pages; an agent creates, moves, deletes and restores pages over MCP; the agent's owner approves or rejects waiting changes in an MCP App panel.

**Architecture:** Archive/restore roles drop to editor in `pages.ts`/`files.ts` and the web controls. New MCP tools in `apps/api/src/mcp/tools/` wrap the existing route functions (`createPage`, `movePage`, `archivePageTx`, `restorePage`). A delete under review is a `suggestions` row of new kind `archive`, accepted through `acceptSuggestion`. The review panel is a second MCP App bundled like the upload panel; its app-only tools run as `actor.owner`, gated by the new `agents.approve_in_client`.

**Tech Stack:** TypeScript, Fastify, Drizzle (hand-written migrations + `meta/_journal.json`), Vitest on PGlite, `@modelcontextprotocol/ext-apps`, esbuild, React (web), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-mcp-delete-and-review-app-design.md`

## Global Constraints

- Branch `feat/mcp-tree-and-review` from `main` after PR #24 is merged (migration `0051` follows #24's `0050`). If #24 is not merged yet, branch from `feat/mcp-upload-and-rename`.
- One migration, `packages/db/migrations/0051_archive_suggestions_and_client_approval.sql`, journal idx 51, `when` greater than idx 50's `1795700000000`.
- Delete is archive; nothing is removed for good.
- Review tools act as `actor.owner` (`{ tenantId, principalType: 'user', principalId: owner.userId, tenantRole }`), never as the agent.
- `kinote_review_list` / `kinote_review_decide` carry `meta: { ui: { visibility: ['app'] } }`.
- Agent-facing copy, verbatim from the spec: `no edit access: a person can delete it`; `The page is already deleted.`; `It has n sub-pages: delete or move them first.`; `no edit access: a person can add pages there`; `Approve this in Kinote: <link>`; `Nothing is waiting for you.`; switch label `Approve in your AI client`.
- Typecheck `pnpm typecheck`; tests `pnpm --filter @kinote/api exec vitest run <file>`; web `pnpm --filter @kinote/web exec vitest run <file>`; e2e `pnpm e2e:local <spec>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The page is archived (by a person in the web app) between `kinote_review_list` and Approve on its delete request → the card says the page is already deleted, not an internal error. Test in Task 4.
2. A delete request is accepted while a child page was added after the request → 409 `has_children`, the request stays open and the card says why. Test in Task 4.
3. An agent restores a page whose parent is still archived → the page returns at the top of its space and the text says so. Test in Task 5.
4. `kinote_review_decide` is called for an item in a space the owner can no longer reach → `{ ok: false, message }` with a plain sentence, never an MCP error. Test in Task 7.
5. `kinote_move` with `under` naming the page itself or a descendant → one plain sentence (`parent_cycle`). Test in Task 5.

---

### Task 1: Editor-level archive and restore

**Files:**
- Modify: `apps/api/src/routes/pages.ts` (`archivePage` ~1450 role `'admin'`→`'editor'`; `restorePage` ~1516 condition)
- Modify: `apps/api/src/routes/files.ts` (`archiveFile` ~571; `restoreFile` ~654), same change
- Modify: `apps/web/src/lib/wiki.ts:299-300`, `apps/web/src/lib/fileUi.ts:49-50`, and the `pageControls` doc comment
- Test: `apps/api/test/lifecycle.test.ts`, `apps/api/test/filesLifecycle.test.ts`, `apps/web/test/wiki.test.ts`, `apps/web/test/fileUi.test.ts`

**Interfaces:**
- Produces: `archivePage` / `restorePage` / `archiveFile` / `restoreFile` accept editor or above (Inbox rule unchanged). Later tasks rely on an agent with editor passing these.

- [ ] **Step 1: Write failing tests**
  - `lifecycle.test.ts`: `test('an editor archives and restores a page')` — editor grant, `POST /pages/:id/archive` → 200 and `archivedAt` set; `POST /pages/:id/restore` → 200 and `archivedAt` null. `test('a viewer cannot archive or restore a page')` → 403 `forbidden`. Keep the existing space-archive-needs-admin test as is.
  - `filesLifecycle.test.ts`: `test('an editor archives and restores a file')`.
  - `wiki.test.ts`: `pageControls({ role: 'editor', archived: false, ... }).archive === true`; `pageControls({ role: 'editor', archived: true, ... }).restorePage === true`; viewer both false.
  - `fileUi.test.ts`: same for `fileControls` `archive` / `restore`.
  - Update any existing test that asserted an editor is refused archive/restore (search for `forbidden` near `archive` in both API test files) to assert the new rule.
- [ ] **Step 2: Run them; expect the new API tests to fail with 403 and the web ones on `false`.**
- [ ] **Step 3: Change the four role checks and the two web control functions.** `restorePage`/`restoreFile`: refuse unless `effectiveRole` is editor, reviewer or admin (the Inbox case is already covered by `requireDocumentRole`).
- [ ] **Step 4: Run the four test files and `pnpm typecheck`; expect pass.**
- [ ] **Step 5: Commit** `feat: editors can archive and restore pages and files`

### Task 2: Migration — `archive` suggestion kind and `approve_in_client`

**Files:**
- Create: `packages/db/migrations/0051_archive_suggestions_and_client_approval.sql`
- Modify: `packages/db/migrations/meta/_journal.json`; `packages/db/src/schema/routing.ts:191` (`kind` enum adds `'archive'`); `packages/db/src/schema/foundations.ts` (agents: `approveInClient: boolean('approve_in_client').notNull().default(true)`); `packages/contracts/src/index.ts:610` (suggestion `kind` adds `'archive'`); agent summary schema adds `approveInClient`, PATCH agent schema adds `approve_in_client: z.boolean().optional()`
- Modify: `apps/api/src/routes/agents.ts:108,154,171` (return and accept the field)
- Modify: `apps/web/src/routes/admin/agents.tsx` (switch beside "Always review")
- Test: `apps/api/test/agents.test.ts` (or the existing agent-settings test file), `apps/web/test/agents.test.ts`

**Interfaces:**
- Produces: `suggestions.kind` may be `'archive'`; `agents.approveInClient: boolean` (default true); API agent JSON `approveInClient`; PATCH `approve_in_client`.

- [ ] **Step 1: Write failing tests.** API: `test('approve_in_client defaults to true and can be turned off')` — new agent → `approveInClient === true`; PATCH `{ approve_in_client: false }` → 200 and `false`. Web: the switch labelled `Approve in your AI client` renders checked and sends `{ approve_in_client: false }` when toggled.
- [ ] **Step 2: Run; expect failures (unknown field / missing label).**
- [ ] **Step 3: Write the migration.** If `suggestions.kind` has a DB CHECK constraint, drop and recreate it with `archive` added; if it is a plain `text` column (Drizzle enum is TS-only), only the TS enums change. Add `ALTER TABLE "agents" ADD COLUMN "approve_in_client" boolean DEFAULT true NOT NULL;`. Then the schema, contracts, route and web switch (help text: `Your AI client's review panel can approve and reject this agent's changes. Turn off to decide only in Kinote.`).
- [ ] **Step 4: Run both tests and `pnpm typecheck`; expect pass.** The typecheck will flag every `switch`/map over suggestion kinds; give `archive` a label there (`Delete this page`) — the full accept path comes in Task 4.
- [ ] **Step 5: Commit** `feat(db): archive suggestions and the approve-in-client agent setting`

### Task 3: `pageSlug` and `resolvePageRef` for archived pages

**Files:**
- Modify: `packages/core/src/routing/apply.ts:926` — rename `slugFor` → exported `pageSlug(title: string, suffix: string): string` (same body, `suffix` replaces `id.slice(0, 8)`); its caller passes `doc!.id.slice(0, 8)`; export from `packages/core/src/index.ts`
- Modify: `apps/api/src/mcp/refs.ts` — `resolvePageRef(tx, actor, rawRef, opts?: { archived?: boolean })`: with `archived: true` match `isNotNull(documents.archivedAt)` instead of `isNull`
- Test: `packages/core/test/pageSlug.test.ts` (create), `apps/api/test/mcpRefs.test.ts` (or the existing refs test)

**Interfaces:**
- Produces: `pageSlug(title, suffix)`; `resolvePageRef(..., { archived: true })`.

- [ ] **Step 1: Failing tests.** `pageSlug('Q3 Report!', 'abcd1234') === 'q3-report-abcd1234'`; `pageSlug('', 'abcd1234') === 'page-abcd1234'`; a 100-char title keeps 60 chars of base. Refs: an archived page resolves only with `{ archived: true }`, a live one only without.
- [ ] **Step 2: Run; expect FAIL (not exported / found).**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, plus `pnpm --filter @kinote/core exec vitest run test/routing` to see capture still passes; expect pass.**
- [ ] **Step 5: Commit** `refactor: export pageSlug; resolvePageRef can find archived pages`

### Task 4: `kinote_delete` and accepting an `archive` suggestion

**Files:**
- Create: `apps/api/src/mcp/tools/delete.ts`
- Modify: `apps/api/src/routes/suggestions.ts` (`acceptSuggestion` branch for `archive`), `apps/api/src/routes/pages.ts` (`archivePageTx` marks the page's other open suggestions `stale`), `apps/api/src/mcp/tools/index.ts` (`EDIT_TOOLS` adds `deleteTool`), web suggestion list component that renders kinds (label `Delete this page — <reason>`)
- Test: `apps/api/test/mcpDelete.test.ts` (create; setup like `mcpEditTitle.test.ts`)

**Interfaces:**
- Consumes: Task 1 editor archive; Task 2 `archive` kind; Task 3 `resolvePageRef`.
- Produces: `deleteTool: ToolDef` (`kinote_delete`, scope `edit`, `writes: true`, limit `edit`, input `{ page_id: z.string().max(64), reason: z.string().trim().min(1).max(500) }`); `acceptSuggestion` handles `kind === 'archive'`.

- [ ] **Step 1: Failing tests** (each its own `k.world()`; agent `alwaysReview` set per test):
  - `archives at once when nothing needs review` → text `Deleted "note". A person can restore it from the page.`; `archivedAt` set.
  - `asks when the agent always reviews` → text matches `/^Asked to delete "note": waiting for a person \(request [0-9a-f]{8}\)/`; one open suggestion `kind 'archive'`, `reason` = given, `proposedByType 'agent'`; page live.
  - `asks when the space requires review` (agent `alwaysReview: false`, space `reviewRequired: true`).
  - `a viewer agent is refused` → isError, text contains `no edit access: a person can delete it`.
  - `a page with sub-pages is refused` → `It has 1 sub-pages: delete or move them first.`
  - `an archived page is refused` → `The page is already deleted.` (resolve with `{ archived: true }` fallback to tell this apart from not found).
  - `a second call answers the open request` → same request id, still one suggestion.
  - `accepting the request archives the page` → owner `POST /suggestions/:id/accept` → 200, page archived, audit `suggestion.accepted` payload `kind: 'archive'`.
  - Review Focus 2: `accepting after a child was added answers has_children and stays open` → 409 `has_children`, suggestion `open`.
  - Review Focus 1: `accepting when the page was already archived` → 409 `suggestion_not_open` (the archive closed it as stale).
  - `declining keeps the page`.
  - `archiving closes the page's other open suggestions as stale`.
- [ ] **Step 2: Run; expect FAIL (unknown tool).**
- [ ] **Step 3: Implement.** Order of checks as the spec table. Review decision: `capturesAlwaysReviewed(tx, agent) || space.reviewRequired` → insert suggestion (`blockId/afterBlockId/proposedMarkdown` null, `blockedBy 'no_edit_access'`); else `lockPage` + `archivePageTx` as the agent. In `acceptSuggestion`, for `archive`: after `decidable`, in one tx `lockPage`, if archived → close `stale` + 409 `suggestion_not_open`; else `archivePageTx` (its `has_children` throws before `close`, so the row stays open), then `close(..., 'accepted')`; skip collab/snapshot; audit and return as today.
- [ ] **Step 4: Run `mcpDelete.test.ts`, `suggestions.test.ts`, `agentSuggestions.test.ts`, `lifecycle.test.ts`; expect pass.**
- [ ] **Step 5: Commit** `feat(mcp): kinote_delete archives a page or asks a person to`

### Task 5: `kinote_create`, `kinote_move`, `kinote_restore`, `kinote_browse { archived }`

**Files:**
- Create: `apps/api/src/mcp/tools/tree.ts` (`createTool`, `moveTool`, `restoreTool`) and a shared helper `resolvePlace(tx, actor, under): Promise<{ spaceId: string; parentId: string | null; label: string }>` in the same file (page ref first, then `resolveSpaceRef`; label `"<title>"` or `the top of <space>`)
- Modify: `apps/api/src/mcp/tools/browse.ts` (input `archived: z.boolean().optional()`), `apps/api/src/mcp/tools/index.ts` (`EDIT_TOOLS` adds the three)
- Test: `apps/api/test/mcpTree.test.ts` (create)

**Interfaces:**
- Consumes: `pageSlug` (Task 3), `resolvePageRef(..., { archived })` (Task 3), `createPage`, `movePage`, `restorePage`, `takePageSnapshot`, `capturesAlwaysReviewed`.
- Produces: tools `kinote_create { title, under, markdown? }`, `kinote_move { page_id, under }`, `kinote_restore { page_id }`.

- [ ] **Step 1: Failing tests:**
  - `create under a page` → text matches `/^Created "Handoff" \([0-9a-f]{8}\) under "note" — (waiting for review|indexing)\.$/`; DB row `parentId` = note, content contains the markdown.
  - `create at the top of a space` (`under: 'Clients'`) → `parentId` null, label `the top of Clients`.
  - `create refused for a viewer` → `no edit access: a person can add pages there`.
  - `move within a space` → `Moved "a" under "b".`, `parentId` = b.
  - `move to another space goes back to review` → text ends ` It waits for review again.`
  - Review Focus 5: `move under its own child is refused` → isError, one sentence containing `inside itself`.
  - `restore an archived page` → `Restored "a" under "b". It waits for review before it is searchable again.`
  - Review Focus 3: `restore when the parent is still archived` → `under "the top of Clients"`, `parentId` null.
  - `restore of a live page is not found`.
  - `browse archived lists archived pages` → contains `- a (<8 hex>) — archived ` and not live pages.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Create: `createPage(agentActor, { space_id, parent_id, title, slug: pageSlug(title, randomBytes(4).toString('hex')), markdown })` then `takePageSnapshot({ ..., reason: 'agent', forceReview })` → detail as `kinote_edit`. Move: `position` after the last sibling (read siblings' max position under the target; `'a0'` if none — reuse the web's ordering helper if one exists in `@kinote/core`). Map `AppError` codes: `parent_cycle` → `A page can't go inside itself or its own sub-pages.`; `parent_not_found` / `page_not_found` → the refs not-found text; `forbidden` → `no edit access: a person can move it`; `slug_taken` → `A page with the same address is already there.`; `page_archived` → `The page is deleted. Restore it first.` Move detects "back to review" by comparing the indexed version id / status before and after. Browse archived: `getSpaceTree(actor, spaceId, true)`, one flat line per node with `archivedAt` date (`YYYY-MM-DD`).
- [ ] **Step 4: Run `mcpTree.test.ts` and the existing `mcpBrowse` tests; expect pass.**
- [ ] **Step 5: Commit** `feat(mcp): kinote_create, kinote_move, kinote_restore and archived browse`

### Task 6: Review data — `reviewItems` and `decideReviewItem`

**Files:**
- Create: `apps/api/src/mcp/review/items.ts`
- Test: `apps/api/test/mcpReviewItems.test.ts` (create)

**Interfaces:**
- Consumes: `listReviewQueue`, `approveVersion`, `rejectVersion`, `acceptSuggestion`, `declineSuggestion`, the `decidable` rule (export it from `suggestions.ts` as `suggestionDecidable(tx, actor, id)` returning `{ ok: true } | { ok: false; why: string }` without throwing).
- Produces:
  ```ts
  export type ReviewPanelItem = { /* exactly as the spec §3 */ };
  export async function reviewItems(owner: Actor, opts: { pageId?: string; agentId?: string }): Promise<ReviewPanelItem[]>;
  export async function decideReviewItem(owner: Actor, input: { type: 'version' | 'suggestion'; id: string; decision: 'approve' | 'reject'; note?: string }, collab: CollabClient): Promise<{ ok: true; status: string } | { ok: false; message: string }>;
  ```
  `agentId` set = `mine_only`. Oldest first, at most 50. `before`/`after` clipped at 20 000 chars with `… (n more characters)`.

- [ ] **Step 1: Failing tests:**
  - `lists a waiting version with before and after` (agent edit in a review-required space; owner is a reviewer) → one item `type 'version'`, `before` has the old text, `after` the new, `decidable true`.
  - `lists an open suggestion and a delete request` → `kind 'replace'` with block before/after; `kind 'archive'`, `after null`, `sub_pages 0`.
  - `mine_only keeps this agent's items`.
  - `the owner's own agent's suggestion in a review-required space is not decidable` → `decidable false`, `why_not` `Your agent proposed this, so someone else decides it.`
  - `approve and reject a version`; `accept and decline a suggestion` → `{ ok: true, status }` and DB state.
  - `deciding twice answers ok false` → `message` is the `AppError` message.
  - Review Focus 4: `an item in a space the owner lost access to answers ok false` → grant removed, decide → `{ ok: false }`, message a sentence.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Versions: `listReviewQueue(owner, {})`, version markdown from the versions' stored markdown (the same source the web diff uses). Suggestions: open rows on pages in spaces where the owner is editor+ (via `senderAccess(owner).editable`), `before` = the addressed block's current text (`readLiveBlocks`) or field value, `after` = `proposedMarkdown`/value. Decide: wrap the route calls; `AppError` → `{ ok: false, message: err.message }`.
- [ ] **Step 4: Run; expect pass.**
- [ ] **Step 5: Commit** `feat(mcp): review items and decisions for the owner`

### Task 7: Review tools

**Files:**
- Create: `apps/api/src/mcp/tools/review.ts` (`REVIEW_RESOURCE = 'ui://kinote/review'`, `reviewTool`, `reviewListTool`, `reviewDecideTool`, `REVIEW_TOOLS`)
- Modify: `apps/api/src/mcp/tools/index.ts` (`READ_TOOLS` adds `reviewTool`, `reviewListTool`; `EDIT_TOOLS` adds `reviewDecideTool`), `apps/api/test/support/mcpkit.ts` (add `callToolFull` returning `{ text, isError, structured }`)
- Test: `apps/api/test/mcpReview.test.ts` (create), `apps/api/test/mcpEndpoint.test.ts` (tool list)

**Interfaces:**
- Consumes: Task 6.
- Produces: `kinote_review { page_id?, mine_only? }` (model-visible, `meta.ui.resourceUri = REVIEW_RESOURCE`); `kinote_review_list` → structured `{ items, can_decide_here }`; `kinote_review_decide` → structured `{ ok, status? , message? }`.

- [ ] **Step 1: Failing tests:**
  - `kinote_review lists items as text and names the panel` → lines `• version on "note" by Docs bot — …`; ends with `Kinote opened a review panel for your user.`; structured `{ page_id: null, mine_only: false }`.
  - `review_list as the owner` → structured `items.length === 2`, `can_decide_here true`.
  - `decide approves a version as the owner` → version `indexed`/`approved`, audit actor is the owner user with `payload.via 'mcp_app'`.
  - `approve_in_client off refuses decide and sets can_decide_here false` → decide structured `{ ok: false, message: 'Approve this in Kinote: <url>' }` (url `<publicUrl>/w/<slug>/reviews`).
  - `the review tools are app-only` → `tools/list` `_meta.ui.visibility` `['app']` for list and decide; `kinote_review` has `resourceUri`.
  - Update `mcpEndpoint.test.ts` expected tool names (add `kinote_create`, `kinote_move`, `kinote_delete`, `kinote_restore`, `kinote_review`, `kinote_review_list`, `kinote_review_decide` in `tools/list` order).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Owner actor from `ctx.actor.owner`; read `agents.approveInClient` for `ctx.actor.principalId`. Pass `via: 'mcp_app', agentId` into the audit payloads (add an optional `auditExtra` param to the four route functions, default `{}`).
- [ ] **Step 4: Run; expect pass.**
- [ ] **Step 5: Commit** `feat(mcp): kinote_review and its app-only list and decide tools`

### Task 8: The review panel

**Files:**
- Create: `apps/api/src/mcp/app/reviewLogic.ts` (pure), `apps/api/src/mcp/app/reviewPanel.ts` (DOM, `App` from ext-apps)
- Modify: `apps/api/src/mcp/app/panelHtml.ts` (generalise `bundle(entry)`; export `reviewPanelHtml()` with its own cache; shared CSS plus `.card`, `.del` (red), `.ins` (green), `.diff`), `apps/api/src/mcp/resources.ts` (`APP_RESOURCES` adds `{ uri: REVIEW_RESOURCE, name: 'Kinote review panel', description: 'Where your user approves or rejects what is waiting for review.', html: reviewPanelHtml }`)
- Test: `apps/api/test/reviewPanel.test.ts` (create), `apps/api/test/capturePanel.test.ts` (resource list)

**Interfaces:**
- Consumes: Task 7 structured shapes.
- Produces (`reviewLogic.ts`):
  ```ts
  export type CardState = { item: ReviewPanelItem; outcome: null | { kind: 'done' | 'error'; text: string }; busy: boolean };
  export function cardsFrom(list: { items: ReviewPanelItem[]; can_decide_here: boolean }): { cards: CardState[]; canDecide: boolean; empty: string | null };
  export function lineDiff(before: string, after: string): Array<{ op: 'same' | 'del' | 'ins'; text: string }>;
  export function applyOutcome(card: CardState, reply: { ok: boolean; status?: string; message?: string }, decision: 'approve' | 'reject'): CardState;
  export function contextLine(item: ReviewPanelItem, decision: 'approve' | 'reject'): string; // 'Approved: replace on "Handoff".'
  ```

- [ ] **Step 1: Failing tests** (`reviewPanel.test.ts`): `cardsFrom` empty → `empty === 'Nothing is waiting for you.'`; `lineDiff('a\nb', 'a\nc')` → `[same a, del b, ins c]`; `applyOutcome` ok approve → `{ kind: 'done', text: 'Approved' }`, reject → `'Rejected'`, not ok → `{ kind: 'error', text: message }`; `contextLine` exact string; the HTML from `reviewPanelHtml()` contains a `<script>` and `Kinote review panel` resource is listed with mime `text/html;profile=mcp-app`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement the logic, then the DOM panel**: on tool input/result call `kinote_review_list` with `{ page_id, mine_only }`; render cards (title, space, kind label — `Delete this page` and `n sub-pages` for archive —, proposer, age, reason, diff); Approve/Reject buttons (version Reject shows a one-line note input) disabled with `why_not` when not decidable, replaced by an `Open in Kinote` link when `!canDecide`; after a decision `applyOutcome` and `app.updateModelContext` with `contextLine`; a Refresh button.
- [ ] **Step 4: Run `reviewPanel.test.ts`, `capturePanel.test.ts`; expect pass.**
- [ ] **Step 5: Commit** `feat(mcp): the review panel as an MCP App`

### Task 9: Instructions, README, end-to-end

**Files:**
- Modify: `apps/api/src/mcp/instructions.ts` (the spec §4 sentence, verbatim), `README.md` (tools table rows for the five tools; lifecycle: editors archive and restore)
- Create: `e2e/review-app.spec.ts` (copy the harness of `e2e/upload-app.spec.ts`)
- Test: `apps/api/test/mcpEndpoint.test.ts` (instructions text, if asserted)

- [ ] **Step 1: Write `e2e/review-app.spec.ts`**: an agent (always review) edits a page through `kinote_edit`; the test host opens `kinote_review`'s panel; the card shows the change; click Approve; expect the card `Approved` and the page's version `indexed`/`approved` via the API.
- [ ] **Step 2: Run `pnpm e2e:local e2e/review-app.spec.ts`; expect FAIL only if Task 8 has a gap — otherwise it passes; if it passes first time, break `applyOutcome` temporarily to see it fail, then restore.**
- [ ] **Step 3: Update instructions and README.**
- [ ] **Step 4: Run `pnpm typecheck`, `pnpm test` (record the two known failures, `linkSites` and the flaky `captureRoute` long-document test, if they appear), and the e2e spec; expect pass otherwise.**
- [ ] **Step 5: Commit** `docs: tree tools and review panel; e2e for approving in the panel`
