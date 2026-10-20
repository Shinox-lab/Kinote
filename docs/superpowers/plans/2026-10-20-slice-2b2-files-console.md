# Slice 2b-2: Files Console, Viewers and Live Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person uploads files in the console, watches each one become text, reads it in a safe viewer, sees how it was cut for search, reviews it, and an admin runs the Sources page; everything proven in a real browser and on the real stack with Docling.

**Architecture:** Pure logic (routing by kind, the upload queue, file controls, viewer choice, CSV/XLSX caps, sanitiser, curl text) lives in `apps/web/src/lib` and `apps/web/src/viewers` and is unit-tested in Node; components stay thin and are proven by Playwright. Every viewer is a lazy chunk behind one error boundary. The server decides every status; the browser only colours it.

**Tech Stack:** React 19, TanStack Router + Query, Tailwind 4 tokens, Vite, Vitest (Node only; `jsdom` for the sanitiser tests), Playwright. New libraries (lazy only): `pdfjs-dist@6.4.299` (Apache-2.0), `mammoth@1.13.0` (BSD-2), `dompurify@3.4.17` (MPL-2.0/Apache-2.0), `read-excel-file@9.3.12` (MIT), `marked@18.1.1` (MIT); dev: `jsdom@30.1.3`. Check each library's current API with the Context7 docs before using it.

**Spec:** `docs/superpowers/specs/2026-10-20-slice-2b-sources-and-console-design.md` (Part 2, Part 3, edge cases 11–21). Backend it calls: Plans 2a and 2b-1 on this branch.

## Global Constraints

- No hard-coded palette colours: only the design tokens (`bg-page`, `text-muted`, `border-line`, `bg-danger-bg`, …). `apps/web/test/tokens.test.ts` enforces it for every file under `src`.
- Web tests are Node-only `*.test.ts` under `apps/web/test`; a test that needs a DOM starts with `// @vitest-environment jsdom`. Components are proven by Playwright (`pnpm e2e:local`, 17 specs today, must stay green).
- Never show a raw error code, `Error.message`, stack or extractor text: use `errorMessage(err)` (contract sentences) or a fixed sentence.
- Every viewer library is imported only from `apps/web/src/viewers/*` and only through `React.lazy(() => import(...))` or a dynamic `import()` inside a lazy module. The main bundle must not grow (checked in Task 10).
- File bytes are fetched with the session's Authorization header (`fetch`), never by putting a token in a URL, an `<img src>` or an `<iframe>`.
- Uploaded content never becomes live markup except through `sanitizeHtml` (allow-list below). Text paths (`<pre>`, table cells, chunk text) use React text nodes only.
- A person below `editor` reads only the file's indexed version (the server enforces it: 404 for anything else); the file page asks for that version, and says "Nothing has been published yet" when there is none.
- Accessibility already built stays: labelled controls, visible focus rings, Escape closes menus and returns focus, `prefers-reduced-motion` respected, live regions polite.
- Sanitiser allow-list (tags): `h1–h6 p br hr ul ol li blockquote pre code em strong i b u s sub sup table thead tbody tfoot tr th td caption a`; attributes: `href`, `title` on `a` only (schemes `http`, `https`, `mailto`; `rel="noopener noreferrer nofollow"` and `target="_blank"` forced); everything else, including `class`, `style`, `id`, `src`, `srcset`, is removed. Images are never loaded.
- Limits: CSV preview 1,000 rows; XLSX preview 200 rows × 26 columns per sheet; no in-browser preview above 25 MB (download card instead); viewer load timeout 15 s; upload queue polls a reading file every 2 s for at most 5 minutes.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work stays on `slice-2-files`.

## Review Focus

1. **A viewer-role person and a file with nothing published**: the file page shows "Nothing has been published yet", never bytes of an unreviewed version, never a loop of 404 retries (Task 5 e2e).
2. **Hostile content** (a Markdown file with `<script>` and `javascript:` links, a DOCX with HTML-looking text, a CSV cell `<img onerror>`, an XLSX cell `=HYPERLINK(...)`): never live markup, never evaluated (Tasks 6, 7, 10).
3. **The upload queue keeps going**: a refused file, a duplicate and a network error do not stop the others; navigating inside the console does not cancel it (Tasks 2, 10).
4. **No link ever lands a file id on the page route or the reverse**, from any list (Task 1 source scan, Task 10).
5. **A viewer that throws, hangs or meets a huge or truncated file** leaves the rest of the page working with a download link (Tasks 5–8, 10).

---

### Task 1: Routing by kind and the file API client

**Files:**
- Create: `apps/web/src/lib/documentLink.ts`, `apps/web/src/components/DocumentLink.tsx`, `apps/web/src/routes/file.tsx` (shell only: title + badge for now)
- Modify: `apps/web/src/router.tsx` (route `f/$fileId`), `apps/web/src/lib/api.ts` (file and source methods, below), `apps/web/src/lib/queries.ts` (hooks), `apps/web/src/lib/wiki.ts` (`badgeTone`, `badgeSettles` for file badges), `apps/web/src/lib/updates.ts` (file wording), `apps/web/src/components/icons.tsx` (`FileIcon`), and every link site: `components/Tree.tsx`, `components/sidebar/SpacesSection.tsx` (file rows become links with a file icon and the node's attention dot), `components/sidebar/UpdatesSection.tsx`, `routes/reviews.tsx`, `routes/search.tsx` (passages and citations link with the page), `routes/space.tsx`.
- Test: `apps/web/test/documentLink.test.ts`, extend `apps/web/test/updates.test.ts`, `apps/web/test/console.test.ts` (or `wiki.test.ts`) for badge tones, `apps/web/test/linkSites.test.ts`

**Interfaces:**
- Produces: `documentHref(tenantSlug: string, kind: 'page'|'file', id: string, opts?: { page?: number | null; version?: string }): string`; `parseFileSearch(search: Record<string, unknown>): { page?: number; v?: string }` (positive integers only; anything else dropped); `<DocumentLink kind id page? version? className? activeProps? children />` (renders the typed `Link` for the right route); route `/w/$tenantSlug/f/$fileId` with `validateSearch: parseFileSearch`; `FileIcon`.
- `api` additions (schemas from contracts; request bodies snake_case): `getFile(id): FileDetails`, `fileVersions(id): FileVersionList`, `uploadFile(form: FormData): UploadFileResponse`, `replaceFile(id, form): UploadFileResponse`, `moveFile(id, body: MoveFileRequest)`, `withdrawFile(id)`, `archiveFile(id)`, `restoreFile(id)`, `dismissRemoval(id)` (all `DocumentSummary`), `versionText(id): VersionText`, `versionChunks(id): ChunkInspector`, `versionFile(id): Promise<{ bytes: ArrayBuffer; mimeType: string }>` (authenticated `fetch`, error answers throw `ApiError` like `request`), `listSources(): SourceList`, `createSource(body)`, `updateSource(id, body)`, `issueSourceToken(id, body): CreateSourceTokenResponse`, `revokeSourceToken(id, tokenId): SourceToken`. `request()` no longer sets `content-type: application/json` when the body is a `FormData` (the browser must set the multipart boundary).
- Hooks: `useFile(id)` (`staleTime 0`, polls with `pagePoll` while its badge settles), `useFileVersions(id, enabled)`, `useVersionText(id, enabled)`, `useVersionChunks(id, enabled)`, `useSources(enabled)`; all keyed under the tenant like the others.

- [ ] **Step 0: Record the bundle baseline** before any change: `pnpm --filter @living-wiki/web build` and note the entry chunk's raw and gzip size from Vite's output in the ledger (Task 10 compares against it).
- [ ] **Step 1: Write the failing tests.**
  - `documentLink.test.ts`: `documentHref('acme','page',id)` is `/w/acme/p/{id}`; `('acme','file',id,{page:3})` is `/w/acme/f/{id}?page=3`; `{version:'v1'}` adds `v=v1`; `page: null`, `0`, `-2` and `1.5` add nothing; slug and id are URL-encoded; `parseFileSearch({page:'4',v:'x'})` is `{page:4,v:'x'}`, `{page:'abc'}` and `{page:'0'}` are `{}`, extra keys are dropped.
  - `linkSites.test.ts`: reads every `.tsx` under `apps/web/src` and asserts the string `"/w/$tenantSlug/p/$pageId"` appears only in an allow-list of files that can only mean a page (`routes/page.tsx` breadcrumb parents, `components/sidebar/NewPageRow.tsx` after creating a page, `components/DocumentLink.tsx`, `router.tsx`); a new link site that forgets `DocumentLink` fails the test.
  - Badge tones (extend the existing `badgeTone` test): `Reading text…` and `Indexing…` and `Not indexed (awaiting approval)` are `pending`; `Removed at source`, `Stored · no searchable text`, `Withdrawn` are `muted`; `Extraction failed` and `Index failed` are `danger`; `Indexed · v2` and `Indexed · v1, v2 awaiting approval` are `ok`; `badgeSettles` is true for `Reading text…`, `Indexing…`, `Indexed · v1, v2 being read` and `Indexed · v1, v2 indexing`, false for the rest.
  - `updates.test.ts`: file items read "{who} uploaded {title}" (version 1), "{who} replaced {title}" (version ≥ 2, indexed or pending), "{System · source} synced {title}" when `actor.type` is `system`, and the rejected, withdrawn and failed phrasings still name the version.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test`. Expected: FAIL (modules and strings missing).
- [ ] **Step 3: Implement** the helpers, route, `FileIcon`, `api` methods, hooks and the badge/updates changes. Replace each link site with `DocumentLink` (search passages and citations pass `page = pageFrom` for files). The sidebar's file row is a link (`FileIcon`, truncated name, `AttentionDot`), never the purple "editing" dot. The shell `FilePage` shows the file name as `<h1>` and the `Badge` (its label stays "Page status:" for pages; give `Badge` an optional `label` prop, default unchanged, so the file page says "File status:").
- [ ] **Step 4: Run** `pnpm vitest run apps/web/test`, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS (17/17).
- [ ] **Step 5: Commit** `feat(web): files route, links by kind and the files api client`.

---

### Task 2: Upload queue and its entry points

**Files:**
- Create: `apps/web/src/lib/uploadQueue.ts` (pure), `apps/web/src/lib/useUploads.tsx` (provider + hook), `apps/web/src/components/sidebar/UploadPanel.tsx`, `apps/web/src/components/AddMenu.tsx`, `apps/web/src/components/DropZone.tsx`
- Modify: `apps/web/src/routes/layout.tsx` (mount the provider and the panel above the router outlet so navigation does not cancel uploads), `apps/web/src/components/sidebar/SpacesSection.tsx` (the "+" on space and page rows opens `AddMenu`: "New page" runs the existing `NewPageRow`, "Upload file" opens a multiple-file picker targeting that space/parent), `apps/web/src/routes/space.tsx` (drop zone + "Upload" button, hidden for viewers and archived spaces), `apps/web/src/routes/workspace-home.tsx` (an "Upload" button targeting the Inbox)
- Test: `apps/web/test/uploadQueue.test.ts`, extend `apps/web/test/api.test.ts`

**Interfaces:**
- Produces (`uploadQueue.ts`): `type UploadStatus = 'waiting'|'uploading'|'reading'|'done'|'failed'|'duplicate'`; `interface UploadItem { id: string; fileName: string; size: number; spaceId: string | null; parentId: string | null; status: UploadStatus; documentId: string | null; badge: string | null; message: string | null; readingSince: number | null }`; `type UploadAction = { type:'add'; items: UploadItem[] } | { type:'start'; id } | { type:'uploaded'; id; documentId; unchanged: boolean; badge: string; now: number } | { type:'badge'; id; badge: string; now: number } | { type:'fail'; id; message: string } | { type:'retry'; id } | { type:'dismiss'; id }`; `reduceUploads(state: UploadItem[], action): UploadItem[]`; `nextToStart(state): UploadItem | null` (the first `waiting` item, and only when none is `uploading`); `readingDecision(item, now): 'poll' | 'give_up' | 'done'` (poll every 2 s, give up after 5 minutes with the message "Still reading — check the file later"); `statusLine(item): string` ("Waiting", "Uploading", "Reading text", the file's own badge when `done`, the plain sentence when `failed`, "Already here" when `duplicate`).
- `api.uploadFile(form)` is used with `FormData` fields `file`, optional `space_id`, `parent_id`.

- [ ] **Step 1: Write the failing tests.** `uploadQueue.test.ts`: adding three files yields three `waiting` items and `nextToStart` is the first; after `start(1)` nothing else starts until item 1 leaves `uploading`; `uploaded` with `unchanged: true` is `duplicate`, with a badge `Reading text…` is `reading`, with any other badge `done`; a `fail` does not block `nextToStart` from returning the next waiting item (five files where the 2nd fails and the 3rd is a duplicate: the others complete); `retry` puts a failed item back to `waiting` and clears its message; `dismiss` removes only `done`, `failed` and `duplicate` items (never one `uploading` or `reading`); `readingDecision` is `poll` before 5 minutes and `give_up` after, `done` once the badge no longer settles; `statusLine` for each status; a zero-byte file is refused locally with the sentence for `empty_file` without a request, and every other refusal uses the server's sentence (`errorMessage`). `api.test.ts`: `request()` with a `FormData` body sends no `content-type` header (and still sends it for a JSON string body); a 413 answer throws `ApiError('file_too_large')`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/uploadQueue.test.ts apps/web/test/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `uploadQueue.ts`, the `request()` change, `useUploads` (one effect: when `nextToStart` exists, upload it with `api.uploadFile`; on success invalidate `tree` and `reviews`; while an item is `reading`, poll `api.getFile` every 2 s per `readingDecision`; on `done` invalidate `tree`, `updates` and `reviews`), `UploadPanel` (bottom of the sidebar column, collapsible, `aria-live="polite"` region, each row a file name + status line + "Try again"/"Dismiss"/link to the file), `AddMenu` (a button with `aria-haspopup`, Escape closes and returns focus), `DropZone` (visible drag-over state "Drop to upload to {space}", also operable by keyboard through its "Upload" button). Entry points are absent for viewers and archived spaces (`canCreatePages(space.myRole)`).
- [ ] **Step 4: Run** the two test files, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): upload queue, drop zone and the add menu`.

---

### Task 3: The file page — header, actions, versions, banners

**Files:**
- Create: `apps/web/src/lib/fileUi.ts` (pure), `apps/web/src/components/FileMenu.tsx`, `apps/web/src/components/MoveFileDialog.tsx`, `apps/web/src/components/FileVersions.tsx`, `apps/web/src/lib/download.ts`
- Modify: `apps/web/src/routes/file.tsx` (real page), `apps/web/src/components/sidebar/OnThisPage.tsx` (for a file: the badge, Replace, Download, History, Chunks)
- Test: `apps/web/test/fileUi.test.ts`

**Interfaces:**
- Produces (`fileUi.ts`): `interface FileControlsInput { role: SpaceRole; spaceArchived: boolean; archived: boolean; placement: 'pinned'|'synced'; sourceDeleted: boolean; badge: string }`; `fileControls(input): { replace: boolean; move: boolean; withdraw: boolean; archive: boolean; restore: boolean; retry: boolean; dismissRemoval: boolean; download: boolean; chunks: boolean; managedBy: boolean }` (`replace` needs editor, not archived, not `synced`; `move` editor and not archived; `withdraw` reviewer; `archive`/`restore` admin; `retry` editor when the badge is `Extraction failed` or `Index failed`; `dismissRemoval` editor, `synced`, `sourceDeleted`, not archived; `chunks` editor; `managedBy` true for `synced`); `fileBanner(input: { badge: string; sourceDeleted: boolean; placement: 'pinned'|'synced'; hasPublished: boolean; role: SpaceRole }): { tone: BadgeTone; text: string } | null` with the fixed sentences below; `publishedVersionId(details: FileDetails, role: SpaceRole): string | null` (editors and above: the latest version; viewers: the indexed one or null); `downloadFileName(name: string): string`.
- Banner sentences: failed read → "This file could not be read. Try again, or upload a corrected copy."; failed index → "This file could not be indexed. Try again."; stored → "No searchable text was found in this file. It is kept for download."; removed at source → "This file was removed at its source." (+ "Dismiss" for an editor of a synced file); pinned and `sourceDeleted` → "The source that sent this file has removed it. It stays here, withdrawn."; awaiting approval (reviewers) → "This version is waiting for review."; nothing published for a viewer → "Nothing has been published yet."

- [ ] **Step 1: Write the failing tests** for each function above: the `fileControls` table (viewer, editor, reviewer, admin × synced/pinned × archived × failed/removed badges); `fileBanner` returns each sentence for its case and `null` for a healthy indexed file; `publishedVersionId` returns the latest for an editor, the indexed one for a viewer and `null` for a viewer when nothing is indexed; `downloadFileName` strips path separators and control characters and keeps the extension.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/fileUi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure module, then the page: breadcrumb (space, then each parent page, via `ancestorIds`), `<h1>` file name, `Badge` ("File status:"), the "…" menu (`FileMenu`, only the allowed items, none disabled), `MoveFileDialog` (space and parent page selects, the same options the page move uses), `FileVersions` (number, who, reason, status, date; each version links to `?v=`; editors only see versions they can read, viewers see the list but only the published one opens), banners, a `Retry` button for `retryVersion`, and `download` through `api.versionFile` + a temporary object URL (revoked after the click). Replace opens a file picker and uses `api.replaceFile`; after any action invalidate `file`, `tree`, `reviews`, `updates`. Archived: read-only with "Restore" for admins. A file that does not exist or is not readable shows the same "File not found" state (no distinction).
- [ ] **Step 4: Run** the test file, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the file page with actions, versions and banners`.

---

### Task 4: Chunk inspector and review-queue files

**Files:**
- Create: `apps/web/src/components/ChunkInspector.tsx`, `apps/web/src/components/FileReviewPreview.tsx`
- Modify: `apps/web/src/routes/file.tsx` (Chunks panel), `apps/web/src/routes/reviews.tsx` (file items), `apps/web/src/lib/review.ts`
- Test: extend `apps/web/test/review.test.ts`, new `apps/web/test/chunks.test.ts`

**Interfaces:**
- Produces: `previewLines(sections: ExtractedSection[], maxLines = 40): { lines: string[]; truncated: boolean }` (non-empty lines in order, text only); `chunkSummary(chunk): string` ("Pages 2–3 · 142 words", "Page 4 · 60 words", "142 words" when no page; the heading path joined with " › " is shown separately); `fileMeta(item: ReviewItem): string` ("PDF · 2.4 MB", type from the MIME table, size humanised with one decimal).

- [ ] **Step 1: Write the failing tests.** `previewLines` skips blank lines, stops at 40 and reports `truncated`; `chunkSummary` for single page, a range, none; `fileMeta` for PDF/DOCX/XLSX/PPTX/CSV/TXT/MD/image and an unknown MIME ("File"), sizes 0 B, 1,023 B, 1.5 KB, 2.4 MB; the review queue helper `approveBlockedReason` is unchanged for file items (extend an existing test with a file item).
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `ChunkInspector` (editors and above; fetches `useVersionChunks` only when opened; shows "Indexed" or "Not indexed yet — this is how the text would be cut", `ready: false` as "The text is still being read.", the page count and "Text read with OCR" when `ocrUsed`; numbered chunk cards with heading path, `chunkSummary` and the text as plain text in a `<pre>` that wraps). In the review queue a file item shows the `FileIcon`, name, `fileMeta`, space, a link to the file (`DocumentLink`) and "Show text" which fetches `useVersionChunks` on demand and renders `FileReviewPreview` (`previewLines`, page count, chunk count); there is no "Show changes" for files; Approve and Reject are unchanged.
- [ ] **Step 4: Run** the tests, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): chunk inspector and file items in the review queue`.

---

### Task 5: The viewer frame, text and image viewers, and the download card

**Files:**
- Create: `apps/web/src/lib/viewers.ts` (pure), `apps/web/src/viewers/FileViewer.tsx` (the frame), `apps/web/src/viewers/TextViewer.tsx`, `apps/web/src/viewers/ImageViewer.tsx`, `apps/web/src/viewers/DownloadCard.tsx`, `apps/web/src/viewers/ViewerBoundary.tsx`, `apps/web/src/viewers/useFileBytes.ts`
- Modify: `apps/web/src/routes/file.tsx` (render the frame for the published version; honours `?v=` for editors)
- Test: `apps/web/test/viewers.test.ts`, `apps/web/test/lazyViewers.test.ts`

**Interfaces:**
- Produces (`viewers.ts`): `type ViewerKind = 'markdown'|'text'|'csv'|'image'|'pdf'|'xlsx'|'docx'|'pptx'|'download'`; `viewerFor(mimeType: string, sizeBytes: number): ViewerKind` (from the MIME the server stored — read the table in `packages/core/src/files/detect.ts` for the exact strings — never from the file name; anything unknown or above `PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024` is `download`); `VIEWER_TIMEOUT_MS = 15_000`; `withTimeout<T>(promise, ms): Promise<T>` rejecting with a fixed `ViewerTimeout`. `useFileBytes(versionId)` (React Query on `api.versionFile`, `staleTime` long, no retry on 404).
- `FileViewer({ version: FileVersion, page?: number })` picks the viewer, renders it inside `<Suspense fallback={<Loading what="preview" />}>` and `ViewerBoundary` (class error boundary; fallback "This file can't be previewed." + the download link); `ImageViewer` makes an object URL from the bytes, revokes it on unmount, shows the image with `max-w-full`, alt = file name; `TextViewer` renders the text decoded as UTF-8 in a wrapping `<pre>`.

- [ ] **Step 1: Write the failing tests.** `viewers.test.ts`: `viewerFor` for every MIME the server can store (one case per type: `text/markdown`, `text/plain`, `text/csv`, the four image types, `application/pdf`, the three OOXML types, audio/video → `download`), an unknown MIME → `download`, a 26 MB PDF → `download`, a 24 MB one → `pdf`; `withTimeout` resolves a fast promise and rejects a slow one (fake timers). `lazyViewers.test.ts` (source scan): the strings `pdfjs-dist`, `mammoth`, `read-excel-file`, `marked`, `dompurify` appear in imports only under `src/viewers/`; `FileViewer.tsx` loads every viewer with `lazy(`; `src/routes/file.tsx` imports no viewer module statically except `FileViewer`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/viewers.test.ts apps/web/test/lazyViewers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure module and the frame with the text, image and download viewers; the other kinds fall back to `DownloadCard` until Tasks 6–8 replace them (write `FileViewer`'s registry as a `Record<ViewerKind, LazyExoticComponent>` with a `// replaced in Task N` marker for the three not yet built, which resolve to `DownloadCard`).
- [ ] **Step 4: Run** the two tests, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the file viewer frame with text, image and download viewers`.

---

### Task 6: The sanitiser, Markdown and DOCX viewers

**Files:**
- Create: `apps/web/src/viewers/sanitize.ts`, `apps/web/src/viewers/MarkdownViewer.tsx`, `apps/web/src/viewers/DocxViewer.tsx`, `apps/web/src/viewers/Html.tsx`
- Modify: `apps/web/src/viewers/FileViewer.tsx` (register both), `apps/web/package.json` (`marked`, `mammoth`, `dompurify`, `jsdom` dev), lockfile
- Test: `apps/web/test/sanitize.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Produces: `sanitizeHtml(dirty: string): string` — DOMPurify with the Global Constraints allow-list, all `src`/`srcset`/`style`/`class`/`id`/`on*` removed, link schemes limited to `http`, `https`, `mailto`, `rel`/`target` forced on every `a`, `<img>` and every non-listed tag dropped (its text kept); `markdownToHtml(source: string): string` (`marked` with raw HTML disabled, then `sanitizeHtml`); `<Html html={string} />` sets `dangerouslySetInnerHTML` only with a string that has just passed through `sanitizeHtml` (a test proves `Html` is the only place `dangerouslySetInnerHTML` appears in `src`); DOCX: `mammoth.convertToHtml({ arrayBuffer }, { convertImage: skip })` → `sanitizeHtml`.

- [ ] **Step 1: Write the failing tests** (hostile inputs, each asserted on the *output string and the parsed DOM*): `<script>alert(1)</script>` gone with its content; `<img src=x onerror=alert(1)>` gone; `<a href="javascript:alert(1)">x</a>` keeps the text, loses the `href`; the same with `JaVaScRiPt:` and with `java&#x73;cript:` and `data:text/html,…`; `<svg><script>`, `<iframe src>`, `<object>`, `<form action>`, `<style>@import url(x)</style>`, `<div style="background:url(x)">` all gone (text of `div` kept); `<a href="https://ok.example/a?b=1" class="x" onclick="y">` becomes `<a href="https://ok.example/a?b=1" rel="noopener noreferrer nofollow" target="_blank">`; nested `<table><tr><td>` survive; a 2 MB string of `<b>` finishes in under a second. `markdownToHtml('# T\n\n<script>x</script> [l](javascript:alert(1)) ![i](http://x/y.png)')` contains no `script`, no `javascript:`, no `<img`. A source scan: `dangerouslySetInnerHTML` appears only in `src/viewers/Html.tsx`.
- [ ] **Step 2: Run** `pnpm add -F @living-wiki/web marked@18.1.1 mammoth@1.13.0 dompurify@3.4.17 && pnpm add -D -F @living-wiki/web jsdom@30.1.3`, then `pnpm vitest run apps/web/test/sanitize.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `sanitize.ts` (a DOMPurify instance created lazily from `window`; an `afterSanitizeAttributes` hook sets `rel`/`target` on `a` and removes any `href` whose scheme is not allowed), the viewers and `Html`.
- [ ] **Step 4: Run** the test file, `pnpm typecheck`, `pnpm vitest run apps/web/test/tokens.test.ts`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): sanitiser with Markdown and DOCX viewers`.

---

### Task 7: CSV and XLSX viewers

**Files:**
- Create: `apps/web/src/lib/tablePreview.ts` (pure), `apps/web/src/viewers/CsvViewer.tsx`, `apps/web/src/viewers/XlsxViewer.tsx`, `apps/web/src/viewers/PreviewTable.tsx`
- Modify: `apps/web/src/viewers/FileViewer.tsx`, `apps/web/package.json` (`read-excel-file`)
- Test: `apps/web/test/tablePreview.test.ts`

**Interfaces:**
- Produces: `parseCsvRows(text: string, maxRows = 1000): { rows: string[][]; totalRows: number; truncated: boolean }` (RFC 4180 as `packages/core/src/files/textNative.ts` `parseCsv`: quoted cells, doubled quotes, line breaks in quotes, CRLF, a BOM; counts all rows but keeps only `maxRows`); `capSheet(rows: unknown[][], maxRows = 200, maxCols = 26): { rows: string[][]; rowCount: number; colCount: number; truncated: boolean }` (cell values rendered with `String(v ?? '')`, dates as ISO date, never evaluated); `columnLabel(index: number): string` (A, B, … Z, AA); `initialSheet(sheetCount: number, page: number | undefined): number` (the `?page=` sheet number, 1-based, clamped, default 0).
- `PreviewTable({ rows, header: boolean, caption })`: a scrolling `<table>` with a sticky header row; every cell is a React text node.

- [ ] **Step 1: Write the failing tests:** `parseCsvRows` with a BOM, CRLF, a quoted newline, `""` escapes, a trailing empty line, 1,500 rows → 1,000 kept and `totalRows 1500, truncated true`, a cell `<img src=x onerror=alert(1)>` returned verbatim as text; `capSheet` with 300 rows × 40 columns → 200 × 26 and `truncated`, `null`/`undefined`/numbers/booleans/`Date`/formula-looking strings (`=HYPERLINK("x")`) become plain strings unchanged; `columnLabel(0)`, `(25)`, `(26)`, `(701)` are `A`, `Z`, `AA`, `ZZ`; `initialSheet(3, 2)` is 1, `(3, 99)` is 2, `(3, undefined)` is 0, `(0, 5)` is 0.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/tablePreview.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure module and the viewers (`CsvViewer`: "Showing the first 1,000 of N rows" with the download link when truncated; `XlsxViewer`: sheet tabs as a `role="tablist"`, the first tab from `initialSheet`, "Showing the first 200 rows and 26 columns of this sheet" when truncated; `readXlsxFile(arrayBuffer)` loaded dynamically inside the viewer module, sheet names from the library's sheet listing; a workbook that fails to parse throws into `ViewerBoundary`).
- [ ] **Step 4: Run** the test file, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): CSV and XLSX viewers`.

---

### Task 8: PDF and PPTX viewers

**Files:**
- Create: `apps/web/src/lib/pdfPages.ts` (pure), `apps/web/src/viewers/PdfViewer.tsx`, `apps/web/src/viewers/PptxViewer.tsx`
- Modify: `apps/web/src/viewers/FileViewer.tsx`, `apps/web/vite.config.ts` only if the pdf.js worker needs a build rule, `apps/web/package.json` (`pdfjs-dist`)
- Test: `apps/web/test/pdfPages.test.ts`, extend `apps/web/test/lazyViewers.test.ts`

**Interfaces:**
- Produces (`pdfPages.ts`): `clampPage(page: number | undefined, pageCount: number): number` (1-based; missing, 0, negative or non-integer → 1; beyond the end → the last page); `zoomSteps = [0.75, 1, 1.25, 1.5, 2]` and `nextZoom(current: number, dir: 1 | -1): number`; `visiblePages(pageCount: number, viewportTop: number, viewportBottom: number, pageHeight: number, buffer = 1): number[]` (the page numbers to render, so a 500-page PDF renders only those near the viewport).
- `PdfViewer({ bytes: ArrayBuffer, page?: number })`: `getDocument({ data, isEvalSupported: false, enableScripting: false, disableAutoFetch: true, useSystemFonts: false })`; the worker loaded as a separate asset (`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` through `GlobalWorkerOptions.workerSrc`); pages drawn to `<canvas>` only when `visiblePages` says so; toolbar with Previous, Next, a page number input (labelled), zoom out/in, "Page N of M"; opens at `clampPage(page)`; no text layer. `PptxViewer({ versionId })`: `useVersionText(versionId)`, slides = sections, each a numbered card with its text in `<pre>`-style plain text, scrolls to `?page=`; when the text is not ready says "The text is still being read."

- [ ] **Step 1: Write the failing tests:** `clampPage(undefined,10)`, `(0,10)`, `(-3,10)`, `(2.5,10)` → 1; `(4,10)` → 4; `(99,10)` → 10; `(5,0)` → 1; `nextZoom(1, 1)` is 1.25, `nextZoom(2, 1)` is 2, `nextZoom(0.75, -1)` is 0.75, an off-grid `1.1` snaps to the next step in the direction; `visiblePages(500, 0, 900, 1000)` is `[1, 2]` with the buffer, `visiblePages(500, 250_000, 251_000, 1000)` is around page 251 only, never more than 6 pages. `lazyViewers.test.ts` additionally asserts the string `isEvalSupported: false` and `enableScripting: false` appear in `PdfViewer.tsx`.
- [ ] **Step 2: Run** `pnpm add -F @living-wiki/web pdfjs-dist@6.4.299`, then `pnpm vitest run apps/web/test/pdfPages.test.ts apps/web/test/lazyViewers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both viewers (a PDF with zero pages or one pdf.js rejects throws into `ViewerBoundary`; a `withTimeout` of `VIEWER_TIMEOUT_MS` wraps document loading; destroy the pdf.js document on unmount).
- [ ] **Step 4: Run** the tests, `pnpm typecheck`, `pnpm vitest run apps/web/test/tokens.test.ts`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): PDF and PPTX viewers`.

---

### Task 9: The Sources admin page

**Files:**
- Create: `apps/web/src/lib/sources.ts` (pure), `apps/web/src/routes/admin/sources.tsx`, `apps/web/src/components/SourceTokenModal.tsx`
- Modify: `apps/web/src/router.tsx` (route `admin/sources`), `apps/web/src/lib/console.ts` (`adminScreens` gets "Sources" for owners and admins), `apps/web/src/lib/queries.ts` if `useSources` needs `enabled`
- Test: `apps/web/test/sources.test.ts`, extend `apps/web/test/console.test.ts`

**Interfaces:**
- Produces (`sources.ts`): `curlExamples(o: { apiBase: string; token: string }): { put: string; delete: string }` (`curl -X PUT -H "Authorization: Bearer {token}" -F "file=@report.pdf" "{apiBase}/api/v1/source/files/reports/2026-q3"`, and the DELETE form; `apiBase` without a trailing slash; single-quote-safe); `sourceStatusLabel(source: Source): string` ("Active", "Paused"); `tokenState(t: SourceToken, now: Date): 'active'|'revoked'|'expired'`; `lastUsedLabel(t, now)` ("Never used", "Used 3h ago", via `relativeTime`).
- Page: list (name, target space, Trusted yes/no, status, items, last sync); "New source" form (name, target space select of live non-Inbox spaces); a source panel: rename, change target space, the **Trusted** switch with the text "Files from this source skip review unless the space requires it. Leave off unless you control what the script sends. Applies to files read from now on.", Pause/Resume, tokens list (name, prefix, created, last used, expires, state) with "New token" (name + optional expiry days) and "Revoke"; `SourceTokenModal` shows the new token once with a copy button (`navigator.clipboard`, falls back to select-all) and the two `curlExamples`, states "This token is shown once. It cannot be shown again." and a "Done" button; closing it removes the token from component state. Other roles see the existing "You don't have access" state.

- [ ] **Step 1: Write the failing tests:** `curlExamples` produces the exact strings above for `https://wiki.example.com/` (trailing slash removed) and quotes a token safely; `tokenState` for revoked, expired (past `expiresAt`) and active; `lastUsedLabel(null)`; `adminScreens('owner')` and `('admin')` include `Sources`, `('member')` and `('viewer')` do not.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/test/sources.test.ts apps/web/test/console.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure module, the page and modal (errors with `ErrorNote`; the token only ever lives in the modal's state; the list never receives a secret).
- [ ] **Step 4: Run** the tests, `pnpm typecheck`, `pnpm e2e:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the Sources admin page`.

---

### Task 10: Browser specs and the bundle report

**Files:**
- Create: `e2e/files.spec.ts`, `e2e/sources.spec.ts`, `e2e/fixtures/` (small files built in the spec: text, Markdown, CSV, a fake-extracted "PDF", a PNG, a truncated "PDF", an XLSX and DOCX written by helper functions), `scripts/bundle-report.mjs`
- Modify: `e2e/support.ts` (`uploadThroughUi(page, files)`, `putAsSource(request, token, id, file)`, `makeSource(request, world, o)`, `fakePdf(...pages)`), `package.json` (`"bundle:report"`)

**Interfaces:**
- `bundle-report.mjs`: after `pnpm --filter @living-wiki/web build`, prints the size (raw and gzip) of the entry chunk and each lazy chunk by name (pdf, docx, xlsx, markdown, sanitize), and exits 1 when any viewer library name appears in the entry chunk's text.

- [ ] **Step 1: Write the specs** (each fails first because the behaviour is wired in earlier tasks only partly; run to see the red ones, fix the console, not the spec).
  - `files.spec.ts`: (1) upload through the UI into a review-required space: the panel shows "Uploading", then "Reading text", then "Waiting for review"; the reviewer opens Reviews, expands "Show text" and sees the sentence; Approve; the badge reads "Indexed · v1"; search finds a sentence from page 2 and the result link opens `/f/{id}?page=2` with the PDF viewer on page 2 (assert the page input value). (2) Replace keeps the old version searchable until the new one is approved (two search assertions). (3) Several files at once: one unsupported (`.html`), one duplicate, one fine: the fine one completes, the others show their sentences, "Try again" works for a refused one after a network error simulated with `page.route` abort; the queue survives navigating to a page and back. (4) A corrupt "PDF" (truncated) and a corrupt DOCX show "This file can't be previewed." with a working Download, and the page still has its menu. (5) A viewer-role person sees only the published version, "Nothing has been published yet." on a file with only a waiting version, and no "…" menu items beyond Download. (6) Move into the Inbox and out; the sidebar tree follows. (7) Markdown and CSV hostile files render as text/inert markup (assert `page.locator('script')` count unchanged, no `img[onerror]`, no dialog event fired). (8) Keyboard: open the add menu with Enter, choose Upload, Escape closes and returns focus.
  - `sources.spec.ts`: admin creates a source and a token on the Sources page, the modal shows the token once and the `curl` text, after closing no `lwsrc_` text remains in the page; a script `PUT` (Playwright `request` with multipart) appears in the sidebar tree of the target space as a file row; `PUT` again with new bytes adds a version; `DELETE` makes the badge "Removed at source" and the sentence unsearchable; an editor dismisses it and it leaves the tree; a revoked token answers 401; a member sees no Sources tab and the Sources URL shows "You don't have access".
- [ ] **Step 2: Run** `pnpm e2e:local`. Expected: the new specs FAIL until the console behaviour is right; fix the console (not the specs) until all pass; the first 17 specs stay green.
- [ ] **Step 3: Write** `scripts/bundle-report.mjs` and run `pnpm --filter @living-wiki/web build && pnpm bundle:report`; compare the entry chunk with the baseline recorded in Task 1, Step 0.
- [ ] **Step 4: Run** `pnpm vitest run`, `pnpm typecheck`, `pnpm e2e:local`, `pnpm bundle:report`. Expected: all pass; the entry chunk is within 5 % of its size before this plan.
- [ ] **Step 5: Commit** `test(e2e): files and sources specs; bundle report`.

---

### Task 11: Live check and docs

**Files:**
- Create: `docs/live-checks/2026-10-slice-2-live-check.md`, `docs/live-checks/slice-2-live-check.mjs` (a script that drives the real api with fetch: sign up, create the workspace and space, upload, approve, search, ask, replace, source PUT/DELETE, second tenant checks)
- Modify: `docs/operations.md` (the extractor profile in `pnpm dev`: how to turn it on and what a fresh clone must build), `infra/dev.sh` (an `EXTRACTOR=1 pnpm dev` switch that adds `--profile extractor` and `EXTRACTOR_MODE=http`, off by default), `.env.example`, `README` section if one lists commands

- [ ] **Step 1: Bring the real stack up:** `pnpm stack:up` (migrates), then `EXTRACTOR_MODE=http docker compose --profile extractor up -d --build extractor worker api` (the first build downloads several gigabytes; record the image size and the build time). Expected: the extractor `/health` answers from inside the worker container; record the output.
- [ ] **Step 2: Run the script** against the real stack with these inputs, real outputs recorded in the document (write "Not run" for anything that could not be): a two-page PDF (a sentence per page), a real XLSX (two sheets), a photographed or rendered printed page (PNG with text), and a replaced PDF. Required observations: all three become searchable after approval; Ask cites the PDF with its page number; the replaced PDF keeps answering until its successor is approved; a script `PUT` then `DELETE` removes the file from search at once and `GET /files/:id` says `Removed at source`; extraction timings per file and the extractor container's memory at rest and during a PDF.
- [ ] **Step 3: Isolation and offline checks:** a second tenant sees none of it by API (a file route, search, a version download) and by SQL as the app role (`SET app.tenant_id` to the second tenant, `SELECT count(*)` on `documents`, `versions`, `chunks`, `sources`, `source_items`, `source_tokens` returns only its own); from inside the extractor container, `curl` to an external host and to the object store host both fail (record the commands and outputs); with the extractor stopped, a PDF upload ends with the plain sentence and Retry recovers it after the extractor is back.
- [ ] **Step 4: Browser pass** with the console on the real stack (`pnpm dev` with the extractor profile): upload the three files, open each in its viewer, open the chunk inspector, run the Sources page once; record anything that differs from the fake-extractor specs in the document.
- [ ] **Step 5: Write** the live-check document (what was run, exact outputs, "Not run" where applicable, the bundle numbers from Task 10, the Slice 2 acceptance sentence checked off line by line) and the docs changes; run `pnpm vitest run`, `pnpm typecheck`, `pnpm e2e:local`, `pnpm test:pg` (temporary database) one last time.
- [ ] **Step 6: Commit** `docs: Slice 2 live check and the extractor profile in pnpm dev`.
