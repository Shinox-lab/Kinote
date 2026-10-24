# Console redesign — foundation and shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the new token palette and the new console shell — 252px sidebar, Home/Search/Reviews/Settings nav, workspace and tree restyle, account menu with theme and sign-out, and the sticky top bar on the page and file screens — with every existing behaviour still working.

**Architecture:** The existing shell already has the sidebar, a collapse, a 768px slide-over, the workspace menu, the spaces tree, the account foot and a per-route main. This plan keeps those mechanics, changes the values under the existing CSS variables, restyles the rows, adds the Home link, moves theme/sign-out into a popover menu, widens the frame to 252/1188 and the slide-over to 330/1024, and introduces one reusable `AppTopBar` that the page and file routes render. The updates feed and the page's "On this page" panel stay until the Home and page plans replace them.

**Tech Stack:** React 19, TanStack Router, Tailwind v4 (`@theme inline`), Vitest, Playwright, the existing Hocuspocus editor.

**Spec:** `docs/superpowers/specs/2026-10-24-console-redesign-design.md` (Phase 0 of its delivery order). Later phases — page, file, Home/search, reviews, settings, night/phone — are separate plans so each ships working software.

## Global Constraints

- Tokens are CSS variables on `:root` and `[data-theme='dark']`; keep the existing names (`--page`, `--sidebar`, `--surface`, `--line`, `--fg`, `--muted`, `--hover`, `--active`, `--accent`, `--accent-fg`, `--accent-text`, `--danger`, `--success`, `--dot-*`, `--author-*`). No raw hex in components. New tokens are additive.
- Light: page `#fcfbf9`, sidebar `#f5f2ed`, surface `#ffffff`, line `#e8e2d9`, fg `#24211d`, muted `#6b645b`, faint `#8d857b`, hover `#f2eee7`, active `#ece7df`, accent `#6550c9`, accent-fg `#ffffff`, accent-text `#5b43c7`, success `#2b7355`, danger `#9c3a30`.
- Dark: page `#1a1713`, sidebar `#141210`, surface `#221e19`, line `#302a23`, fg `#ece6dd`, muted `#a79c8e`, faint `#7c7266`, hover `#241f1a`, active `#2b251f`, accent `#a08cff`, accent-fg `#1a1713`, accent-text `#c8b9ff`, success `#6cc39b`, danger `#e58a80`.
- Soft status tokens (light / dark): ok `#f3f8f5`/`#1c2a23`, `#dfe9e3`/`#2c4438`, `#3c6350`/`#8fd3b1`, `#2f7d5d`/`#6cc39b`; warn `#fbf3e6`/`#2e2619`, `#f0e2c8`/`#4a3b22`, `#7a531f`/`#e0b378`, `#b5813b`/`#e0ab6a`; review `#efeafb`/`#2c2542`, `#ddd3f7`/`#443a63`, `#5b43c7`/`#c8b9ff`, `#6550c9`/`#a08cff`; bad `#f9eae7`/`#301f1c`, `#f0d6d1`/`#4a2e29`, `#97382f`/`#f0a49b`, `#b4443a`/`#e58a80`. Diff: changed `#f8f5fe`/`#241f36` + line `#b9aee6`/`#8b76e8`; added `#f3f8f5`/`#1b2721` + `#79ad92`/`#4f8f74`; removed `#fbf1ef`/`#2b1e1b` + `#c98279`/`#a9635c`.
- Sidebar 252px; top bar 44px; main max 1188px; gutters 28px desktop. The slide-over is 330px and appears below 1024px (was 768).
- Keep the updates feed and the "On this page" panel in this phase. Keep UploadPanel, the rename/drag/context-menu/New-space work, all permissions, the focus trap, the theme storage and the pre-paint script.
- No new dependencies. One commit per task. Typecheck, unit tests, e2e and the build must pass at the end.
- The previous round is uncommitted in the working tree. Do not revert or rewrite it; build on it.

## Review Focus

1. **The sidebar at every width.** Collapsed (the open control must stay reachable), 1024–1439 (column, no clipped tree, the account row pinned), <1024 (slide-over opens/closes on navigation, Escape, the scrim). A dead end here locks the whole console.
2. **The account menu.** It must open by keyboard, close on Escape/outside click, return focus, apply and persist the theme without a flash, and leave no duplicate theme or sign-out controls.
3. **Roles.** A viewer or member sees no Settings & members link and no admin tree affordances; the Reviews badge and the tree still respect space permissions.
4. **Long names and truncation.** Workspace, space, page and file names truncate in the sidebar and the top bar without pushing the menus off-screen; the tree scrolls; the account row stays at the foot.
5. **The page/file menus after the move.** Rename, move, archive, delete, replace and download remain reachable from the top bar (`Page actions`/`File actions`) and the e2e roles still resolve.

---

### Task 1: Tokens and the theme test

**Files:**
- Modify: `apps/web/src/index.css`
- Test: `apps/web/test/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the light/dark variables and utilities every later task uses: `bg-page`, `bg-sidebar`, `bg-surface`, `border-line`, `text-fg`, `text-muted`, `text-faint`, `bg-hover`, `bg-active`, `text-accent-text`, `bg-accent`, `text-accent-fg`, `bg-ok-bg`/`text-ok-text`/`border-ok-line`, the warn/review/bad sets, `bg-diff-changed`/`bg-diff-added`/`bg-diff-removed` and their line colours.

- [ ] **Step 1: Extend the failing theme test.**

In `apps/web/test/theme.test.ts`, add the new token names to the "declares every token" list (`faint`, `ok-bg`, `ok-line`, `ok-text`, `ok-dot`, `warn-bg`, `warn-line`, `warn-text`, `warn-dot`, `review-bg`, `review-line`, `review-text`, `review-dot`, `bad-bg`, `bad-line`, `bad-text`, `bad-dot`, `diff-changed-bg`, `diff-changed-line`, `diff-added-bg`, `diff-added-line`, `diff-removed-bg`, `diff-removed-line`), and add:

```ts
const BASES = {
  light: { page: '#fcfbf9', sidebar: '#f5f2ed', surface: '#ffffff', line: '#e8e2d9', fg: '#24211d', muted: '#6b645b', accent: '#6550c9', 'accent-fg': '#ffffff', 'accent-text': '#5b43c7', success: '#2b7355', danger: '#9c3a30' },
  dark:  { page: '#1a1713', sidebar: '#141210', surface: '#221e19', line: '#302a23', fg: '#ece6dd', muted: '#a79c8e', accent: '#a08cff', 'accent-fg': '#1a1713', 'accent-text': '#c8b9ff', success: '#6cc39b', danger: '#e58a80' },
} as const;

test('the design base values are the palette', () => {
  const t = tokens(selector);
  for (const [name, value] of Object.entries(BASES[_name as 'light' | 'dark'])) {
    expect(t[name], `--${name}`).toBe(value);
  }
});

test('status chip text reads on its fill (4.5:1)', () => {
  const t = tokens(selector);
  for (const [text, bg] of [['ok-text', 'ok-bg'], ['warn-text', 'warn-bg'], ['review-text', 'review-bg'], ['bad-text', 'bad-bg']] as const) {
    expect(contrastRatio(t[text]!, t[bg]!), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});
```

- [ ] **Step 2: Run the test and see it fail.**

Run: `pnpm vitest run apps/web/test/theme.test.ts`
Expected: FAIL — missing new tokens and the old base values.

- [ ] **Step 3: Set the palette in `index.css`.**

Replace the values of the existing variables with the light and dark values in Global Constraints. Add `--faint`, the four status sets (`--ok-bg`, `--ok-line`, `--ok-text`, `--ok-dot`, and warn/review/bad the same way), the three diff pairs, and map all of them in `@theme inline` (`--color-faint`, `--color-ok-bg`, …; the diff ones as `--color-diff-changed`, `--color-diff-changed-line`, …). Keep `--author-*` and its tints unchanged (they still pass on the new surfaces), keep the author-based `usePageChanges` styles, and update `--shadow` to `0 8px 24px rgba(60,48,30,.12), 0 1px 3px rgba(60,48,30,.06)` light and `0 10px 30px rgba(0,0,0,.55)` dark. Keep `--accent` as the focus ring and selection base; set `--selection` to `rgba(101,80,201,.22)` light and `rgba(160,140,255,.28)` dark.

- [ ] **Step 4: Run the tests and see them pass.**

Run: `pnpm vitest run apps/web/test/theme.test.ts`
Expected: PASS. If an author tint or dot fails 3:1 on the new sidebar, adjust that one value (the tints are the only existing colours on the new surfaces) — do not change the base palette.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/index.css apps/web/test/theme.test.ts
git commit -m "feat(web): warm paper palette and night tokens"
```

---

### Task 2: Account menu

**Files:**
- Modify: `apps/web/src/components/sidebar/AccountRow.tsx`
- Modify: `e2e/sidebar.spec.ts` (the theme test)
- Test: `e2e/sidebar.spec.ts`

**Interfaces:**
- Consumes: the tokens and the existing `loadTheme`, `saveTheme`, `applyTheme`, `endSession`, `api.signOut`.
- Produces: a trigger with the accessible name `Account`; a `role="menu"` named `Account`; `role="menuitemradio"` options named Light/System/Dark with `aria-checked`; a `role="menuitem"` named Sign out. Later tasks rely on no other theme controls existing.

- [ ] **Step 1: Update the failing theme test.**

Replace the direct theme-button clicks in the theme test with the menu:

```ts
const account = sidebar(page).getByRole('button', { name: 'Account' });
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
await account.click();
await page.getByRole('menuitemradio', { name: 'Dark' }).click();
await expect.poll(theme).toBe('dark');
await page.reload();
await expect.poll(theme).toBe('dark');
await account.click();
await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
await page.getByRole('menuitemradio', { name: 'System' }).click();
await expect.poll(theme).toBe('light');
// Escape closes and returns focus.
await account.click();
await page.keyboard.press('Escape');
await expect(page.getByRole('menu', { name: 'Account' })).toHaveCount(0);
await expect(account).toBeFocused();
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/sidebar.spec.ts -g "theme"`
Expected: FAIL — no Account button.

- [ ] **Step 3: Implement the popover.**

Replace the inline theme group and sign-out button with one row: a full-width button (`aria-haspopup="menu"`, `aria-expanded`, `aria-controls`) holding the avatar (initials from the name, using the existing `--accent-soft`/`--accent-text`), the name, and a `···` glyph, plus a menu anchored above (`bottom-full mb-1`) with `role="menu"`, `aria-label="Account"`. Inside: a small "Appearance" caption, the three `menuitemradio` buttons (Sun/Monitor/Moon icons from `icons.tsx`, `aria-checked={theme === value}`), a divider, and Sign out as `menuitem`. Close on Escape, outside pointerdown, and after a choice; return focus to the trigger on Escape. Keep the existing theme storage/apply and sign-out mutation exactly.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/sidebar.spec.ts -g "theme"`
Expected: PASS. Also run `pnpm typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/sidebar/AccountRow.tsx e2e/sidebar.spec.ts
git commit -m "feat(web): move theme and sign-out into the account menu"
```

---

### Task 3: Sidebar nav — Home, order, no duplicate paths

**Files:**
- Modify: `apps/web/src/components/sidebar/Sidebar.tsx`
- Modify: `apps/web/src/components/icons.tsx` (add `HomeIcon` if missing)
- Test: `e2e/shell.spec.ts` (new)

**Interfaces:**
- Consumes: the routes `/w/$tenantSlug` (Home), `/w/$tenantSlug/search`, `/w/$tenantSlug/reviews`, the existing admin screens from `adminScreens(role)`.
- Produces: the nav order Home, Search, Reviews, Settings & members; the Home link is active only at the workspace root (`activeOptions={{ exact: true }}`, `aria-current="page"` on the active link). The Updates section and OnThisPage stay for now.

- [ ] **Step 1: Write the failing shell test.**

Create `e2e/shell.spec.ts`:

```ts
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addMember, openAs, seedWorld } from './support.js';

const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Sidebar' });

test('the sidebar leads with Home, then Search, Reviews and Settings', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);

  const main = sidebar(page).getByRole('list', { name: 'Main' });
  await expect(main.getByRole('link')).toHaveText(['Home', 'Search', 'Reviews', 'Settings & members']);
  await expect(main.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  await main.getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${world.slug}/search$`));
  await expect(main.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
});

test('a member sees the tree but no Settings link', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const member = await addMember(request, world, 'Vera Viewer', 'viewer');
  const page = await openAs(browser, world, member);
  await page.goto(`/w/${world.slug}`);

  await expect(sidebar(page).getByRole('list', { name: 'Main' }).getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Settings & members' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "sidebar leads"`
Expected: FAIL — no Home link, wrong order.

- [ ] **Step 3: Implement the nav.**

In `Sidebar.tsx`, put the Home `Link` first with `HomeIcon`, then Search, Reviews, Settings (role-gated as today), inside a `<ul aria-label="Main">`. Add `aria-current="page"` to each active `activeProps` and `activeOptions={{ exact: true }}` for Home. Keep `UpdatesSection`, `SpacesSection`, `UploadPanel` and `OnThisPage` in the same places. Add `HomeIcon` (a 24×24 house outline matching the other icons) if `icons.tsx` lacks it.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "sidebar leads"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/sidebar/Sidebar.tsx apps/web/src/components/icons.tsx e2e/shell.spec.ts
git commit -m "feat(web): add Home to the sidebar and order the console nav"
```

---

### Task 4: Frame, workspace row, tree and slide-over

**Files:**
- Modify: `apps/web/src/routes/layout.tsx`
- Modify: `apps/web/src/lib/sidebar.ts` (`SIDEBAR_BREAKPOINT_PX`)
- Modify: `apps/web/src/components/sidebar/WorkspaceMenu.tsx`, `SpacesSection.tsx`, `NavRow.tsx` (classes only)
- Test: `e2e/shell.spec.ts`, `e2e/sidebar.spec.ts`

**Interfaces:**
- Consumes: the tokens; the existing collapse/expanded storage; the existing focus trap and `useMediaQuery`.
- Produces: `SIDEBAR_BREAKPOINT_PX = 1024`; the sidebar column 252px; the slide-over 330px; the main `max-w-[1188px]` with `px-5 md:px-7`; the workspace row (monogram, name, chevrons, collapse) and tree rows restyled with the new tokens. No behaviour change to drag, rename, add or focus.

- [ ] **Step 1: Write the failing frame test.**

Add to `e2e/shell.spec.ts`:

```ts
test('the sidebar is a column on a desktop and a slide-over below 1024', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`/w/${world.slug}`);
  await expect(sidebar(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toHaveCount(0);

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(sidebar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible();
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "column on a desktop"`
Expected: FAIL — at 1000 the sidebar is still a column (breakpoint 768).

- [ ] **Step 3: Implement the frame.**

`lib/sidebar.ts`: `SIDEBAR_BREAKPOINT_PX = 1024`. `layout.tsx`: aside `w-[252px]`, slide-over `w-[330px] max-w-[85vw]`, main `mx-auto w-full max-w-[1188px] px-5 py-6 md:px-7`. Restyle `WorkspaceMenu` (monogram tile 20, name 12.5/500, chevrons; the menu rows 28px), `NavRow` (28px rows, 12px labels, the active `bg-active`), and `SpacesSection` rows (26px, `gap-1.5`, the selected `bg-active`, page/file glyph colours from the tokens; the attention dots keep their existing colours and positions). The tree must still scroll inside the nav and the account row stays at the foot. Keep the keyboard shortcut, the focus trap and the storage helpers.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "column on a desktop"`
Expected: PASS. Then run the existing sidebar suite: `pnpm e2e:local e2e/sidebar.spec.ts` — the collapse, phone slide-over, drag, rename and New space tests must pass unchanged (the 390px phone is still below 1024).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/routes/layout.tsx apps/web/src/lib/sidebar.ts apps/web/src/components/sidebar/WorkspaceMenu.tsx apps/web/src/components/sidebar/SpacesSection.tsx apps/web/src/components/sidebar/NavRow.tsx e2e/shell.spec.ts
git commit -m "feat(web): size the shell and restyle the workspace and spaces tree"
```

---

### Task 5: Sticky top bar on the page and file screens

**Files:**
- Create: `apps/web/src/components/AppTopBar.tsx`
- Modify: `apps/web/src/routes/page.tsx`
- Modify: `apps/web/src/routes/file.tsx`
- Test: `e2e/shell.spec.ts`

**Interfaces:**
- Consumes: the existing page `Breadcrumb` and `LifecycleMenu`, the file `Breadcrumb` and `FileMenu`.
- Produces: `AppTopBar({ crumbs, right }: { crumbs: ReactNode; right?: ReactNode })` — a sticky 44px `<header>` with a bottom hairline, the crumbs on the left (min-w-0, truncating) and the menu on the right. The page/file routes render it above their article/content; the page's badge and the file's header actions stay in the content.

- [ ] **Step 1: Write the failing top-bar test.**

Add to `e2e/shell.spec.ts`; add `call` and `uploadViaApi` to the `./support.js` import:

```ts
test('the page breadcrumb and menu live in the top bar', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const pageId = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, title: 'Notes', slug: `notes-${world.suffix}`, parent_id: null, markdown: 'Notes text.' },
  });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${pageId}`);

  const banner = page.getByRole('banner');
  await expect(banner.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Page actions' })).toBeVisible();
  // No second breadcrumb in the document column.
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(1);

  // The file's breadcrumb and menu use the same bar.
  const fileId = await uploadViaApi(request, world, world.owner, {
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes'),
  });
  await page.goto(`/w/${world.slug}/f/${fileId}`);
  await expect(page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: 'File actions' })).toBeVisible();
});

test('a long title keeps the page menu in reach', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const title = 'A very long page title that keeps going and going until the sidebar and the top bar have to truncate it';
  const pageId = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, title, slug: `long-${world.suffix}`, parent_id: null, markdown: 'Long title.' },
  });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${pageId}`);

  await expect(page.getByRole('banner').getByRole('button', { name: 'Page actions' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "top bar"`
Expected: FAIL — no banner.

- [ ] **Step 3: Implement `AppTopBar` and move the chrome.**

Create `AppTopBar.tsx`:

```tsx
import type { ReactNode } from 'react';

export function AppTopBar({ crumbs, right }: { crumbs: ReactNode; right?: ReactNode }) {
  return (
    <header role="banner" className="sticky top-0 z-20 mb-4 flex h-11 items-center gap-3 border-b border-line bg-page">
      <div className="min-w-0 flex-1">{crumbs}</div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </header>
  );
}
```

In `page.tsx`, return a fragment: `<AppTopBar crumbs={<Breadcrumb …/>} right={<LifecycleMenu …/>} />` before the `<article>`. Remove the breadcrumb and menu from the article's header; keep the badge and the archived chip in a small row above the h1. Keep `PageActions` where they are (the sidebar panel or, when there is no column, the content) — the page plan moves them into the chip.

In `file.tsx`, the same: the `AppTopBar` gets the `Breadcrumb` and `FileMenu`; remove them from the content's first row and keep the title/status/Download/Replace header.

- [ ] **Step 4: Run it and see it pass.**

Run: `pnpm e2e:local e2e/shell.spec.ts -g "top bar"`
Expected: PASS. Then the existing page and file specs: `pnpm e2e:local e2e/page.spec.ts e2e/file.spec.ts` (adjust any locator that expected the breadcrumb inside the document column; the roles and names are unchanged).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/AppTopBar.tsx apps/web/src/routes/page.tsx apps/web/src/routes/file.tsx e2e/shell.spec.ts
git commit -m "feat(web): one sticky top bar for page and file"
```

---

### Task 6: Full verification and cleanup

**Files:**
- Test: `e2e/shell.spec.ts`, `e2e/sidebar.spec.ts`, `e2e/page.spec.ts`, `e2e/file.spec.ts`
- Modify: any spec the moved elements break.

**Interfaces:**
- Consumes: everything above.
- Produces: a green baseline for the page and file plans.

- [ ] **Step 1: Run the full checks.**

Run, in order:
```bash
pnpm typecheck
pnpm test
pnpm e2e:local
pnpm web:build
```
Expected: typecheck clean; all Vitest tests pass; all Playwright specs pass (the suite is 39+); the web build succeeds.

- [ ] **Step 2: Fix only what the moves broke.**

If a spec fails because the breadcrumb/menu/theme control moved, update that locator to the new role/name (the elements are the same). Do not change behaviour to make a test pass. Commit any spec-only fixes:

```bash
git add e2e
git commit -m "test: follow the shell moves in e2e"
```

- [ ] **Step 3: Manual pass (5 minutes).**

At 1440: the sidebar is 252, the tree scrolls, the account row is pinned; open the account menu with the keyboard, switch to Dark, reload (no flash), switch back to System. Collapse the sidebar and reopen it (button and Ctrl+\). At 1000: the sidebar is a slide-over; open it, follow a page, it closes. On a page and a file: the breadcrumb and `Page actions`/`File actions` sit in the top bar; the title and the preview/body below.

---

## Notes for the next plans

- The page plan removes `OnThisPage` and adds the page emoji, the status chip, presence and the Changes tab.
- The Home plan removes `UpdatesSection` and `UpdatesSection`'s storage helpers once the feed exists on Home; this plan deliberately keeps both until then.
- The phone plan moves the "Open sidebar" button into the sticky top bar; until then the current floating control stays for routes without `AppTopBar`.
