# README, GitHub Pages site and feature clips — design

Date: 2026-10-30. Status: draft for the owner's review.
Builds on: `kinote-standalone-design.md` (Progress table), `2026-10-26-routing-engine-design.md`, `docs/operations.md`.

## Intent

Feature work stops after Phase C2. What's built is already a real product, so Kinote now needs a public front door: a
README, a GitHub Pages site with a landing page and documentation, and short clips that show each key feature working.

There are two audiences, in this order:
1. **Technical people** who might contribute to Kinote or self-host it for their own team. They decide from the README
   and the self-host docs whether it's worth `docker compose up`.
2. **Non-technical people** who will use the hosted Kinote service. It isn't live yet; every "Try Kinote" link points to
   one placeholder.

The one clip that has to sell Kinote is **capturing a note and watching it route to the right pages**.

## Goals

- A README in the style of AFFiNE's and Outline's: centred logo and tagline, the hero clip, feature highlights with
  visuals, quick start, self-hosting, architecture, contributing, and licence. It's scannable and links to the site for
  depth.
- A GitHub Pages site at `https://shinox-lab.github.io/Kinote/`, with a landing page (direction A, below) and
  documentation for both audiences.
- Eight short clips recorded from the real app running locally. The site gets MP4s and the README gets GIFs.
- An MIT licence.

## Non-goals

- No new product features, and no fixes to the known gaps listed in the main design's Progress section.
- No hosted sign-up, waitlist backend or analytics.
- No docs for routes or the internal API beyond what self-hosters and contributors need. No full API reference.
- No translations.

## Anti-goals (a failure even if it works)

- **Promising unbuilt features as if they work.** WhatsApp, Google Drive, MCP for external agents, space export and the
  self-maintaining wiki may appear in the main feature list, but each is labelled **"(In development)"**, gets one
  honest line and has no clip or how-to page.
- **Faked clips.** Every clip records the real app doing the real thing. Mocked UI, staged HTML or edited-in results
  are not allowed. Cutting idle waiting time is fine.
- **Leaking anything.** No API keys, `.env` values, internal hostnames or real people's names may appear in clips,
  screenshots or docs. Demo content uses invented people and a fictional company.
- **Internal language on public pages.** Public pages never mention "Shinox", "slice", "Phase C1b", "W1" and the like,
  and never use the name "Curator".
- **A README that's a wall of text.** Depth belongs on the site.

## Positioning and wording

- The headline feature is **routing**. You write something down once (a note, pasted meeting notes, a file) and Kinote
  edits the right pages across spaces, with a receipt, citations and Undo. A working hero line is *"Write it down once.
  Kinote files it everywhere it belongs."* The builder can refine it.
- Supporting features, all built, which the clips and docs must cover:
  live co-editing (people and agents on one page); review per space with page badges ("Indexed · v7", "awaiting
  approval"); files (PDF, Office, sheets, images) with previews and text extraction; the GridCraft spreadsheet editor;
  hybrid search and Ask with citations; links, backlinks and comments; collections with table, board, calendar and
  timeline views; drawings (Excalidraw); multi-tenant workspaces with row-level security; self-hostable with Docker
  Compose and bring-your-own OpenAI-compatible models.
- In development, labelled as such: WhatsApp groups as a source; Google Drive sync; MCP for external AI agents;
  self-maintaining wiki (follows changed sources, catches broken links and contradictions); space export to Markdown.
- Licence: MIT. Hosted-service links all read one setting (see "Placeholder link").

## Landing page (direction A, chosen by the owner)

It uses the app's own look: the warm-paper light palette and violet accent from `apps/web/src/index.css` (`--page`
`#fcfbf9`, `--sidebar` `#f5f2ed`, `--fg` `#24211d`, `--accent` `#6550c9`, and so on), the system sans font stack, and the
app's dark tokens for dark mode. It should read as calm and product-led, closer to Outline than to a dark developer
site.

Order, top to bottom:
1. Nav: logo, Features, Docs, GitHub (with star count if cheap; otherwise just the link).
2. Hero: headline, one-sentence sub-line, two buttons: **Try Kinote** (primary, placeholder link) and **Self-host**
   (secondary, goes to the self-host section or the quick-start doc). Under them, the routing clip in a framed window,
   autoplaying, muted, looping, `playsinline`, with a poster frame.
3. Feature rows that alternate left and right, each with a clip, a heading and two lines: co-editing, review, files and
   search, Ask, collections, drawings, links and comments.
4. A compact grid of smaller features (spreadsheet editor, multi-tenant with RLS, bring-your-own models, Docker
   Compose), with the in-development items in the same grid, visibly labelled.
5. Self-host section: the three commands, a line on what you get, and a link to the full guide.
6. Footer: MIT, GitHub, Docs.

It must work at phone width. Clips there scale down, never overflow, and do not autoplay when the visitor has
`prefers-reduced-motion` set (show the poster and a play button instead).

## Documentation outline

Docs content comes from the specs, `docs/operations.md`, `.env.example` and the code. Every behaviour described is
checked against the code or an e2e spec. Nothing is written from memory of the design if the code differs.

**Using Kinote** (written for non-technical readers, short pages, a clip or still on each):
- Workspaces, spaces and pages
- Capture and routing: what happens to a note, receipts, follow-up questions, Undo, "Wrong page → move to…"
- Editing together
- Review and the page badges: what each badge means, approving and rejecting, restoring a version
- Files: uploading, previews, the spreadsheet editor
- Search and Ask
- Collections and views
- Drawings
- Links, backlinks and comments
- Members and roles

**Self-hosting:**
- Quick start (Docker Compose, the six secrets, first sign-up)
- Configuration: every `.env` setting grouped as in `.env.example`, including connecting OpenAI-compatible embedding,
  Ask and routing models (for example OpenRouter), and what `deterministic` means
- Database roles and row-level security (from `docs/operations.md`)
- Ports, running behind a reverse proxy, `TRUST_PROXY`, Coolify
- Object storage (bundled MinIO or external S3)
- Upgrading and backups

**Contributing:**
- Repo layout and services (web, api, collab, worker, extractor, gridcraft) with an architecture diagram
- Running locally, the test suites (`pnpm test`, `pnpm test:pg`, `pnpm e2e`, `pnpm e2e:local`)
- How work is designed and planned (specs and plans under `docs/superpowers/`)
- Code conventions (from the "Conventions for plans" section of the main design, rewritten for outsiders)

**Roadmap:** one page listing the in-development items, with no dates.

## Clips

| # | Clip | Shows |
|---|---|---|
| 1 | Capture and routing (hero) | Typing a realistic note on the Capture page; the receipt filling in with the pages it changed; opening one page with the change highlighted. If a follow-up question appears, answering it is part of the clip. |
| 2 | Editing together | Two people on one page, side by side, with cursors and text appearing live. |
| 3 | Review | An edit in a review space shows "awaiting approval"; a reviewer approves it in the review queue; the badge turns "Indexed". |
| 4 | Files | Dropping a PDF and a spreadsheet; the preview appears; a search finds text from inside the file. |
| 5 | Ask | Asking a question and getting an answer with citations; clicking a citation opens the source. |
| 6 | Collections | One collection switching between table, board, calendar and timeline, with one card dragged on the board. |
| 7 | Drawings | Adding a drawing block, sketching, and seeing the preview on the page. |
| 8 | Links and comments | Typing `[[` to link a page, opening backlinks on the target, and leaving a comment. |

Each clip is 10 to 25 seconds long. The quality bar:
- **Real models.** Clips record against the full compose stack (`docker compose up`, web on 8080) using the owner's
  configured OpenAI-compatible models, so routing and Ask show real behaviour. The e2e scripts force `deterministic`,
  so the clip scripts must not use `infra/e2e.sh`.
- **Readable.** Recorded at 1280×800 or larger, with text crisp at the size the site shows it. If Playwright's
  `recordVideo` output is too soft, record with a higher-quality method (for example CDP screencast frames assembled by
  ffmpeg, which is installed).
- **Followable.** Headless recordings have no cursor, so the scripts inject a visible cursor and click ripple.
  Typing is human-paced.
- **Tight.** Waiting on models or the worker is cut or sped up in post, never shown as a long spinner. A clip that
  depends on the model's wording is re-recorded if the result looks wrong.
- **Light theme**, a clean demo workspace, and no browser chrome other than an optional drawn window frame.
- **Outputs:** `*.mp4` (H.264, web-optimised) and a `*.jpg` poster for the site; a `*.gif` for the README, each under
  about 5 MB (palette-optimised, lower frame rate and width as needed). The README uses the hero GIF and two or three
  others at most.
- **Repeatable.** One command (for example `pnpm clips`, or `pnpm clips capture` for one clip) seeds a fresh demo
  workspace through the API, records, and post-processes. The clips are re-recorded whenever the UI changes.

**Demo workspace.** "Northwind Studio" or a similar fictional company, with three spaces (for example Engineering,
Clients with review on, and Handbook), 15 to 25 realistic pages with substance, a collection with a dozen rows that
have dates and statuses, two or three files, and three or four invented members. It's seeded through the public API
like `e2e/support.ts` does, so it works against any running stack. The routing clip's note must touch at least two
pages in two spaces, so the receipt shows routing doing real work.

## Assets

- **Logo:** Kinote has none. Make a simple mark plus wordmark in the accent violet, as SVG, with light and dark
  variants, and use it for the README header, the site and the favicon. Adding it to the app itself is out of scope.
- A social preview image (1280×640) for the repo and the site's Open Graph tags.

## Where things live (builder's call unless noted)

- `README.md` and `LICENSE` at the repo root.
- The site uses VitePress (my call, accepted by the owner). The landing page is a custom home layout; the docs are
  Markdown. It lives in its own folder such as `site/`, as a workspace package or standalone, whichever keeps the
  monorepo's install and typecheck clean.
- Clip scripts and their Playwright config sit beside the site, not mixed into `e2e/`, so `pnpm e2e` never runs them.
- Clip outputs: MP4s and posters under the site's public folder; README GIFs in a folder the README links relatively
  (for example `docs/assets/`). Check that the repo size stays reasonable.
- Deployment: a GitHub Actions workflow builds the site and deploys it to Pages on every push to `main` that touches
  the site. The base path is `/Kinote/`. The owner has set Pages to deploy from GitHub Actions and approved pushing
  `main` once the site is ready (2026-10-30).
- `LICENSE`: MIT, copyright "Shinox-lab" (owner's answer).

## Placeholder link

There's one setting for the hosted-service URL, used by every "Try Kinote" link in the README and on the site. Until
the service is live, it points to a short "Hosted Kinote is coming soon" section on the landing page, not to a made-up
domain. (My call.)

## Done means

- The README renders well on GitHub in light and dark, with the hero GIF playing.
- The site builds locally and in CI, works at 375 px and desktop widths in both themes, and every docs link resolves.
- All eight clips exist in both formats and were recorded from the real app.
- Every "(In development)" item is labelled everywhere it appears.
- A search of the README, site and clip text finds none of the internal terms listed under "Anti-goals".
