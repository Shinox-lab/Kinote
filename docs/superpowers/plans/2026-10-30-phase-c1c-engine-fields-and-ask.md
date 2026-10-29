# Phase C1c: the engine writes fields; Ask reads collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A routed fact can set or change a row's field (applied, suggested, receipted and undoable exactly like a text edit), and Ask answers questions across a collection from a compact table of its rows.

**Architecture:** `set_field` becomes one more planned op. The planner sees each row candidate's fields and live values, resolves the model's value (choice names, member names, page titles, ISO dates) into a stored value, and gates it with the text rules (R2 removal, rule 5 protection, edit access). Applying rides the existing collab `apply-block-ops` call: it gains a `set_field` op with a compare-and-set `expected` value, so text and field edits on one page are still one collab change and one snapshot. Receipts and suggestions keep raw JSON in their existing text columns and return a formatted `field` object to the console. Ask adds one table passage per collection whose rows were retrieved, built from indexed versions only.

**Tech Stack:** TypeScript, Drizzle, Zod contracts, Yjs/Hocuspocus (collab), Vitest with PGlite, React.

**Spec:** `docs/superpowers/specs/2026-10-29-phase-c-collections-design.md`, decisions C3, C9 (second part) and C10. Also the routing engine spec `docs/superpowers/specs/2026-10-26-routing-engine-design.md` (R1, R2, R10, R13, rule 5).

## Global Constraints

- Field values are stored by id: a select is a choice id, a person is user ids, a page is document ids, a date is `{ start, end? }` with `YYYY-MM-DD` (no time of day). Every stored value must pass `fieldValueFits` from `@kinote/contracts`.
- The engine never creates a choice: a choice name that isn't one of the field's choices is rejected (the edit is dropped).
- Clearing a field that has a value, with nothing replacing it, is a removal: always a suggestion (R2), never applied.
- A field a person changed within the space's `human_protection_seconds` (a `block_activity` row with `block_id = field:<fieldId>`, `actor_type = 'user'`) is never overwritten by the engine: suggestion with `blocked_by = 'protection'`.
- `capture_changes` set_field rows: `op = 'set_field'`, `block_id = 'field:<fieldId>'`, `before_markdown` / `after_markdown` hold the value as canonical JSON (`before_markdown` null when the field was empty).
- `suggestions` set_field rows: `kind = 'set_field'`, `block_id = 'field:<fieldId>'`, `proposed_markdown` holds the proposed value as canonical JSON (`null` JSON literal `'null'` for a clear), `expected_text` holds the value seen when proposed as canonical JSON (`'null'` when empty).
- Undo restores the before value only while the field still holds the after value; otherwise (a person changed it, the field or choice was removed, the page is no longer a row) it is left and reported in `changedSince`.
- Accepting a set_field suggestion goes `stale` when the field was removed, the proposed value no longer fits, or the current value differs from `expected_text`.
- Receipt line format: `Launch date: 2026-11-15 → 2026-12-01`, values printed with `formatFieldValue`; a removed field prints as `Removed field`, an empty side as `empty`.
- Search and Ask never read `page_field_values`; Ask's collection table reads indexed versions' `fields` only, readable rows only, at most 200 rows per collection, at most 2 collections per question.
- `capture_changes.op` and `suggestions.kind` are text columns with TypeScript-only enums: adding `'set_field'` needs no migration. `pnpm db:generate` must produce no new migration.
- No commit may include the in-progress `living-wiki` → `kinote` rename: stage only the files a task names.

## Review Focus

1. **A field value the model phrases loosely** ("December 1st", "Active " with a trailing space, "yes") — `resolveFieldValue` accepts the common spellings listed in Task 2 and drops anything else; it never stores a value `fieldValueFits` rejects. Test in Task 2.
2. **A person edits the field between planning and applying** — collab's `expected` check refuses the whole page's call with `block_changed`, and every edit for that page becomes a protection suggestion (nothing half-applied). Test in Task 4.
3. **The planned value equals the live value** — no change, no receipt row; the fact is `already_known`. Test in Task 3.
4. **The field or choice is removed after a suggestion was made** — accept goes stale with `suggestion_not_open`; undo of an applied change is reported as changed since. Tests in Task 5.
5. **Ask's table leaking an unreadable row or an unapproved value** — the table uses indexed versions only and the same readable-space list as the search; a row whose latest change waits for review shows its indexed value. Test in Task 7.

---

## File map

| File | Change |
|---|---|
| `packages/contracts/src/collections.ts` | `canonicalFieldJson`, `FieldChangeSchema` |
| `packages/contracts/src/index.ts` | `set_field` op on `CollabApplyBlockOpsRequestSchema`; `field` on `CaptureChangeSchema` and `SuggestionSummarySchema`; `set_field` in their enums |
| `packages/db/src/schema/routing.ts` | `'set_field'` in `captureChanges.op` and `suggestions.kind` enums |
| `apps/collab/src/internal.ts` | `applyDocumentBlockOps` checks and applies `set_field` ops |
| `packages/core/src/collections/resolve.ts` (new) | `resolveFieldValue` |
| `packages/core/src/collections/describe.ts` (new) | `describeFieldChange` for receipts and suggestions |
| `packages/core/src/routing/liveBlocks.ts` | `readLiveBlocks` also returns `fields` |
| `packages/core/src/placement/model.ts` | `PlanCandidate` field info, `set_field` op, `create_page.fields`, deterministic rule, prompt |
| `packages/core/src/routing/plan.ts` | candidates carry fields; `checkEdits` resolves and gates `set_field`; document page as fields-only candidate |
| `packages/core/src/routing/apply.ts` | recheck, apply, record, suggest `set_field`; fields on engine-created pages |
| `apps/api/src/routes/captureChanges.ts` | undo `set_field`; document-page undo ignores field rows; `field` on listed changes |
| `apps/api/src/routes/suggestions.ts` | accept `set_field` |
| `apps/api/src/routes/captures.ts` | `field` on receipt changes and suggestion summaries |
| `apps/web/src/lib/capture.ts`, `components/capture/Receipt.tsx`, `CaptureBanner.tsx`, `SuggestionsPanel.tsx` | show field changes |
| `packages/core/src/search/collectionTable.ts` (new) | `collectionTables` |
| `packages/core/src/answer.ts`, `apps/api/src/search/ask.ts`, `apps/api/src/server.ts` | tables in Ask |
| `packages/core/test/fixtures/routingSeed.ts` | `addCollection`, `setLiveFields` |

---

### Task 1: Contracts, schema enums and the collab `set_field` op

**Files:**
- Modify: `packages/contracts/src/collections.ts`, `packages/contracts/src/index.ts:893-931`, `packages/db/src/schema/routing.ts:139,172`, `apps/collab/src/internal.ts:186-210`
- Test: `packages/contracts/test/collections.test.ts`, `apps/collab/test/internal.test.ts`

**Interfaces:**
- Produces:
  - `canonicalFieldJson(value: unknown): string` — JSON with object keys sorted recursively; `undefined` and `null` both give `'null'`. Move the existing `canonicalJson` out of `packages/core/src/snapshot.ts:55` into `collections.ts` under this name and have `snapshot.ts` import it (one implementation, so a version's hash and a receipt's JSON never disagree).
  - `FieldChangeSchema = z.object({ fieldId: z.string(), name: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable() })` and `type FieldChange`. `name` null means the field no longer exists; `before`/`after` are display text (null = empty).
  - Collab op `{ op: 'set_field'; fieldId: string (uuid); value: unknown; expected?: string }` in `CollabApplyBlockOpsRequest['ops']`. `value: null` clears. `expected` is `canonicalFieldJson` of the value the caller saw.
  - `CaptureChangeSchema.op` and `SuggestionSummarySchema.kind` gain `'set_field'`; both gain `field: FieldChangeSchema.nullable()` (null for block changes).

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/test/collections.test.ts`:
```ts
it('canonicalFieldJson sorts keys and treats undefined as null', () => {
  expect(canonicalFieldJson({ start: '2026-12-01', end: '2026-12-03' })).toBe(canonicalFieldJson({ end: '2026-12-03', start: '2026-12-01' }));
  expect(canonicalFieldJson(undefined)).toBe('null');
  expect(canonicalFieldJson(['b', 'a'])).toBe('["b","a"]'); // arrays keep their order
});
```
In `apps/collab/test/internal.test.ts` (use the existing in-process server helpers there):
- `it('set_field sets and clears a value in the same change as block ops')` — one call with an `insert_after` and a `set_field`, then a second call with `{ op: 'set_field', fieldId, value: null }`; assert the `fields` map holds then lacks the key, and the block was inserted.
- `it('set_field with a stale expected value changes nothing')` — the map holds `"Lead"` id; call with an `insert_after` plus `set_field` whose `expected` is `canonicalFieldJson('other')`; expect `AppError` `block_changed`, and neither the block nor the field changed.
- `it('set_field expected "null" matches an absent field')`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/contracts/test/collections.test.ts apps/collab/test/internal.test.ts`
Expected: FAIL (`canonicalFieldJson` is not exported; the `set_field` op fails validation).

- [ ] **Step 3: Implement**

- Add `canonicalFieldJson` and `FieldChangeSchema` to `collections.ts` and export them.
- Add the `set_field` member to the ops discriminated union (`value: z.unknown()`, `expected: z.string().max(100_000).optional()`). Keep the existing `.min(1)` on ops.
- Add `'set_field'` to the two TS enums in `routing.ts` and to the two contract enums; add `field` to both summary schemas. Every place that builds these objects must now set `field: null` (typecheck lists them: `captures.ts`, `captureChanges.ts`); Task 5 fills it in for field rows.
- In `applyDocumentBlockOps`, split `ops` into block ops and field ops. Inside the existing `session.transact` callback, in this order: (1) for each field op with `expected`, compare `canonicalFieldJson(map.get(fieldId))` with it and throw `AppError('block_changed')` on a mismatch; (2) `applyBlockOps(fragment, blockOps)` when there are any (it validates before it mutates); (3) set or delete each field op's key on `doc.getMap(FIELDS_MAP)`. Nothing is mutated before every check has passed. Only the block ops go through the off-document `blocksToYXmlFragment` validation.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run packages/contracts apps/collab && pnpm typecheck`
Expected: PASS. Then `pnpm db:generate` — expected: "No schema changes".

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src packages/contracts/test/collections.test.ts packages/db/src/schema/routing.ts apps/collab/src/internal.ts apps/collab/test/internal.test.ts apps/api/src/routes/captures.ts apps/api/src/routes/captureChanges.ts
git commit -m "feat(collab): set_field op with a compare-and-set value"
```

---

### Task 2: Resolving the model's value into a stored value

**Files:**
- Create: `packages/core/src/collections/resolve.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/fieldResolve.test.ts`

**Interfaces:**
- Consumes: `FieldDef`, `fieldValueFits` (contracts); `memberships`, `users`, `documents` tables.
- Produces: `resolveFieldValue(tx: DbTransaction, tenantId: string, def: FieldDef, raw: unknown, spaceId: string): Promise<{ ok: true; value: unknown } | { ok: false }>` — `value` is `null` for a clear, otherwise a value that passes `fieldValueFits(def, value)`.

Accepted model spellings, per type (anything else is `{ ok: false }`):

| Type | Accepted `raw` |
|---|---|
| any | `null` → clear |
| text | a string; trimmed, inner whitespace kept |
| number | a finite number, or a string that is one after removing `,` and a leading currency symbol or trailing `%` |
| date | `'YYYY-MM-DD'` → `{ start }`; `{ start, end? }` with those strings |
| select | a choice name (case-insensitive, trimmed) or a choice id → the id |
| multi_select | a string or array of strings, each a choice name or id → ids, de-duplicated, order kept; empty → clear |
| checkbox | a boolean, or `yes/no/true/false/checked/unchecked` (case-insensitive) |
| person | a string or array of member names (exact, case-insensitive, unique within the tenant) or user ids that are members → user ids |
| page | a string or array of page titles (exact, case-insensitive, unique among live pages of `spaceId`) or such page ids → document ids |

- [ ] **Step 1: Write the failing tests**

One `it` per type, plus:
- `it('a choice name that is not a choice is rejected, never created')` → `{ ok: false }`, and the field's options are unchanged in the database.
- `it('a member name shared by two members is rejected')`.
- `it('a page title in another space is rejected')`.
- `it('an impossible date such as 2026-02-30 is rejected')`.
- `it('" Active " resolves to the Active choice id')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/core/test/fieldResolve.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `resolveFieldValue` in `resolve.ts`**

It ends with `fieldValueFits(def, value) ? { ok: true, value } : { ok: false }`, so no branch can return an ill-typed value.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run packages/core/test/fieldResolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collections/resolve.ts packages/core/src/index.ts packages/core/test/fieldResolve.test.ts
git commit -m "feat(core): resolve routed field values to stored values"
```

---

### Task 3: The planner sees fields and plans `set_field`

**Files:**
- Modify: `packages/core/src/routing/liveBlocks.ts`, `packages/core/src/placement/model.ts`, `packages/core/src/routing/plan.ts`
- Modify: `packages/core/test/fixtures/routingSeed.ts`
- Test: `packages/core/test/routingFields.test.ts`

**Interfaces:**
- Consumes: `resolveFieldValue` (Task 2), `canonicalFieldJson` (Task 1), `rowCollectionOf`, `collectionFieldDefs`, `fieldNames`, `fieldEntries`.
- Produces:
  - `readLiveBlocks(...)` returns `{ title, blocks, fields: Record<string, unknown> }` (the raw `fields` map).
  - `PlanCandidate` gains `fields: PlanField[] | null` (the collection this page is a row of), `values: Record<string, string>` (fieldId → formatted live value, only fields that fit), `collectionFields: PlanField[] | null` (set when the page itself is a collection), `fieldsOnly: boolean`. `PlanField = { id: string; name: string; type: FieldType; choices: string[] }`.
  - `PlannedOp` gains `{ op: 'set_field'; documentId: string; fieldId: string; value: unknown }`; `create_page` gains `fields?: Array<{ fieldId: string; value: unknown }>`.
  - `CheckedEdit` for a `set_field`: `edit.op.value` is the resolved stored value, `beforeMarkdown` is `canonicalFieldJson(current)` or null when empty, `expectedText` is `canonicalFieldJson(current)`. For a `create_page`, `edit.op.fields` holds only resolved, non-null entries.
  - `Candidate` gains `defs: FieldDef[]` and `liveFields: Record<string, unknown>`.
  - Fixtures: `addCollection(w, documentId, fields: Array<{ name: string; type: FieldType; choices?: string[] }>): Promise<FieldDef[]>` and `setLiveFields(w, pageId, values: Record<string, unknown>)` (writes the stored Yjs state and the projection, as collab would).

- [ ] **Step 1: Write the failing tests**

Seed for most tests: space "Clients", page "Clients" made a collection with `Status` (select: Lead, Active, Churned), `Launch date` (date), `Owner` (person); row page "George" with Status = Lead, Launch date = 2026-11-15.

- `it('a change to a row field plans set_field with the resolved value')` — capture "George launch date moved to 2026-12-01." → one edit `{ op: 'set_field', documentId: george, fieldId: launch, value: { start: '2026-12-01' } }`, gate null, `beforeMarkdown === canonicalFieldJson({ start: '2026-11-15' })`.
- `it('a select value is planned by choice id')` — "George status is now Active." → value is the Active choice id.
- `it('an unknown choice drops the edit')` — "George status is now Paused." → no set_field edit (plan is `needs_home`, or a text edit only).
- `it('clearing a field that has a value is gated as a removal')` — "George no longer has a launch date." → set_field with value null, gate `removal`.
- `it('a value equal to the live one is already_known')` → plan status `already_known` with `blockId: 'field:<launchId>'`.
- `it('a field a person changed a minute ago is gated as protection')` — insert a `block_activity` row for `field:<launchId>`, actor user, one minute ago.
- `it('a row in a read-only space is gated as no_edit_access')`.
- `it('a set_field matching an open set_field suggestion is dropped')`.
- `it('the planner is shown the row fields, choices and live values')` — with a recording model, assert the candidate has `fields` with `choices: ['Lead', 'Active', 'Churned']` and `values[launchId] === '2026-11-15 (15 November 2026)'`.
- `it('a create_page under a collection keeps only fields that resolve')` — a stub model returning `create_page` under Clients with `fields: [{ fieldId: status, value: 'Active' }, { fieldId: status, value: 'Paused' }]` at confidence 0.9 → one resolved field kept.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/core/test/routingFields.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `readLiveBlocks`: add `fields: doc.getMap(FIELDS_MAP).toJSON()`.
- `gatherCandidates`: per page, `rowCollectionOf` gives `defs`; `fields`/`values` from them and `validFields` + `fieldEntries` over `live.fields` (strip the `Name: ` prefix for `values`); `collectionFields` when `isCollection(doc.id)`.
- `OpSchema`: add `set_field` (`documentId: Id, fieldId: Id, value: z.unknown()`) and optional `fields` on `create_page` (array of `{ fieldId: Id, value: z.unknown() }`, at most 50). `nestOp` already flattens.
- `DeterministicPlacementModel.planEdits`: before the text rules, for the first candidate with `fields` whose title (lower-cased) the statement contains, and a field whose name the statement contains: removal kind → `set_field` value null at 0.9; otherwise the text after the last ` to ` or ` is now ` or ` is ` (trailing `.` stripped) → `set_field` with that string at 0.9. Document the rule in its doc comment.
- `OpenAIPlacementModel.planEdits`: per candidate, after its blocks, a `Fields:` section listing `[fieldId] name (type; choices: a, b) = current value or (empty)`; for a collection candidate, `New pages under it can set fields:` with the same list. Add to the system prompt: the `set_field` shape, "value is a plain value: text, a number, YYYY-MM-DD, a choice name from the list, a list of choice names, a person's name, true/false, or null to clear; never invent a choice", and `create_page` may carry `"fields": [{"fieldId","value"}]` only under a page listing them.
- `checkEdits`: a `set_field` must name a candidate with `defs` containing `fieldId` and not be `fieldsOnly`-violating (fields-only candidates accept only `set_field`); confidence floor `ROUTING.apply` as for text. Resolve the value; drop on `{ ok: false }`. Equal canonical JSON to the live value → counts as `duplicateOf` with `blockId: field:<id>`. Null while empty → dropped. Gates: null with a value → `removal`; `block_activity` user row on `field:<id>` within the window → `protection`; not editable → `no_edit_access`. Duplicate check: an open `suggestions` row with `kind = 'set_field'`, the same `blockId` and the same `proposedMarkdown`; or an applied `capture_changes` set_field row with the same `afterMarkdown` whose version is `pending_review`. `targetOf` already groups by `documentId`, so a text edit and a field edit on one page count as one target for R10.
- `create_page` with `fields`: the parent must be a collection; resolve each entry against its defs and the new page's space; keep the resolved, non-null ones.

- [ ] **Step 4: Run planner tests (new and old)**

Run: `pnpm vitest run packages/core/test/routingFields.test.ts packages/core/test/routingPlan.test.ts packages/core/test/routingModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/liveBlocks.ts packages/core/src/placement/model.ts packages/core/src/routing/plan.ts packages/core/test/fixtures/routingSeed.ts packages/core/test/routingFields.test.ts
git commit -m "feat(routing): plan set_field on collection rows"
```

---

### Task 4: Applying, receipting and suggesting `set_field`

**Files:**
- Modify: `packages/core/src/routing/apply.ts`, `packages/core/src/routing/plan.ts` (document page candidate)
- Test: `apps/worker/test/captureRouteFields.test.ts` (same harness as `captureRoute.test.ts`: in-process collab, `useTestDb`)

**Interfaces:**
- Consumes: Task 1's collab op, Task 3's `CheckedEdit`.
- Produces: `capture_changes` and `suggestions` rows as in Global Constraints. No new exports.

- [ ] **Step 1: Write the failing tests**

Same seed as Task 3, in a space with review off unless the test says otherwise.
- `it('applies a field change live, with a receipt row and one snapshot')` — route "George launch date moved to 2026-12-01." → live `fields[launch]` is `{ start: '2026-12-01' }`; one `capture_changes` row `{ op: 'set_field', blockId: 'field:<launch>', beforeMarkdown: '{"start":"2026-11-15"}', afterMarkdown: '{"start":"2026-12-01"}', status: 'applied' }` with a `versionId`; the version's `fields` holds the new value; the fact outcome is `applied`.
- `it('in a review space the field change waits for review')` → version `pending_review`, fact `waiting_review`.
- `it('a text edit and a field edit on one page are one collab change and one snapshot')` — a stub model returning a `replace` and a `set_field` on George → exactly one new version.
- `it('a person changing the field after planning turns the edit into a suggestion')` — in `hooks.afterPlan`, set the field through `collab.setFields` as a user → no change applied, a suggestion `{ kind: 'set_field', blockedBy: 'protection' }`, the person's value kept.
- `it('a clear becomes a set_field suggestion with expected and proposed values')` → `proposedMarkdown: 'null'`, `expectedText: '{"start":"2026-11-15"}'`.
- `it('a new page under a collection gets its planned fields with receipt rows')` — stub model `create_page` under Clients with `fields: [{ fieldId: status, value: 'Active' }]` → the new page's stored `fields` holds the Active id; a `set_field` receipt row with `beforeMarkdown: null`.
- `it('a document capture filed under a collection can set its own page fields')` — a document capture whose page is placed under Clients ("Kickoff with George" style seed where the planner places it there) and a fact naming a field → `set_field` applied on the document page.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/worker/test/captureRouteFields.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `applyPlannedFacts`: `set_field` items group into `byPage` like text edits.
- `recheck`: for `set_field`, read `live.fields` (from `readLiveBlocks`); `canonicalFieldJson(current) !== checked.expectedText` or a user `block_activity` on `field:<id>` within the window → `protection`; else apply. A field no longer in the row's defs → dropped.
- `applyToPage`: push `{ op: 'set_field', fieldId, value, expected: checked.expectedText }` into the same `ops` array; `Planned` gains a variant for field items. `block_changed` already maps every item to `protection`.
- `recordChanges`: one row per field item as in Global Constraints. No citation row for fields.
- `createEnginePage`: takes `fields?: Record<string, unknown>`; writes them into the new Y.Doc's `fields` map in `encodeBlocksYDoc` (add an optional `fields` parameter there), and inserts a `set_field` receipt row per field in the same transaction. `createPageFor` passes `op.fields`.
- `writeSuggestions`: for `set_field`, `kind: 'set_field'`, `blockId: 'field:<id>'`, `proposedMarkdown: canonicalFieldJson(value)`, `proposedBlocks: null`, `expectedText`.
- `plan.ts` (`planFact`): when `deps.fromDocument.pageId` is a row, add the document page to the candidates as `fieldsOnly: true` with `blocks: []` (it stays excluded from text edits).

- [ ] **Step 4: Run routing tests (new and old)**

Run: `pnpm vitest run apps/worker/test/captureRouteFields.test.ts apps/worker/test/captureRoute.test.ts apps/worker/test/capturePlace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing apps/worker/test/captureRouteFields.test.ts
git commit -m "feat(routing): apply, receipt and suggest field changes"
```

---

### Task 5: Undo, accept, and field changes in receipts

**Files:**
- Create: `packages/core/src/collections/describe.ts` (export from `packages/core/src/index.ts`)
- Modify: `apps/api/src/routes/captureChanges.ts`, `apps/api/src/routes/suggestions.ts`, `apps/api/src/routes/captures.ts`
- Test: `apps/api/test/captureFieldChanges.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts and collab op; Task 4 rows.
- Produces: `describeFieldChange(tx, tenantId, documentId, fieldId, beforeJson: string | null, afterJson: string | null): Promise<FieldChange>` — reads the row's current defs (`rowCollectionOf`), parses the JSON, formats each side with `formatFieldValue` and `fieldNames`; `name: null` when the field is gone. `fieldIdOf(blockId: string): string | null` (strips `FIELD_BLOCK_PREFIX`).

- [ ] **Step 1: Write the failing tests**

- `it('undo restores the before value')` → live value back to 2026-11-15; change `undone`; fact `undone`.
- `it('undo of a field set on an empty field clears it')`.
- `it('undo leaves a field a person changed since and reports it')` → `changedSince` holds the change id, the person's value kept.
- `it('undo reports a change whose field was removed')`.
- `it('accepting a set_field suggestion applies it and snapshots')`.
- `it('accepting goes stale when the choice was removed')` → 409 `suggestion_not_open`, status `stale`.
- `it('accepting goes stale when the value changed since it was proposed')`.
- `it('the receipt shows "Launch date" with before and after text')` → the change's `field` is `{ name: 'Launch date', before: '2026-11-15 (15 November 2026)', after: '2026-12-01 (1 December 2026)' }`.
- `it('undoing a document page with field changes still archives it')`.
- `it('wrong page on a fact with a text and a field change undoes both')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/api/test/captureFieldChanges.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `undoChanges`: field rows of a page are checked against `live.fields` and the row's current defs: still holding `afterMarkdown` → op `{ op: 'set_field', fieldId, value: beforeMarkdown === null ? null : JSON.parse(beforeMarkdown), expected: afterMarkdown }` in the same `planned` list; otherwise `changedSince`. The existing one-by-one retry on `block_changed` covers them.
- `undoDocumentPage`: block comparisons use only rows with `op !== 'set_field'`; field rows are marked undone with the page.
- `acceptSuggestion`: for `kind === 'set_field'`, before calling collab, load the row's defs: field gone, or proposed value not `null` and not `fieldValueFits` → `stale` (`suggestion_not_open`). Op is `{ op: 'set_field', fieldId, value, expected: row.expectedText }`. No citations for field suggestions; the rest (snapshot, approval in a review space) is unchanged.
- `captures.ts` receipt builder, `listPageCaptureChanges` and `toSuggestionSummary` callers: fill `field` with `describeFieldChange` for `set_field` rows (`toSuggestionSummary` takes the `field` as a new parameter, null otherwise).

- [ ] **Step 4: Run API tests**

Run: `pnpm vitest run apps/api/test/captureFieldChanges.test.ts apps/api/test/captureChanges.test.ts apps/api/test/suggestions.test.ts apps/api/test/captureDocuments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collections/describe.ts packages/core/src/index.ts apps/api/src/routes/captureChanges.ts apps/api/src/routes/suggestions.ts apps/api/src/routes/captures.ts apps/api/test/captureFieldChanges.test.ts
git commit -m "feat(api): undo and accept field changes; field text in receipts"
```

---

### Task 6: The console shows field changes

**Files:**
- Modify: `apps/web/src/lib/capture.ts`, `apps/web/src/components/capture/Receipt.tsx:48-53`, `CaptureBanner.tsx:58-62`, `SuggestionsPanel.tsx:27`, `Receipt.tsx:127`
- Test: `apps/web/test/capture.test.ts`

**Interfaces:**
- Produces: `fieldChangeText(field: FieldChange): string` in `lib/capture.ts` — `` `${name ?? 'Removed field'}: ${before ?? 'empty'} → ${after ?? 'empty'}` ``.

- [ ] **Step 1: Write the failing test**

```ts
it('fieldChangeText', () => {
  expect(fieldChangeText({ fieldId: 'f', name: 'Launch date', before: '2026-11-15', after: '2026-12-01' })).toBe('Launch date: 2026-11-15 → 2026-12-01');
  expect(fieldChangeText({ fieldId: 'f', name: null, before: null, after: 'Active' })).toBe('Removed field: empty → Active');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/web/test/capture.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Where a change or suggestion has `field`, render `fieldChangeText(field)` in place of the before/after Markdown lines (same classes, strike-through when not applied). In `Receipt.tsx:127` a set_field suggestion reads `Suggestion: {fieldChangeText(s.field)} · {status}`. Changes with `op === 'set_field'` are not `movable`.

- [ ] **Step 4: Run web tests and build**

Run: `pnpm vitest run apps/web && pnpm web:build`
Expected: PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/capture.ts apps/web/src/components/capture apps/web/test/capture.test.ts
git commit -m "feat(web): show routed field changes in receipts and suggestions"
```

---

### Task 7: Ask's collection table

**Files:**
- Create: `packages/core/src/search/collectionTable.ts` (export from `packages/core/src/index.ts`)
- Modify: `packages/core/src/answer.ts`, `apps/api/src/search/ask.ts`, `apps/api/src/server.ts:940-967`
- Test: `packages/core/test/collectionTable.test.ts`, `apps/api/test/askCollections.test.ts`

**Interfaces:**
- Produces:
  - `interface CollectionTable { collectionId: string; title: string; fields: string[]; rows: CollectionTableRow[]; truncated: boolean }`
  - `interface CollectionTableRow { title: string; values: Record<string, string>; citeAs: string; documentId: string; versionId: string; versionNumber: number; chunkId: string; spaceId: string }` — `values` keyed by field name; `chunkId` is the row's ordinal-0 chunk (it holds the field header); `citeAs` in the same `{title} (v{n}, updated {date})` form search uses (reuse its formatter).
  - `collectionTables(tx: DbTransaction, actor: Actor, readableSpaceIds: string[], passages: SearchPassage[]): Promise<CollectionTable[]>`
  - `AnswerProvider.answer({ question, passages, tables?: CollectionTable[] })`
  - `answerPassages(question, passages, provider, tables: CollectionTable[] = [])`

Rules: a collection is included when a retrieved page passage's document is one of its rows or is the collection page itself; at most 2 collections, in the order their first passage appears; rows are the collection's live (unarchived) sub-pages with an indexed version, in a readable space, ordered by title, at most 200 (`truncated` when more); values come from each row's indexed version's `fields` read against the collection's current defs. A fixed number of queries per collection, not per row.

- [ ] **Step 1: Write the failing tests**

`collectionTable.test.ts`:
- `it('builds a table of indexed rows with their field values')`.
- `it('a row whose newer version waits for review shows its indexed value')`.
- `it('rows without an indexed version and archived rows are left out')`.
- `it('stops at 200 rows and says so')`.
- `it('no table when no retrieved passage is a row or a collection')`.

`askCollections.test.ts` (deterministic providers, through `POST /api/v1/ask`):
- `it('answers across a collection and cites the rows it used')` — 3 client rows, two with Launch date in December; ask "which clients launch in December?" → `foundRelevant`, citations include those rows' `documentId`s.
- `it('a member who cannot read the collection space gets no table')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/core/test/collectionTable.test.ts apps/api/test/askCollections.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `collectionTables` as specified.
- `OpenAIAnswerProvider`: after the passages, each table as `Table: {title} (each row cites itself)` then `Title | field… | Cite as` lines. `DeterministicAnswerProvider`: append ` — Table {title}: {row title} ({k: v, …}) [{citeAs}]; …` for each row.
- `answerPassages`: citations are every passage (unchanged) plus each table row whose `[citeAs]` appears in the answer text, as an `AskCitation` with `documentKind: 'page'`, `blockIds: []`, `pageFrom/pageTo: null`, `quote` = `Title — k: v, …` sliced to 300.
- `server.ts` Ask route: compute `collectionTables` in the same transaction as `searchWiki`, with the same `effectiveSpaces`; pass them to `answerPassages`. An empty passage list still answers `NO_RELEVANT_ANSWER` without tables.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/test/collectionTable.test.ts apps/api/test/askCollections.test.ts apps/api/test/askFailures.test.ts packages/core/test/answer.openai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/search/collectionTable.ts packages/core/src/index.ts packages/core/src/answer.ts apps/api/src/search/ask.ts apps/api/src/server.ts packages/core/test/collectionTable.test.ts apps/api/test/askCollections.test.ts
git commit -m "feat(ask): answer across a collection from a table of its rows"
```

---

### Task 8: Full suites, evaluation and progress

**Files:**
- Modify: `docs/kinote-standalone-design.md` (Progress table), `docs/operations.md` if it lists routed ops
- Create: `docs/live-checks/2026-10-phase-c1c-live-check.md`

- [ ] **Step 1: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm routing:eval`
Expected: all pass; the evaluation prints `PASS` with no wrong removals.

- [ ] **Step 2: Postgres suite** (Docker running)

Run: `pnpm test:pg`
Expected: PASS. If Docker is down, record that in Known gaps instead.

- [ ] **Step 3: Live check**

Against `pnpm stack:up` with the real router and Ask models: make a Clients collection with Status and Launch date, route "George launch moved to 1 December", check the receipt line, Undo, route again in a review space, approve, ask "which clients launch in December?". Write the steps and results to the live-check file.

- [ ] **Step 4: Update the Progress table**

Mark C1c "Merged 2026-10-30" with this plan's path; set Phase C Excalidraw as **Next**.

- [ ] **Step 5: Commit** (only once the owner has committed the rename: `docs/kinote-standalone-design.md` is part of it until then)

```bash
git add docs/kinote-standalone-design.md docs/live-checks/2026-10-phase-c1c-live-check.md
git commit -m "docs: Phase C1c live check and progress"
```
