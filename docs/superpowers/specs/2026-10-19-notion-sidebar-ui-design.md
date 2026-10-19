# Notion-style console with one integrated sidebar — design

Date: 2026-10-19. Builds on the Slice 0/1 console in `apps/web` (branch `remediation/slice-0-1`). Spec context: `docs/2026-10-18-living-wiki-standalone-design.md`.

## Intent

The console works but looks like an admin tool: a top bar, a space dropdown, and a separate screen per space. The person who asked wants it to *feel* like Notion or Obsidian: one place on the left where the workspace, its spaces and every page live together, and a quiet, wide page to read and write in. The sidebar is also where a person sees **what changed** without opening anything.

The three things they said they want, in their words or from what they picked:

- A sidebar that is "all integrated": workspace, then spaces, then each page or document in one tree.
- Notion's look (light, soft, warm grey sidebar, large title, quiet page), **in both light and dark mode**.
- The sidebar shows changes effectively. They picked all three of the ways shown in the mockup: a workspace-wide **Updates** feed, **status dots** on pages in the tree, and an **On this page** changes section (with Index now and History).

Mockups they reacted to are in `.superpowers/brainstorm/` (git-ignored); the shape is described below so this document stands alone.

## Goals

1. One persistent left sidebar for every signed-in screen under `/w/$tenantSlug`; the top bar is removed.
2. Sidebar contents, top to bottom:
   - Workspace header (avatar letter + name, a menu to switch workspace and to sign out), then **Search** and **Reviews** (with the waiting count) rows, and **Settings & members** for people who may administer.
   - **Updates**: the most recent changes anywhere in the workspace the person can read (newest first, about 8 shown, "show more" up to 30).
   - **Spaces**: each space is a collapsible node; its pages nest beneath it as an expandable tree (pages can have child pages). The current page is highlighted and its ancestors are expanded. A "+" on hover adds a page in that space or under that page. Archived spaces are not listed. The Inbox space is shown like any other space.
   - **On this page** (only when a page is open): who changed what since the indexed version, coloured per author and matching a coloured left border on the changed blocks in the page; the status badge; **Index now** / **Submit for review**; a **History** entry that opens the existing history drawer.
   - Account row at the bottom: the person's name, the theme toggle, sign out.
3. **Status dots** on page rows in the tree, computed by the server (the browser still computes no status): red = indexing failed, amber = waiting for review, purple = edited live in the last minute. If more than one applies, red wins over amber over purple. No dot = nothing to flag.
4. A designed **light and dark theme** with one set of design tokens (CSS variables). It follows the system setting by default, with a manual toggle (light / dark / system) remembered per browser. Both themes meet WCAG AA contrast for text and for the dots/borders that carry meaning.
5. The page screen takes the Notion look: breadcrumb at the top with the badge at the right, large title, wide readable column (about 720px), generous spacing, the BlockNote editor restyled to match (including its "/" menu and side handle). The Changes panel, lifecycle menu (move / withdraw / archive) and history drawer are re-skinned and re-homed (changes in the sidebar, lifecycle in a "…" menu in the page header), not rewritten.
6. Every other screen — sign in, sign up, accept invite, create workspace, space page, reviews, search and Ask, admin members / groups / spaces — gets the same tokens and components so nothing looks left behind.
7. The sidebar works on a phone-width screen: below 768px it becomes a slide-over opened from a menu button, closes on navigation and on Escape, and traps focus while open. The sidebar can also be collapsed on desktop (button and keyboard shortcut `Ctrl/⌘+\`), remembered per browser.

## Non-goals (this round)

- Drag-and-drop to reorder or reparent pages (the move menu stays).
- Page icons, covers, emoji pickers, favourites, templates, a command palette, or `[[` links / backlinks.
- Real presence (cursors, "who is here now"). The purple dot means "edited live in the last minute", not "someone is connected".
- Changing permissions, roles, review rules, the badge wording, collaboration, indexing or search behaviour.
- New admin features (group member listing, audit events, restore-space) that were deferred earlier.
- Re-theming the Playwright suite beyond what the new markup requires.

## Anti-goals (failure even if it technically works)

- The browser computing any status or permission. Dots and the badge come from the server; role-dependent controls keep using server-provided roles.
- **Leaking what a person may not read.** The Updates feed and the dots must follow the same visibility as search and the review queue: only spaces the person can read, Inbox pages only for their creator or a tenant admin, archived spaces only for admins and never in the sidebar, another tenant's data never. A hidden page must be indistinguishable from a missing one.
- A raw error code or `Error.message` shown anywhere (every error still goes through `errorSentence`).
- Losing accessibility already built: focus rings, labelled controls, dialog focus handling in the history drawer, Escape behaviour. Colour must never be the only signal (dots get an accessible name; changes keep the author's name).
- A flash of the wrong theme on load, or a layout that jumps while the tree loads.
- Slowing the app noticeably: the sidebar must not fetch every space's whole tree up front.

## Constraints

- Stack stays as built: React 19, TanStack Router and Query, Tailwind 4 (tokens as CSS variables mapped into Tailwind), BlockNote 0.49, `@hocuspocus/provider` 4. No UI component library. Icons are a small inline SVG set (no emoji — they render differently per platform) or one small icon package if the builder prefers; fonts are the system stack (no network font load).
- Backend work is limited to three small additions, contracts first, reply bodies camelCase, every query tenant-filtered and inside `withTenantTx`, reusing the existing permission gate and visibility helpers rather than re-deriving rules:
  1. `GET /api/v1/spaces/:id/tree` gains a per-page `attention` field: `'failed' | 'review' | 'editing' | null`, derived server-side from the page's latest version status and live-edit time (a named constant, 60 seconds). Files (non-page nodes) get `null`.
  3. `GET /api/v1/pages/:id/changes` entries gain the author's display `name` (users who are members of the tenant; agents by their agent name; someone who has since left the workspace shows as "Former member"), so the changes section needs no members lookup and works for every role.
  2. New `GET /api/v1/updates?limit=` (default 8, max 30): recent versions across the person's readable spaces, newest first: version id and number, document id and title, space id and name, status, reason, the actor `{type, id, name}` and the time. Agents are marked. Only versions of **pages** in non-archived documents count (not files, not archived pages); statuses shown are `pending_review` ("proposed"), `indexed` ("published"), `rejected`, `withdrawn` and `failed`; `superseded`, `extracting`, `stored` and `indexing` rows are left out. The actor is the version's creator (`createdBy`), a connector or source version shows as "System"; each row links to its page.
- Author **names** are shown to every member of the workspace (Updates feed and the changes section), not only admins. A workspace is a team; this removes the earlier "Collaborator 1a2b" fallback. Names come only from users who are members of the same tenant.
- The existing tests stay green; Playwright specs are updated only where markup changed and keep every assertion's meaning. New behaviour gets tests: contract and route tests (including cross-tenant, Inbox, archived and viewer cases) for the two endpoints, pure-helper unit tests for the tree/dot/theme/updates-wording logic, and Playwright coverage for the sidebar (expand a space and open a page from it, dots appear for a pending review, Updates shows an edit, theme toggle persists, mobile slide-over).
- Work continues on the branch `remediation/slice-0-1`; merging that branch is a separate decision still open with the person.

## Rules settled after the builder check (author's calls)

- **`attention` must agree with the badge.** It is computed in the same file as `computePageBadge` from the same inputs by a pure function that is tested against every badge outcome: `failed` exactly when the badge is "Index failed" (latest version failed, nothing newer); `review` when the badge says the page is awaiting approval; `editing` when `liveChangedSinceSnapshot` is true **and** `liveUpdatedAt` is within 60 seconds (opening a page does not set either). Priority red > amber > purple.
- **Freshness.** Dots and Updates refetch on window focus, on navigation, and when a space is expanded; Updates and the *open* space's tree also poll every 30 seconds while the tab is visible. Other expanded spaces stay as loaded until focus or expansion. The browser never decides a dot has expired; it asks again. The global "no refetch on window focus" default is overridden for these queries only.
- Names for the "On this page" section come from the changes endpoint (addition 3), not the members list.

## Decisions made by the person

- Notion-like look; light and dark.
- One integrated sidebar: workspace → spaces → pages.
- All three change views: Updates feed, status dots, On this page section.

## Calls made by the author (to be checked)

- Dot colours and meanings (red / amber / purple) and priority; "editing" = live edit in the last 60 seconds.
- Updates feed is built from **versions** (snapshots, approvals, rejections, withdrawals, restores), so a live edit appears in Updates once it is snapshotted; before that the purple dot covers it.
- Showing member names to all members (see Constraints).
- Theme control lives in the account row; default is the system setting.
- Collapse shortcut `Ctrl/⌘+\`; mobile breakpoint 768px; page column about 720px.
- Inline SVG icons; system fonts.
- Lifecycle actions move to a "…" menu in the page header; the history drawer opens from the sidebar's History entry and from the header.
- Sidebar lists only the spaces' pages that the tree route already returns (kind `page` and `file`); a space's tree loads when it is first expanded (and the current page's space is expanded on load), then stays cached and is refreshed after page create/move/archive/withdraw.

## Left to the builder

Visual details (exact token values, spacing scale, radii, hover/active states, icon drawings, transitions that respect reduced-motion), the file/component split, how the tree fetches and caches per space, the exact wording of Updates rows, empty and loading states, and the e2e selectors.
