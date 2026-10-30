# README, GitHub Pages site and feature clips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kinote a public front door: an MIT licence, a README, a VitePress site on GitHub Pages (landing page plus
docs), and eight feature clips recorded from the real app.

**Architecture:** A new workspace package `site/` (`@kinote/site`) holds the VitePress site, a content checker, and the
clip recorder. The recorder drives the running compose stack with Playwright, captures CDP screencast frames, cuts out
model and worker waits, and encodes MP4, poster and GIF with ffmpeg. A GitHub Actions workflow builds and deploys the
site.

**Tech Stack:** VitePress 1.6.3 (Vue 3), Playwright (`@playwright/test` from the root), ffmpeg (installed at
`/opt/homebrew/bin/ffmpeg`), exceljs 4.4.0 (to make the demo spreadsheet), Vitest (the root config already picks up
`**/*.test.ts`), GitHub Actions (`actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`).

**Spec:** `docs/superpowers/specs/2026-10-30-readme-site-and-clips-design.md`

## Global Constraints

- Public text (README, site, demo content) never contains: `Shinox` other than in `Shinox-lab`, `Curator`,
  `Phase <letter>`, `slice <n>`, or anything that looks like an API key (`sk-…`). The checker in Task 1 enforces this.
- Unbuilt features are labelled exactly **"(In development)"** wherever they're listed: WhatsApp, Google Drive, MCP for
  external AI agents, Self-maintaining wiki, Space export. They get no clip and no how-to page.
- Never use the name "Curator". The feature is called "Self-maintaining wiki".
- Hosted-service links come from `site/hosted.json` (`{"url": "https://shinox-lab.github.io/Kinote/#hosted"}`), and
  that section of the landing page says hosted Kinote is coming soon.
- Site base path: `/Kinote/`. Site URL: `https://shinox-lab.github.io/Kinote/`.
- Palette: the tokens in `apps/web/src/index.css` (light `:root` and the `[data-theme='dark']` block). Font: the app's
  `--font-sans` stack. No web fonts.
- Licence: MIT, `Copyright (c) 2026 Shinox-lab`.
- Clips: 10–25 s each, recorded from the real app with the owner's real models, light theme, invented people and
  company only. MP4 is H.264, `yuv420p`, `+faststart`. Each README GIF is ≤ 5 MB.
- Docs describe only behaviour you have checked in the code or an e2e spec. The specs under `docs/superpowers/specs/`
  are the starting point, not the authority.
- Pin exact versions in `site/package.json`.

## Review Focus

1. **Assets under the `/Kinote/` base path.** A video or logo that loads in `vitepress dev` 404s on Pages if it's
   referenced as `/clips/x.mp4` without `withBase`. Task 3's site test serves the built site under `/Kinote/` and
   requests every `<video>`, `<source>` and `<img>` URL.
2. **Phone width.** At 375 px the landing page must not scroll sideways and clips must scale down. Task 3's site test
   checks `scrollWidth <= innerWidth` at 375 px.
3. **Reduced motion.** With `prefers-reduced-motion: reduce`, clips don't autoplay and show the poster and controls.
   Task 3's site test emulates this.
4. **Recording against stand-in models.** If the stack runs with `ROUTER_PROVIDER=deterministic`, the hero clip shows
   meaningless routing, and if the model asks a follow-up question, the clip stalls. Task 7's `run.ts` refuses
   deterministic providers, and Task 8's capture clip answers a follow-up question by picking its first option.
5. **The README in GitHub's dark theme.** A dark wordmark disappears on a dark background. The README uses `<picture>`
   with a `prefers-color-scheme: dark` source, and Task 1's checker has a test for it (`findReadmeIssues`).

---

### Task 1: Site package, content checker, licence

**Files:**
- Create: `site/package.json`, `site/tsconfig.json`, `site/hosted.json`, `LICENSE`
- Create: `site/scripts/check-content.ts`, `site/scripts/check-content.test.ts`
- Modify: `pnpm-workspace.yaml` (add `"site"`), root `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces:
  - `findBannedTerms(text: string): string[]`: each offending match, in order.
  - `findUnlabelledInDevelopment(text: string): string[]`: lines naming an in-development feature without
    "(In development)".
  - `findReadmeIssues(readme: string, hostedUrl: string, exists: (relPath: string) => boolean): string[]`.
  - `IN_DEVELOPMENT: readonly string[]` = `['WhatsApp', 'Google Drive', 'MCP', 'Self-maintaining wiki', 'Space export']`.
  - CLI `pnpm --filter @kinote/site check` exits 1 and prints `file:line: problem` for each finding.
  - Root scripts: `site:dev`, `site:build`, `site:check`, `clips` (the `clips` script is added in Task 7).

- [ ] **Step 1: Write the failing tests** in `site/scripts/check-content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findBannedTerms, findReadmeIssues, findUnlabelledInDevelopment } from './check-content';

describe('findBannedTerms', () => {
  it('allows the GitHub org name', () => expect(findBannedTerms('github.com/Shinox-lab/Kinote')).toEqual([]));
  it('flags internal names', () => {
    expect(findBannedTerms('Built in Shinox during Phase C2, slice 3, by the Curator')).toEqual(['Shinox', 'Phase C2', 'slice 3', 'Curator']);
  });
  it('flags API keys', () => expect(findBannedTerms('key sk-or-v1-abc123def456ghi789jkl0')).toHaveLength(1));
});

describe('findUnlabelledInDevelopment', () => {
  it('passes labelled lines', () => expect(findUnlabelledInDevelopment('- **WhatsApp groups** (In development): …')).toEqual([]));
  it('flags unlabelled lines', () => expect(findUnlabelledInDevelopment('Sync from Google Drive')).toEqual(['Sync from Google Drive']));
});

describe('findReadmeIssues', () => {
  const ok = `<picture><source media="(prefers-color-scheme: dark)" srcset="site/public/logo-dark.svg"><img src="site/public/logo-light.svg"></picture>
[Try Kinote](https://shinox-lab.github.io/Kinote/#hosted)`;
  it('passes a good README', () => expect(findReadmeIssues(ok, 'https://shinox-lab.github.io/Kinote/#hosted', () => true)).toEqual([]));
  it('needs a dark logo', () => expect(findReadmeIssues(ok.replace('prefers-color-scheme: dark', ''), 'https://shinox-lab.github.io/Kinote/#hosted', () => true)).toContain('logo has no dark-theme source'));
  it('needs Try links to use the hosted URL', () => expect(findReadmeIssues(ok, 'https://example.org', () => true)).toContain('"Try Kinote" link is not the hosted URL'));
  it('reports missing local files', () => expect(findReadmeIssues(ok, 'https://shinox-lab.github.io/Kinote/#hosted', (p) => !p.includes('dark'))).toContain('missing file: site/public/logo-dark.svg'));
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run site/scripts/check-content.test.ts`. Expected:
  FAIL because the module can't be resolved.

- [ ] **Step 3: Implement `site/scripts/check-content.ts`.** The three functions are pure. Banned patterns:
  `/\bShinox\b(?!-lab)/`, `/\bCurator\b/`, `/\bPhase [A-Z]\d?[a-z]?\b/`, `/\bslice \d+\b/i`,
  `/\bsk-[A-Za-z0-9-]{20,}/`. `findUnlabelledInDevelopment` checks each line that names an `IN_DEVELOPMENT` item
  (case-insensitive, whole word; for `MCP`, only lines that also say "agent"). The CLI (`import.meta.url` main
  guard) scans `README.md`, `site/**/*.md`, `site/.vitepress/theme/**/*.{ts,vue}` and `site/clips/seed/**/*.ts` for
  banned terms. It runs the in-development check on `README.md` and `site/.vitepress/theme/features.ts`, and
  `findReadmeIssues` on `README.md`, skipping files that don't exist yet.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run site/scripts/check-content.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Scaffold the package.** Create `site/package.json` (`"name": "@kinote/site"`, `private`,
  `type: module`) with scripts `dev: vitepress dev`, `build: vitepress build`, `preview: vitepress preview --port 4173`,
  `check: tsx scripts/check-content.ts` and `typecheck: vue-tsc --noEmit` (or `tsc --noEmit` if no `.vue` needs it),
  and devDependencies `vitepress: 1.6.3`, `exceljs: 4.4.0` (plus `vue-tsc` if used). Add `"site"` to
  `pnpm-workspace.yaml`, and add root scripts `site:dev`, `site:build` and `site:check` that use
  `pnpm --filter @kinote/site`. Add `site/.vitepress/dist`, `site/.vitepress/cache` and `site/clips/.work` to
  `.gitignore`. Write `site/hosted.json` and the standard MIT `LICENSE` text with `Copyright (c) 2026 Shinox-lab`.

- [ ] **Step 6: Verify the install and the existing checks.** Run `pnpm install`, `pnpm typecheck`, `pnpm test` and
  `pnpm site:check`. Expected: everything passes. The root typecheck doesn't include `site/`, so the existing count
  is unchanged.

- [ ] **Step 7: Commit:** `chore(site): site package, content checker and MIT licence`.

### Task 2: Logo, theme and site skeleton

**Files:**
- Create: `site/public/logo-light.svg`, `site/public/logo-dark.svg`, `site/public/mark.svg` (favicon)
- Create: `site/.vitepress/config.ts`, `site/.vitepress/theme/index.ts`, `site/.vitepress/theme/kinote.css`
- Create: `site/index.md` (temporary hero text, replaced in Task 3) and empty section indexes: `site/guide/index.md`,
  `site/self-host/index.md`, `site/contributing/index.md`, `site/roadmap.md`

**Interfaces:**
- Produces: the theme entry `site/.vitepress/theme/index.ts`, which extends `DefaultTheme` and registers global
  components (Task 3 adds `Landing` and `ClipVideo`). The CSS custom properties `--k-page`, `--k-sidebar`, `--k-fg`,
  `--k-muted`, `--k-line`, `--k-accent`, `--k-accent-soft` and `--k-surface` are defined for light and dark. The sidebar
  config in `config.ts` is keyed by `/guide/`, `/self-host/` and `/contributing/`; Tasks 4 and 5 fill in the items.

- [ ] **Step 1: Draw the logo.** The mark is a simple glyph in `#6550c9`, for example a page with a routing arrow, or
  a "K" built from two strokes meeting a dot. It must read at 16 px. The wordmark is "Kinote" in the system sans stack
  at weight 650, `#24211d` on light and `#ece9f5` on dark (check the dark `--fg` token in `index.css` and use it).
  Turn the text into paths so it doesn't depend on fonts. Each SVG has a `viewBox` and no fixed pixel size beyond
  `height`.

- [ ] **Step 2: Map Kinote's tokens onto VitePress's.** In `kinote.css`, set `--vp-c-brand-1/2/3`, `--vp-c-bg`,
  `--vp-c-bg-alt`, `--vp-c-bg-soft`, `--vp-c-text-1/2`, `--vp-c-divider`, `--vp-font-family-base` and
  `--vp-button-brand-bg` from the app's light tokens on `:root`, and from its dark tokens on `.dark`. VitePress toggles
  `.dark` on `<html>` and follows the system setting by default.

- [ ] **Step 3: Write `config.ts`.** Set `base: '/Kinote/'`, title `Kinote`, the description (from the hero
  sub-line), `head` (favicon `mark.svg` through the base, `og:image` set to
  `https://shinox-lab.github.io/Kinote/social.png`, `og:title` and `og:description`), `themeConfig.logo` with
  `{ light, dark }`, nav (Features → `/#features`, Docs → `/guide/`, GitHub social link), the sidebar per section,
  `search: { provider: 'local' }`, `editLink` pointing at `site/` on `main`, and a footer with "Released under the MIT
  License."

- [ ] **Step 4: Build and look at it.** Run `pnpm site:build && pnpm --filter @kinote/site preview`. Open
  `http://localhost:4173/Kinote/` in light and dark (Playwright screenshot or a browser). Expected: the logo, favicon
  and accent colour show in both themes, and the build reports no dead links.

- [ ] **Step 5: Commit:** `feat(site): logo, Kinote theme and site skeleton`.

### Task 3: Landing page

**Files:**
- Create: `site/.vitepress/theme/features.ts`, `site/.vitepress/theme/Landing.vue`,
  `site/.vitepress/theme/ClipVideo.vue`
- Create: `site/tests/site.spec.ts`, `site/playwright.site.config.ts`
- Modify: `site/index.md` (`layout: page`, `<Landing />`), `site/.vitepress/theme/index.ts`, `site/package.json`
  (script `test:site`)

**Interfaces:**
- Consumes: `site/hosted.json`, the theme tokens from Task 2.
- Produces:
  - `features.ts` exports `type Feature = { title: string; body: string; clip?: ClipName; status: 'built' | 'in-development' }`,
    `type ClipName = 'capture' | 'co-edit' | 'review' | 'files' | 'ask' | 'collections' | 'drawings' | 'links'`,
    `heroClip: ClipName = 'capture'`, `rows: Feature[]` (one per clip except `capture`, in the spec's order), and
    `grid: Feature[]` (spreadsheet editor, multi-tenant with row-level security, bring your own models, Docker
    Compose, then the five in-development items with `status: 'in-development'`).
  - `<ClipVideo name="capture" />` renders `withBase('/clips/capture.mp4')` with poster `withBase('/clips/capture.jpg')`,
    `muted loop playsinline`, and `preload="metadata"`. It autoplays only when the reduced-motion media query doesn't
    match (checked on mount); otherwise it shows `controls`. Until Tasks 8–9 produce the files, the component shows
    the poster box at the clip's aspect ratio (16:10).
  - Element hooks the tests use: `data-testid="try-kinote"` on every Try button, `id="hosted"` on the coming-soon
    section, and `id="features"` and `id="self-host"` on their sections.

- [ ] **Step 1: Write the failing site tests** in `site/tests/site.spec.ts`. They run against
  `vitepress preview --port 4173` (a `webServer` in `playwright.site.config.ts` that first builds the site), with
  `baseURL` set to `http://localhost:4173/Kinote/`:
  - `phone width has no sideways scroll`: at viewport 375×812, `document.documentElement.scrollWidth <= window.innerWidth`
    on `/` and on `/guide/`.
  - `Try Kinote goes to the hosted setting`: every `[data-testid=try-kinote]` has `href` equal to `hosted.json`'s `url`,
    and `#hosted` is visible after clicking one.
  - `in-development items are labelled`: for each of the five names, the element containing it in `#features` also
    contains `(In development)`.
  - `every media URL resolves under the base path`: collect `src` and `poster` from `video` and `source` and `src` from
    `img` on `/`; each starts with `/Kinote/` and a GET returns 200. Skip `.mp4`/`.jpg` under `/clips/` while
    `site/public/clips/` is empty (the test reads the folder), so this test passes before Task 8 and becomes strict
    once the clips exist.
  - `reduced motion does not autoplay`: with `page.emulateMedia({ reducedMotion: 'reduce' })`, the hero `video` has
    `paused === true` and the `controls` attribute.

- [ ] **Step 2: Run them and confirm they fail.** Run
  `pnpm --filter @kinote/site exec playwright test -c playwright.site.config.ts`. Expected: FAIL (no Landing yet).

- [ ] **Step 3: Build the landing page** in `Landing.vue`, from top to bottom: hero (headline *"Write it down once.
  Kinote files it everywhere it belongs."* or a better line, a one-sentence sub-line about people and AI agents
  sharing one wiki, the Try Kinote button and a Self-host button linking to `#self-host`, and the hero `ClipVideo`
  inside a framed window with `--shadow` from the app); alternating rows from `rows`; the `grid`; the self-host block
  with the three commands (`git clone https://github.com/Shinox-lab/Kinote.git`, `cd Kinote && cp .env.example .env`,
  `docker compose up -d`), a line saying the app is at `http://localhost:8080`, and a link to `/self-host/`; the
  `#hosted` coming-soon block; and the footer links. Use only the theme tokens, so dark mode works. Rows stack in a
  single column below 768 px.

- [ ] **Step 4: Run the site tests and confirm they pass.** Expected: PASS (5 tests).

- [ ] **Step 5: Take screenshots and check by eye.** Capture 1280 px and 375 px, light and dark, into
  `site/clips/.work/screens/`. Look at all four. The hierarchy should be clear, nothing should overlap, and the
  in-development labels should be visible but quiet (muted chip).

- [ ] **Step 6: Commit:** `feat(site): landing page`.

### Task 4: Docs: Using Kinote

**Files:**
- Create under `site/guide/`: `index.md` (Workspaces, spaces and pages), `capture.md`, `editing-together.md`,
  `review.md`, `files.md`, `search-and-ask.md`, `collections.md`, `drawings.md`, `links-and-comments.md`, `members.md`
- Modify: `site/.vitepress/config.ts` (the `/guide/` sidebar, in that order)

**Interfaces:**
- Consumes: `ClipVideo` (Task 3). Each page with a matching clip embeds it near the top: `capture.md` ← `capture`,
  `editing-together.md` ← `co-edit`, `review.md` ← `review`, `files.md` ← `files`, `search-and-ask.md` ← `ask`,
  `collections.md` ← `collections`, `drawings.md` ← `drawings`, `links-and-comments.md` ← `links`.

- [ ] **Step 1: Gather the facts for each page.** For each page, read its spec under `docs/superpowers/specs/` and
  then the UI that implements it (`apps/web/src/routes/*.tsx`, `apps/web/src/components/**`) and its e2e spec
  (`e2e/*.spec.ts`). Use the UI's exact button labels and badge texts in the docs (for example "Index now",
  "Submit for review", "Saved · not indexed (awaiting approval)" and "What do you want to file?"). If the spec and the
  code differ, the code wins.

- [ ] **Step 2: Write the pages.** They're for non-technical readers: short paragraphs, second person, plain words,
  and no internals (no Yjs, no chunks, no RLS). Each page has what it's for, how to do it in numbered steps, and what
  you'll see. `review.md` has a table of every badge and what it means, copied from what `Badge.tsx` and
  `PageStatus.tsx` render. `capture.md` covers receipts, follow-up questions, Undo, Undo all, and "Wrong page → move
  to…". `members.md` covers workspace roles (owner, admin, member, viewer) and space roles (viewer, editor, reviewer,
  admin).

- [ ] **Step 3: Check the pages.** Run `pnpm site:check && pnpm site:build`. Expected: no findings and no dead links.

- [ ] **Step 4: Commit:** `docs(site): Using Kinote guide`.

### Task 5: Docs: Self-hosting, Contributing, Roadmap

**Files:**
- Create under `site/self-host/`: `index.md` (Quick start), `configuration.md`, `database.md`, `proxy.md` (ports,
  reverse proxy, `TRUST_PROXY`, Coolify), `storage.md`, `upgrading.md`
- Create under `site/contributing/`: `index.md` (repo layout and services), `development.md` (running locally and the
  test suites), `how-we-work.md` (specs and plans), `conventions.md`
- Create: `site/public/architecture.svg`, `site/roadmap.md`
- Modify: `site/.vitepress/config.ts` (sidebars)

- [ ] **Step 1: Write the self-hosting pages from the sources.** Use `docs/operations.md`, `.env.example`,
  `docker-compose.yml`, `infra/dev.sh` and `Dockerfile`. The quick start lists prerequisites (Docker with at least
  about 4 GB of RAM free for the extractor, a first build of several GB), the six secrets and how to generate them
  (`openssl rand -hex 32`), `docker compose up -d`, the URL, and signing up the first account. `configuration.md`
  has one table per group in `.env.example`, with each variable, its default and what it does. It includes a worked
  OpenRouter example for embeddings, Ask and routing, with placeholder keys only (`<your-key>`), and explains that
  `deterministic` is for tests and that the worker refuses to mix it with real models. `upgrading.md` covers pulling,
  rebuilding (`docker compose up -d --build`), migrations through the one-shot `migrate` service, and backing up the
  Postgres volume and the object storage.

- [ ] **Step 2: Write the contributing pages.** Explain the apps and packages one line each (read each
  `package.json` and entry point). `architecture.svg` shows browser → web (nginx) → api, collab, `/mcp`; the worker
  with the extractor; and Postgres (pgvector, RLS) plus S3/MinIO. Draw it with the theme colours so it works on both
  backgrounds (a transparent background with mid-tone strokes). `development.md` covers `pnpm install`,
  `pnpm dev`, `pnpm web`, `pnpm test`, `pnpm test:pg`, `pnpm e2e` and `pnpm e2e:local`, and what each needs.
  `how-we-work.md` covers design docs in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, and live
  checks in `docs/live-checks/`. `conventions.md` rewrites "Conventions for plans" and "Rules the system must keep"
  from `docs/kinote-standalone-design.md` for outsiders, without internal labels such as `W1` or `S3`.

- [ ] **Step 3: Write the roadmap.** `roadmap.md` lists the five in-development items, each labelled
  "(In development)" with one honest sentence and no dates.

- [ ] **Step 4: Check the pages.** Run `pnpm site:check && pnpm site:build && pnpm --filter @kinote/site test:site`.
  Expected: everything passes.

- [ ] **Step 5: Commit:** `docs(site): self-hosting, contributing and roadmap`.

### Task 6: Demo workspace seed

**Files:**
- Create: `site/clips/seed/content.ts` (data only), `site/clips/seed/seed.ts`, `site/clips/seed/files.ts`

**Interfaces:**
- Consumes: `call`, `signUpAccount`, `Account` and `TestFile` from `e2e/support.ts`; `ClipName` from `site/.vitepress/theme/features.ts` (Task 3).
- Produces: `seedDemo(request: APIRequestContext): Promise<Demo>`, where
  `interface Demo { tenantId: string; slug: string; spaces: Record<'engineering' | 'clients' | 'handbook', { id: string; slug: string }>; people: Record<'priya' | 'tomas' | 'mei' | 'jonah', Account>; pages: Record<string, string> }`.
  `pages` is keyed by the content keys below. Also `accountsFor(clip: ClipName): Array<keyof Demo['people']>`:
  `co-edit` → `['priya', 'tomas']`, `review` → `['jonah', 'mei']`, and every other clip → `['priya']`. Also
  `makeDemoFiles(browser: Browser): Promise<TestFile[]>`, which returns a real PDF (an HTML page rendered with
  Chromium's `page.pdf()`) and a real XLSX (exceljs).

- [ ] **Step 1: Write `content.ts`.** The workspace is "Northwind Studio", a small product design studio, with these
  people: Priya Shah (owner), Tomás Reyes (editor), Mei Lin (reviewer of Clients), Jonah Okafor (editor). Spaces:
  Engineering (review off), Clients (review on), Handbook (review off). Write 18–22 pages of real substance in
  Markdown (3–10 lines each, with headings and lists). These keys are required, because the clips depend on them:
  - `harbor` (Clients): "Harbor & Co". Main contact Ruth Alvarez, launch on 14 November, and the brand guide they owe us.
  - `lumen` (Clients): "Lumen Health". The page clip 3 edits.
  - `roadmap` (Engineering): "Roadmap", a collection with fields Status (select: Planned, In progress, Blocked,
    Shipped), Owner (text), Start (date) and Due (date), and 10–12 child pages with values spread over October to
    December 2026. One child is `checkout`, "Checkout redesign" (In progress, for Harbor & Co).
  - `design-review` (Engineering): "Design review notes". The page clip 2 co-edits.
  - `office` (Handbook): "Office layout". The page clip 7 draws on.
  - `weekly` (Engineering): "Weekly notes". The page clip 8 links from.
  - `time-off` (Handbook): "Time off". New hires get 22 vacation days (the Ask clip's answer).
  Read `docs/superpowers/specs/2026-10-29-phase-c-collections-design.md` and `e2e/collection-views.spec.ts` for the
  field and timeline API before choosing the field types. The timeline view needs date fields.

- [ ] **Step 2: Implement `seedDemo`.** Sign up the four people with a per-run suffix in their emails
  (`@example.test`), create the tenant ("Northwind Studio", slug `northwind-<suffix>`), the spaces, members and
  grants (Mei is reviewer on Clients; everyone else is an editor), then the pages, the collection, the fields and
  their values. Snapshot every page (`POST /pages/:id/snapshot`), have Mei approve the Clients pages
  (`/reviews` → approve), and poll until every page's badge starts with `Indexed`. Then wait another 30 s so the
  worker can build the page cards that routing uses. Sign-ups stay under 10 a minute.

- [ ] **Step 3: Run the seed against the stack.** Start the stack with `docker compose up -d`, then run the seed from a scratch script under `site/clips/.work/`. Expected:
  it finishes without errors, and the workspace looks right when you sign in as Priya at `http://localhost:8080`
  (password `correct-horse-battery`): three spaces, a filled Roadmap, and every page with an "Indexed" badge.

- [ ] **Step 4: Check the content.** Run `pnpm site:check`. Expected: no findings in the seed content.

- [ ] **Step 5: Commit:** `feat(clips): Northwind Studio demo workspace seed`.

### Task 7: Clip toolkit

**Files:**
- Create: `site/clips/lib/timeline.ts`, `site/clips/lib/timeline.test.ts`, `site/clips/lib/recorder.ts`,
  `site/clips/lib/cursor.ts`, `site/clips/lib/encode.ts`, `site/clips/lib/types.ts`, `site/clips/run.ts`
- Modify: root `package.json` (`"clips": "tsx site/clips/run.ts"`)

**Interfaces:**
- Produces:
  - `timeline.ts`: `interface Frame { file: string; t: number }` (`t` in epoch ms),
    `interface Timeline { start: number; end: number; cuts: Array<[number, number]> }`, and
    `framesAt(frames: Frame[], tl: Timeline, fps: number): string[]`, which returns one file per output frame. Output
    time runs from `start` to `end`, skipping cut intervals. Each output frame shows the latest frame with `t` at or
    before that real time, or the first frame if there's none yet.
  - `recorder.ts`: `class Recorder { constructor(page: Page, dir: string); start(): Promise<void>; stop(): Promise<Frame[]> }`.
    It uses CDP `Page.startScreencast({ format: 'jpeg', quality: 92 })`, writes each frame to `dir`, acks it, and
    takes `t` from `metadata.timestamp * 1000`. `stop()` adds a copy of the last frame at the stop time so the tail
    holds.
  - `cursor.ts`: `installCursor(context: BrowserContext): Promise<void>` adds an init script that draws a 20 px arrow
    following `mousemove` and a 300 ms ripple on `mousedown`, both with `pointer-events: none` and the highest z-index.
    `glide(page: Page, target: Locator, o?: { click?: boolean }): Promise<void>` moves the mouse to the target's
    centre in 25 steps and then clicks unless `click: false`. `typeHuman(target: Locator, text: string): Promise<void>`
    uses `pressSequentially` with `delay: 28`.
  - `types.ts`: `type ClipName` (same union as `features.ts`; import it from there), and
    `interface Clip { name: ClipName; readme: boolean; layout: 'single' | 'side-by-side'; viewport: { width: number; height: number }; record(run: ClipRun): Promise<void> }`.
    Also `interface ClipRun { demo: Demo; pages: Page[]; request: APIRequestContext; start(): Promise<void>; cut<T>(fn: () => Promise<T>): Promise<T>; hold(ms: number): Promise<void> }`.
    `pages` has one entry for `single` and two for `side-by-side`, each already signed in as the account the clip
    names (see `accountsFor` below). Recording starts at `start()`, so the clip navigates first. `cut(fn)` runs `fn`
    and adds its interval to `cuts`, keeping the first 400 ms and the last 200 ms.
  - `encode.ts`: `encodeClip(name: ClipName, sequences: string[][], o: { fps: 30; readme: boolean; outDir: string; gifDir: string }): Promise<{ mp4: string; poster: string; gif?: string; seconds: number }>`.
    It writes an ffconcat list per sequence. For two sequences it `hstack`s them with a 24 px gap filled with
    `#fcfbf9`. It scales to a width of 1920 (`lanczos`) and encodes `libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart`.
    The poster is the last frame as `.jpg`. When `readme` is set, the GIF is made with `palettegen`/`paletteuse` at
    960 px and 12 fps; if it's over 5 MB it retries at 800 px and 10 fps, then 720 px and 8 fps, then throws.
  - `run.ts` takes the CLI `pnpm clips [name...]` (none means all, in Task 8–9 order). It reads `CLIPS_BASE_URL`
    (default `http://127.0.0.1:8080`) and checks that `/api/v1/me` answers, or exits with "Start the stack first:
    docker compose up -d". It reads `.env` and exits if `ROUTER_PROVIDER`, `ASK_PROVIDER` or `EMBEDDING_PROVIDER` is
    `deterministic`, unless `CLIPS_ALLOW_DETERMINISTIC=1` is set (for dry runs). Then it runs `seedDemo` (Task 6) once,
    and for each clip it launches Chromium with `deviceScaleFactor: 1.5` and the clip's viewport, installs the cursor,
    opens the pages, records, and encodes into `site/public/clips/` and `docs/assets/clips/`. Work files go under
    `site/clips/.work/<name>/`. At the end it prints a table of names, seconds and sizes, and warns when a clip is
    outside 10–25 s.

- [ ] **Step 1: Write the failing tests** in `site/clips/lib/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { framesAt } from './timeline';

const frames = [{ file: 'a', t: 0 }, { file: 'b', t: 100 }];
describe('framesAt', () => {
  it('samples the latest frame at each tick', () => {
    expect(framesAt(frames, { start: 0, end: 200, cuts: [] }, 10)).toEqual([...Array(10).fill('a'), ...Array(10).fill('b')]);
  });
  it('skips cut time', () => {
    expect(framesAt(frames, { start: 0, end: 200, cuts: [[50, 150]] }, 10)).toEqual([...Array(5).fill('a'), ...Array(5).fill('b')]);
  });
  it('uses the first frame before any frame exists', () => {
    expect(framesAt([{ file: 'x', t: 500 }], { start: 0, end: 100, cuts: [] }, 10)).toEqual(Array(10).fill('x'));
  });
  it('is empty when end is not after start', () => expect(framesAt(frames, { start: 100, end: 100, cuts: [] }, 10)).toEqual([]));
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run site/clips/lib/timeline.test.ts`. Expected:
  FAIL.

- [ ] **Step 3: Implement `framesAt`, then the recorder, cursor, encode and `run.ts`** to the signatures above.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run site/clips/lib/timeline.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Smoke-test the pipeline.** Add a throwaway clip under `site/clips/.work/` (not committed) that opens
  `/sign-in`, glides to the email field, types, and holds for 2 s. Run it against `pnpm e2e:local`'s stack or the
  compose stack with `CLIPS_ALLOW_DETERMINISTIC=1`. Expected: an MP4 of about 4 s, sharp text at full size, a visible
  cursor and ripple, and a GIF under 5 MB. Open the MP4 and look at it.

- [ ] **Step 6: Commit:** `feat(clips): screencast recorder, cutter and encoder`.

### Task 8: Clips 1–4: capture, co-edit, review, files

**Files:**
- Create: `site/clips/capture.clip.ts`, `site/clips/co-edit.clip.ts`, `site/clips/review.clip.ts`, `site/clips/files.clip.ts`
- Output: `site/public/clips/{capture,co-edit,review,files}.{mp4,jpg}`; `docs/assets/clips/{capture,co-edit,review}.gif`

**Interfaces:**
- Consumes: `Clip`, `ClipRun`, `glide`, `typeHuman` (Task 7); `Demo` (Task 6). Take selectors from
  `e2e/capture.spec.ts`, `e2e/co-edit.spec.ts`, `e2e/console.spec.ts`, `e2e/files.spec.ts`, `e2e/support.ts` and the
  components under `apps/web/src/components/capture/`.

Before this task, start the stack with the owner's `.env` (real models) by running `docker compose up -d`, and wait
for `http://localhost:8080`.

- [ ] **Step 1: Write `capture.clip.ts`** (`readme: true`, single, 1280×800). Start on the workspace home, glide to
  Capture in the sidebar, and type this note into "What do you want to file?": *"Call with Harbor & Co today: launch
  moves from 14 Nov to 28 Nov, and Daniel Cho takes over from Ruth Alvarez as their main contact. Let's pause the
  checkout redesign until their new brand guide arrives."* Send it, then `cut` the wait until the receipt card leaves
  `queued`/`routing`. If a follow-up question appears, glide to its first option, then `cut` the next wait. Hold
  2.5 s on the receipt, open the Harbor & Co page from it (with the change highlighted), and hold 3 s. Expected: the
  receipt shows at least two pages in two spaces. If it doesn't, re-run it; if it still doesn't after three runs,
  change the note's wording and say so in the commit message.

- [ ] **Step 2: Write `co-edit.clip.ts`** (`readme: true`, side-by-side, 960×800 each). Priya and Tomás have "Design
  review notes" open. Priya types a heading and a line, Tomás adds a bullet list under another heading while Priya
  is still typing, and both see each other's cursors and text. To show both people typing at the same moment, run
  the two typings with `Promise.all`. It's about 15 s long.

- [ ] **Step 3: Write `review.clip.ts`** (`readme: true`, side-by-side). Jonah adds a sentence to "Lumen Health" and
  runs Submit for review; his badge shows awaiting approval. Mei's side shows the review queue; reload it with
  `cut` if it doesn't update by itself. She opens the item, shows "Changes only", and clicks Approve. `cut` until
  Jonah's badge turns "Indexed", then hold 2 s.

- [ ] **Step 4: Write `files.clip.ts`** (`readme: false`, single). Upload `makeDemoFiles`' PDF ("Harbor & Co brand
  guide.pdf") and XLSX ("Q4 budget.xlsx") into Clients through the sidebar's Add menu, `cut` until both are
  extracted and waiting or indexed, open the PDF preview, then the XLSX preview, then search a phrase that only
  appears inside the PDF and show the result.

- [ ] **Step 5: Record them.** Run `pnpm clips capture co-edit review files`. Expected: four MP4s at 10–25 s, three
  GIFs at 5 MB or less, and the summary table printed.

- [ ] **Step 6: Watch every clip in full.** Check the text is crisp, the cursor is visible, there are no long
  spinners, no error toasts, nothing outside the demo content, and the result is right. Re-record any that fail.

- [ ] **Step 7: Run the site tests and commit.** Run `pnpm --filter @kinote/site test:site`. Expected: PASS, with the
  media test now strict for these four. Commit: `feat(clips): capture, co-edit, review and files clips`.

### Task 9: Clips 5–8: ask, collections, drawings, links

**Files:**
- Create: `site/clips/ask.clip.ts`, `site/clips/collections.clip.ts`, `site/clips/drawings.clip.ts`, `site/clips/links.clip.ts`
- Output: `site/public/clips/{ask,collections,drawings,links}.{mp4,jpg}`; `docs/assets/clips/collections.gif`

**Interfaces:**
- Consumes: the same as Task 8. Selectors come from `apps/web/src/routes/search.tsx` (`Search pages and files`, the
  `Answer` region, the `Sources` list), `e2e/collection-views.spec.ts`, `e2e/drawings.spec.ts`, `e2e/links.spec.ts`
  and `e2e/talk.spec.ts`.

- [ ] **Step 1: Write `ask.clip.ts`** (single). Ask "How many vacation days do new hires get?" on the search page,
  `cut` until the Answer shows, hold on the answer and its sources, then click the first source.

- [ ] **Step 2: Write `collections.clip.ts`** (`readme: true`, single). Open Roadmap, insert a Collection view block
  from the slash menu (table), scroll it into view, switch to board, drag "Checkout redesign" to Blocked, then show
  calendar and then timeline. It's about 20 s long.

- [ ] **Step 3: Write `drawings.clip.ts`** (single). On "Office layout", insert a Drawing, draw two rectangles
  (`r`), an arrow (`a`) and a text label (`t`, "Quiet room"), then click back into the page so the preview shows.

- [ ] **Step 4: Write `links.clip.ts`** (single). On "Weekly notes", type "Follow up with " and then `[[Harb`, pick
  Harbor & Co, click the link to open the side preview, and close it. Open Harbor & Co and show Connections with the
  backlink. Select a phrase, Add comment, type "Confirm the new date with Daniel", and Save.

- [ ] **Step 5: Record and watch them.** Run `pnpm clips ask collections drawings links`, then watch each one in full
  as in Task 8 Step 6.

- [ ] **Step 6: Run the site tests and commit.** Run `pnpm --filter @kinote/site test:site`. Expected: PASS for all
  eight clips. Commit: `feat(clips): ask, collections, drawings and links clips`.

### Task 10: README and social image

**Files:**
- Create: `README.md`, `site/public/social.png`, `site/scripts/social.ts`, `site/scripts/social.html`

**Interfaces:**
- Consumes: the logo (Task 2), the GIFs (Tasks 8–9), `hosted.json`, and `findReadmeIssues` (Task 1).

- [ ] **Step 1: Write `README.md`.** Use AFFiNE/Outline structure. Centre a `<picture>` logo (light and dark), the
  tagline, and one line of links (Website · Docs · Self-host · Try Kinote, where Try Kinote is the `hosted.json` URL)
  plus licence and stars badges. Then: the hero GIF `docs/assets/clips/capture.gif`; "What is Kinote" in three
  sentences; Features as short bold-lead bullets with the co-edit, review and collections GIFs interleaved (at most
  four GIFs in total), followed by the five in-development items, each labelled; Quick start (the three commands, then
  a link to the self-host docs); How it works (link to `site/public/architecture.svg` and one paragraph); Contributing
  (link to the contributing docs and `pnpm test`); and License (MIT, Shinox-lab). Keep it under about 150 lines.

- [ ] **Step 2: Render the social image.** Write `social.html`: 1280×640, logo, tagline and the hero poster in a
  framed window, using the light palette. `social.ts` renders it with Playwright to `site/public/social.png`.
  Run `tsx site/scripts/social.ts` and look at the PNG.

- [ ] **Step 3: Check everything.** Run `pnpm site:check && pnpm site:build && pnpm --filter @kinote/site test:site && pnpm test && pnpm typecheck`.
  Expected: all pass.

- [ ] **Step 4: Preview the README.** Render it with
  `gh api markdown -f text="$(cat README.md)" -f mode=gfm -f context=Shinox-lab/Kinote > site/clips/.work/readme.html`,
  open it, and check the layout. (Relative images only resolve once pushed; that's checked in Task 11.)

- [ ] **Step 5: Commit:** `docs: README and social preview image`.

### Task 11: Pages deployment and launch check

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `docs/kinote-standalone-design.md` (Progress table: one row for this work)

- [ ] **Step 1: Write the workflow.** It runs on `push` to `main` with `paths: ['site/**', 'README.md', '.github/workflows/pages.yml']`,
  and on `workflow_dispatch`. It has `permissions: { contents: read, pages: write, id-token: write }` and
  `concurrency: { group: pages, cancel-in-progress: true }`. The build job uses `pnpm/action-setup@v4` and
  `actions/setup-node@v4` (Node 22, pnpm cache), runs `pnpm install --frozen-lockfile --filter @kinote/site...`,
  `pnpm site:check` and `pnpm site:build`, then `actions/upload-pages-artifact@v3` with path
  `site/.vitepress/dist`. The deploy job uses `actions/deploy-pages@v4` with environment `github-pages`.

- [ ] **Step 2: Check the size.** Run `du -sh site/public/clips docs/assets/clips`. Expected: under 40 MB in total.
  If it's over, re-encode the MP4s at `-crf 23`.

- [ ] **Step 3: Update the Progress table and commit.** Add a row for "README, site and clips" and commit:
  `ci: deploy the site to GitHub Pages`.

- [ ] **Step 4: Push.** The owner approved pushing `main` once the site is ready. Run `git push origin main`, then
  `gh run watch` on the Pages workflow. Expected: the build and deploy jobs succeed.

- [ ] **Step 5: Do the live check.** Open `https://shinox-lab.github.io/Kinote/` at desktop and phone widths: the
  hero clip plays, every docs link works, and dark mode is right. Open `https://github.com/Shinox-lab/Kinote`: the
  README logo shows in both GitHub themes, the GIFs play, and the links resolve. Set the repo's social preview to
  `site/public/social.png` (Settings → General). This is a manual step for the owner; say so in the hand-off.
