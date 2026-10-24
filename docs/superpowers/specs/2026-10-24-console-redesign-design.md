# Living Wiki console — premium redesign

Date: 2026-10-24. Status: **proposed — awaiting approval. Nothing here is built.**
Builds on: `2026-10-20-slice-2b-sources-and-console-design.md` (the console as it exists),
`2026-10-21-sidebar-polish.md` (rename, drag-to-move, right-click, New space — uncommitted in the working tree).
Where this document and the earlier console specs differ, this one wins for the console's layout and look.
The previous round's API work (rename, moves, audit) is kept; its sidebar feed and "On this page" panel are superseded.

## Intent

The console today is a competent admin tool. It has the data — pages, files, versions, reviews, chunks,
sources — but every screen presents it as a form: cards, selects, grey metadata strings, a blue button.
The product's reason to exist is quieter: a person writes a page, or finds a passage, and trusts that what
they read is the version a person approved. The index is the supporting hand, not the subject.

This redesign makes the **page the product**, the **file the artifact**, the **search the answer**, and the
**review the moment the index waits for a human**. The look is warm paper with an ink palette and one violet
accent — Notion's calm — with the file system's bones: a real sidebar, a file tree, a queue, panes that keep
their place. It is a human tool with an agent-aware index, not an agent console with a writing box.

The work is a redesign of eight screens of the existing console. No new product surface, no new audience:
the same workspace, the same permissions, the same data.

## The eight decisions (yours)

| # | Screen | Decision |
|---|--------|----------|
| 1 | Shell | **A** — one 252px sidebar, no icon rail; Home is a destination; the updates feed leaves the sidebar for Home; theme and sign-out move into the account menu. |
| 2 | Page | **B** — an emoji icon per page, above the title. |
| 3 | File | **A** — a right rail with Details / Chunks / Versions, collapsible. |
| 4 | Home | **A** — a personal flow: search, Continue, Updates; no space list duplicated from the sidebar. |
| 5 | Search | **A** — search leads; "Get an answer" is an opt-in layer above the results. |
| 6 | Reviews | **B** — a two-pane queue and reading pane showing the **whole document with changes in place**; a Changes only toggle. |
| 7 | Settings | **A** — a docked right pane edits the selected space or source. |
| 8 | Phone | **A** — the desktop sidebar as a slide-over drawer. Night is warm charcoal as shown; that palette is my call, listed below. |

## Goals

1. **A page feels like the product.** Identity, state and presence in one header; a quiet reading/writing
   surface; the index act available when there is something to index.
2. **A file feels like the artifact.** The preview fills the screen; the extractor's work and the versions
   are a quiet rail, not two empty cards.
3. **Home answers "what now?"** — find it, continue it, see what moved. No duplicated navigation.
4. **Search answers.** One field, a scope chip, scan-friendly passages; an answer with citations when asked.
5. **Review is reading, not form-filling.** The queue on the left, the document with its changes in place on
   the right; one approve decision, one reason when it is blocked.
6. **Settings are lists first.** People, spaces and sources read as rows; a pane appears for the one item
   being edited.
7. **Night and phone are first-class.** A warm dark palette, not an inversion; a phone layout that drops
   chrome, not one that shrinks the desktop.
8. **No regression.** Every existing behaviour that survives is reachable; permissions, warnings, review
   rules, downloads, accessibility and the live editor keep working.

## Non-goals

- No new editor features: no comments, mentions, suggestions, covers, custom images, embeds, databases,
  slash-menu changes beyond the gutter note, or AI writing.
- No sharing: no public links, guests, share sheets or permissions redesign. Roles and space access stay.
- No command palette, keyboard-shortcut system, notifications, inbox, "All activity" page or bottom tab bar.
- No new search modes or filters beyond the existing space scope; no streaming answers.
- No line diff inside a PDF or image; file reviews show the file and its extraction, not edits on the image.
- No personal settings page; the account menu holds theme and sign-out.
- No mobile app; the phone is the responsive web console at 390px and up.

## Anti-goals (a failure even if it works)

- **A page that cannot act on itself.** Index, review, history and changes reachable from the page's own
  header — never only from the sidebar.
- **Navigation duplicated.** No spaces list on Home, no second nav column in Settings, no icon rail.
- **A wall of open forms.** Every list is rows; a form appears for the selected thing only.
- **Fake affordances.** No invented data, no fake keyword highlights, no email that is really a link, no
  "Connected" as a human presence.
- **A theme that is an inversion.** No pure black, no pure white body text, no system blue; the status
  tints are rebuilt for dark.
- **A phone that is a shrunken desktop.** No 40px titles, no 54px editor indent, no buttons competing with
  the content.
- **Lost behaviour.** Every existing test that still describes real behaviour passes or is deliberately
  updated; no silent removal of download, retry, restore, review rules or permissions.
- **A slower console.** No viewer or editor code in the main bundle; the diff/answer/chunks fetch on demand.

## Constraints and current state

- React + TanStack Router + Tailwind; BlockNote with Hocuspocus for live pages; pdf.js, SheetJS, mammoth,
  pptx viewers already exist and stay. No new runtime dependency is expected; the emoji picker is a
  curated inline grid.
- The working tree already holds the previous round (rename APIs, drag-to-move, context-menu rename,
  New space, content-first file screen) uncommitted. It is the base; do not revert it. Its feed and
  "On this page" panel are replaced here.
- The e2e suite (39 passing on the local stack) encodes: Download visible to viewers, a "Preview" region,
  a "Versions" list, one `role="note"` banner, `Expand/Collapse <space>`, and the old page header. Every
  change that touches these updates the test deliberately.
- The target desktop is 1440×900; the phone target is 390×844. The console must remain usable at 1024 and
  in between.
- Data and permissions are unchanged except the additive fields listed under **Data and API deltas**.

## Foundation

### Shell

- **Sidebar 252px**, fixed on desktop, `--sidebar`. Collapsible with the panel control in the workspace
  row (existing behaviour, kept); collapsed, the top bar shows the expand control.
- **Workspace row:** monogram, name, chevrons (opens the existing workspace menu), collapse control.
- **Nav:** Home, Search, Reviews (badge count), Settings & members (owners/admins only). Icons are 14px
  line glyphs, `--muted`; the active row is `--selected` with ink text.
- **Spaces:** the existing tree: space rows toggle, drag to move, right-click rename, the per-space add
  menu, New space for owners/admins. Page rows show the page's emoji; file rows show the type tile. The
  tree is the only place spaces are listed.
- **Account row:** initials, name, `···` menu: Appearance (System / Light / Dark), Sign out.
- **Top bar 44px**, sticky. Left: the breadcrumb for the current document (space / ancestors / title; the
  current title is not a link) or the section name (Home, Search, Reviews, Settings). Right: presence and
  the page/file `···` menu. On Home/Search/Reviews/Settings the right side is empty unless the screen
  defines an action.
- **Main:** fluid, max 1188px, gutters 28px desktop / 20px phone. Screens use a 820px column except the
  page and the file/review reading panes (660 / 620).
- **No feed, no "On this page"** in the sidebar. The page's changes live in the version menu; the feed
  lives on Home.

### Tokens

All colours are CSS custom properties on `:root` and `[data-theme='dark']` (the existing mechanism); Tailwind maps them (no raw hex in components).

Light:

| Token | Value | Use |
|---|---|---|
| `--paper` | `#fcfbf9` | page background |
| `--sidebar` | `#f5f2ed` | sidebar, secondary panels |
| `--surface` | `#ffffff` | cards, inputs, popovers |
| `--ink` | `#24211d` | primary text |
| `--muted` | `#79726a` | secondary text |
| `--faint` | `#a49b91` | tertiary text |
| `--line` | `#e8e2d9` | hairlines and borders |
| `--hover` | `#f2eee7` | hover fills |
| `--selected` | `#ece7df` | selected tree/menu row |
| `--accent` | `#6550c9` | links, active underline, focus |
| `--accent-soft` | `#ece6fa` | accent fills |
| `--accent-ink` | `#5b43c7` | text on accent-soft |
| `--ok-bg` / `--ok-line` / `--ok-text` / `--ok-dot` | `#f3f8f5` / `#dfe9e3` / `#3c6350` / `#2f7d5d` | indexed |
| `--warn-bg` / `--warn-line` / `--warn-text` / `--warn-dot` | `#fbf3e6` / `#f0e2c8` / `#7a531f` / `#b5813b` | unindexed changes |
| `--review-bg` / `--review-line` / `--review-text` / `--review-dot` | `#efeafb` / `#ddd3f7` / `#5b43c7` / `#6550c9` | in review |
| `--bad-bg` / `--bad-line` / `--bad-text` / `--bad-dot` | `#f9eae7` / `#f0d6d1` / `#97382f` / `#b4443a` | failed |
| `--diff-changed-bg` / `-line` | `#f8f5fe` / `#b9aee6` | changed block |
| `--diff-added-bg` / `-line` | `#f3f8f5` / `#79ad92` | added block |
| `--diff-removed-bg` / `-line` | `#fbf1ef` / `#c98279` | removed block |
| `--shadow-pop` | `0 8px 24px rgba(60,48,30,.12), 0 1px 3px rgba(60,48,30,.06)` | menus, popovers |

Night:

| Token | Value |
|---|---|
| `--paper` | `#1a1713` |
| `--sidebar` | `#141210` |
| `--surface` | `#221e19` |
| `--ink` | `#ece6dd` |
| `--muted` | `#a79c8e` |
| `--faint` | `#7c7266` |
| `--line` | `#302a23` |
| `--hover` | `#241f1a` |
| `--selected` | `#2b251f` |
| `--accent` | `#a08cff` |
| `--accent-soft` | `#2c2542` |
| `--accent-ink` | `#c8b9ff` |
| `--ok-bg` / `--ok-line` / `--ok-text` / `--ok-dot` | `#1c2a23` / `#2c4438` / `#8fd3b1` / `#6cc39b` |
| `--warn-bg` / `--warn-line` / `--warn-text` / `--warn-dot` | `#2e2619` / `#4a3b22` / `#e0b378` / `#e0ab6a` |
| `--review-bg` / `--review-line` / `--review-text` / `--review-dot` | `#2c2542` / `#443a63` / `#c8b9ff` / `#a08cff` |
| `--bad-bg` / `--bad-line` / `--bad-text` / `--bad-dot` | `#301f1c` / `#4a2e29` / `#f0a49b` / `#e58a80` |
| `--diff-changed-bg` / `-line` | `#241f36` / `#8b76e8` |
| `--diff-added-bg` / `-line` | `#1b2721` / `#4f8f74` |
| `--diff-removed-bg` / `-line` | `#2b1e1b` / `#a9635c` |
| `--shadow-pop` | `0 10px 30px rgba(0,0,0,.55)` |

Rules: no pure `#000` or `#fff` text; surfaces differ in luminance, not only borders; status is always
text + dot, never colour alone; images and PDF canvases are not tinted; the PDF page stays white.

The existing CSS variable names stay (`--page`, `--sidebar`, `--surface`, `--line`, `--fg`, `--muted`,
`--hover`, `--active`, `--accent`, `--accent-fg`, `--accent-text`); the design names above map onto them
(paper → `--page`, ink → `--fg`, hairline → `--line`). New tokens (faint, the four status tints, the three
diff tints) are additive. The tree's existing attention-dot values keep their meaning (failed / review /
editing); the review screen's diff tones use the new diff tokens.

### Type and space

- `system-ui, -apple-system, "Segoe UI", sans-serif`; `ui-monospace, SFMono-Regular, Menlo, monospace`
  for ordinals, chunk numbers and hex.
- Page title 34/600/-0.024em (phone 26); file title 30/600 (phone 24); Home greeting 27/600 (phone 23);
  Settings and section titles 24/600 (phone 21); document h2 19/600/1.35; h3 16/600; body 15.5/1.72
  (phone 15/1.7); UI row titles 12.5–13/500–600; metadata 10.5–11.5; uppercase labels 9–10 with 0.08em.
- Reading measure 660; file/review doc 620 within their panes; lists 820. Phone: full width, 20px gutters.
- Spacing on a 4px base; section gaps 24–28; card padding 16–20; row heights 40–54 desktop, 44 minimum on
  touch.
- Radii: 6 (chips, small buttons), 7 (buttons/inputs), 9–10 (cards, panels), 12 (app frame), 30 (phone).
- Motion: 140ms ease-out for hover/popover; 220ms `cubic-bezier(.2,.8,.2,1)` for the drawer; respect
  `prefers-reduced-motion` (no transform motion).
- Focus: 2px `--accent` ring with 2px offset, visible on every interactive element, including dark.

### Breakpoints

- `>= 1024px`: fixed sidebar. `< 1024px`: drawer (nav hidden), top bar keeps the hamburger.
- `>= 1200px`: file rail, review two-pane and settings docked pane. Below: those become sheets.
- `< 768px`: phone type, gutters and one-column layouts; sheets are full-screen.
- The editor's 54px block gutter applies at `>= 1100px` (existing). Below 768 it is removed and text aligns
  with the title; the slash menu still works.

## Screens

### 1. The page

**Header.** Top bar crumbs; presence at the right. Inside the document column: emoji (38) above the title;
title 34/600; meta row: status chip + relative time ("2h ago" from the indexed version). The page menu
(rename, move, archive, delete) stays in the top bar.

**Emoji icon.** Clicking the icon opens a small picker (48 curated emoji, Remove). The icon shows above the
title, in the sidebar tree (replacing the page glyph), in search result rows, review rows and Home's
Continue cards. Files show a type tile instead. Nothing else about the page identity is new.

**Status chip and menu.** One chip carries clean / changed / in review / failed:
- Clean: green dot, "Indexed · v1", "2h ago"; no visible primary action.
- Changed: amber, "3 unindexed changes", a compact "Index now" (or "Submit for review" in a review space).
- In review: violet, "In review · v2", "Review" (a navigation link to the matching item in the Reviews
  queue) / "Waiting for a reviewer" for the author. The page never approves; the queue holds the decision
  and the blocked reason.
- Failed: red, "Index failed", compact "Retry".
Clicking the chip opens a 280px popover: the state line, **Index now / Submit for review** (always available
here, even when clean), **History** and **Changes (N)**. History and Changes open the existing right-hand
`HistoryDrawer`, which gains two tabs, Versions and Changes (the existing `ChangesList`). The inline
author-coloured block highlights on the page stay.

The four states above are the common ones, not the whole state machine. **Every server badge is kept.** The
tone comes from the existing `badgeTone`: `Withdrawn`, `Removed at source`, `Stored · no searchable text` and
`Not indexed · vN rejected` are muted; `Indexing…`, `Saved · indexing soon`, `Reading text…` and the
"being read / indexing" indexed variants are pending; `Index failed` / `Extraction failed` are danger. The
review state uses the review tint, not the pending tint. Labels are the server's badge text, except the
changed state, which the client composes as "N unindexed changes" when `liveChangedSinceSnapshot` is true.
The available actions remain the existing page controls (primary, retry, restore), so no state loses its
action. The sidebar tree keeps its existing attention dots alongside the emoji/type icon.

**Presence.** Up to three initials avatars (fixed six-colour palette keyed by user id) + "+N" and a 6px live
dot from the Hocuspocus awareness, with names on hover/title. When the connection drops, the dot becomes an
"Offline" chip with Reconnect, in a `role="status"` live region. "Connected" disappears from the body.

**Body.** BlockNote on paper, 660px; the existing typography is restyled to the scale above: h2 19, h3 16,
body 15.5, quote with a 2px left rule, tables with header caps and hairline rows only, code blocks on
`--sidebar` with a hairline. The editor is the page; nothing else sits between the title and the first
sentence.

### 2. The file

**Header.** Type tile (extension-derived, 34), file name 30/600, meta: status chip + type · size · pages ·
uploaded. Right: Download (kept visible to viewers) and `···` (Replace file, Rename, Move, Withdraw from
index, Archive/Delete as today). Replace leaves the top-level button row and lives here.

**Preview.** Full-bleed on a mat (`#f1ede7` light, `#211d18` dark), no card, no padding box. PDFs open at
**fit-to-width** (new; clamped 50–200%), one page at a time, with a floating bottom-centre toolbar: prev,
page n / N, next, −, %, +, Fit. Images fit contain. Markdown and text use the page's reading scale in a
660px column. XLSX/CSV/PPTX/DOCX keep their viewers, restyled; spreadsheet sheet tabs sit above the grid.

**Rail (300, collapsible).** Header "File" + collapse; tabs **Details** (default), **Chunks (N)**,
**Versions (N)**.
- Details: Type, Size, Uploaded by/when, Indexed version/when, Pages, Chunks, Space.
- Chunks: "N chunks · M pages · text read from the PDF"; rows: ordinal (mono), "Page 2 · 96 words", three
  lines of text; empty state "The text is still being read." / "Not indexed yet" (existing copy).
- Versions: rows with "Showing", status, author, size, time; selecting opens that version (`?v=`); the
  existing download/restore rules.

The rail's Chunks/Versions data is the existing chunk and version API. Below 1200 the rail becomes a sheet
opened from an "Info" control in the top bar.

### 3. Home

- Top bar "Home". Greeting "Welcome back, {first name}" 27/600, the date below in 11.5.
- Right: "Upload files" (ink button) + "or drop files into Inbox". Dropping anywhere on Home uploads to the
  Inbox as today.
- Search field 820×46: magnifier, "Search pages and files", `Enter`. Submitting navigates to Search with
  the query in `q`.
- **Continue**: three cards (emoji/type tile, title, space · edited/uploaded 2h ago). Ordering and the time
  come from a new **recent for me** read endpoint: pages the caller changed (block activity) and files the
  caller uploaded, deduped, newest first. The section is omitted when empty.
- **Updates** (the main block): day groups Today / Yesterday / earlier date; rows: avatar initial,
  "**Rae** proposed a change to **Agent API** · Product", right time; six rows then "Show more". Existing
  updates data; grouping is client-side.
- No spaces list, no "All activity" link, no duplicate feed in the sidebar.

### 4. Search

- Top bar "Search". Field 820×46 with the magnifier, the query, and the **scope chip** ("All spaces" +
  chevron) inside it; Enter submits; the query and space live in the URL (`q`, `space`) so a search is
  linkable.
- Meta row: "N passages · M pages" left; **Get an answer** (sparkle, accent-soft) right.
- Results are rows (no cards): 20px emoji/type icon, title 13/600 + space 10.5, excerpt 12.5 two lines,
  location "The first sentence · v1" (files: "Page 2 · v1"). No highlight — search is semantic and the API
  returns no offsets. Six rows, then "Show more".
- Rows open the document at the passage (existing block/page links).
- A new query **or a change of space scope** clears the answer and the previous results; an answer is never
  shown above results it was not computed for.
- **Answer** (opt-in): a soft violet panel above the results: "Answer · from N passages", the text with
  numbered citation links, a Sources list with the cited titles and one-line quotes. It stays while results
  remain below. If `foundRelevant` is false: "No answer was found in the pages you can read." and results
  stand. A new query clears it. No streaming, no separate route.

### 5. Reviews

- Top bar "Reviews"; header "Reviews" + "N waiting" + scope chip.
- **Two panes (>=1200):** queue 280 left (selected row warm, title, space, version, age; "Nothing else
  waiting" when one); detail right.
- The detail fetches the selected version's diff lazily (one request per selected item). Header: title,
  space, "Version 1 · proposed by {name} · 4h ago · 1 added · 1 changed · 1 removed"; toggle **Full
  document / Changes only**. The name is the version creator's display name, resolved server-side with the
  existing fallbacks ("System" for a connector, "Former member" for someone who left).
- **Full document** renders every block in order with its change tone: unchanged normal; changed shows the
  old line struck through and the new line below, violet left rule; added green; removed red, in its
  position. Headings, lists, quotes and code keep their type; tables that cannot be rendered structurally
  show as their plain text blocks. The review renders **plain text inside typed blocks**: inline bold,
  links, list nesting and table cells are not preserved (documented limit, not an accident). "Changes only"
  shows the changed blocks alone.
- Sticky action bar at the foot: the blocked line ("You proposed this change — approve needs someone who
  didn't write it.") when it applies, Approve (primary, ink) and Reject…. Approve disabled when blocked;
  Reject always opens the required-note form (existing) above the bar. After approve/reject the item leaves,
  the next is selected, and an inline `role="status"` line says what happened.
- File reviews: the detail shows the file preview (no line diff for files), the same actions and rules; the
  Full/Changes toggle is hidden.
- Empty: "Nothing is waiting for your review." with a quiet check.

### 6. Settings

- Top bar "Settings". Title 24 + one line ("Members, spaces and sources for Acme."); underline tabs:
  Members, Groups, Spaces, Sources. Routes stay `/admin/...`; the tab labels match.
- **Members:** "N people in this workspace" + "Invite someone" (opens the invite row). Invite row: email,
  role chip menu (admin/member/viewer), **Create link**, hint "Creates a one-time link for that email. It
  expires in 7 days — you send it yourself." After creation, a result panel with the link + Copy (shown
  once; existing behaviour). Rows: initials, name (+ "you"), email, role chip menu (locked for self/owner
  per existing rules), `···` (Remove… with an inline confirm). The owner shows a lock + "Owner", not a
  disabled select.
- **Spaces:** "N spaces" + New space. Rows: space glyph, name, /slug, "Personal" (Inbox) or "Review
  required" chip; selecting opens the docked pane (Name, URL slug, Changes need review, Reviewers may
  approve their own changes, Manage access, Archive space, Save changes). New space opens the same pane in
  create mode. The Inbox follows its existing restrictions.
- **Sources:** rows (status, name, target space, files count, last sync, trusted); Add source; the same
  docked pane (name, target space, trusted switch with the existing explanation, pause/resume, tokens list,
  new token with expiry, secret shown once; the existing copy).
- **Groups:** the existing list, restyled to the row language.
- Below 1200 the pane is a full-screen sheet on tap.

### 7. Night

Warm charcoal, three planes (sidebar `#141210`, paper `#1a1713`, surface `#221e19`), ink `#ece6dd`, violet
`#a08cff`, rebuilt status tints (table above). The theme control lives in the account menu: System follows
`prefers-color-scheme`; Light/Dark set `data-theme="dark"` on `<html>` and persist (existing storage). BlockNote's CSS
variables, the History drawer, popovers, the diff tones, the file mat and the editors' chrome are all
themed; PDF pages, images and extracted content are not tinted. Dark uses borders over shadows; popovers
keep a soft shadow.

### 8. Phone (<768) and tablet (768–1023)

- **Shell:** top bar 48 sticky: hamburger, the current space (or section), live dot, `···`. The sidebar
  becomes a 330px **drawer** (the same content, 44px touch rows, workspace menu, tree, account row) over a
  scrim; Escape/back closes, focus is trapped, body scroll locks. Below 1024 the desktop sidebar is hidden
  entirely; the drawer is the only nav.
- **Page:** 26/600 title, 30 emoji, chip; no index buttons (the chip's sheet holds the actions); no editor
  gutter; text aligns with the title; the page menu in `···`.
- **Home:** greeting, search, Continue cards stacked, Updates full width; upload button and hint.
- **Search:** field full width, scope chip beneath it, rows, "Get an answer" a full-width button, answer
  panel above.
- **File:** header; preview full width; "Info" opens the rail as a sheet with the three tabs; toolbar
  floats at the bottom; actions in `···`.
- **Reviews:** the queue as a list; a tap opens the detail full-screen (`?review=`), with a back control;
  the toggle and the sticky footer stay.
- **Settings:** tabs scroll horizontally; rows; the docked pane is a full-screen sheet.
- Safe areas: sticky bars and sheets respect `env(safe-area-inset-bottom)`.
- Touch: every action visible without hover; 44px minimum.

## Data and API deltas

| # | Delta | Why | Where |
|---|---|---|---|
| 1 | `documents.icon` (text, nullable) + `icon` in page/tree/search/review/recent payloads; `PATCH /api/v1/pages/:id` accepts `title` and/or `icon` (null clears); one audit event | Emoji identity (decision 2) | migration, contracts, API, tree/search/review queries |
| 2 | Presence: read the Hocuspocus awareness in the page shell (`name`, colour, clientId) | Avatars are real people, not a socket label | web only (provider already exists) |
| 3 | `GET /api/v1/recent?limit=3`: the caller's recent pages (block activity) and uploaded files, deduped | Home's Continue | new read route; an index on block activity by actor may be needed |
| 4 | `SearchPassage.spaceId`; `AskCitation.documentTitle` + `spaceId` | Show the space on a result row and the cited title/space in the answer's sources (no parsing `citeAs`) | contracts + search/ask queries |
| 5 | `q` and `space` search params on the Search route | Shareable, reloadable search; Home's field | web router |
| 6 | `BlockDiffEntry.type` (+ the minimal props for headings/lists/code) on **every** entry, including unchanged and removed | Full-document review with formatting from one request per selected item | contracts + diff query + read-only renderer |
| 7 | `ReviewItem.version.createdByName` (the creator's display name, with the existing System/Former member fallbacks) | "proposed by {name}" in the queue and detail | contracts + reviews query |
| 8 | File type tiles and PDF fit-to-width | Identity and a preview that fits | web only (derived; pdf.js scale) |

`documents.icon` validation: null or a single untrimmed-emoji grapheme, max 16 UTF-16 units; the picker only
sends values from its curated grid; unknown values render as no icon. The migration is additive, no RLS
change. The tree updates optimistically; a failed save reverts.

## Semantics, copy, accessibility

- Status chips: text + dot, never colour only; the popover is a labelled menu; the primary action's
  disabled reason is text next to it.
- Underline tabs are a tablist with `aria-selected`; the file rail is a tablist; the drawer is a modal
  dialog (`aria-modal`, labelled by the workspace name) with focus trap and restore.
- The diff labels "Changed / Added / Removed" carry meaning; the tones reinforce.
- The emoji icon is decorative next to the title (`aria-hidden`); the picker button is labelled "Change page
  icon".
- The live connection state stays a `role="status"` live region; "Offline" and Reconnect are visible.
- Keyboard: all menus/rows reachable; Escape closes; arrow navigation in the workspace/account menus where
  the existing component supports it.
- Contrast: body ≥ 4.5:1, large text ≥ 3:1 in both themes; the test is a token check, not a screenshot.
- Keep existing labels the e2e suite relies on where the element survives ("Preview", "Versions",
  "Download", `role="note"`, `Expand/Collapse <space>`); update tests where the element moves (see Testing).

## Testing

- **Unit:** emoji validation and clearing; type-tile derivation; PDF fit scale; day grouping for Updates;
  diff tone mapping; the review blocked-reason copy; recent dedupe order.
- **API:** icon PATCH (set/clear/invalid/permission), the recent route (auth, limit, dedupe), `spaceId` in
  search passages, block types in diffs, and the existing page/file tests.
- **E2E (Playwright, local stack):** update the shell-dependent specs (breadcrumbs in the top bar, no
  sidebar Updates/On this page, page actions via the chip, admin tabs renamed Settings, file Replace in the
  menu, review diff inline, Versions tab in the file rail). Add: icon → tree; Home Continue/Updates; search
  `q` + scope; review full document/Changes only + approve/reject; settings invite link + space pane; dark
  toggle; the 390px viewport with the drawer and the phone page.
- **Accessibility:** keyboard/focus checks for the drawer, tablists, popovers and the invite/role menus;
  contrast of the new tokens.

## Delivery order

0. Commit the previous round. Tokens + shell (sidebar, top bar, account menu, theme control, collapse);
   update the shell e2e baseline. The feed and the OnThis page panel stay until Home and the page phases
   replace them, so every phase ships working software. This lands the frame every later phase lives in.
1. Page: icon migration/API/picker; header; status chip and popover; HistoryDrawer Changes tab; presence;
   type and table styles.
2. File: rail, type tiles, fit, menu changes, markdown/sheet treatments.
3. Home: recent endpoint; search field; Continue; Updates; remove the duplicated blocks.
4. Search: `q`/space params; `spaceId` on passages; rows; answer panel.
5. Reviews: two-pane; rich diff; lazy loading; actions and states.
6. Settings: tabs; members/invite; spaces pane; sources; groups restyle.
7. Night: tokens; BlockNote mapping; previews; theme toggle.
8. Phone: drawer; per-screen layouts; editor gutter; safe areas.
9. Tests and cleanup: the e2e suite, accessibility pass, delete the old sidebar components, final run of
   `pnpm typecheck`, `pnpm test`, `pnpm e2e:local`, `pnpm web:build`.

Each phase is shippable on its own; no feature flags are planned. The mockups for the eight screens live in
`.superpowers/brainstorm/87068-1792731483/content/` (untracked, reference only).

## Calls made by the author (check these)

1. **Warm charcoal dark**, not graphite/true black; the palette in the table is the one shown.
2. The sidebar **collapse control is kept** (it appears in the approved shell mockup).
3. The page icon is **emoji only, per page, on `documents`**; no covers, no custom images, a curated 48-emoji
   grid; files use derived type tiles.
4. The page's **Changes** opens the HistoryDrawer's new Changes tab; the inline page highlights stay.
5. The visible page primary action is **hidden when clean**; the chip menu always offers Index now.
6. The file rail defaults to **Details** (the mockup showed Chunks to demonstrate); Chunks is one click.
7. The search answer is **inline, non-streaming**, and clears on a new query or scope change; results always remain.
8. The review full document renders **headings/lists/quotes/code**; **tables fall back to plain text**
   blocks because the diff is block-level.
9. Breakpoints: **1024** drawer, **1200** rails/panes → sheets, **768** phone.
10. The phone drawer is **330**; settings/file/review panes are full-screen sheets under 768.
11. The account menu is **theme + sign out** only; no personal settings page.
12. The Settings tabs keep the existing routes; **Groups is restyled only**.
13. The invite link is **shown once**; no pending-invite list or revoke UI (no API exists).
14. Continue is **per-user** (block activity + uploads), not workspace-wide "recently updated".
15. The top bar is **sticky**; the current breadcrumb moves out of the document column.
16. Reading measure **660**; file/review docs 620; list columns 820.
17. All existing server badge states are kept (withdrawn, indexing, rejected, stored, removed at source…);
    the four named states are the common presentations, not a reduced state machine.
18. The page's "Review" is a navigation link to the queue; approval and the blocked reason live only in
    Reviews.
19. The review diff carries block types/props on every entry; inline marks, links, list nesting and table
    cells are not preserved in the review.
20. The answer clears on a query **or** scope change.
21. The sidebar tree keeps its attention dots next to the emoji/type icons.
22. Ask citations carry title + space; review items carry the proposer's name — both additive fields, no
    parsing of `citeAs`.

## Left to the builder

- The exact 48 emoji and their order; the six avatar tints.
- The popover/sheet/drawer positioning and focus mechanics; the transition curves (the tokens give the
  duration).
- The token wiring (CSS variables + Tailwind theme) and the mapping of existing utility names.
- The recent-query SQL and whether the block-activity index is needed.
- The exact block types (beyond the minimum: paragraph, heading, list item, quote, code) and the table
  fallback details.
- The PDF fit scale steps and the empty/loading/error copy for every screen.
- Breakpoint fine-tuning and the editor gutter mechanism (BlockNote side menu).
- The e2e updates file by file; the a11y test harness.
- Empty states: no pages, no files, no updates, no search results, no answer, no reviews, no sources, no
  chunks, no versions.

## Risks

- **Scale.** Eight phases on an uncommitted base; the shell phase must land before anything else or the
  screens will be rebuilt twice.
- **Presence.** Hocuspocus awareness is already used by BlockNote, but the provider's awareness may not be
  populated with names/colours; if not, a small collab change is needed.
- **Rich diff.** The diff API returns text only; the full-document review needs block types/props. Until
  that lands, the review falls back to paragraphs.
- **The recent query.** Block activity is indexed by page/block, not actor; a large workspace may need an
  index. The fallback is workspace-wide recent documents (a different promise).
- **Mobile editor.** Removing the 54px gutter changes BlockNote's side-menu behaviour; test the slash menu
  and the tap targets on a real phone.
- **Contrast.** The warm dark and the soft status tints need measured contrast, not eyeballing.
- **Tests.** The e2e suite encodes the old shell; several specs must change. Do it in the same phase as the
  change, not at the end.
