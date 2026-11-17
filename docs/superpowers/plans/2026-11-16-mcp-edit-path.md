# MCP Edit Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kinote_edit`, the MCP tool for precise agent edits through the collaboration layer, with suggestions for blocked edits, field edits, agent-attributed suggestions, and the Edit scope at sign-in.

**Architecture:** A pure core helper replaces text inside one block's inline content. An API module (`apps/api/src/mcp/edit/`) validates each edit against the live page, sorts edits into refused / suggested / applied, sends applied ones to collab in one `applyBlockOps` call as the agent, snapshots, and writes suggestions that name the proposing agent. The MCP tool wraps it; suggestions, OAuth and the web learn about agent proposers and the Edit scope.

**Tech Stack:** pnpm monorepo, Fastify 5, Drizzle (hand-written migration + journal), Postgres RLS, Vitest on PGlite, Playwright (`pnpm e2e:local <spec>`), BlockNote/Yjs collab, MCP SDK 1.32.2.

**Spec:** `docs/superpowers/specs/2026-11-16-mcp-edit-path-design.md` (from build step 4 of https://claude.ai/artifact/6Wyvb6h6PvxtrsBjwSS9fS)

## Global Constraints

- Max 20 edits per call; inserted Markdown max 10,000 characters per edit.
- `MCP_EDIT_PER_MINUTE = 30` per agent; `kinote_edit` has `writes: true` (suspension refuses it).
- Removals are always suggestions (`blocked_by: 'removal'`).
- Snapshot reason `'agent'`; `forceReview` = the agent's `alwaysReview`.
- Collab actor for applied edits `{ type: 'agent', id: agentId }`, `source: 'agent'`.
- Refusal copy (exact):
  - not found / no longer contains old: `changed since you read it: read the section again`
  - gone block: `block not found: read the page again`
  - duplicate: `"old" appears N times in block <short>; quote more words`
  - unsupported block: `This block can't be edited with kinote_edit; use kinote_capture to propose the change.`
  - ambiguous id: `Block id "<ref>" is ambiguous; give more characters`
  - same block twice: `one edit per block per call`
  - file page: `kinote_edit changes pages, not files. Use kinote_capture to file what a file says.`
- Suggested copy: `suggested: removals wait for a person`, `suggested: <name> edited this block N minutes ago`, `suggested: no edit access`.
- Server instruction line (exact): `Use kinote_edit for precise fixes: read the section first and quote the exact words to change. Check kinote_related so a fact written on several pages is fixed everywhere.`
- Sign-in checkbox label (exact): `Also let it make precise edits (Edit)`.
- Never put the user's email anywhere outside the repo.

## Review Focus

1. `old` spanning two styled runs (e.g. half bold) — replacement succeeds, text outside the span keeps its styles; Task 2 test `spans runs`.
2. A person typing between the server's read and the apply — collab `block_changed` makes every applied edit of the call `refused: changed since…`, nothing half-applied; Task 3 test `collab block_changed refuses the call's applied edits`.
3. An agent whose owner lost edit rights since the grant — edits become `no_edit_access` suggestions, never applied; Task 3 test `owner lost edit → suggestion`.
4. Accepting an agent's suggestion after the agent was disabled — applies as the Routing engine, no crash; Task 1 test `disabled agent's suggestion is accepted as the Routing engine`.
5. Inserting after a table/drawing block (allowed) while editing one is refused; Task 3 test `insert after a table is allowed`.

---

### Task 1: Suggestions name their proposer

**Files:**
- Create: `packages/db/migrations/0048_agent_edits.sql` (+ journal entry in `packages/db/migrations/meta/_journal.json`)
- Modify: `packages/db/src/schema/routing.ts` (suggestions), `packages/contracts/src/index.ts` (`SuggestionSummarySchema`), `apps/api/src/routes/captures.ts` (`toSuggestionSummary`), `apps/api/src/routes/suggestions.ts` (`decidable`, `acceptSuggestion`, list), `apps/web/src/components/capture/SuggestionsPanel.tsx`
- Test: `apps/api/test/agentSuggestions.test.ts`, web test next to SuggestionsPanel if one exists (else `apps/web/test/suggestionsPanel.test.tsx`)

**Interfaces:**
- Produces: columns `suggestions.proposedByType: 'user'|'agent'|null`, `suggestions.proposedBy: uuid|null`; `SuggestionSummary.proposedBy: { type: 'user'|'agent'; id: string; name: string } | null`.

- [ ] **Step 1: Write failing tests** in `agentSuggestions.test.ts` (use `useCaptureKit`, insert suggestion rows directly with `proposedByType: 'agent'`):
  - `the list names the proposing agent`: `GET /api/v1/pages/:id/suggestions` → `proposedBy` equals `{ type: 'agent', id: agentId, name: 'Docs bot' }`.
  - `accepting an agent's suggestion applies it as that agent`: replace suggestion on `w.george`; accept as owner; latest version's `createdByType/createdBy` (whatever `versions` uses for the snapshot actor) is the agent; audit `suggestion.accepted` actor is the owner.
  - `disabled agent's suggestion is accepted as the Routing engine`: set `agents.disabledAt`; accept succeeds; snapshot actor is the router agent (`ensureRouterAgent`).
  - `the agent's owner cannot decide it in a review space`: space `review_required` true, `allow_self_approval` false, agent created by a member; member (editor+reviewer grant) accept → 403 `self_approval`; owner (another user) accept → 200.
- [ ] **Step 2: Run** `pnpm --filter @kinote/api exec vitest run test/agentSuggestions.test.ts` — Expected: FAIL (column/field missing).
- [ ] **Step 3: Implement.** Migration adds `proposed_by_type text CHECK (proposed_by_type IN ('user','agent'))` and `proposed_by uuid`, both nullable. `toSuggestionSummary(row, conflictWith, field, proposedBy = null)`; list and accept/decline look up the agent name (`agents.name`) for rows with `proposedByType = 'agent'`. `decidable`: in a review space without self-approval, refuse `self_approval` when `row.proposedByType === 'agent'` and that agent's `createdBy === actor.principalId`. `acceptSuggestion`: when the proposer is an enabled external agent use it as collab actor and snapshot `actorId`, else the router. Panel: when `suggestion.proposedBy` render `Suggested by {name}` above the reason.
- [ ] **Step 4: Run** the test file and `pnpm --filter @kinote/api exec vitest run test/suggestions.test.ts test/captureChanges.test.ts` and `pnpm --filter @kinote/web test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(suggestions): name the agent that proposed a suggestion; accept applies as it`.

### Task 2: Replace text inside a block

**Files:**
- Create: `packages/core/src/edit/replaceInBlock.ts`, export from `packages/core/src/index.ts`
- Test: `packages/core/test/replaceInBlock.test.ts`

**Interfaces:**
- Produces: `replaceInBlock(block: BlockLike, old: string, next: string): { ok: true; block: BlockLike } | { ok: false; reason: 'not_found' | 'ambiguous'; count: number }`; `EDITABLE_BLOCK_TYPES: ReadonlySet<string>` (paragraph, heading, bulletListItem, numberedListItem, checkListItem, quote, codeBlock).

- [ ] **Step 1: Failing tests:**
  - `replaces inside one run`: `[text "Launch is in November."]`, old `November` new `December` → text `Launch is in December.`
  - `keeps links and bold outside the span`: content `[text "See ", link{href:"https://x", content:[text "the plan"]}, text " — due May", bold run " 3"]`, replace `May` with `June` → link node unchanged, bold run unchanged.
  - `spans runs`: `[text "Launch " , bold "in Nov"]`, old `Launch in` → new `Ship in`: result plain text equals `Ship in Nov`; ` Nov` still bold.
  - `inserted text takes the style of the run where old starts` (bold start → new text bold).
  - `not_found` and `ambiguous` (count 2) results; children untouched; `id`, `type`, `props` unchanged.
  - Text inside a link: replacing words wholly inside a link keeps the href.
- [ ] **Step 2: Run** `pnpm --filter @kinote/core exec vitest run test/replaceInBlock.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement.** Flatten inline content to a list of leaf text runs `{text, styles, linkHref?}` with offsets; locate `old` in the joined text (count occurrences, non-overlapping); remove the covered characters across runs, insert `next` in the start run (inheriting its styles/link); drop empty runs; rebuild, regrouping consecutive runs with the same `linkHref` back into link nodes. Children excluded from matching.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): replace text inside a block keeping its formatting`.

### Task 3: The edit engine and `kinote_edit` (blocks)

**Files:**
- Create: `apps/api/src/mcp/edit/plan.ts` (validate + sort), `apps/api/src/mcp/edit/apply.ts` (collab, snapshot, suggestions, audit), `apps/api/src/mcp/tools/edit.ts`
- Modify: `apps/api/src/mcp/tool.ts` (limit `'edit'`, `MCP_EDIT_PER_MINUTE = 30`), `apps/api/src/mcp/tools/index.ts` (add to `ALL_TOOLS`), `apps/api/src/mcp/format.ts` (`dataBlock` source `'edit'`), `apps/api/src/mcp/instructions.ts` (edit line, shown when scopes include `edit`)
- Test: `apps/api/test/mcpEdit.test.ts`

**Interfaces:**
- Consumes: `replaceInBlock`, `EDITABLE_BLOCK_TYPES` (Task 2); suggestion `proposedByType/proposedBy` (Task 1); `senderActor`, `senderAccess`, `capturesAlwaysReviewed` (core routing/access); `resolvePageRef`; `readLiveBlocks`; `markdownBlocks`; `takePageSnapshot`; `blockFullText`.
- Produces:
  - `type AgentEdit = { block_id: string; old: string; new: string } | { after_block_id: string | null; markdown: string } | { remove_block_id: string } | { field: string; value: unknown }`
  - `type EditOutcome = { label: string; result: 'applied' | 'suggested' | 'refused'; detail: string }` (`label` e.g. `b_33aa12`, `after b_33aa12`, `top`, `field Status`)
  - `runAgentEdits(ctx: { actor: Actor; agentId: string; collab: CollabClient; now?: Date }, pageId: string, edits: AgentEdit[]): Promise<{ page: DocumentRow; outcomes: EditOutcome[]; versionId: string | null }>`

- [ ] **Step 1: Failing tests** (`useCaptureKit` world; agent with editor grant on Clients, `alwaysReview` false unless stated; token scopes `['read','edit']`; call via `callTool`). Each asserts reply lines and page text (`k.pageText`):
  - `replace applies as the agent`: `{block_id: short(george block), old: 'November', new: 'December'}` → line `— applied · indexing`; page text has `December`; latest version actor is the agent, reason `agent`.
  - `insert after and at the top` (`after_block_id: null`).
  - `remove becomes a suggestion` → `suggested: removals wait for a person`; suggestion row `proposedBy` = agent, `blockedBy` = `removal`.
  - `a person's recent edit makes a suggestion`: owner edits block via `k.collab.applyBlockOps` source `human` (writes block_activity); agent replace → `suggested: <owner name> edited this block 0 minutes ago`, `blockedBy: 'protection'`.
  - `viewer grant → suggestion` (`no_edit_access`); `owner lost edit → suggestion` (agent's member owner demoted to viewer on space).
  - `old missing → refused`, `old twice → refused` (exact copy), `unknown block → refused`, `ambiguous prefix → refused`, `same block twice → refused`, `nested block id → refused` with the unsupported copy, `table block → refused`, `insert after a table is allowed`.
  - `collab block_changed refuses the call's applied edits`: wrap `k.collab` so `applyBlockOps` throws `AppError('block_changed')`; both applied edits report `refused: changed since you read it…`, nothing written.
  - `all refused → isError true`; `mixed → isError false`.
  - `always review → applied · waiting for review`.
  - `a file page is refused`; `a read-only token does not list kinote_edit`; `suspended → refused`; `31st call in a minute is limited` (mirror `mcpWrites` limit test with `kinote_edit` and a trivially refused edit).
  - `instructions mention kinote_edit only for edit tokens` (exact line).
- [ ] **Step 2: Run** `pnpm --filter @kinote/api exec vitest run test/mcpEdit.test.ts` — FAIL (tool missing).
- [ ] **Step 3: Implement.**
  - Tool input (zod): `page_id` string 1–64; `edits` array 1–20 of a union of the four shapes (`old` min 1, `new` max 10,000, `markdown` 1–10,000). Description: "Make precise edits to a page you have read: replace exact words in a block ({block_id, old, new}), insert Markdown after a block ({after_block_id, markdown}; null for the top), propose removing a block ({remove_block_id}), or set a collection field ({field, value}). Block ids come from kinote_read. Edits a person made recently, removals, and spaces you can only read become suggestions for a person."
  - `plan.ts`: flush the page, read live blocks once; resolve ids against top-level blocks by `sameId` (move the helper from `read.ts` into `format.ts` and reuse); id found only nested → unsupported; type not in `EDITABLE_BLOCK_TYPES` → unsupported (inserts exempt). Gate per edit: removal → `removal`; `senderAccess(actor).editable` lacks the page's space → `no_edit_access`; block activity by a user inside `humanProtectionSeconds` → `protection` (name from `users`, minutes floored). Expected text = `blockFullText(block)` as read.
  - `apply.ts`: one `applyBlockOps` for the applied set; on `block_changed`/`block_not_found` mark them refused; then flush, `takePageSnapshot({ reason: 'agent', actorType: 'agent', actorId: agentId, manual: false, forceReview })`; insert suggestions with `proposedByType: 'agent'`, `proposedBy: agentId`, `captureId: null`, `reason` = the agent's line; one audit `agent.edit` (`subjectType: 'page'`, payload `{ applied, suggested, refused, versionId }`) — add the type to the contracts audit list.
  - Reply: `<title> · N edits` inside `dataBlock('edit', …)`, one `• <label> — <result>[ · <detail> | : <detail>]` line per edit in input order, then the page link. `isError` when every outcome is refused (throw `ToolError` with the full text).
- [ ] **Step 4: Run** the test file, then `pnpm --filter @kinote/api exec vitest run test/mcp` — PASS (update `mcpEndpoint` tool-list expectations if they enumerate tools).
- [ ] **Step 5: Commit** `feat(mcp): kinote_edit applies precise block edits as the agent, suggests blocked ones`.

### Task 4: Fields in read and edit

**Files:**
- Modify: `apps/api/src/mcp/tools/read.ts`, `apps/api/src/mcp/edit/plan.ts`, `apps/api/src/mcp/edit/apply.ts`
- Test: `apps/api/test/mcpEditFields.test.ts`

**Interfaces:**
- Consumes: `rowCollectionOf`, `fieldValueFits`, `canonicalFieldJson`, `FIELD_BLOCK_PREFIX`; collab op `{ op: 'set_field', fieldId, value, expected }`.

- [ ] **Step 1: Failing tests** (collection with fields Status (choice Open/Done) and Due (date); a row page; see `apps/api/test/captureFieldChanges.test.ts` for setup):
  - `read shows field values`: outline and section reads contain `Fields: Status: Open · Due: 2026-12-01` (choice shown by name).
  - `field edit applies`: `{field: 'status', value: <Done choice id or name — accept the choice name and map to id>}` → `applied`, row value changed.
  - `unknown field refused, listing names` (`Unknown field "Priority". Fields: Status, Due`); `bad value refused` (`Due expects a date (YYYY-MM-DD)` — word per field type); `field on a non-row page refused` (`This page is not a collection row`).
  - `a person's recent field change → suggestion` (`set_field`, `protection`); `value null` → `suggested: removals wait for a person` (same as capture: clearing is a removal).
- [ ] **Step 2: Run** `pnpm --filter @kinote/api exec vitest run test/mcpEditFields.test.ts` — FAIL.
- [ ] **Step 3: Implement** field resolution (name case-insensitive or id; choice values by name or id), checks, gates (`FIELD_BLOCK_PREFIX + fieldId` for block activity), apply in the same `applyBlockOps` call with `expected: canonicalFieldJson(current)`, suggestions `kind: 'set_field'`. Read: one `Fields:` line after the header for row pages.
- [ ] **Step 4: Run** the file plus `test/mcpRead.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(mcp): field values in kinote_read and field edits in kinote_edit`.

### Task 5: Edit scope at sign-in and on the Agents page

**Files:**
- Modify: `packages/contracts/src/index.ts` (`OAUTH_SCOPES = ['read','capture','edit']`, `OAuthDecisionSchema` allow `edit: z.boolean().default(false)`), `apps/api/src/oauth/routes.ts`, `apps/web/src/routes/oauth-authorize.tsx`, `apps/web/src/lib/agents.ts`, `apps/web/src/routes/admin/agents.tsx`, `README.md`
- Test: `apps/api/test/oauth.test.ts`, `apps/web/test/agents.test.ts`, `e2e/agents.spec.ts`

**Interfaces:**
- Produces: `OFFERED_SCOPES = ['read','capture','edit']`; `writesHaveNowhereToGo(agent, scopes?, now?): { capture: boolean; edit: boolean }` replacing `captureHasNowhereToFile`.

- [ ] **Step 1: Failing tests:**
  - oauth: `sign-in can allow Edit`: client asks `read edit`, decision `{allow, edit: true}` → token scopes `['read','edit']`, grants editor; `edit refused when not asked` (`validation_failed`); `scopes_supported` is `['read','capture','edit']`.
  - web: `writesHaveNowhereToGo` → `{capture:false, edit:true}` for an edit-only token with only viewer grants; both false with an editor grant.
  - e2e agents: the Edit checkbox is visible on the token form; ticking Edit with no editor grant shows a note containing `its edits would only be suggestions`.
- [ ] **Step 2: Run** `pnpm --filter @kinote/api exec vitest run test/oauth.test.ts`, `pnpm --filter @kinote/web test` — FAIL.
- [ ] **Step 3: Implement.** OAuth decision: scopes = `['read', ...(capture ? ['capture'] : []), ...(edit ? ['edit'] : [])]`; exchange grants editor when scopes include capture or edit. Sign-in page: second opt-in checkbox with the exact label, shown when the client asked for `edit`. Warning copy: Capture → existing sentence; Edit → "It can't edit any space yet, so its edits would only be suggestions. Give it Editor access to a space above." (both lines when both). README "Connect an agent": a sentence on Edit (precise fixes; blocked ones become suggestions).
- [ ] **Step 4: Run** the tests above and `pnpm e2e:local agents.spec.ts oauth.spec.ts` — PASS.
- [ ] **Step 5: Commit** `feat(agents): offer the Edit scope on tokens and at sign-in`.

### Task 6: End to end

**Files:**
- Create: `e2e/edit-agents.spec.ts`
- Modify: `apps/api/test/mcpClient.test.ts` (real SDK client calls `kinote_edit`), README MCP tools list if it enumerates tools

- [ ] **Step 1: Write** `mcpClient` test `a real client edits a page` (list includes `kinote_edit`; replace applies) and e2e: seed world (review off), agent with editor grant and `['read','edit']` token; `kinote_read` section to get a block id; `kinote_edit` replace + remove; owner opens the page: text shows the change, Suggestions panel shows `Suggested by Docs bot`; Accept → block gone.
- [ ] **Step 2: Run** `pnpm --filter @kinote/api exec vitest run test/mcpClient.test.ts` and `pnpm e2e:local edit-agents.spec.ts` — PASS (they exercise finished code; if either fails, debug the code, not the test).
- [ ] **Step 3: Full check** `pnpm typecheck` and `pnpm test > <workspace>/full.log` — PASS (known `captureRoute` flake: rerun alone).
- [ ] **Step 4: Commit** `test: an agent edits a page over MCP and its owner accepts the removal`.
