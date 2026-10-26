# Routing 3c — The Capture console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give people the routing engine in the console:
- a **Capture** page to send anything and follow what happened to it (the thread, the receipt, Undo, "wrong page", and Needs a home);
- a **"changes from this capture"** view on the page itself;
- **suggestions** on pages;
- **review bundles** in Reviews.

**Architecture:**
- **Where things live:** the web app (React 19, TanStack Router and Query) talks only to the 3b API. Pure, testable logic sits in `apps/web/src/lib/capture.ts` (copy, grouping, highlight CSS, URL params) with Vitest unit tests. Screens are verified by Playwright specs in `e2e/capture.spec.ts`, run against the local stack.
- **Local stack:** it already runs the worker; it gains the collab client the routing jobs need.
- **Highlighting** reuses the page's existing block-tint mechanism (`blockHighlightCss`): a capture's blocks are tinted in the Routing engine's colour. Suggestions are marked in the margin the same way.

**Tech Stack:** React 19, TanStack Router 1.x, TanStack Query 5, Tailwind tokens already in `index.css`, Vitest (node), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-routing-engine-design.md`, section "What people see" (Capture page, Receipt, Review bundle). The API comes from plan 3b (merged), in `apps/api/src/server.ts`:
- **Captures:** `POST /captures`, `GET /captures`, `GET /captures/:id`, `POST /captures/:id/answer`, `POST /captures/:id/undo`.
- **Changes:** `POST /capture-changes/:id/undo|move`, `GET /pages/:id/capture-changes?capture=`.
- **Needs a home:** `GET /needs-home`, `POST /capture-facts/:id/place|dismiss`.
- **Suggestions:** `GET /pages/:id/suggestions`, `POST /suggestions/:id/accept|decline`.
- **Reviews:** `GET /reviews`, whose items carry `capture` and `suggestions`.

## Global Constraints

- The sidebar entry is **Capture**, directly under Home (option A, accepted by the owner).
- **Capture box:** accepts up to **20,000** characters. It has a **Limit to** control (Anywhere, a space, or a page) and **Send**. Opening Capture from a space or a page presets the limit to it (`?space=` / `?page=`).
- **Below the box:** the sender's captures, newest first. Each shows its original text, the thread (engine questions with their options, answered inline) and the receipt.
- **Receipt:**
  - grouped by space, then page;
  - each page marked **Applied**, **Waiting for review**, **Suggestion** or **Already known**;
  - before and after of each changed block, plus the reason;
  - **Undo** per page and **Undo all applied**; blocks changed since are listed as "changed since, not undone";
  - **Wrong page → move to…** on inserted and replaced blocks;
  - pages in unreadable spaces show only as **"1 change in a space you can't see"** (plural "N changes in spaces you can't see").
- **Clicking a receipt page card** opens the page in "changes from this capture" mode:
  - the capture's applied blocks are highlighted in the Routing engine's colour;
  - the page is scrolled to the first change;
  - a banner reads **"Changes from this capture · Routing engine on behalf of {sender}"**.
  
  A "Waiting for review" card opens that page in Reviews.
- **Needs a home:** a section on the Capture page. Each fact can be placed on a page (picker) or dismissed.
- **Suggestions:**
  - shown on the page as a margin marker plus a "N suggestions" chip that opens a panel with **Accept** / **Decline**;
  - a removal's button reads **Approve removal**;
  - a conflict shows "cited by {conflictWith}, still valid".
- **Review bundle:**
  - header: **"Routing engine on behalf of {senderName} · from Capture · {time}"**, the excerpt, and "Also applied: {titles}";
  - the capture's items are adjacent (the server already orders them);
  - inline suggestions with **Approve removal** / **Decline**;
  - **Approve all from this capture** approves every item of the bundle the reviewer may approve.
- The Routing engine's colour is the CSS custom property `--routing` (light `#7c5cff`, dark `#a08bff`), with tint `--routing-tint` (light `#7c5cff1a`, dark `#a08bff26`). It is added to `index.css` next to the existing diff tokens.
- Error text always comes from `errorMessage(err)` (`apps/web/src/lib/api.ts`), never raw codes.
- The capture list polls every **2 s** while any capture is `queued` or `routing`, and stops otherwise. Reviews keep their existing poll.
- The page picker (Place, Move to) searches indexed pages through `api.search`. Pages never indexed can't be picked; this matches the spec's "a page that has never been indexed is invisible to candidate search".
- No new runtime dependencies.

## Review Focus

1. **Send is double-clicked, or Enter is pressed twice.** Exactly one capture must be created. Pinned by Task 2's e2e `sending twice quickly makes one capture`.
2. **A capture still routing when the page is opened.** The receipt must appear without a reload, and polling must stop once done. Pinned by Task 1's unit test `capturesBusy is true only while a capture is queued or routing`, and by Task 2's e2e `the receipt appears without reloading`.
3. **Undo where a person changed a block since.** The screen must say which blocks were left. Pinned by Task 1's `undoNotice reports changed-since blocks` and Task 3's e2e `undo shows what was undone`.
4. **The "changes from this capture" link for a change since undone or moved.** It must not be highlighted as applied. Pinned by Task 1's `captureHighlightCss tints only applied changes`.
5. **A reviewer who can approve some, but not all, of a bundle.** "Approve all" must approve only the ones they may, and say what was skipped. Pinned by Task 1's `approvableInBundle` and Task 5's e2e `approve all from this capture`.

---

### Task 1: Client, queries and pure helpers

**Files:**
- Modify: `apps/web/src/lib/api.ts` (methods), `apps/web/src/lib/queries.ts` (hooks), `apps/web/src/index.css` (the `--routing` tokens, light and dark, as in Global Constraints)
- Create: `apps/web/src/lib/capture.ts`
- Test: `apps/web/test/capture.test.ts`

**Interfaces:**
- Produces, in `api` (each parsed with its 3b contract schema):

  | Method | Call |
  |---|---|
  | `createCapture(body)` | POST /captures |
  | `listCaptures()` | GET /captures |
  | `getCapture(id)` | GET /captures/:id |
  | `answerCapture(id, { message_id, choice })` | POST /captures/:id/answer |
  | `undoCapture(id)` | POST /captures/:id/undo |
  | `undoChange(id)` | POST /capture-changes/:id/undo |
  | `moveChange(id, { target_page_id })` | POST /capture-changes/:id/move |
  | `pageCaptureChanges(pageId, captureId)` | GET /pages/:id/capture-changes?capture= |
  | `needsHome()` | GET /needs-home |
  | `placeFact(id, { document_id })` | POST /capture-facts/:id/place |
  | `dismissFact(id)` | POST /capture-facts/:id/dismiss |
  | `pageSuggestions(pageId)` | GET /pages/:id/suggestions |
  | `acceptSuggestion(id)` | POST /suggestions/:id/accept |
  | `declineSuggestion(id)` | POST /suggestions/:id/decline |

- Produces, in `queries.ts`:
  - `useCaptures()`: key `['captures']`; `refetchInterval` is `CAPTURE_POLL_MS = 2_000` while `capturesBusy(data)`, otherwise false.
  - `useCapture(id, enabled)`: key `['capture', id]`, polled the same way while that capture is busy.
  - `useNeedsHome()`: key `['needs-home']`.
  - `usePageSuggestions(pageId)`: key `['page', pageId, 'suggestions']`.
  - `usePageCaptureChanges(pageId, captureId | undefined)`.
- Produces, in `capture.ts`:
  ```ts
  export const CAPTURE_MAX = 20_000;
  export function capturesBusy(list: CaptureSummary[] | undefined): boolean;
  export function captureStatusLabel(s: CaptureSummary['status']): string; // queued→'Waiting to route', routing→'Routing…', waiting_for_answer→'Needs your answer', done→'Done', failed→'Routing failed'
  export function outcomeLabel(o: 'applied'|'waiting_review'|'suggestion'): string; // 'Applied' | 'Waiting for review' | 'Suggestion'
  export function hiddenChangesText(n: number): string | null; // 0→null, 1→"1 change in a space you can't see", n→"n changes in spaces you can't see"
  export function undoNotice(r: UndoChangesResponse): string; // "Undid 2 changes." + " 1 changed since, not undone." when any; nothing undone & nothing changed → "Nothing to undo."
  export function captureHighlightCss(changes: CaptureChange[]): string; // applied only; inset 3px var(--routing) + background var(--routing-tint), same selector shape as blockHighlightCss
  export function suggestionMarkerCss(s: SuggestionSummary[]): string;   // open, blockId non-null: `outline: 1px dashed var(--routing); outline-offset: 2px`
  export function parseCaptureSearch(search: Record<string, unknown>): { space?: string; page?: string };      // uuid-shaped strings only
  export function parsePageCaptureSearch(search: Record<string, unknown>): { capture?: string };               // uuid-shaped only
  export function approvableInBundle(items: ReviewItem[], captureId: string): { approve: ReviewItem[]; skipped: ReviewItem[] }; // canApprove splits
  export function suggestionAction(s: SuggestionSummary): 'Approve removal' | 'Accept';
  ```

- [ ] **Step 1: Write the failing tests** in `apps/web/test/capture.test.ts`:
  - `capturesBusy is true only while a capture is queued or routing`: `[done, failed, waiting_for_answer]` → false; adding one `routing` → true; `undefined` → false.
  - `hiddenChangesText`: 0 → null; 1 → `"1 change in a space you can't see"`; 3 → `"3 changes in spaces you can't see"`.
  - `undoNotice reports changed-since blocks`: `{undone:[a,b], changedSince:[c]}` → `"Undid 2 changes. 1 changed since, not undone."`; `{undone:[a], changedSince:[]}` → `"Undid 1 change."`; empty → `"Nothing to undo."`.
  - `captureHighlightCss tints only applied changes`: given changes with statuses `applied`, `undone`, `moved`, only the applied block id appears; output contains `var(--routing)`; a block id with a quote is escaped (same as `blockHighlightCss`).
  - `suggestionMarkerCss` skips non-open suggestions and inserts (`blockId` null).
  - `parseCaptureSearch` keeps uuid strings and drops `'x'`, numbers and `''`.
  - `approvableInBundle` splits a capture's items by `canApprove` and ignores other captures' items.
  - `suggestionAction`: remove → `'Approve removal'`, otherwise `'Accept'`.
  - Status and outcome labels exactly as listed above.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/capture.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `capture.ts`, the api methods, the hooks and the CSS tokens.
- [ ] **Step 4: Run** `pnpm vitest run apps/web && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): capture client, queries and helpers`

### Task 2: The Capture page — box, list, thread

**Files:**
- Create: `apps/web/src/routes/capture.tsx`, `apps/web/src/components/capture/CaptureBox.tsx`, `apps/web/src/components/capture/CaptureCard.tsx` (text, status chip, thread)
- Modify: `apps/web/src/router.tsx` (route `capture` under the workspace, `validateSearch: parseCaptureSearch`), `apps/web/src/components/sidebar/Sidebar.tsx` (a **Capture** row under Home, with a new `CaptureIcon` in `icons.tsx`), `apps/web/src/routes/space.tsx` and `apps/web/src/components/LifecycleMenu.tsx` (a "Capture here" link to `capture?space=` / `capture?page=`), `e2e/harness/local-stack.ts` (`runWorkerLoop({... collab: new HttpCollabClient(\`http://${HOST}:${collabPort}\`, internalSecret) })`)
- Test: `e2e/capture.spec.ts`

**Interfaces:**
- Consumes the Task 1 api, queries and helpers.
- Produces `CaptureCard({ capture }: { capture: CaptureSummary })`. It loads `useCapture(capture.id)` when expanded; the newest capture is expanded by default. It renders `<Receipt>` from Task 3 under the thread; until Task 3 lands, that is a placeholder.
- **Box behaviour:**
  - a textarea with a character count, which turns red past `CAPTURE_MAX`; Send is then disabled;
  - Limit to is a `<select>`: "Anywhere", then each non-Inbox space where `myRole` is not viewer; a `?page=` preset shows "This page: {title}";
  - Send is disabled while its mutation is pending;
  - on success the box clears and `['captures']` is invalidated.
- **Thread:**
  - an engine message with `options` shows one button per option, labelled with the option's label;
  - clicking calls `answerCapture`, after which the buttons are replaced by "You answered: {label}".

- [ ] **Step 1: Write the failing e2e specs** in `e2e/capture.spec.ts`. The world is `seedWorld(request, { reviewRequired: false })`; an owner page "Billing service" is created through the API with the text "Billing uses Stripe." and indexed with `runPageAction(page, 'Index now')`.
  - `the receipt appears without reloading`: click **Capture** in the sidebar and expect the Capture heading. Then open Capture with `?page=<Billing id>`; expect Limit to to read "This page: Billing service"; type "Billing moved to Adyen."; Send. With no reload, expect within 15 s a card showing "Applied" and "Billing moved to Adyen.".
  - `sending twice quickly makes one capture`: double-click Send; after 2 s `GET /captures` (via `call`) has length 1 more than before.
  - `a question is answered inline`: seed two pages naming "Aisha Rahman" and "Aisha Tan" (indexed). Capture "Aisha is on leave."; expect the "Which Aisha do you mean?" message and two buttons; click "Aisha Rahman"; expect "You answered: Aisha Rahman".
  - `the count turns red past 20,000 characters and Send is off`: fill 20,001 characters; expect Send disabled.
  - `the Capture page fits a phone`: at 390×844, `document.documentElement.scrollWidth <= 390`.
- [ ] **Step 2: Run** `pnpm e2e:local e2e/capture.spec.ts`. Expected: FAIL (no Capture row).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, plus `pnpm e2e:local e2e/sidebar.spec.ts` (the sidebar gained a row). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the Capture page`

### Task 3: Receipt, Undo, Wrong page and Needs a home

**Files:**
- Create: `apps/web/src/components/capture/Receipt.tsx`, `apps/web/src/components/capture/PagePicker.tsx`, `apps/web/src/components/capture/NeedsHome.tsx`
- Modify: `apps/web/src/routes/capture.tsx` (the Needs a home section above the list, shown only when non-empty), `CaptureCard.tsx` (render `<Receipt>`)
- Test: `e2e/capture.spec.ts` (extend)

**Interfaces:**
- `Receipt({ captureId, receipt }: { captureId: string; receipt: CaptureReceipt })`:
  - one section per space, one card per page;
  - each card has a title link and an outcome chip. The link goes to `/w/$slug/p/$id?capture=$captureId`, or to `/w/$slug/reviews?review=…` when the page is `waiting_review` and its version is known; otherwise it falls back to the page link.
  - each change shows its before (struck through, muted) and after, its reason, and per inserted or replaced change a **Wrong page → move to…** button that opens a `PagePicker`.
  - each page with applied changes gets **Undo**; the receipt top gets **Undo all applied**.
  - `hiddenChangesText(receipt.hiddenChanges)` is shown when non-null; Already known facts are listed; Needs a home facts get a link to the section.
- `PagePicker({ onPick, label }: { onPick: (page: { id: string; title: string }) => void; label: string })`: a text input that, debounced 250 ms, calls `api.search({ query, limit: 10 })`. It lists distinct `documentKind === 'page'` results as buttons titled `versionTitle`.
- `NeedsHome()`: lists `useNeedsHome()` items with their statement and reason, a **Place…** button (a PagePicker, then `placeFact`) and **Dismiss**.
- After any mutation, invalidate `['captures']`, `['capture', id]`, `['needs-home']` and the affected page's `['page', id, …]` keys. Undo results are shown with `undoNotice`.

- [ ] **Step 1: Write the failing e2e specs:**
  - `undo shows what was undone`: after a capture like Task 2's applied ("Billing moved to Adyen." limited to Billing service), click **Undo** on the Billing card; expect the notice "Undid 1 change." and the page (open it) to read "Billing uses Stripe.".
  - `wrong page moves the fact`: create and index a second page "Runbook" ("Page the on-call."). Capture "Billing has a new dashboard." limited to Billing service; click **Wrong page → move to…**, search "Runbook", pick it; expect within 15 s that the Runbook page contains "Billing has a new dashboard." and the Billing page does not.
  - `a fact nobody can place waits in Needs a home and can be placed`: capture "Lunch is at noon." limited to Billing service; expect the Needs a home section with that statement; Place… → Runbook; expect it to leave the section and the Runbook page to contain it.
  - `dismiss removes it from Needs a home`.
- [ ] **Step 2: Run** `pnpm e2e:local e2e/capture.spec.ts`. Expected: the new specs FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): receipts with undo, wrong page and needs a home`

### Task 4: The page — "changes from this capture" and suggestions

**Files:**
- Modify: `apps/web/src/router.tsx` (page route `validateSearch: parsePageCaptureSearch`), `apps/web/src/routes/page.tsx`
- Create: `apps/web/src/components/capture/CaptureBanner.tsx`, `apps/web/src/components/capture/SuggestionsPanel.tsx`
- Test: `e2e/capture.spec.ts` (extend)

**Interfaces:**
- **With `?capture=`:**
  - `page.tsx` renders `<style>{captureHighlightCss(changes)}</style>` **instead of** `blockHighlightCss` (the indexed-version highlight would be empty for an indexed routed edit);
  - it renders `CaptureBanner` above the editor: the text "Changes from this capture · Routing engine on behalf of {sender}", a list of the changes (before struck through, after), and an **Exit** link that drops the search param;
  - `{sender}` is the capture's sender name when `useCapture` succeeds (the sender or an admin), else "a teammate";
  - after the editor mounts, the first applied change's block (`[data-id="…"]`) is scrolled into view once.
- **Suggestions:**
  - `page.tsx` always renders `<style>{suggestionMarkerCss(suggestions)}</style>`;
  - in the header meta, a chip "{n} suggestion(s)" appears when n > 0 and toggles `SuggestionsPanel`;
  - each entry shows its kind, reason, proposed Markdown, `blockedBy` in words, and "cited by {conflictWith}, still valid" when set;
  - the buttons are `suggestionAction(s)` and **Decline**; errors show via `ErrorNote`;
  - on success, invalidate `['page', id, 'suggestions']`, `['page', id]` and `['page', id, 'changes']`.

| blockedBy | Words |
|---|---|
| removal | Removals always wait for a person |
| protection | Someone edited this block recently |
| conflict | Another source is cited here |
| no_edit_access | The sender can't edit this space |

- [ ] **Step 1: Write the failing e2e specs:**
  - `a receipt card opens the page with the capture's blocks highlighted`: after a capture like Task 2's applied, click the Billing card in its receipt; expect the URL to contain `?capture=`, the banner text, and the block containing "Billing moved to Adyen." to have a computed `box-shadow` containing `rgb(124, 92, 255)` (light theme).
  - `a removal becomes a suggestion the editor approves on the page`: capture "Billing no longer uses Stripe." limited to the page; open the page; expect the chip "1 suggestion"; open it; **Approve removal**; expect the editor to no longer contain "Billing uses Stripe." and the chip to disappear.
  - `exit leaves capture mode`: click Exit; expect no banner and the URL without `capture`.
- [ ] **Step 2: Run** `pnpm e2e:local e2e/capture.spec.ts`. Expected: the new specs FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `pnpm e2e:local e2e/page.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): capture highlight mode and page suggestions`

### Task 5: Review bundles

**Files:**
- Modify: `apps/web/src/routes/reviews.tsx`
- Create: `apps/web/src/components/capture/BundleHeader.tsx`
- Test: `e2e/capture.spec.ts` (extend)

**Interfaces:**
- **Queue list:** items with `capture` show a small "From Capture" line under the title. Consecutive items with the same `capture.id` are wrapped in a bordered group (the server already orders them).
- **ReviewDetail:**
  - when `item.capture` is set, it shows `BundleHeader`: "Routing engine on behalf of {senderName} · from Capture · {ago(createdAt)}", the excerpt, and "Also applied: {titles}" as links;
  - the header has **Approve all from this capture**. It uses `approvableInBundle(items, capture.id)`, approves each with `api.approveVersion` in sequence, then shows "Approved {n}." plus " {m} need another reviewer." when any were skipped;
  - `item.suggestions` render below the document with `suggestionAction` / **Decline** (the same `SuggestionsPanel` entry component from Task 4, exported as `SuggestionEntry`).

- [ ] **Step 1: Write the failing e2e spec** `approve all from this capture`:
  - a world with `reviewRequired: true` and two indexed pages "Acme" ("Acme pays yearly.") and "Globex" ("Globex pays quarterly."). The editor `ed` sends "Acme now pays monthly. Globex now pays monthly." through the API (`call`, POST /captures) with no scope;
  - the reviewer `rae` opens Reviews and sees both items grouped, with the header "Routing engine on behalf of Ed Editor · from Capture";
  - **Approve all from this capture**; expect "Approved 2." and the queue empty.
- [ ] **Step 2: Run** `pnpm e2e:local e2e/capture.spec.ts -g "approve all"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm e2e:local e2e/capture.spec.ts e2e/console.spec.ts` (the review queue specs must still pass). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): review bundles from captures`

---

## Not in this plan (by design)

- Capture over MCP (the MCP rework).
- Notifications to reviewers or senders (Phase A).
- Archiving engine-created pages on Undo, and Undo of accepted suggestions (3b deferred minors).
- Mobile-specific layouts beyond what the existing responsive shell gives. The Capture page must not scroll sideways at 390 px (checked in Task 2's specs with `page.setViewportSize({ width: 390, height: 844 })`).
