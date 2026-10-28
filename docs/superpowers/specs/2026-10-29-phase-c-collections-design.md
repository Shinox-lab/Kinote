# Phase C1: page collections — design

Status: draft, 2026-10-29. Follows Phase A (merged). Builds on `docs/2026-10-18-living-wiki-standalone-design.md`, the
routing specs (`2026-10-26-routing-engine-design.md`, `2026-10-27-routing-documents-design.md`) and Phase A
(`2026-10-28-phase-a-connected-pages-design.md`). Where they differ, this wins for collections. Excalidraw drawings
(the other half of Phase C) get their own spec after this one.

## Why

A wiki team keeps lists of like things: clients, projects, people, vendors. Today each one is a sub-page with its
details written as prose, so nobody can see "every client, its status and its launch date" in one place, sort them, or
plan on a calendar. The owner wants Notion-style collections: a page whose sub-pages share typed fields, shown as
table, board, calendar or timeline views that can be placed on any page. The routing engine already files facts onto
those sub-pages. With fields, it can also keep the structured details current ("George launch moved to December" sets
George's Launch date), and Search and Ask can answer from them.

## Goals

1. **Collections set up by the team.** Any editor of a space turns a page into a collection and adds, renames, reorders
   and removes its fields. No admin, no code.
2. **Typed fields on every row.** Each direct sub-page of a collection is a row. Its fields show under its title, the
   way Notion shows properties, and anyone who can edit the page fills them in.
3. **View blocks, Notion-style.** A view is a block inside a page, so the page keeps its own text (an intro above the
   table). It has tabs, one per view, each a table, board, calendar or timeline with its own filter, sort, grouping and
   visible fields. A view block can show a collection from any page, not only its own.
4. **Editing from views.** Edit cells in place, drag cards between board columns, drag items on the calendar, drag and
   resize bars on the timeline, and add rows with "+ New".
5. **The engine writes fields.** A routed fact can set or change a field on a row, following the space's review rules
   exactly as page text does, with a receipt, reason and Undo.
6. **Search and Ask understand fields.** Field values are indexed with their page; Ask can answer questions across a
   collection ("which clients launch in December?") with citations.

## Non-goals

- Formulas, relations with rollups, and the gallery and list layouts (owner's call: not now).
- Rows that aren't pages, and databases that live only inside a block (Notion's inline database). Every row is a real
  page under the collection page. *(my call: keeps routing, links, comments and permissions working on rows unchanged)*
- Changing a field's type after it is made. Make a new field instead. *(my call)*
- Built-in columns beyond Title (created time, last edited, created by). *(my call: can be added later as read-only
  columns)*
- Personal (per-viewer) view settings. Views are shared, like Notion's.
- Field filters typed into the Search box. Search finds field values as text.
- Collections in the Inbox. *(my call: the Inbox is per-person; collections are for a team)*
- Anything the owner dropped: templates, AI writing help, public pages, import, mobile.

## Anti-goals

- **A field changed on the wrong page, or a value lost that should stay** (the owner's two fears, applied to fields).
  Clearing a value with nothing replacing it is a removal, so the engine never does it on its own (R2). A value a person
  set recently is never overwritten by the engine (rule 5).
- A view that shows a row someone can't read. Rows, titles and values are filtered by read access when the view is
  loaded, never baked into the page that holds the view block.
- Field values that bypass review. In a review space a field change waits for approval before Search and Ask see it,
  exactly like a text change.
- A view block that copies data. It always reads the collection; nothing goes stale.

## Decisions

Calls marked *(my call)* were made by me while writing this design; the owner can overturn them. Unmarked decisions are
the owner's.

**C1. A collection is a page.** Turning a page into a collection doesn't change its kind or move anything. It gains
field definitions, and its direct sub-pages become rows. Sub-pages of rows are not rows. Files under the collection page
are not rows. A page stops being a collection with "Turn back into a page" (field definitions are removed; values stay
in each row's document but are hidden, see C3). Who can do it: an editor of the collection's space. *(my call)*

**C2. Field definitions live in Postgres.** New table `collection_fields`: `{ id, tenant_id, collection_id
(documents.id), name, type, options jsonb, position, created_at }`, unique `(tenant_id, collection_id, lower(name))`.
Defining fields is structural, like renaming or moving a page: it applies at once, is audited (`collection.*` audit
types), and is not reviewed or versioned. *(my call)* Types and options:

| Type | Value | Options |
|---|---|---|
| `text` | string (one line or a few; no rich text) | — |
| `number` | number | `format`: plain, decimal (2 places), percent, currency (`code`, e.g. USD) |
| `date` | `{ start: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }` | — |
| `select` | option id | `choices: [{ id, name, color }]` |
| `multi_select` | option id[] | `choices` as above |
| `person` | user id[] | — |
| `checkbox` | boolean | — |
| `page` | document id[] | — |

Dates have no time of day. *(my call: Notion's time and time-zone options add a lot for little; add later if wanted)* An
empty value is the field being absent. Removing a field asks for confirmation ("Launch date will be removed from 24 pages").
Removing a select choice removes it from every row that had it, with the same kind of confirmation. Neither writes into
the rows' documents: the stale values are ignored when read (C3), and the affected rows' indexed versions are re-indexed
so Search and Ask drop them, without making new versions or review items. *(my call, after review: a real clear would
make N versions, N review items, and block the engine on N pages under rule 5)* A limit of 50 fields
per collection. *(my call)*

**C3. Field values live in each row's page document.** A row's values are a `fields` Y.Map in its page's Y.Doc, next to
the existing `meta` map that holds the title, keyed by field id. That way values are co-edited live, attributed to
whoever changed them, snapshotted into versions, held for review, restored with "Restore this version", and moved with
the page, using the machinery that already exists for text. Concretely:
- `versions` gains `fields jsonb`: the values at that snapshot, `{ [fieldId]: value }`, written by `takePageSnapshot`.
  The content hash covers them, so a field-only change makes a new version.
- Collab attribution counts a change to `fields` as a page change (as it does for `meta`), marking the page changed
  since its snapshot and recording the contributor. Each field change is recorded in `block_activity` under the block
  id `field:<fieldId>`, so rule 5 ("a block a person edited recently is never replaced by the engine") applies to fields
  with no new mechanism. *(my call)*
- Values whose field no longer exists, or whose page is no longer a row, stay in the document but are ignored
  everywhere. Moving a row back under its collection shows them again. *(my call: nothing is destroyed by a move)*
- Values are checked against the field type when written through the API or by the engine. Live editors write the
  Y.Doc over the websocket, which collab can't partly reject, so collab accepts any value and every reader (projection,
  snapshot, index, views) ignores a value that doesn't fit its field's type. *(my call, after review)*
- For a row, a non-empty field counts as content: a row with only a title and fields still gets snapshotted, reviewed
  and indexed. Pages that aren't rows keep today's "empty page makes no version" rule. *(my call, after review: otherwise
  rows made from views would never reach Search or Ask)*
- The review diff, version history and receipts show field changes ("Status: Lead → Active") next to block changes, so a
  reviewer never approves a field change they can't see. Required in C1a. *(my call, after review)*
- "Restore this version" restores the version's field values too (collab's replace path gains a `fields` payload).
  Values for fields or choices that no longer exist come back as ignored values, like any stale value. *(my call)* A page id or user id that later becomes
  unreadable or deleted shows as "Page unavailable" / "Former member", like Phase A's links.

**C4. A live projection for views.** Views need many rows at once, so collab keeps a projection table
`page_field_values { tenant_id, page_id, field_id, value jsonb, updated_at }`, rewritten for a page whenever collab
stores its document. Views read the projection (live values, like a page shows live text even before review). Search
and Ask never read it; they read indexed versions (C9). A projection that is missing or behind is rebuilt from the
stored document. Moving a page into or out of a collection also rebuilds its projection and re-indexes its indexed
version, so views, Search and Ask follow the move at once. *(my call, after review)*

**C5. Fields on the row page.** Under the title of a row, a properties area lists every field: a name, an icon for the
type, and an editor suited to the type (text box, number box, date picker with an optional end date, choice menu that
can add a choice, member picker, checkbox, `[[`-style page picker). Empty fields can be collapsed behind "N empty
fields". On the collection page itself the same area shows "Fields" with an "Add a field" button. Readers see values
without editors. *(Builder: exact look within the existing page style.)*

**C6. A view is a block.** New BlockNote block `collectionView` with props `{ collectionId, views (JSON) }`, inserted
from the slash menu ("Collection view"). On a page that isn't a collection, the slash item asks: "Make this page a
collection" or "Show an existing collection" (a picker of collections the person can read). Because settings live in
the block's props, they are co-edited and versioned with the page that holds the block, and any editor of that page can
change them. A reader can switch tabs and change filters for their own session without saving. *(my call: matches
Notion, where readers can't save view changes)* Each saved view is:

```
{ id, name, layout: 'table'|'board'|'calendar'|'timeline',
  filters: [{ fieldId, op, value }],        // all must match (AND)
  sorts: [{ fieldId | 'title', dir }],
  groupBy: fieldId | null,                  // table and board
  dateField: fieldId | null,                // calendar and timeline
  visible: [fieldId], widths: { [fieldId]: px } }
```

Filters are AND only. *(my call: Notion's nested AND/OR groups are rarely needed)* Filter ops per type: text
contains/is/is empty; number =, ≠, <, >, is empty; date is, before, after, within (this week, this month, next month),
is empty; select is/is not/is empty; multi-select and person contains/does not contain/is empty, with "Me" for person;
checkbox is checked/unchecked; page contains/is empty. Markdown and the engine read the block as one line, "Collection
view: Clients", linked to the collection. *(my call)* The block's text is not indexed beyond that line; rows are indexed
on their own pages.

**C7. Four layouts.**
- **Table:** Title first, then visible fields as columns; hide, reorder and resize columns; edit cells in place; group
  by any choice, person or checkbox field. *(my call: grouping in tables, as in Notion)*
- **Board:** columns from a select, person or checkbox field (plus "No value"). Dragging a card changes that field.
  Cards show the title and up to three visible fields.
- **Calendar:** a month grid on a date field; items with an end date span days. Dragging moves the date (keeping the
  length). Items with no date are listed in a side tray, from which they can be dragged onto a day.
- **Timeline:** bars from start to end of a date field on a scrolling time axis with week, month and quarter zoom. Drag a
  bar to move it, drag an end to change its length; a date with no end is a one-day bar. A left column lists titles.
  *(Builder: the axis and bar drawing.)*

Clicking an item opens its page in the Phase A side panel. "+ New" (table bottom, board column, calendar day, timeline
row) creates a sub-page under the collection, pre-filled from the view's filters (when a filter pins one value) and the
column, day or range it was added in, and opens it in the side panel with its title focused. A view loads at most 1,000
rows and says so when there are more. *(my call)* Every edit from a view goes through the same field write as the row
page (C3), so it is attributed, reviewed and protected the same way.

**C8. Views on other pages.** A `collectionView` block may name any collection. When it loads, rows are filtered to pages
the viewer can read. A viewer who can read none of the collection's space sees "You don't have access to this
collection"; an archived collection shows "This collection was removed". The collection's own name and field names are
shown only to someone who can read the collection page. Access is per space and a row always sits in its collection's
space, so in practice the check is once per collection, plus leaving out archived rows. *(my call, per the anti-goal)*

**C9. Indexing fields.** When a row's version is indexed, its readable fields are written as a header at the top of its
first chunk: one line per non-empty field, `Field name: value`, with dates in ISO and words ("Launch date: 2026-12-01
(1 December 2026)"), choices by name, people by name, pages by title, checkbox as Yes/No. Search then matches field
values as text, and Ask quotes them with the page as citation. The page card (routing) includes the same header.
*(my call)* For questions across a collection, Ask adds one more passage when the retrieved passages include rows of a
collection: a compact table of that collection's rows (title plus indexed field values, readable rows only, at most
200 rows, each row citing its page). This is what answers "which clients launch in December?". *(my call: no query
language; the model reads the table)*

**C10. The engine writes fields.** The planner learns about fields:
- A candidate page that is a row is shown to the model with its collection's fields (name, type, choices) and the row's
  current live values.
- `PlannedOp` gains `set_field { documentId, fieldId, value }`, where `value` is a new value (set or change) or null
  (clear). The planner validates it against the field type; a choice name that isn't one of the field's choices is
  rejected, never created by the engine. *(my call: the engine doesn't invent categories)*
- Gating reuses the text rules: clearing a field with nothing replacing it is a removal → always a suggestion (R2); a
  field a person changed within the protection window → a suggestion (rule 5); no edit access → suggestion. Otherwise
  it applies live, and the page's next snapshot follows the space's review rule (R1) — the same path as a text edit.
- `capture_changes.op` gains `set_field`, with `block_id = field:<fieldId>`, and before/after values as JSON text.
  Undo restores the before value if the field still holds the after value; if a person changed it since, or the field
  was removed, Undo leaves it and says so (same rule as text). `suggestions.kind` gains `set_field` with the proposed
  value, and `expected_text` holds the value seen when proposed (JSON). Accepting goes stale when the field was removed,
  the proposed value no longer fits (a removed choice), or the current value differs from the expected one. *(my call,
  after review)*
- The receipt shows the change as "Launch date: 2026-11-15 → 2026-12-01" on the row's page.
- A new page the engine creates under a collection (a document capture filed under "Clients") may get field values from
  the same plan, as `set_field` edits on the new page. *(my call)*

**C11. API.**
- `POST /pages/:id/collection` (turn into a collection), `DELETE` (turn back), `GET /collections/:id` (fields), `POST/PATCH/DELETE
  /collections/:id/fields[/:fieldId]` (including choices and order).
- `GET /collections/:id/rows?view=<json>` returns readable rows with their live values, filtered, sorted and grouped on
  the server (so access checks and the 1,000-row cap are enforced in one place).
- `PATCH /pages/:id/fields` `{ [fieldId]: value | null }` writes values through collab (the same internal path as
  engine edits), so a write from a view and a write from the row page are the same change.
- New errors: `collection_not_found`, `field_not_found`, `field_invalid_value` (400), `field_limit` (400),
  `field_name_taken` (409).

**C12. Copying, moving, archiving.** Archiving a collection hides its views (C8) and keeps its rows as pages. Moving a row
out of its collection hides its fields (C3); moving a page into a collection makes it a row with empty fields (values for
other collections' fields stay hidden). Moving the collection page keeps its rows with it, as moves already do.

## Delivery

Three parts, each merged on its own:

- **C1a Fields:** `collection_fields`, `fields` Y.Map and `versions.fields`, attribution and `block_activity`, the
  projection, the API for collections and values, the properties area on row pages and the collection page, turn into /
  turn back, indexing the field header (C9 first part) and page cards.
- **C1b Views:** the `collectionView` block, the four layouts, filter/sort/group/visible fields, editing from views,
  "+ New", side panel, views on other pages and their access rules.
- **C1c Engine and Ask:** `set_field` planning, gating, apply, receipts, Undo and suggestions; Ask's collection table.

## Edge cases

- Two people edit the same field at once: last write wins (Y.Map), both attributed.
- A row is archived: it leaves every view; its values stay in its document.
- A select choice is renamed: rows keep the choice id, so nothing changes but the label. Search sees the new name after
  the row's next indexing. *(my call: no re-index of every row on rename)*
- A field is renamed: same, label only.
- A person in a person field leaves the tenant: shown as "Former member"; indexing writes nothing for them.
- A review space: a person's field edit shows live in views and on the page at once, and the page's status chip says it
  waits for review; Search and Ask keep the approved value until then.
- An engine `set_field` on a page someone is editing: applied through collab like a text op; the editor sees it live.
- A view block naming a collection that was turned back into a page: "This page is no longer a collection".

## Left to the builder

- The look of the properties area, view tabs, toolbar, cards, calendar and timeline, within the existing style.
- Drag-and-drop library choice (or none), timeline drawing, and keyboard support details (cells reachable and editable
  by keyboard is required; how is the builder's).
- Projection rebuild strategy and indexes for the rows query.
- Prompt wording for `set_field` and the Ask collection passage.
- Whether filters/sorts run in SQL over the projection or in memory after loading readable rows, as long as the
  1,000-row cap and access filtering hold.
