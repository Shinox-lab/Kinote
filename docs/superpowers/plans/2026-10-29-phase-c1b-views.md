# Phase C1b: collection views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A `collectionView` block shows a collection's rows as a table, board, calendar or timeline, with tabs,
filters, sorts, grouping and visible fields, editable in place, on the collection page or any other page.

**Architecture:** View settings live in the block's props (co-edited, versioned with the page that holds it). Rows come
from one API call that checks read access, filters and sorts on the server over the C1a projection, and caps at 1,000.
Filter/sort/prefill logic is pure and lives in contracts. Every edit from a view goes through `PATCH /pages/:id/fields`.

**Spec:** `docs/superpowers/specs/2026-10-29-phase-c-collections-design.md` (C6, C7, C8; delivery part C1b).

## Global Constraints

- Layouts exactly `table | board | calendar | timeline`. Filters are AND only. At most 1,000 rows per view, then
  "Showing the first 1,000 pages".
- Filter ops: text `contains | is | is_empty`; number `eq | ne | lt | gt | is_empty`; date `is | before | after |
  this_week | this_month | next_month | is_empty`; select `is | is_not | is_empty`; multi_select/person `contains |
  not_contains | is_empty` (person value may be `me`); checkbox `checked | unchecked`; page `contains | is_empty`.
- Board groups by select, person or checkbox (plus "No value"); table may group by the same. Calendar and timeline use
  a date field. Board cards show the title and up to three visible fields.
- Copy: "Collection view", "Make this page a collection", "Show an existing collection", "+ New", "No value",
  "You can't open this collection, or it was removed.", "This page is no longer a collection.", "Showing the first
  1,000 pages".
- Readers can change tabs/filters for their session only; only editors of the page holding the block save settings.
- Markdown/engine read the block as `Collection view: <title>` linked to the collection; that is its whole index text.
- No palette colour classes (tokens test). Commits end with the Co-Authored-By line. Never stage other sessions' files.

## Review Focus

1. A view on a page in space A showing a collection in space B, opened by someone who can't read B: no title, field
   names or rows reach them (Task 3 test `no access shows nothing`).
2. A filter/sort on a field that was removed, or a value that doesn't fit: ignored, never an error (Task 1 tests).
3. A view block whose props JSON is garbage (hand-edited, older shape): falls back to one default table (Task 1
   `parseViews` test).
4. Dragging a card into "No value" clears the field; dragging onto the same column does nothing (Task 5 unit test on
   `boardMove`).
5. "+ New" in a filtered view: the new row matches the filter so it doesn't vanish (Task 1 `prefill` test).

---

### Task 1: View contracts and row logic
- Create `packages/contracts/src/views.ts` (export from index): `collectionViewConfig` (type `collectionView`, props
  `collectionId`, `title`, `views` (JSON string), content none), `ViewSchema`, `parseViews(json): View[]` (garbage →
  `[defaultView()]`), `defaultView(layout?)`, `rowMatches(defs, values, filters, ctx: { me, today })`,
  `compareRows(defs, sorts)`, `prefill(defs, filters): Record<string, unknown>`, `groupKeyOf(def, value)`.
- Test `packages/contracts/test/views.test.ts`: each op per type; removed field/ill-typed ignored; `me`; date windows
  against a fixed `today`; sort by title and by field with empties last; prefill only from single-value pins; garbage
  views. Commit `feat(contracts): collection views and row filters`.

### Task 2: The block on the server
- `packages/shared/src/editorSchema.ts`: server `collectionView` spec rendering `<p>Collection view: <a href=/p/id>`;
  `packages/shared/src/blocks.ts`: its text is `Collection view: <title>`.
- Test `packages/shared/test/editorSchema.test.ts` additions: round trip keeps the block in Yjs; Markdown line; block
  text. Commit `feat(shared): collection view block on the server`.

### Task 3: Rows API
- `POST /api/v1/collections/:id/rows` body `{ filters, sorts }` → `{ collection, rows: [{ id, title, icon, values }],
  truncated }` (viewer of the collection page; otherwise 404 `collection_not_found`); `GET /api/v1/collections?q=` →
  readable collections `{ id, title, spaceName }` (for the picker, at most 20).
- Test `apps/api/test/collectionViews.test.ts`: filter + sort on the server; values validated; archived rows left out;
  1,000 cap (`truncated`); `no access shows nothing`; `me`; list only readable collections. Commit `feat(api): collection rows for views`.

### Task 4: The view block (web): tabs, toolbar, table, + New
- `apps/web/src/components/views/` `CollectionViewBlock.tsx` (block spec render: loads collection + rows, tabs,
  toolbar, layout switch, unavailable states), `ViewToolbar.tsx` (Filter, Sort, Group, Fields), `TableView.tsx`
  (cells edit through FieldEditor, title opens the side panel), `lib/views.ts` (pure: grouping, `boardMove`,
  calendar weeks, timeline scale). Slash item "Collection view" in `menus.tsx`; block registered in `schema.tsx`.
- Tests `apps/web/test/views.test.ts` (pure helpers). Commit `feat(web): collection view block with table`.

### Task 5: Board, calendar, timeline
- `BoardView.tsx` (native drag between columns, "Move to" menu for keyboard), `CalendarView.tsx` (month grid, drag to
  a day, undated tray), `TimelineView.tsx` (week/month/quarter zoom, drag to move, drag the end to resize).
- Tests in `apps/web/test/views.test.ts` (`boardMove`, calendar weeks, timeline math). Commit `feat(web): board, calendar and timeline views`.

### Task 6: Browser test
- `e2e/collection-views.spec.ts`: insert a view on the collection page, add a row with + New, edit a cell, filter,
  board drag changes Status, a view on another page, a reader can't save settings, a viewer without access sees the
  unavailable note. Full suite, build, typecheck. Commit `test(e2e): collection views`.
