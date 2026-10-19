# Notion-style Sidebar Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console's top bar and per-screen navigation with one Notion-like sidebar (workspace → spaces → nested pages, Updates feed, status dots, "On this page" changes), in a designed light and dark theme.

**Architecture:** Three small, contracts-first backend additions (tree `attention`, a changes `name`, an `/updates` feed) feed a re-built web shell. Design tokens are CSS variables mapped into Tailwind 4; a pure `theme.ts` and pure sidebar helpers carry the testable logic; screens are re-skinned onto the tokens. The browser still computes no status.

**Tech Stack:** Fastify 5 + Drizzle + Zod (api), React 19, TanStack Router/Query, Tailwind 4, BlockNote 0.49, Vitest, Playwright (`pnpm e2e:local`).

**Spec:** `docs/2026-10-18-living-wiki-standalone-design.md` (product) and `docs/superpowers/specs/2026-10-19-notion-sidebar-ui-design.md` (this work — read it first; it holds every decision, call and non-goal).

## Global Constraints

- Work on branch `remediation/slice-0-1`; base the first task on its current HEAD. Do not merge or push.
- Tenant isolation: every query filters `tenant_id` and runs in `withTenantTx`; another tenant's data and spaces/pages the actor cannot read never appear and answer as if missing; Inbox pages only for their creator or a tenant admin; archived spaces and archived pages are not listed for anyone in the sidebar; reuse the existing gate (`requireSpaceRole`, `listSpacesForActor` rules, reviews/search visibility), never re-derive roles.
- Contracts first (Zod schema before handler); every reply goes through `parseReply`; reply bodies camelCase, request/query keys snake_case.
- The browser computes no status or permission: dots, badge and names come from the server. Every error shown goes through `errorSentence`; no raw codes or `Error.message`.
- Both themes meet WCAG AA contrast for text, and for dots/borders that carry meaning; colour is never the only signal (dots have an accessible name, changes show the author's name).
- Fonts: system stack (no network fonts). Icons: inline SVG (no emoji). No UI component library added.
- Keep accessibility already built (focus ring, labelled controls, history-drawer focus handling and Escape behaviour).
- All existing tests stay green (`pnpm vitest run`, `pnpm typecheck`, `pnpm --filter @living-wiki/web build`, `pnpm e2e:local`); update an e2e selector only where markup changed and keep each assertion's meaning.
- Dot rule: red = latest version failed; amber = badge says awaiting approval; purple = `liveChangedSinceSnapshot` and `liveUpdatedAt` within 60 s; priority red > amber > purple. Live window constant `LIVE_EDIT_WINDOW_SECONDS = 60`.
- Theme: `light | dark | system`, default `system`, remembered per browser in a try/catch-wrapped `localStorage` key; no flash of the wrong theme.
- Sidebar: desktop collapse via button and `Ctrl/⌘+\` (remembered); below 768px a slide-over (focus trap, Escape, closes on navigation); page column ≈ 720 px.
- Freshness: dots/Updates refetch on window focus, navigation and space expansion; Updates and the *open* space's tree poll every 30 s while the tab is visible; no polling of other expanded spaces. The global `refetchOnWindowFocus: false` default is overridden only for these queries.

## Review Focus

- An Updates row or dot that reveals a page the person cannot read (Inbox page of someone else, archived space/page, other tenant, viewer-capped role) — must be absent, never a placeholder.
- Dots contradicting the badge for the same page (e.g. amber while the badge says Indexed, red after a newer withdrawn/rejected version).
- Wrong or missing author names: a user who left the workspace, an agent, a connector/system version — must render "Former member", the agent's name, "System", never an id fragment or blank.
- A flash of the wrong theme on first paint, a theme toggle that is not remembered, or unreadable text/dots in one theme (editor, diff view, badges, review screens).
- A sidebar that fetches every space's tree up front, loses its expanded state on navigation, or hides the current page (page in a collapsed/unloaded space).

---

### Task 1: `attention` on tree nodes

**Files:**
- Modify: `apps/api/src/pages/badge.ts` (add predicates + `pageAttention`), the `getSpaceTree` implementation (find it with `grep -rn "getSpaceTree" apps/api/src`), `packages/contracts/src/index.ts`
- Test: `apps/api/test/attention.test.ts`, extend the existing tree test file

**Interfaces:**
- Produces: `export const AttentionSchema = z.enum(['failed','review','editing']).nullable()`; `TreeNodeSchema` gains `attention: AttentionSchema` (files and the `/archived` list use `null`); `export const LIVE_EDIT_WINDOW_SECONDS = 60`; `export function pageAttention(input: BadgeInput & { liveUpdatedAt: Date }, now: Date): 'failed' | 'review' | 'editing' | null` in `badge.ts`.

- [ ] **Step 1: Failing tests.** `attention.test.ts` — a table over every `computePageBadge` outcome (withdrawn, failed, indexing, pending_review with and without live change, rejected, live-changed with/without review, indexed, never indexed): `pageAttention` is `'failed'` iff the badge is `Index failed`; `'review'` iff the badge contains `awaiting approval`; `'editing'` iff `liveChangedSinceSnapshot` and `now - liveUpdatedAt <= 60 s` and neither of the first two applies; `null` otherwise; a page opened but not changed (`liveChangedSinceSnapshot=false`, fresh `liveUpdatedAt`) is `null`; at 61 s it is `null`. Tree route test: a space with a failed page, a pending-review page, a live-edited page and a plain page returns `attention` `failed/review/editing/null`; a file node is `null`; a viewer sees the same values; the response has no other new keys.
- [ ] **Step 2:** Run `pnpm vitest run apps/api/test/attention.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Extract the status predicates from `computePageBadge`'s branches into small exported helpers in `badge.ts` used by both `computePageBadge` and `pageAttention`, so the two cannot drift; extend the tree query to join each page's latest version status, `live_changed_since_snapshot`, `live_updated_at`, `agent_changed_at` and the space's `review_required` and its indexed version (one query for the whole space, no per-page query); contracts first.
- [ ] **Step 4:** Run `pnpm vitest run` and `pnpm typecheck` — Expected: pass (update web code and tests that construct `TreeNode` objects).
- [ ] **Step 5:** Commit `feat(api): attention on tree nodes`.

### Task 2: Author names on page changes

**Files:**
- Modify: `packages/contracts/src/index.ts` (`BlockDiffEntrySchema.author` gains optional `name: string`), `getPageChanges` in `apps/api/src/routes/pages.ts`
- Create: `apps/api/src/people.ts`
- Test: `apps/api/test/changesNames.test.ts`

**Interfaces:**
- Produces: `export async function resolveActorNames(tx: Tx, tenantId: string, actors: Array<{ type: 'user' | 'agent'; id: string }>): Promise<Map<string, string>>` keyed `"<type>:<id>"` — users who are members of `tenantId` → their name; agents of the tenant → agent name; a user no longer a member → `"Former member"`; an unknown agent → `"Agent"`. Only `getPageChanges` fills `name`; `/compare` and `/versions/:id/diff` still send none.

- [ ] **Step 1: Failing tests:** a member's change shows their name for an editor, a viewer and a plain member (not only admins); an agent's change shows the agent's name; a user removed from the tenant shows `Former member`; a user belonging only to another tenant is never named; `/compare` entries carry no `name`.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Implement `resolveActorNames` with one query per actor type (tenant-filtered; membership join for users), and map `name` onto `diffBlocks` entries after the diff.
- [ ] **Step 4:** Run `pnpm vitest run` — Expected: pass.
- [ ] **Step 5:** Commit `feat(api): author names on page changes`.

### Task 3: `GET /api/v1/updates`

**Files:**
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/server.ts`
- Create: `apps/api/src/routes/updates.ts`
- Test: `apps/api/test/updates.test.ts`

**Interfaces:**
- Produces in contracts: `UpdatesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(30).default(8) })`; `UpdateItemSchema = { versionId: uuid, number: int, status: enum('pending_review','indexed','rejected','withdrawn','failed'), reason: string | null, createdAt: datetime, document: { id, title, spaceId, spaceName }, actor: { type: enum('user','agent','system'), id: string | null, name: string } }`; `UpdatesResponseSchema = z.array(UpdateItemSchema)`. In `updates.ts`: `export async function listUpdates(actor: Actor, query: unknown): Promise<UpdateItem[]>`.
- Rules: pages only, document not archived, space not archived, statuses limited to the five above, newest first by `createdAt`, only spaces the actor can read (admins every non-archived space; Inbox pages only for their creator or a tenant admin); actor = version creator (`createdByType user` → member name or `Former member`, `agent` → agent name, connector/other → `{type:'system', id:null, name:'System'}`); the actor's tenant role cap applies exactly as in the review queue. One batched query for rows, one for names (reuse `resolveActorNames`), no N+1.

- [ ] **Step 1: Failing tests:** returns the newest N across two spaces in order; `limit=3` and `limit=31` (400) and `limit=0` (400); a viewer sees only spaces they can read; another member's Inbox page is absent, the creator's present; an archived page and a page in an archived space are absent; another tenant's versions never appear; superseded/indexing versions are absent; an agent version has `actor.type: 'agent'` with the agent's name; a removed user shows `Former member`; the reply has no markdown/blocks/ydoc and the exact key set of `UpdateItemSchema`.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Implement and register the route (default tenant auth); add a typed `api.updates(limit)` wrapper in `apps/web/src/lib/api.ts`.
- [ ] **Step 4:** Run `pnpm vitest run` and `pnpm typecheck` — Expected: pass.
- [ ] **Step 5:** Commit `feat(api): workspace updates feed`.

### Task 4: Design tokens and theme

**Files:**
- Modify: `apps/web/src/index.css`, `apps/web/index.html`, `apps/web/src/components/ui.tsx`, `apps/web/src/main.tsx`
- Create: `apps/web/src/lib/theme.ts`
- Test: `apps/web/test/theme.test.ts`

**Interfaces:**
- Produces: `export type ThemeChoice = 'light' | 'dark' | 'system'`; `loadTheme(storage?: Pick<Storage,'getItem'>): ThemeChoice` (default `'system'`; garbage or throwing storage → `'system'`); `saveTheme(choice: ThemeChoice, storage?: Pick<Storage,'setItem'>): void` (never throws); `resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark'`; `applyTheme(choice: ThemeChoice, root?: HTMLElement): void` sets `data-theme` on `<html>`. Tokens (CSS variables on `:root` and `[data-theme=dark]`, also following `prefers-color-scheme` when no explicit choice) for: background, sidebar, surface, border, text, muted text, hover, active, accent, danger, success, warning, the three dot colours, the author colour set (light/dark variants), selection and focus ring — mapped into Tailwind 4 `@theme` names (e.g. `bg-surface`, `text-muted`).
- Values to use as the starting palette (adjust only to meet AA): light — page `#ffffff`, sidebar `#f7f7f5`, border `#e9e9e7`, text `#37352f`, muted `#6b6a67`, hover `#efefed`, active `#e8e8e5`, accent `#2383e2`; dark — page `#191919`, sidebar `#202020`, border `#2f2f2f`, text `#e6e6e4`, muted `#9b9a97`, hover `#2a2a2a`, active `#343434`, accent `#529cca`.

- [ ] **Step 1: Failing tests** (`theme.test.ts`): `loadTheme` returns each stored value, `'system'` for missing/garbage and when storage throws; `saveTheme` swallows a throwing storage; `resolveTheme('system', true)` is `'dark'`, `('light', true)` is `'light'`; a contrast helper `contrastRatio(hexA, hexB)` exported from `theme.ts` is used to assert, for both palettes, text/page, muted/page, text/sidebar, muted/sidebar ≥ 4.5 and each dot colour vs page and vs sidebar ≥ 3.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Write `theme.ts`, the token CSS, an inline script in `index.html` `<head>` that sets `data-theme` from storage before first paint (same try/catch rules, no framework), re-skin `ui.tsx` primitives (Button, fields, Card, Loading, ErrorNote, AuthShell) onto tokens, and call `applyTheme` at startup plus react to the OS setting when the choice is `system`.
- [ ] **Step 4:** Run `pnpm vitest run`, `pnpm --filter @living-wiki/web build` — Expected: pass.
- [ ] **Step 5:** Commit `feat(web): design tokens, light and dark theme`.

### Task 5: Sidebar shell

**Files:**
- Modify: `apps/web/src/routes/layout.tsx`, `apps/web/src/router.tsx` (only if the shell needs it)
- Create: `apps/web/src/components/sidebar/{Sidebar,WorkspaceMenu,NavRow,AccountRow}.tsx`, `apps/web/src/components/icons.tsx`, `apps/web/src/lib/sidebar.ts`
- Test: `apps/web/test/sidebar.test.ts`

**Interfaces:**
- Produces in `sidebar.ts`: `loadCollapsed(storage?): boolean`, `saveCollapsed(v: boolean, storage?): void`, `loadExpanded(tenantId: string, storage?): Set<string>`, `saveExpanded(tenantId: string, ids: Set<string>, storage?): void` (all try/catch, malformed → empty), `isCollapseShortcut(e: Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'>): boolean` (`Ctrl/⌘+\`).

- [ ] **Step 1: Failing tests:** the four storage helpers round-trip, survive throwing/malformed storage and are per tenant; `isCollapseShortcut` true for ctrl+`\` and meta+`\`, false for plain `\` and other keys.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Build the shell: remove the top bar; left sidebar (≈ 260 px) with workspace header + menu (switch workspace, sign out), Search and Reviews rows (count badge from the same `useReviews` query), Settings & members (shown by `adminScreens(role)`), placeholders for the Spaces/Updates/On-this-page regions (filled by Tasks 6–8), account row (name, theme toggle with light/dark/system, sign out). Desktop collapse button + shortcut; below 768 px a slide-over with focus trap, Escape and close-on-navigation; a menu button in the main area when collapsed. Main area is the page `Outlet`. Icons in `icons.tsx` as small inline SVG components.
- [ ] **Step 4:** Run `pnpm vitest run`, `pnpm typecheck`, `pnpm --filter @living-wiki/web build` — Expected: pass; open the app on the e2e harness and check both themes at 1280 px and 390 px (report what you saw).
- [ ] **Step 5:** Commit `feat(web): sidebar shell`.

### Task 6: Spaces tree with status dots

**Files:**
- Create: `apps/web/src/components/sidebar/{SpaceNode,PageNode,NewPageButton,AttentionDot}.tsx`
- Modify: `apps/web/src/lib/queries.ts`, `apps/web/src/lib/wiki.ts`, `apps/web/src/components/sidebar/Sidebar.tsx`
- Test: `apps/web/test/sidebarTree.test.ts`

**Interfaces:**
- Produces in `wiki.ts`: `attentionLabel(a: 'failed' | 'review' | 'editing'): string` (`'Indexing failed'`, `'Waiting for review'`, `'Edited just now'`); `ancestorIds(nodes: readonly TreeNode[], id: string): string[]` (parents from the root down); `expandedFor(nodes, currentPageId, saved: Set<string>): Set<string>` (saved plus the current page's ancestors). `useSpaceTree(spaceId, { enabled, poll })` extended so the open space polls every 30 s while visible and every expanded space refetches on focus/mount; `useSpaces` lists only non-archived spaces.

- [ ] **Step 1: Failing tests:** `ancestorIds`/`expandedFor` on a three-level tree (current page in a collapsed branch is revealed; a root page returns `[]`; an unknown id returns `[]`); `attentionLabel` strings; `buildTree` keeps `attention` on items.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Render **Spaces**: one collapsible node per open space (name, chevron); its tree fetches only when first expanded, plus the current page's space on load (fetch the page first to learn its space); child pages nest and expand; the current page is highlighted (`aria-current="page"`) and its ancestors auto-expand; each page row shows an `AttentionDot` with an accessible name from `attentionLabel` (none when `null`); a "+" on hover/focus (keyboard reachable) on a space or page creates a page via the existing `createPage` call with an inline title field (slug via `slugify`), then navigates to it and refreshes that space's tree; expanded ids persist per tenant via `saveExpanded`; empty and loading rows in the Notion style. Files (`kind: 'file'`) render as non-link rows.
- [ ] **Step 4:** Run `pnpm vitest run`, typecheck, build — Expected: pass.
- [ ] **Step 5:** Commit `feat(web): spaces tree with status dots in the sidebar`.

### Task 7: Updates section

**Files:**
- Create: `apps/web/src/components/sidebar/UpdatesSection.tsx`, `apps/web/src/lib/updates.ts`
- Modify: `apps/web/src/lib/queries.ts`, `apps/web/src/components/sidebar/Sidebar.tsx`
- Test: `apps/web/test/updates.test.ts`

**Interfaces:**
- Produces: `updateSentence(item: UpdateItem, selfId: string | null): { who: string; what: string }` — who is `You` for the viewer's own versions else `actor.name`; what by status: `pending_review` → `proposed a change to {title}`, `indexed` → `published v{n} of {title}`, `rejected` → `had v{n} of {title} rejected`, `withdrawn` → `withdrew {title}`, `failed` → `{title} failed to index`; `relativeTime(iso: string, now: Date): string` (`just now`, `4m`, `3h`, `2d`, then a short date); `useUpdates(limit: number)` (30 s poll while visible, refetch on focus).

- [ ] **Step 1: Failing tests:** `updateSentence` for every status, self vs other, agent and system actors; `relativeTime` boundaries (59 s, 60 s, 59 m, 24 h, 8 d).
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Render **Updates** under the nav rows: 8 rows with a "Show more" up to 30; each row links to its page; agent actors carry a small "Agent" tag (text, not colour only); empty state "Nothing yet"; the section is collapsible and its state remembered.
- [ ] **Step 4:** Run `pnpm vitest run`, typecheck, build — Expected: pass.
- [ ] **Step 5:** Commit `feat(web): updates feed in the sidebar`.

### Task 8: Page screen and the "On this page" section

**Files:**
- Modify: `apps/web/src/routes/page.tsx`, `apps/web/src/components/{Editor,Badge,ChangesPanel,LifecycleMenu,HistoryDrawer}.tsx`, `apps/web/src/lib/wiki.ts`, `apps/web/src/components/sidebar/Sidebar.tsx`
- Create: `apps/web/src/components/sidebar/OnThisPage.tsx`
- Test: extend `apps/web/test/wiki.test.ts`

**Interfaces:**
- Produces in `wiki.ts`: `blockHighlightCss(entries: Array<{ blockId: string; author?: { id: string } }>): string` — CSS text that gives each changed block `[data-id="<id>"]` a 3 px left border and tint in its author's colour (ids escaped; empty input → `''`); `authorLabel` uses the new `author.name` when present (fallbacks unchanged for old payloads).

- [ ] **Step 1: Failing tests:** `blockHighlightCss` for two authors and one block with a quote in its id (escaped), empty list; `authorLabel` prefers `name`.
- [ ] **Step 2:** Run it — Expected: FAIL.
- [ ] **Step 3:** Page screen: breadcrumb (space / ancestors / title) with the badge at the right and a "…" lifecycle menu (move, withdraw, archive, History) in the header; large editable title; ≈ 720 px column; BlockNote themed from the tokens (light/dark via its `theme` prop and CSS variables) including its "/" menu and side handle; changed blocks highlighted via an injected `<style>` from `blockHighlightCss`. Move the Changes list, **Index now** / **Submit for review**, **Retry**, **Restore indexed version**, status badge and **History** into the sidebar's **On this page** section (shown only on `/p/$pageId`); the section still lists "who changed what" with the author's name from the server; remove the old right/stacked panels. Behaviour and labels are unchanged (same exact strings and rules from `pageControls`).
- [ ] **Step 4:** Run `pnpm vitest run`, typecheck, build — Expected: pass; verify on the e2e harness in both themes that two windows still converge and the read-only viewer cannot edit (report what you saw).
- [ ] **Step 5:** Commit `feat(web): Notion-style page screen and On this page section`.

### Task 9: Re-skin the remaining screens

**Files:**
- Modify: `apps/web/src/routes/{sign-in,sign-up,accept-invite,workspaces,workspace-home,space,reviews,search}.tsx`, `apps/web/src/routes/admin/*.tsx`, `apps/web/src/components/{DiffView,HistoryDrawer,SpaceCard,SpaceGrants,InviteForm,GroupMembers,PrincipalPicker,Tree}.tsx`

- [ ] **Step 1:** Replace hard-coded slate/indigo utility classes with the token classes; space screen becomes a quiet list/table of pages; workspace home becomes a welcome page with recent Updates and the person's spaces; auth screens centred on the page token; diff view and badges use the dot/author tokens in both themes; keep every label, role and focus behaviour.
- [ ] **Step 2:** Add a test that fails if hard-coded colour classes remain: `apps/web/test/tokens.test.ts` scans `apps/web/src/**/*.tsx` and fails on `bg-slate-`, `text-slate-`, `border-slate-`, `bg-indigo-`, `text-indigo-` (an allowlist array for any justified exception, empty at the end). Run it — Expected: FAIL before the sweep.
- [ ] **Step 3:** Do the sweep.
- [ ] **Step 4:** Run `pnpm vitest run`, typecheck, build — Expected: pass; view every screen in both themes on the harness and report any contrast problem found and fixed.
- [ ] **Step 5:** Commit `feat(web): re-skin remaining screens onto the tokens`.

### Task 10: End-to-end coverage and the sidebar live check

**Files:**
- Modify: `e2e/*.spec.ts`, `e2e/support.ts` (selectors only where markup changed)
- Create: `e2e/sidebar.spec.ts`
- Modify: `docs/live-checks/2026-10-slice-0-1-live-check.md` (append a section "Sidebar console")

- [ ] **Step 1:** Run `pnpm e2e:local` and fix the existing specs' selectors for the new markup without changing what they assert.
- [ ] **Step 2:** `sidebar.spec.ts`: expand a space and open a page from the tree; a page awaiting review shows an amber dot named "Waiting for review" and the Reviews count matches; an edit by another context shows in Updates and an own edit reads "You"; the purple dot appears after typing and the section header is keyboard operable; the theme toggle persists across reload and `system` follows the emulated colour scheme (Playwright `colorScheme`); the 390 px viewport shows the slide-over, which closes on navigation and Escape; a viewer does not see another member's Inbox page in the tree or Updates.
- [ ] **Step 3:** Run `pnpm e2e:local` three times — Expected: all green each time, no fixed sleeps.
- [ ] **Step 4:** Append real outputs and screenshots-by-description of both themes to the live-check doc; anything not run is marked so.
- [ ] **Step 5:** Run `pnpm vitest run`, `pnpm typecheck`, `pnpm --filter @living-wiki/web build`; commit `test: sidebar console e2e and live check`.
