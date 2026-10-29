# Phase C2: Excalidraw drawings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors insert Excalidraw drawings into pages, draw in them together live, and drawings are versioned, reviewed, restored and searched like the rest of the page.

**Architecture:** A `drawing` BlockNote block holds only `drawingId`, `title` and `height`. The scene lives in the page's Y.Doc as a `drawings` Y.Map (`drawingId → Y.Map(elementId → element JSON)`), synced by a small binding we own that merges by Excalidraw's element `version`. Collab attributes drawing changes to the drawing block; the snapshot copies referenced, non-deleted elements into `versions.drawings` and puts the drawing's words into the block's in-memory `text` prop before converting to Markdown, so indexing, diffs and the engine see it through existing paths.

**Tech Stack:** `@excalidraw/excalidraw@0.18.1` (MIT, React 19 peer), BlockNote 0.49, Yjs, Hocuspocus, Drizzle, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-phase-c-drawings-design.md` (D1–D13).

## Global Constraints

- Excalidraw pinned to exactly `0.18.1`; its fonts are served by Kinote from `/excalidraw-assets/` (`window.EXCALIDRAW_ASSET_PATH`), never a CDN.
- Pages without a drawing block must not load the Excalidraw chunk (checked in Task 6 with `pnpm bundle:report`).
- Limits: 5,000 live elements and 1 MB of element JSON per drawing (editor-enforced); server readers read at most the first 5,000 live elements by `index`; indexed text at most 200 lines per drawing.
- Pages without drawings must hash exactly as before (no new versions on upgrade).
- Element merge rule: higher `version` wins; equal `version` → lower `versionNonce` wins. Deleted elements are kept as `isDeleted: true` tombstones in the live map; they never appear in `versions.drawings`.
- The server never writes the live `drawings` map except through restore (D9).
- Images in drawings are refused with the exact copy: "Images in drawings aren't supported yet. Add the image to the page instead."
- Error copy: "This drawing is full", "This drawing couldn't load", "This drawing was removed", placeholder title "Untitled drawing".
- No commit may include the in-progress `living-wiki` → `kinote` rename: stage only the files a task names.

## Review Focus

1. **Two people editing the same element at the same moment** — both clients converge to the same element (merge rule above), with no flicker loop of re-writes. Test in Task 5 (two Y.Docs, crossed updates).
2. **A remote update arriving mid-stroke** — the local in-progress element is not reset to the remote one. Test in Task 5.
3. **A drawing block copied within a page** — the copy gets a new `drawingId` and its own elements; editing one doesn't change the other. Test in Task 5.
4. **A version restore that removes shapes added since** — open editors drop them (tombstones with a bumped `version`), and a late write from a stale client can't resurrect them unless it truly edits later. Test in Task 2.
5. **A page whose only content is a drawing in a review space** — it is snapshotted, waits for review, and Search finds its words only after approval. Test in Task 3.

---

### Task 1: Shared drawing model and the block on the server

**Files:**
- Modify: `packages/contracts/src/index.ts` (or the file holding `collectionViewConfig`) — `drawingConfig`, constants
- Create: `packages/shared/src/drawings.ts` (export from `packages/shared/src/index.ts`)
- Modify: `packages/shared/src/editorSchema.ts`, `packages/shared/src/blocks.ts:78-82`
- Test: `packages/shared/test/drawings.test.ts`

**Interfaces:**
- Produces:
  - `drawingConfig = { type: 'drawing', propSchema: { drawingId: { default: '' }, title: { default: '' }, height: { default: 480 }, text: { default: '' } }, content: 'none' }`. `text` is never written by the web; the snapshot fills it in memory (Task 3).
  - Constants: `DRAWINGS_MAP = 'drawings'`, `MAX_DRAWING_ELEMENTS = 5000`, `MAX_DRAWING_BYTES = 1_000_000`, `MAX_DRAWING_TEXT_LINES = 200`, `DRAWING_HEIGHT = { min: 240, max: 1200, default: 480 }`.
  - `type DrawingElement = { id: string; index: string; version: number; versionNonce: number; isDeleted?: boolean; type: string; text?: string; [k: string]: unknown }`
  - `isDrawingElement(v: unknown): v is DrawingElement`
  - `newerElement(a: DrawingElement, b: DrawingElement): DrawingElement` — the merge rule.
  - `liveElements(map: Y.Map<unknown> | undefined): DrawingElement[]` — valid, non-deleted, sorted by `index` (string compare), first 5,000.
  - `drawingText(title: string, elements: DrawingElement[]): string` — `Drawing: {title || 'Untitled drawing'}` then each non-empty `text` (whitespace collapsed), newline-joined, at most 200 text lines.
  - `drawingDiff(before: DrawingElement[], after: DrawingElement[]): { added: number; changed: number; removed: number }` — by id; changed when `version` differs.
  - `drawingBlockIds(blocks: BlockLike[]): Map<string, string>` — drawingId → block id, children included.
- Server schema: `drawing` block renders `<p>` with its `text` prop (each line a `<br>`-separated run), so Markdown carries it. `flattenBlocks` uses `props.text || 'Drawing: ' + (title || 'Untitled drawing')` for `drawing` blocks.

- [ ] **Step 1: Write the failing tests**

- `it('newerElement keeps the higher version, then the lower versionNonce')`.
- `it('liveElements drops tombstones and invalid entries and orders by index')`.
- `it('liveElements reads at most 5,000 elements')`.
- `it('drawingText lists the title then the words, at most 200 lines')`.
- `it('drawingDiff counts added, changed and removed by id and version')`.
- `it('a drawing block converts to Markdown with its text')` — server editor, a block with `text: 'Drawing: Flow\nStart\nEnd'` → Markdown contains `Drawing: Flow`, `Start`, `End`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/shared/test/drawings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the config, constants, `drawings.ts`, the server block spec and the `flattenBlocks` case. Register `drawing` in the server `wikiSchema`.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `pnpm vitest run packages/shared packages/contracts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src packages/shared/src packages/shared/test/drawings.test.ts
git commit -m "feat(shared): drawing block config and element model"
```

---

### Task 2: Collab attribution and restore for drawings

**Files:**
- Modify: `apps/collab/src/attribution.ts`, `apps/collab/src/internal.ts:115-150,49`, `packages/contracts/src/index.ts` (replace-blocks request), `packages/shared/src/collabClient.ts:19-28,105-115`
- Test: `apps/collab/test/attribution.test.ts`, `apps/collab/test/internal.test.ts`

**Interfaces:**
- Consumes: Task 1's `DRAWINGS_MAP`, `drawingBlockIds`, `isDrawingElement`.
- Produces:
  - Attribution: a transaction that changes `drawings` (any element map under it) counts as a page change and names the drawing block's id (found by scanning the fragment's `drawing` blocks for that `drawingId`; none found → page change, no block named).
  - `CollabClient.replaceBlocks` gains `drawings?: Record<string, DrawingElement[]>`. For each key: element ids in the payload are set; live ids not in it become tombstones `{ ...live, isDeleted: true, version: live.version + 1, versionNonce: random }`. Drawings not in the payload are left alone.
  - `MAX_INTERNAL_BODY_BYTES` becomes `8 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests**

- `it('a change inside a drawing is attributed to its drawing block')`.
- `it('a change to a drawing no block references still marks the page changed')`.
- `it('replace-blocks with drawings restores the elements and tombstones the rest')` — live drawing has A(v3), B(v1); payload has A(v2) → live A equals the payload's A, B is `isDeleted` with version 2.
- `it('a stale client write after a restore loses to the tombstone')` — apply a remote update setting B to v1 again via `newerElement` merge → B stays deleted.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/collab/test/attribution.test.ts apps/collab/test/internal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified. In the replace path, write drawings in the same transaction as blocks and fields.

- [ ] **Step 4: Run collab tests**

Run: `pnpm vitest run apps/collab`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/collab/src packages/contracts/src packages/shared/src/collabClient.ts apps/collab/test
git commit -m "feat(collab): attribute and restore drawings"
```

---

### Task 3: Versions keep drawings; snapshot, index and restore

**Files:**
- Modify: `packages/db/src/schema/*` (the `versions` table): `drawings: jsonb('drawings')`; generate the migration with `pnpm db:generate` (never hand-edit)
- Modify: `packages/core/src/snapshot.ts:143-175,224`, the restore route in `apps/api/src/routes/pages.ts` (where `replaceBlocks` is called with `fields`)
- Test: `packages/core/test/snapshot.drawings.test.ts`, `apps/api/test/restore.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `versions.drawings: Record<string, DrawingElement[]> | null` — only drawings referenced by a block of the version, live elements only; null when none. `withDrawingText(blocks, ydoc): BlockLike[]` in `snapshot.ts` (or `packages/core/src/drawings.ts`) — a copy of `blocks` with each drawing block's `props.text` set to `drawingText`.

- [ ] **Step 1: Write the failing tests**

- `it('a snapshot stores referenced drawings and their words')` — version `drawings[id]` has the live elements; `markdown` contains `Drawing: Flow` and the drawing's words; `blocks` has the `text` prop.
- `it('moving a shape makes a new version')` — change only `x` and bump `version` → a new version.
- `it('a page without drawings hashes as before')` — compare `contentHash` with the pre-change formula (`# title\n\nmarkdown` plus fields when present).
- `it('a page whose only content is a drawing is snapshotted')`.
- `it('an unreferenced scene is not versioned')`.
- `it('in a review space a drawing-only page waits, and search finds its words only after approval')` — through `indexVersion` and `searchWiki`.
- `restore.test.ts`: `it('restoring a version brings its drawing back')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/core/test/snapshot.drawings.test.ts apps/api/test/restore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `takePageSnapshot`: after `yDocToBlocks`, `blocks = withDrawingText(blocks, ydoc)`; collect `drawings` for `drawingBlockIds(blocks)`; a non-empty `drawings` counts as content; hash `indexedPayload`, then `\n\n` + `canonicalJson(fields)` when fields, then `\n\n` + `canonicalJson(drawings)` when drawings. Store `drawings`. Restore passes `version.drawings ?? {}` keyed by the version's drawing ids.

- [ ] **Step 4: Run core and API page tests**

Run: `pnpm vitest run packages/core apps/api/test/restore.test.ts apps/api/test/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema packages/db/migrations packages/core/src apps/api/src/routes/pages.ts packages/core/test/snapshot.drawings.test.ts apps/api/test/restore.test.ts
git commit -m "feat(core): version, index and restore drawings"
```

---

### Task 4: Drawing scenes over the API, drawing diffs, and the engine's drop rule

**Files:**
- Modify: `apps/api/src/routes/pages.ts:470-560` (diff callers), `apps/api/src/server.ts` (route), `packages/contracts/src/index.ts:624` (`BlockDiffEntrySchema`), `packages/core/src/routing/plan.ts` (`checkEdits`)
- Test: `apps/api/test/drawings.test.ts`, `packages/core/test/routingPlan.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/pages/:id/drawings/:drawingId?version=<number>` → `{ elements: DrawingElement[] }` — the version's elements, or the live ones when `version` is absent. Page viewers only; another tenant's or unreadable → 404 `page_not_found`; unknown drawing → 404 `block_not_found`.
  - `BlockDiffEntry` gains `drawing?: { drawingId: string; added: number; changed: number; removed: number }` on `drawing` entries; an entry whose text is equal but whose counts aren't all zero is `changed`.
  - `checkEdits` drops a planned `replace` or `remove` whose block is a `drawing` (D13). An `insert_after` a drawing stays allowed: it adds a block beside it, never inside it.

- [ ] **Step 1: Write the failing tests**

- `it('a viewer reads a drawing of a version and the live one')`.
- `it('another tenant gets 404')`, `it('an unknown drawing is block_not_found')`.
- `it('moving a shape shows the drawing block as changed with counts')` — diff between two versions → entry `{ change: 'changed', drawing: { added: 0, changed: 1, removed: 0 } }`.
- `routingPlan.test.ts`: `it('the engine never replaces or removes a drawing block')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/api/test/drawings.test.ts packages/core/test/routingPlan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The diff callers load both sides' drawings (version `drawings`, or live via `liveElements`) and post-process `diffBlocks`' entries with `drawingDiff`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/api packages/core/test/routingPlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src packages/contracts/src packages/core/src/routing/plan.ts apps/api/test/drawings.test.ts packages/core/test/routingPlan.test.ts
git commit -m "feat(api): drawing scenes, drawing diffs, engine leaves drawings alone"
```

---

### Task 5: The binding between Excalidraw and the page document

**Files:**
- Create: `apps/web/src/components/drawing/binding.ts`
- Test: `apps/web/test/drawingBinding.test.ts`

**Interfaces:**
- Consumes: Task 1's model.
- Produces:
  ```ts
  interface SceneApi {
    getSceneElementsIncludingDeleted(): readonly DrawingElement[];
    updateScene(scene: { elements: readonly DrawingElement[] }): void;
  }
  function bindDrawing(opts: {
    doc: Y.Doc; drawingId: string; api: SceneApi; origin: object;
    reconcile: (local: readonly DrawingElement[], remote: DrawingElement[]) => DrawingElement[];
    throttleMs?: number; // default 50
  }): { onChange(elements: readonly DrawingElement[]): void; flush(): void; destroy(): void; full: () => boolean };
  function copyDrawing(doc: Y.Doc, fromId: string, toId: string): void;
  ```
  `reconcile` is Excalidraw's `reconcileElements` in the app and a pure stand-in in tests. `onChange` writes changed elements (by `version`) in one transaction with `origin`, throttled; `flush` writes now; remote changes (any other origin) call `api.updateScene` with `reconcile(current, changed)`. `full()` is true past either limit; past the limit new element ids are not written (existing ones still are) — the block shows "This drawing is full".

- [ ] **Step 1: Write the failing tests** (two `Y.Doc`s wired with `Y.applyUpdate` both ways, fake `SceneApi`s)

- `it('a local change reaches the other document')`.
- `it('concurrent edits of different elements both survive')`.
- `it('concurrent edits of one element converge to the newer version')`.
- `it('its own writes do not call updateScene back')` (no echo loop).
- `it('a remote update mid-stroke keeps the local in-progress element')` — local element has a higher version not yet flushed; remote update for it at a lower version → scene keeps the local one.
- `it('writes are throttled and flush writes at once')` (fake timers).
- `it('past 5,000 live elements new elements are not written')`.
- `it('copyDrawing gives the copy its own elements')`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/web/test/drawingBinding.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `binding.ts`.**

- [ ] **Step 4: Run to see them pass**

Run: `pnpm vitest run apps/web/test/drawingBinding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/drawing/binding.ts apps/web/test/drawingBinding.test.ts
git commit -m "feat(web): live binding between Excalidraw and the page document"
```

---

### Task 6: The drawing block in the editor

**Files:**
- Modify: `apps/web/package.json` (add `"@excalidraw/excalidraw": "0.18.1"`), `apps/web/vite.config.ts` (copy `node_modules/@excalidraw/excalidraw/dist/prod/fonts` to `excalidraw-assets/fonts` at build; serve in dev), `apps/web/src/components/editor/schema.tsx`, `apps/web/src/components/editor/menus.tsx`
- Create: `apps/web/src/components/drawing/DrawingBlock.tsx` (light shell: title, height, placeholder, Suspense), `apps/web/src/components/drawing/DrawingCanvas.tsx` (lazy: Excalidraw + binding + pointers)
- Test: `apps/web/test/drawingBlock.test.ts`

**Interfaces:**
- Consumes: Task 5's `bindDrawing`, `copyDrawing`; the page's live `Y.Doc` and awareness from the editor's provider (`Editor.tsx:56`).
- Produces: the web `drawing` block spec (same config as the server's), the "Drawing" slash item (creates a block with a fresh `drawingId`), re-id on duplicate/paste (on `onChange` of the editor, a `drawingId` used by two blocks: the later block gets a new id via `copyDrawing`).

- [ ] **Step 1: Write the failing tests**

- `it('the slash menu has a Drawing item that inserts a drawing block with a new id')`.
- `it('a duplicated drawing block gets its own drawing id and elements')`.
- `it('a pasted image is refused with the notice')` — assert the exact copy from Global Constraints.
- `it('the title placeholder is Untitled drawing')`.

(Excalidraw's canvas needs a real browser; it is exercised in Task 8. Mock `DrawingCanvas` here.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/web/test/drawingBlock.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `DrawingCanvas` = `lazy(() => import('./DrawingCanvas.js'))`; set `window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'` inside that module before importing Excalidraw; import its CSS there.
- Excalidraw props: `viewModeEnabled={!editable}`, `theme` from the console theme, `UIOptions.canvasActions` with `loadScene: false`, `saveToActiveFile: false`, `export: { saveFileToDisk: true }`; no `renderTopRightUI` collaboration button; hide the image tool (`UIOptions.tools.image: false`); `onPaste` returns false for image files and shows the notice; `isCollaborating` true and `collaborators` from awareness (`{ drawingId, pointer, button }`, names and colours as `PagePresence` uses).
- Confirm `reconcileElements` is exported by `0.18.1`; if not, use the binding's pure merge (`newerElement` per id) as `reconcile`.
- Height drag handle (240–1200) and full-screen overlay; failure boundary with "This drawing couldn't load", Retry and the drawing's text.

- [ ] **Step 4: Run tests, build, and check the bundle**

Run: `pnpm vitest run apps/web && pnpm web:build && pnpm bundle:report`
Expected: PASS; the report shows Excalidraw only in a lazy chunk, not in the entry chunk; `dist/excalidraw-assets/fonts` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/vite.config.ts apps/web/src/components/drawing apps/web/src/components/editor/schema.tsx apps/web/src/components/editor/menus.tsx apps/web/test/drawingBlock.test.ts
git commit -m "feat(web): drawing block with Excalidraw, lazy loaded"
```

(`pnpm-lock.yaml` is also touched by the rename; if the owner hasn't committed the rename yet, wait before this commit.)

---

### Task 7: Drawings in review, history and the changes panel

**Files:**
- Create: `apps/web/src/components/drawing/DrawingPreview.tsx` (lazy; `exportToSvg` of fetched elements)
- Modify: `apps/web/src/components/DiffView.tsx`, `apps/web/src/lib/api.ts` (`getDrawing(pageId, drawingId, version?)`)
- Test: `apps/web/test/diff.test.ts`

**Interfaces:**
- Consumes: Task 4's route and `BlockDiffEntry.drawing`.
- Produces: `drawingChangeText(d: { added: number; changed: number; removed: number }): string` — e.g. `3 shapes added, 1 changed, 2 removed`; zero parts left out; all zero → `No changes to the drawing`.

- [ ] **Step 1: Write the failing test**

```ts
it('drawingChangeText', () => {
  expect(drawingChangeText({ added: 3, changed: 1, removed: 2 })).toBe('3 shapes added, 1 changed, 2 removed');
  expect(drawingChangeText({ added: 1, changed: 0, removed: 0 })).toBe('1 shape added');
  expect(drawingChangeText({ added: 0, changed: 0, removed: 0 })).toBe('No changes to the drawing');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run apps/web/test/diff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** A `drawing` diff entry renders the change line and, side by side, `DrawingPreview` of the before and after versions (added: after only; removed: before only). The same preview renders drawing blocks in the review document and history views.

- [ ] **Step 4: Run web tests and build**

Run: `pnpm vitest run apps/web && pnpm web:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/drawing/DrawingPreview.tsx apps/web/src/components/DiffView.tsx apps/web/src/lib/api.ts apps/web/test/diff.test.ts
git commit -m "feat(web): show drawings in review, history and diffs"
```

---

### Task 8: End-to-end, suites and progress

**Files:**
- Create: `e2e/drawings.spec.ts` (same harness as `e2e/gridcraft.spec.ts`)
- Create: `docs/live-checks/2026-10-phase-c2-drawings-live-check.md`
- Modify: `docs/kinote-standalone-design.md` (Progress table)

- [ ] **Step 1: Write the e2e tests**

- `test('two people draw in one drawing and both keep their shapes')` — two browser contexts; each draws a rectangle; after reload both rectangles are there.
- `test('a drawing in a review space waits, then its words are searchable')` — add a text element "Payment flow", submit, approve as the reviewer, search "Payment flow" → the page is found.
- `test('a page without drawings does not load Excalidraw')` — no request for the Excalidraw chunk.
- `test('restore brings an earlier drawing back')`.

- [ ] **Step 2: Run e2e**

Run: `pnpm e2e:local e2e/drawings.spec.ts`
Expected: PASS.

- [ ] **Step 3: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm test:pg && pnpm routing:eval`
Expected: PASS (record in Known gaps if Docker is down for `test:pg`).

- [ ] **Step 4: Live check and progress**

Against `pnpm stack:up`: draw with two browsers, review, restore, search; confirm in the network panel that fonts come from `/excalidraw-assets/`. Write the results. Mark "Phase C: Excalidraw drawings" merged in the Progress table with this plan's path; set "Agents and MCP rework" as **Next**.

- [ ] **Step 5: Commit** (after the owner's rename commit)

```bash
git add e2e/drawings.spec.ts docs/live-checks/2026-10-phase-c2-drawings-live-check.md docs/kinote-standalone-design.md
git commit -m "test(e2e): drawings; docs: Phase C2 live check and progress"
```
