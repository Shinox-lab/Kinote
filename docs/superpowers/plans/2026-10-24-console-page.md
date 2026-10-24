# Page phase — emoji identity, status chip, history tabs and presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the page itself the product: an emoji identity, a title/status header that carries every index and review state, a real presence strip from the live editor, a two-tab history drawer, and the quiet 660px writing surface — with every existing role, review rule, editor and restore behaviour kept.

**Architecture:** The shell already owns the tokens, top bar, sidebar and account menu. This phase adds one additive `documents.icon` column and its API, then turns the page route into a header (icon, title, status chip/popover) plus the existing BlockNote editor. Presence is read from the same Hocuspocus provider the editor already opens, lifted into a small hook so the top bar and the editor share it. The sidebar's “On this page” panel is removed; its actions move to the chip/popover and the page menu in the top bar. The HistoryDrawer gains a Changes tab over the existing ChangesList.

**Tech Stack:** React 19, TanStack Router, Tailwind v4, BlockNote + Hocuspocus, Zod contracts, Drizzle/PGlite, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-console-redesign-design.md` (phase 1 of the delivery order).

## Global Constraints

- Tokens and shell from phase 0: warm paper/night, no raw hex; page column 660; top bar 44; main 1188; sidebar 252; slide-over 330/1024.
- Page identity: emoji (38) above the title; title 34/600; meta row = status chip + relative time from the indexed version; the page menu (rename/move/archive/restore/withdraw) stays in the top bar.
- `documents.icon`: null or one untrimmed-emoji grapheme, max 16 UTF-16 units; `PATCH /api/v1/pages/:id` accepts `title` and/or `icon` (null clears); one audit event; additive migration, no RLS change. The picker sends only its curated set; unknown values render no icon. The tree updates optimistically and reverts on failure.
- Every server badge is kept. Labels are the server's badge text, except changed = “N unindexed changes”. Tones: clean ok, changed warn, in review review (not pending), failed bad, withdrawn/rejected/removed/stored muted, indexing/being-read pending. The existing page controls (primary, retry, restore indexed) keep working; the page never approves.
- The chip is text + dot; its popover is a labelled menu; the drawer is a modal tablist; the icon is decorative next to the title and the picker button is labelled “Change page icon”; the presence is a `role="status"` live region with Offline/Reconnect when the socket drops; “Connected” leaves the body.
- Presence: up to three initials avatars, +N, a 6px live dot; six fixed tints keyed by user id; names on title; awareness from the same provider; cleanup on unmount.
- Body: BlockNote on paper, 660px; h2 19/600/1.35, h3 16/600, body 15.5/1.72, quote 2px left rule, tables with header caps and hairline rows only, code on `--sidebar` with a hairline.
- Keep existing labels the e2e uses where the element survives: “Preview”, “Versions”, “Download”, `role="note"`, `Expand/Collapse <space>`. Update tests where the element moves. The Updates feed stays until the Home phase.
- No new dependencies. One commit per task. Typecheck, Vitest, local e2e and web build must pass at the end. Work on branch `console-screens`.

## Review Focus

1. **Roles and review.** A viewer sees the page and no edit/action controls; an editor gets Index/Submit only when the server controls allow; a reviewer gets the Review link and never an approve button on the page; the menu actions (move/withdraw/archive/restore) stay role-gated. A 403 in the UI is a failure.
2. **The provider lift and presence.** The editor, the top bar and the reconnect path share one provider; a refused/expired token still retries; the editor stays usable when presence is offline; the awareness is cleaned up on unmount and on page change; the self is not duplicated; two people show two avatars.
3. **Every badge.** Clean, changed, in review, failed, withdrawn, rejected, removed-at-source, stored-no-text and indexing states all render with a tone and the right action; the changed count is the visible block count; the review state uses the review tint; the archived page can restore.
4. **Icon edges.** No icon, clearing, an unknown/removed emoji, a multi-codepoint emoji, a long title in the header/tree, a failed save reverting the tree, and a viewer not seeing the picker.
5. **The actions after OnThisPage.** History and Changes still work on desktop and mobile now that the sidebar panel is gone; the drawer's tabs, focus trap, Escape and restore; the chip popover's keyboard/outside close.

---

### Task 1: Icon data, contract and API

**Files:**
- Modify: `packages/db/src/schema/pages_and_index.ts`
- Create: `packages/db/migrations/<generated>.sql` (via `pnpm db:generate`)
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/routes/pages.ts`
- Test: `apps/api/test/icon.test.ts`
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Consumes: the existing `documents` table, page services and audit writer.
- Produces: `documents.icon`; `icon: string | null` on `PageSummary`, `PageDetails`, `TreeNode` and `DocumentSummary`; `IconSchema`/`UpdatePageSchema`; `updatePage(actor, pageId, input)`; `api.updatePage(id, { title?, icon? })`; the tree query includes the icon.

- [ ] **Step 1: Write the failing API test.**

In `apps/api/test/icon.test.ts`, seed a page (copy the setup from `apps/api/test/rename.test.ts`) and assert: `PATCH /pages/:id { icon: '🚀' }` returns `icon: '🚀'`; `GET /pages/:id` and `GET /spaces/:id/tree` carry it; `PATCH { icon: null }` clears it; `PATCH { icon: 'ab' }` fails with `validation_failed`; a viewer's PATCH is `forbidden`; the audit has one event for the update.

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm vitest run apps/api/test/icon.test.ts`
Expected: FAIL — unknown `icon` field / route rejects the body.

- [ ] **Step 3: Add the column, migration, contracts and API.**

Add `icon: text('icon')` to `documents`; run `pnpm db:generate` and keep the additive migration. In contracts add:

```ts
export const IconSchema = z.string().max(16).refine((s) => [...new Intl.Segmenter().segment(s)].length === 1, 'a single emoji');
export const UpdatePageSchema = z.object({ title: titleSchema.optional(), icon: IconSchema.nullable().optional() }).refine((v) => v.title !== undefined || v.icon !== undefined);
```

Add `icon` to the page/tree/document schemas (nullable). The PATCH service accepts both fields, updates only what is present, sets the collab title only for a title change, and writes one `page.renamed` audit event with the changed fields. Select `documents.icon` in page details and the space tree. In `api.ts` replace `renamePage` with `updatePage(id, input)` (keep a title-only wrapper if callers read better).

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm vitest run apps/api/test/icon.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add packages/db packages/contracts apps/api apps/web/src/lib/api.ts
git commit -m "feat(page): add emoji icon to documents and the page API"
```

---

### Task 2: Icon picker, page header skeleton and tree icon

**Files:**
- Create: `apps/web/src/lib/emoji.ts`
- Create: `apps/web/src/components/PageIconPicker.tsx`
- Create: `apps/web/src/components/PageHeader.tsx`
- Modify: `apps/web/src/routes/page.tsx`
- Modify: `apps/web/src/components/sidebar/SpacesSection.tsx`
- Test: `apps/web/test/emoji.test.ts`
- Test: `e2e/page.spec.ts` (new)

**Interfaces:**
- Consumes: `PageDetails.icon`, `TreeNode.icon`, `api.updatePage`.
- Produces: `PAGE_ICONS: readonly string[]` (48 unique); `PageIconPicker({ icon, canEdit, onPick })`; `PageHeader` rendering `{ icon, title, meta }`; the tree page row shows `node.icon ?? glyph`.

- [ ] **Step 1: Write the failing unit/e2e tests.**

Unit: `PAGE_ICONS` has 48 unique entries, all one grapheme and ≤16 UTF-16 units.
E2E (`e2e/page.spec.ts`): create a page; open the “Change page icon” button; choose 🚀; the header and tree show 🚀; reload keeps it; open the picker and Remove; both lose it. A viewer does not see the button. Use long titles in one assertion.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm vitest run apps/web/test/emoji.test.ts` and `pnpm e2e:local e2e/page.spec.ts -g "icon"`
Expected: FAIL — no picker/emoji set.

- [ ] **Step 3: Implement the 48-emoji set, the picker and the header.**

Pick a curated 48 (documents, work, places, ideas, tools); no duplicates. The picker is a small 6-column grid in a popover: a labelled button, Escape/outside close, Remove; only `canEdit` renders it. On pick, call `api.updatePage(page.id, { icon })`, update the page query and every cached tree row optimistically, and invalidate on error. The tree page row uses the emoji with the attention dot; files keep their glyph until the file phase. Remove the old h1/badge row from the page article and render `PageHeader` with the icon, h1 (34/600 for now), and an empty meta slot that Task 3 fills.

- [ ] **Step 4: Run them and see them pass.**

Run: `pnpm vitest run apps/web/test/emoji.test.ts` and `pnpm e2e:local e2e/page.spec.ts -g "icon"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/emoji.ts apps/web/src/components/PageIconPicker.tsx apps/web/src/components/PageHeader.tsx apps/web/src/routes/page.tsx apps/web/src/components/sidebar/SpacesSection.tsx apps/web/test/emoji.test.ts e2e/page.spec.ts
git commit -m "feat(page): emoji picker in the header and tree"
```

---

### Task 3: Status chip, actions, page menu and removing OnThisPage

**Files:**
- Create: `apps/web/src/lib/pageStatus.ts`
- Create: `apps/web/src/components/PageStatus.tsx`
- Modify: `apps/web/src/components/PageActions.tsx` (full/compact variant)
- Modify: `apps/web/src/components/LifecycleMenu.tsx` (Rename)
- Modify: `apps/web/src/routes/page.tsx`
- Modify: `apps/web/src/components/sidebar/Sidebar.tsx`
- Delete: `apps/web/src/components/sidebar/OnThisPage.tsx`
- Test: `apps/web/test/pageStatus.test.ts`
- Test: `e2e/page.spec.ts`, `e2e/console.spec.ts`

**Interfaces:**
- Consumes: `PageDetails`, `PageControls`, `usePageChanges` count, `PageActions`.
- Produces: `pageStatus(page, changedCount, opts): { state, label, tone, time, primary, retry, review }`; `PageStatus({ page, changedCount, spaces, controls, canReview, tenantSlug, onChanged, onHistory })`; `openHistory(pageId, tab?)`; the top bar right = presence (Task 5) + page menu; no sidebar panel.

- [ ] **Step 1: Write the failing unit/e2e tests.**

Unit `pageStatus`: clean Indexed → ok + time; `liveChangedSinceSnapshot` → warn + “N unindexed changes”; latest version pending_review → review tint + review action; Index failed → bad + retry; Withdrawn/Not indexed/Stored → muted; indexing → pending; every badge text preserved; a viewer has no primary.
E2E: the changed chip shows the count and its compact Index now/Submit; the popover has the state line, primary (even clean), History, Changes; the page menu renames; the archived page restores; no “On this page” anywhere; a viewer sees no action.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm vitest run apps/web/test/pageStatus.test.ts` and `pnpm e2e:local e2e/page.spec.ts -g "status|menu|On this page"`
Expected: FAIL.

- [ ] **Step 3: Implement the chip, popover and menu.**

Chip: dot + label; the state line; 280px popover; the compact primary outside only for changed/failed; the full PageActions in the popover; History and Changes (N) call `onHistory('versions'|'changes')`; the review link to `/w/$tenantSlug/reviews` (or waiting copy for the author); a labelled menu with Escape/outside. Remove the article badge/archived row and the `!sidebarColumn` PageActions; render `PageStatus` in the header meta. Delete OnThisPage and its Sidebar import. Add Rename to LifecycleMenu using the existing TitleInput pattern and `api.updatePage`, keeping `onChanged`. The page menu remains in the top bar; the chip sits in the document column.

- [ ] **Step 4: Run them and see them pass.**

Run: `pnpm vitest run apps/web/test/pageStatus.test.ts` and `pnpm e2e:local e2e/page.spec.ts e2e/console.spec.ts -g "status|menu|history|On this page"`
Expected: PASS after updating the console helpers that clicked the sidebar “Submit for review”/“History” to open the chip/popover. Also `pnpm typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/pageStatus.ts apps/web/src/components/PageStatus.tsx apps/web/src/components/PageActions.tsx apps/web/src/components/LifecycleMenu.tsx apps/web/src/routes/page.tsx apps/web/src/components/sidebar/Sidebar.tsx apps/web/src/components/sidebar/OnThisPage.tsx apps/web/test/pageStatus.test.ts e2e/page.spec.ts e2e/console.spec.ts
git commit -m "feat(page): status chip, actions and page menu; remove the sidebar panel"
```

---

### Task 4: History drawer tabs — Versions and Changes

**Files:**
- Modify: `apps/web/src/lib/pageUi.ts`
- Modify: `apps/web/src/components/HistoryDrawer.tsx`
- Modify: `apps/web/src/routes/page.tsx`
- Test: `e2e/page.spec.ts`, `e2e/console.spec.ts`

**Interfaces:**
- Consumes: `ChangesList`, `usePageChanges`, the existing restore/compare.
- Produces: `openHistory(pageId, tab: 'versions' | 'changes' = 'versions')`; `useHistoryOpen(pageId)` plus the requested tab; `HistoryDrawer({ initialTab })` with a tablist (`aria-selected`), Versions content unchanged and Changes = `<ChangesList/>`.

- [ ] **Step 1: Write the failing e2e test.**

The page with unindexed changes: the chip → Changes opens the drawer on the Changes tab showing the changed blocks; History opens Versions; switching tabs keeps focus inside; Escape/backdrop closes and restores focus; the inline page highlights stay.

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/page.spec.ts -g "History"`
Expected: FAIL — the drawer only has versions and `openHistory` takes no tab.

- [ ] **Step 3: Implement the tab state and content.**

Store `{ pageId, tab }` in `pageUi.ts`; `openHistory(pageId, tab)`; the page passes the tab; the drawer shows a tablist “Versions” / “Changes”, renders the existing versions/compare under Versions and ChangesList under Changes, keeps the focus trap/Escape/restore, and labels the dialog. The page's History/Changes buttons and the chip both use the tab.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/page.spec.ts e2e/console.spec.ts -g "History|Changes"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/pageUi.ts apps/web/src/components/HistoryDrawer.tsx apps/web/src/routes/page.tsx e2e/page.spec.ts e2e/console.spec.ts
git commit -m "feat(page): Versions and Changes tabs in the history drawer"
```

---

### Task 5: Presence from the live provider

**Files:**
- Create: `apps/web/src/lib/useLivePage.ts`
- Create: `apps/web/src/lib/presence.ts`
- Create: `apps/web/src/components/PagePresence.tsx`
- Modify: `apps/web/src/components/Editor.tsx`
- Modify: `apps/web/src/routes/page.tsx`
- Test: `apps/web/test/presence.test.ts`
- Test: `e2e/co-edit.spec.ts` and the `expectConnected` helper in `e2e/support.ts`

**Interfaces:**
- Consumes: the existing `api.collabToken`, HocuspocusProvider, `collabDocumentName`, `authorColor`.
- Produces: `useLivePage(pageId, onSynced): { live, access, state, error, reconnect, retry }`; `Editor({ live, access, archived, onSynced })` presentational; `presencePeople(awarenessStates, selfId)` → `{ id, name, tint }[]`; `PagePresence({ live, state, onReconnect })`.

- [ ] **Step 1: Write the failing unit/e2e tests.**

Unit: `presencePeople` dedupes by id, caps at three + N, uses the six tints deterministically, and excludes self; the offline state.
E2E: two browsers on the same page show two initials in the page top bar with title names; disconnect/stop one and the offline chip with Reconnect appears; the editor keeps working; the “Connected” text is gone from the body; `expectConnected` finds the presence dot instead.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm vitest run apps/web/test/presence.test.ts` and `pnpm e2e:local e2e/co-edit.spec.ts -g "presence|connected"`
Expected: FAIL.

- [ ] **Step 3: Lift the provider and render presence.**

Move the token/provider/status/reconnect logic into `useLivePage`; the page calls it once and passes `live` to the editor and the presence; set the awareness user (`name`, `tint`/color, id) in the hook; remove the editor's “Connected” line (keep Read only); the presence renders avatars in the top bar right (before the page menu), the 6px dot, +N, title names, and the Offline chip/Reconnect in `role="status"`. Update `expectConnected` to wait for the presence dot. Clean up awareness/provider on page change/unmount.

- [ ] **Step 4: Run them and see them pass.**

Run: `pnpm vitest run apps/web/test/presence.test.ts` and `pnpm e2e:local e2e/co-edit.spec.ts e2e/page.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/useLivePage.ts apps/web/src/lib/presence.ts apps/web/src/components/PagePresence.tsx apps/web/src/components/Editor.tsx apps/web/src/routes/page.tsx apps/web/test/presence.test.ts e2e/co-edit.spec.ts e2e/support.ts
git commit -m "feat(page): live presence in the top bar from the editor provider"
```

---

### Task 6: The page's writing surface

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/routes/page.tsx` (article/header spacing)
- Modify: `apps/web/src/components/PageHeader.tsx`
- Test: `e2e/page.spec.ts` (long title / 660)

**Interfaces:**
- Consumes: the tokens; BlockNote's `bn-` variables.
- Produces: the 660px article; h1 34/600; h2 19/600; h3 16/600; body 15.5/1.72; quote/code/table treatments; the editor's gutter hanging only where the column has room; the top bar unchanged.

- [ ] **Step 1: Write the failing layout test.**

At 1440, the document column measures 660 and the title 34; a long title wraps without horizontal overflow; at 1024 the column stays 660 or the viewport width, and the editor gutter does not create sideways scroll; the table/quote/code classes are on paper/sidebar.

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/page.spec.ts -g "660|long title"`
Expected: FAIL — the old 720/4xl styles.

- [ ] **Step 3: Apply the type scale.**

Set the article to 660, the header icon 38, h1 34/600/-0.024em; the meta 11.8; the BlockNote h2/h3/body/quote/table/code styles (the `bn-block-content` selectors) using the tokens; keep the existing `@media (max-width: 767px)` gutter rule for the phone phase; remove the `min-[1100px]:-mx-[54px]` hack in favour of the 660 measure with the handles in the margin.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/page.spec.ts -g "660|long title"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/index.css apps/web/src/routes/page.tsx apps/web/src/components/PageHeader.tsx e2e/page.spec.ts
git commit -m "feat(page): 660px writing surface and the page type scale"
```

---

### Task 7: Full verification and cleanup

**Files:**
- Modify: `e2e/console.spec.ts`, `e2e/sidebar.spec.ts`, `e2e/co-edit.spec.ts`, `e2e/viewer.spec.ts` as the moved controls require.
- Test: the whole suite.

**Interfaces:**
- Consumes: everything above.
- Produces: a green page phase and the e2e baseline for the file and Home phases.

- [ ] **Step 1: Update the e2e suite.**

Replace sidebar OnThisPage expectations with the chip; update the console Submit/History helpers; assert the icon in the tree; the history tabs; the presence; the viewer's read-only; the long title; the page actions.

- [ ] **Step 2: Run all checks.**

Run:
```bash
pnpm typecheck
pnpm test
pnpm e2e:local
pnpm web:build
```
Expected: typecheck clean; all Vitest pass; all Playwright specs pass; the web build succeeds.

- [ ] **Step 3: Manual pass.**

At 1440 and 1024: pick/clear an icon (header + tree), change a page and index it, submit in a review space, open History and Changes, restore a version, two browsers show presences, resize to 390 (phone phase still owns the final layout). Confirm no sidebar panel, no 403, and the top bar menu.

- [ ] **Step 4: Commit any spec-only fixes.**

```bash
git add e2e
git commit -m "test: follow the page controls in e2e"
```
