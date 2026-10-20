# Slice 2b: Upload API, Files console and live check — design

Date: 2026-10-20. Builds on Plan 2a (the files ingest backend, branch `slice-2-files`, head `1321d8a`, not yet merged).
Parent specs: `docs/2026-10-18-living-wiki-standalone-design.md` and `docs/superpowers/specs/2026-10-20-slice-2-files-design.md`
(the "Slice 2 spec"). Where this document and the Slice 2 spec differ, this one wins for 2b and the difference is listed
under "Calls made by the author".

## Intent

After 2a, the backend can take a file, read it, review it, index it and cite it, but only through API calls: a person has
no button to press, and a script has no way in. Slice 2b finishes Slice 2. A person drops files into the console, watches
each one become text, reads it in a viewer, sees exactly how it was cut for search, and reviews it. A tenant admin creates
a *source*, hands a script a token, and the script keeps a folder of files in sync, including deletes.

The slice proves the Slice 2 story end to end in a real browser and on the real stack: *a member drops a PDF, an XLSX and
a photo of a printed page into a review space; a reviewer approves them from the queue; search finds a sentence from each
and opens the PDF at the right page; a corrected PDF keeps the old one answering until it is approved; a script's `DELETE`
removes a file from search at once and the file shows "Removed at source".*

## Goals

1. **Sources.** A tenant admin creates an `upload_api` source (name, one target space, `trusted` off by default), issues
   and revokes its tokens, pauses it. Tokens are shown once.
2. **Script routes.** `PUT` creates or replaces a file by `external_id`; `DELETE` removes it from the index in the same
   transaction. Everything a script does is audited as "System · {source name}".
3. **Trusted switch.** A connector's version needs review unless its source is trusted; a trusted source then follows the
   space's own rule. Agent versions always need review.
4. **Upload from the console.** Button and drag-and-drop, several files, one at a time, a visible state for each file,
   plain sentences on failure.
5. **File page.** Name, badge, viewer, versions, replace, move, withdraw, archive/restore, download, and the chunk inspector.
6. **Files everywhere a page is.** Sidebar tree, Updates, breadcrumbs, review queue and search results link to the right
   screen for the kind of document, and a search hit on a file opens it at the passage's page.
7. **Viewers** for Markdown, text, CSV, images, PDF, XLSX, DOCX and PPTX, each loaded lazily and each failing safe.
8. **Sources admin page.**
9. **Proof.** Playwright specs on the fake extractor, `pnpm test:pg` for the new database paths, and a live check against
   the real stack with Docling written to `docs/live-checks/2026-10-slice-2-live-check.md`.
10. **2a loose ends** that this slice's screens would otherwise expose (listed under "Carried over from 2a").

## Non-goals (this slice)

- Google Drive, WhatsApp and every connector but `upload_api`; `source_mappings`, `secrets`, cursors, reconcile.
- MCP `upload_file`, agent tokens (Slice 3). A source token cannot call any other route.
- Editing a file in the browser, renaming a file, a text diff between two file versions ("Show changes" for files).
- Resumable or chunked uploads, upload progress percentages (a file is "Uploading" until the request returns).
- Per-token rate limits and quotas (Slice 7). Purge, orphan-object cleanup, drift repair (Slice 7).
- Legacy Office formats, archives, audio/video playback (stored files offer download only).
- Thumbnails, full-text search *inside* a viewer, annotation, a PDF toolbar beyond page up/down and zoom.

## Anti-goals (a failure even if it technically works)

- **A token that does more than its source.** A source token reaches exactly two routes, for exactly one source, in
  exactly one tenant. It never opens a session, never reads a page, never lists files, and a script can learn nothing about
  documents it did not create (an `external_id` it did not use is 404).
- **A token that leaks.** The secret is shown once, stored only as a hash, never logged, never in an audit payload, never
  in a URL, never in an error. Authentication failures are all the same 401 with the same sentence.
- **A delete that lingers.** After `DELETE` returns, no search or Ask answer contains the file, even if its extraction or
  indexing was running. A job already in flight must not put the file back.
- **A viewer that runs content.** No uploaded byte becomes HTML, script, a style or an `<iframe>` in the console except
  through a sanitiser whose configuration is under test. The PDF viewer cannot evaluate code from a PDF. A crashing viewer
  leaves the rest of the page standing.
- **A heavy console.** No viewer library in the main bundle. First paint of the workspace does not grow.
- **A wrong link.** Following any file item, from any list, never lands on a 404 or a blank page.
- A browser that decides status, or shows a raw error code, an `Error.message`, a stack trace or an extractor's text.
- Breaking Slice 0/1/2a behaviour, tests, the sidebar console, theme tokens or accessibility already built.

## Rules kept

All of the Slice 2 spec's rules, plus: a person's move pins a file and a sync never moves it (rule 5); a script's actor is its
source (rule 14); `trusted` never lets an agent's work skip review.

## Carried over from 2a (fixed here because 2b's screens expose them)

1. **Links by kind.** Every list that links a document picks its route from `document.kind` (today everything goes to the
   page route, and a file id there is 404).
2. **`hasText`.** `FileVersion.hasText` currently means "an extracted file exists". It becomes "the version has searchable
   text": true when `extractedKey` is set and the version is not `stored`. The console uses it to decide whether to offer the
   chunk inspector.
3. **Two pending versions.** A move into a review space returns the indexed version to review while a newer version may still be
   `extracting`. The returned version stays as it is; when the newer one reaches `pending_review`, `extractVersion` marks every
   other `pending_review` version of that document `superseded` in the same transaction (the page rule: a reviewer reviews
   the newest state). If the newer one ends `stored` or `failed`, the returned older version stays waiting for a reviewer.
4. **Over-long table row** keeps its header (the row alone is split, each piece prefixed with the header) and a CSV with a
   quoted newline is not cut mid-record.
5. **`ensureBucket` race** at first start: tolerate "bucket already owned" from a concurrent api or worker.

The rest of 2a's deferred minors stay deferred (downloads buffered rather than streamed, unpinned transitive Python
dependencies, `ocrUsed` only for images, abandoned extractor requests continuing, non-Docling exceptions retried as 500).

## Part 1 — Sources backend (Plan 2b-1)

### Schema (`0012` generated by Drizzle; `0013` custom for RLS and grants, the 0008/0009 pattern)

- **`sources`**: `id`, `tenant_id`, `kind` (`upload_api`), `name` (1–80 characters, unique per tenant, case-insensitive),
  `target_space_id`, `trusted` (default false), `status` (`active` | `paused`), `last_sync_at` (set by any successful
  `PUT` or `DELETE`), `created_by`, `created_at`. A source is paused, never removed, so audit rows and documents keep a meaning: `0013` revokes DELETE on `sources` from
  the app role (the default privileges of `0004` grant it on every new table), and a test proves the app role cannot delete.
- **`source_items`**: `tenant_id`, `source_id`, `external_id`, `document_id`, `content_hash`, `last_seen_at`, `deleted_at`;
  primary key (`tenant_id`, `source_id`, `external_id`); unique on `document_id`.
- **`source_tokens`**: `id`, `tenant_id`, `source_id`, `name` (1–80 characters, what the admin calls it), `token_hash`
  (unique), `token_prefix` (the first 8 characters of the secret part, for the admin's list), `expires_at` (nullable),
  `last_used_at`, `revoked_at`, `created_by`, `created_at`.
- `documents.source_id` gains a foreign key to `sources`. Every new table gets tenant-scoped RLS, FORCE (in `0013`, generated with `gen-rls.mjs`), and the
  missing-`app.tenant_id` test.

### Token format and authentication

- A token is `lws_{tenantId without dashes}.{secret}`, the secret being 32 random bytes in base64url. The tenant id is not
  secret; it lets the api open the tenant transaction (so RLS stays on) before it can look the token up. The lookup is by
  `sha-256(token)` inside `withTenantTx`, then checks `revoked_at`, `expires_at` and the token's source `status = 'active'`. The target space is *not* an
  authentication matter (see PUT and DELETE below). A malformed token, an unknown tenant, an unknown hash, a revoked, expired or paused
  one, and a token used on a tenant other than its own all answer the same 401 `unauthenticated`.
- A new route auth mode `'source'` next to `public | session | tenant`. A source route receives a `SourceActor`
  `{ tenantId, sourceId, sourceName, trusted, targetSpaceId }` and never an `Actor`. The `x-tenant-id` header is ignored.
- `last_used_at` is updated at most once a minute per token (a plain conditional update, not a write per request).
- Session routes reject a source token and source routes reject a session token; both with the same 401.

### Admin routes (tenant owner or admin, session auth)

`POST /api/v1/sources`, `GET /api/v1/sources`, `PATCH /api/v1/sources/:id` (name, target space, `trusted`, `status`),
`POST /api/v1/sources/:id/tokens` (name, optional `expires_in_days` 1–3650; reply carries the token string once),
`DELETE /api/v1/sources/:id/tokens/:tokenId` (revokes; repeated revoke is 200). `GET /sources` returns each source with
its target space name, item count, last sync, and its tokens (name, prefix, created, last used, expires, revoked) — never a
hash and never a secret. The target space must be a live, non-Inbox space (409 `space_archived` for archived; a new code
is not needed for Inbox: an Inbox target is a validation error). Anyone else is 403, a source of another tenant is 404
`source_not_found`. Changing the target space moves *future* files only; existing documents stay where they are.

### Script routes (source token)

| Route | Behaviour |
|---|---|
| `PUT /api/v1/source/files/:externalId` | Multipart, one file part, no other fields. Creates or replaces. Reply `{ document, version, unchanged, created }` |
| `DELETE /api/v1/source/files/:externalId` | Runs the delete path. Reply `{ removed: true }` |

`externalId` is URL-decoded, 1–256 characters, no control characters; anything else is 400 `validation_failed`.

**PUT** shares everything with a person's upload (type detection, size limit, name cleaning, object storage, `insertFileVersion`)
and differs only in who and where:
- The version is authored `connector` / source id, reason `source`; the document is `created_by_type = 'connector'`,
  `source_id`, `external_id`, `placement = 'synced'`, in the source's target space, never under a page.
- Lookup is by (`source_id`, `external_id`) in `source_items`, inside the document lock. New id → new document, version 1,
  `source_items` row. Known id → a replace of that document, wherever a person may since have moved it (the sync updates
  content, never place). No space-level duplicate check applies to a source: its identity is the `external_id`, so two ids
  with the same bytes are two documents.
- **`unchanged`** means the bytes equal `source_items.content_hash`, the bytes this source last sent (200, no version, no job),
  whatever the document's latest version is. So a person's own replacement of a pinned file is not overwritten by the next
  identical `PUT`, and a file a person withdrew is not reawakened by it. A source-deleted document is never `unchanged`.
- A source-deleted document is **revived** by any `PUT`: `source_deleted_at` and `source_items.deleted_at` are cleared, any
  archive on it is lifted (the source removed the file, then sent it again, so whoever archived it did so in response to
  the removal), and a new version follows the normal review rules. No new column records where an archive came from.
- A document archived while *not* removed at source (a person archived it on purpose) is not touched by a `PUT`: 409 with the
  file-archived sentence (`page_archived`), whatever the bytes; the script's author sees it and the admin decides.
- The document's current space archived → 409 `space_archived`. For a new file the target space archived is the same 409.
  `DELETE` is never refused for an archived space: removing is always allowed (rule 9).
- Each `PUT` writes `source_items.content_hash` and `last_seen_at`, sets `sources.last_sync_at`, and one audit event
  (`file.uploaded` for a new document, `version.created` for a replace) with actor `connector` / source id.
- Two simultaneous `PUT`s of the same `external_id` serialise on the document lock (or, for a new id, on an advisory lock
  keyed `tenant:source:external_id`) and produce one document.

**DELETE**: in one transaction, document locked first: `source_items.deleted_at` and `documents.source_deleted_at` set; every
live version (`extracting`, `stored`, `pending_review`, `indexing`, `indexed`) becomes `withdrawn`; the document's chunks
are deleted; one `source.item_deleted` audit event. An unknown `external_id` (or one this source never created) is 404
`document_not_found`; an id already deleted answers 200 `{ removed: true }` again with no new event. The `file.extract` and
`version.index` jobs treat a document with `source_deleted_at` set like an archived one: the version is settled `withdrawn`
and nothing is written to the index.

`POST /api/v1/files/:id/dismiss-removal` (editor): only for a `synced` file with `source_deleted_at` set; archives it
(audited as `file.archived`). A `pinned` file that lost its source stays withdrawn and listed, with the note "Removed at
source" on its page; a space admin archives it like any file. A file that is not synced-and-removed answers 409
`not_removed` (new code, "This file has not been removed at its source."); a file the person cannot see is 404
`document_not_found`; a role below editor is 403.

### Trusted switch in `extractVersion`

`needsReview = space.reviewRequired || createdByType === 'agent' || (createdByType === 'connector' && !source.trusted)`. The
source row is read in the same transaction as the space; a connector version whose source row is missing is untrusted.
Changing `trusted` affects only versions extracted after the change. The Sources page says so.

### What a viewer may read (a change to 2a's read routes)

A person below `editor` in the file's space may read the *bytes* (`GET /versions/:id/file`) and the text of the document's
**indexed version only**; any other version (waiting, rejected, withdrawn, superseded, failed, stored) answers 404
`version_not_found` for them. Editors and above read every version, as today. `GET /files/:id` and the version list stay
open to viewers (metadata only), and the file page opens a viewer on the indexed version, or says "Nothing has been
published yet" when there is none. A new route **`GET /api/v1/versions/:id/text`** (same rule as the file route: viewer on
the indexed version, any version for editors) returns `{ versionId, pageCount, ocrUsed, sections }` without chunks; the PPTX
preview uses it so a viewer gets the same preview an editor does. `GET /versions/:id/chunks` stays editor-only.

### Audit

`source.created`, `source.updated` (name, target, trusted, status — before and after), `source.token_issued` (token id and
name, never the secret), `source.token_revoked`, `source.item_deleted`. Every one records the admin (or source) as actor.
`source.updated`, `source.token_issued` and `source.token_revoked` are new members of the audit type list.

## Part 2 — Console (Plan 2b-2)

Layout, tokens and behaviour follow the Notion-style console already built: no hard-coded palette classes (the tokens test
enforces it), focus rings, labelled controls, Escape closes menus, reduced motion respected.

### Routing by kind

- A new route `/w/$tenantSlug/f/$fileId` for files, with optional search params `page` (a positive integer) and `v` (a version
  id). The page route keeps answering pages only.
- One helper in `apps/web/src/lib` — `documentTarget(kind, id, options?)` → `{ to, params, search? }` — is the only place
  that knows both routes. The sidebar tree, Tree, Updates, review queue, search results, breadcrumbs, the space page's page
  list and the workspace home all use it. A test fails if a component links to `/p/$pageId` with a value that can be a file.
- Search results for a file passage link to the file route with `page = pageFrom`; a passage with no page number opens the
  file at its first page. The passage text is shown as today.
- A file's breadcrumb is its space, then each parent page, as for a page.
- `GET /api/v1/spaces/:id/tree` already returns file nodes; the sidebar shows them with a file icon and the same dot
  rules (red failed, amber waiting for review or removed at source). Files never show the purple "editing" dot.

### Upload

- **Entry points:** the "+" on a space row and on a page row becomes a small menu, "New page" and "Upload file" (a file
  picker, multiple); the space page and the page-list view get a drop zone and an "Upload" button; the workspace home gets
  an "Upload" button targeting the Inbox. A person who is a viewer in the space sees none of these.
- **Queue.** One `UploadQueue` held above the router (so navigating inside the console does not cancel it). Files upload
  strictly one at a time through `POST /files` (multipart; `parent_id` when dropped on a page). Each file has a state:
  *Waiting*, *Uploading*, *Reading text* (the version is `extracting`; the queue polls `GET /files/:id` every 2 s, up to
  5 minutes, then stops polling and shows "Still reading — check the file later"), then the file's own badge
  ("Waiting for review", "Searchable", "Stored", "Failed…"), or the plain sentence for a refusal. A duplicate answers "Already
  here" with a link to the existing file. Failed items offer "Try again" (re-send, not retry-extraction) and "Dismiss".
- **Where it shows:** a quiet panel anchored to the bottom of the sidebar column, listing the files from this session;
  collapsible; announced to screen readers through a polite live region; it disappears when empty and dismissable
  items clear. Drag-over shows a visible drop target and says where the files will go ("Drop to upload to {space}").
- Client-side checks are courtesy only (a zero-byte file is not sent); the size limit is the server's, shown from its 413
  sentence. The server's answer is always the one shown.

### File page

- **Header:** breadcrumb, file name as the title (read-only), the server's badge, a "…" menu: Replace (a file picker),
  Move (the existing move dialog pattern for pages, space and parent), Withdraw, Archive / Restore, Download. Items the
  person's role cannot use are absent, not disabled. A synced file shows no Replace and says "Managed by {source name}".
- **Body:** the viewer for the indexed version for viewers, and for the latest version for editors and above (a person who cannot read
  the file at all gets the not-found state; a viewer with nothing published yet gets "Nothing has been published yet"). Below or beside it (right column on wide screens, a tab on narrow ones): **Versions** (number, who,
  reason, status, date; each opens its own viewer through `?v=`; reuses the history drawer styling) and **Chunks**.
- **Banners:** the server's badge explains the state in a sentence: failed (with Retry for editors), stored with no
  readable text, removed at source (with "Dismiss" for an editor of a synced file), waiting for review (with a link to the
  review screen for reviewers).
- **Chunk inspector** (editors and above): fetches `GET /versions/:id/chunks`, shows the extracted text and the chunks as
  numbered cards with heading path, page range and word count, and a plain note "Indexed" or "Not indexed yet — this is how
  the text would be cut". Chunks are computed text only; rendering is as plain text, never markup.
- Archived file: read-only with "Restore" for space admins.

### Review queue and Updates

- The review queue lists each file item with its file icon, name, type, size and space; "Show text" expands a preview fetched
  on demand from `GET /versions/:id/chunks` (first 40 lines of the extracted text, page count, chunk count) and links to the
  file page for the full viewer. Approve and reject use the existing buttons and rules. "Show changes" does not appear for
  files.
- Updates sentences for files: "{who} uploaded {title}" (first version), "{who} replaced {title}" (v2 and later),
  "{System · source} synced {title}" for source versions. Rejected, withdrawn and failed phrasing stays. A source delete
  creates no version and so no Updates line: it shows on the file's badge and as an amber dot in the tree.

### Viewers

All in `apps/web/src/viewers/`, one lazy chunk each (`React.lazy` with a dynamic `import()`), picked by the file's MIME
type from the version (never from its name), each wrapped in an error boundary whose fallback is "This file can't be
previewed. Download it" with the download link. Bytes come from `GET /versions/:id/file` with the session token (a fetch,
not an `<img src>` or `<iframe>`), turned into a `Blob`/`ArrayBuffer` in the browser.

| Type | Viewer | Rules |
|---|---|---|
| Markdown | `marked`-style parser → sanitised HTML | Raw HTML in the source is dropped, not escaped into view; links get `rel="noopener noreferrer nofollow"` and `target="_blank"`; `javascript:`/`data:` link schemes are removed; images are not loaded (a placeholder with the alt text) |
| Text | `<pre>` with wrapping | Plain text only |
| CSV | Table, first 1,000 rows, header row sticky | "Showing the first 1,000 of N rows" with a download link; quoted newlines and the BOM handled; text only, never markup |
| Images | `<img>` from a `blob:` URL of the server-chosen type | The blob URL is revoked on unmount |
| PDF | pdf.js ≥ 4.2.67 (`pdfjs-dist`), worker as a separate asset | `isEvalSupported: false`, `enableScripting: false`; canvas pages rendered lazily as they scroll into view; opens at `?page=`; page up/down and zoom; a text layer for find-in-page is *not* required |
| XLSX | A maintained reader (not npm `xlsx` 0.18.x) | Sheet tabs; the sheet number from `?page=` is the initial tab; at most 200 rows × 26 columns per sheet shown, cell values as text; formulas shown by their cached value, never evaluated |
| DOCX | A maintained DOCX-to-HTML converter → sanitiser | Same sanitiser configuration as Markdown; images dropped; styles and `class` dropped |
| PPTX | Text per slide, read from `GET /versions/:id/text`, no PPTX library | Slides as numbered sections; the initial slide from `?page=` |
| Anything else | Download card | Name, type, size, Download |

The sanitiser is one shared module with an allow-list of tags and attributes (headings, paragraphs, lists, tables, `a`
with `href`/`title`, `code`, `pre`, `blockquote`, `em`, `strong`, `br`, `hr`); everything else is removed. It has its own
unit tests with hostile inputs (`<script>`, `onerror`, `javascript:` hrefs, SVG, `<iframe>`, CSS `url()`, entity-encoded
schemes). A viewer that takes longer than 15 s or throws shows the fallback.

### Sources admin page

`/w/$tenantSlug/admin/sources` beside Members, Groups and Spaces; owners and admins only (others see the existing
"not allowed" state).
- A list of sources: name, target space, trusted, status, items, last sync.
- "New source": name and target space (non-Inbox, live spaces only).
- A source's panel: rename, change target space, the **Trusted** switch with its explanation ("Files from this source skip
  review unless the space requires it. Leave off unless you control what the script sends. Applies to files read from now
  on."), Pause/Resume, tokens (name, prefix, created, last used, expiry, revoked) with "New token" and "Revoke".
- A new token is shown once in a modal with a copy button and a ready `curl` example (the real API base URL, the token, a
  sample `PUT` and `DELETE`); closing it cannot bring it back, and the page says so before it closes.
- Errors are the plain sentences; the token never appears in the page after the modal.

### Playwright (on the fake extractor, `pnpm e2e:local`)

Specs: `files.spec.ts` — upload through the UI to a review space, see the states, reviewer approves from the queue, search
finds a sentence and the link opens the file at the right page; replace keeps the old version searchable until the new
one is approved; a corrupt file shows the viewer fallback and not a broken page; viewer access by role; move into Inbox.
`sources.spec.ts` — admin creates a source and a token, a script `PUT` (through the request fixture) appears in the tree,
`DELETE` makes it "Removed at source" and unsearchable, dismiss archives it; a revoked token is refused; a non-admin sees
no Sources page.

## Part 3 — Live check (written last, against the real stack with Docling)

`docs/live-checks/2026-10-slice-2-live-check.md` with real outputs and "Not run" where something was not: a two-page PDF,
an XLSX and a photographed printed page become searchable through the real extractor in compose (profile `extractor`);
Ask cites the PDF page; a replaced PDF keeps answering until its successor is approved; a script's `PUT` then `DELETE`
removes the file from search at once and the file page shows "Removed at source"; a second tenant sees none of it by API
or by SQL as the app role; the extractor container has no route to the internet or storage (checked from inside it). The
document also records the extractor's timings and image size. `docs/operations.md` gains the Sources section (creating a
source, rotating a token, the `curl` example) and `pnpm dev` documents how to turn the extractor profile on.

## Constraints

- Stack as built. New front-end dependencies, each lazy-loaded and each open source with a permissive licence: `pdfjs-dist`
  (≥ 4.2.67), an XLSX reader (`read-excel-file`, or another maintained one), `mammoth`, `dompurify` (or an equivalent
  allow-list sanitiser), a Markdown parser. No new backend service; no new backend dependency is expected.
- The main bundle's size is checked before and after (`vite build`); the report goes in the ledger and the live check.
- Two-tenant isolation tests for every new route; RLS tests for the new tables; the existing suites stay green
  (`pnpm vitest run`, `pnpm typecheck`, `pnpm e2e:local`, `pnpm test:pg`).
- Contracts first; replies camelCase, requests snake_case; every reply parsed; new error codes and sentences added to the
  contract table (`not_removed`, and `source_name_taken` for a duplicate source name).
- Slice work stays on the branch; the merge is a separate decision.

## Calls made by the author (to be checked)

- **Two plans.** 2b-1 (sources backend and the carried-over fixes) lands and is tested first; 2b-2 (console, viewers, live
  check) follows. Both continue on `slice-2-files`, because they depend on 2a's routes.
- **Token carries the tenant id** so the lookup stays inside RLS; no security-definer function and no RLS bypass.
- **Tokens default to no expiry**, with an optional expiry the admin can set; revoking is one click.
- **Identical bytes from a source are `unchanged` even if a person withdrew the file**, so a daily script cannot undo a
  person's withdrawal; changed bytes do create a new version and return the file to review or the index. The Slice 2 spec's
  wording ("same hash, not withdrawn") applies to people.
- **A source delete is not an Updates line.** The Slice 2 spec listed "removed at source" among Updates wording; a delete
  creates no version, so it shows on the badge and as a tree dot instead.
- **Pinned files that lose their source stay withdrawn; only synced ones can be dismissed**, by an editor.
- **A moved (pinned) file still receives its source's new versions**, in the place the person chose, under that space's
  review rules.
- **A source's target space cannot be the Inbox.** Inbox items are per-owner; a script has no owner.
- **Review queue shows a text preview on demand**, not in the list reply, so listing never reads object storage.
- **No text diff for files** in this slice.
- **No upload progress percentage**; the state names are enough.
- **PPTX preview is the extracted text**, not a rendered slide, so no PPTX library enters the bundle.
- **"Unchanged" for a source means "same as what it last sent"** (`source_items.content_hash`), not "same as the latest version",
  so a person's replace or withdraw is not undone by the next identical sync.
- **A `PUT` never touches a file a person archived on purpose** (409); a file removed at source and then sent again is revived
  and un-archived, whoever archived it.
- **`DELETE` works for any live source**, even when the target space has since been archived; the archived check is on `PUT`.
- **Viewers read only the published version** (bytes and text); editors read every version. This tightens the 2a download route.
- **Migration `0013`** is custom SQL for RLS and the DELETE revoke on `sources`, following the repo's 0008/0009 pattern.
- **Two new error codes:** `not_removed` (dismissing a file that was not removed at its source) and `source_name_taken` (a duplicate source name).

## Edge cases the plans must cover (each needs a named test)

1. A token for tenant A on tenant B's source path, an unknown tenant prefix, a truncated token, a revoked, expired and
   paused-source token: all identical 401 bodies; a session token on a source route and the reverse.
2. `externalId` of 1 and 256 characters, 257 characters, empty, percent-encoded slashes and Unicode, a control character.
3. `PUT` twice with the same bytes (second is `unchanged`); with changed bytes while the previous version is extracting,
   pending review, indexed and withdrawn; two simultaneous `PUT`s of one new `external_id` (one document).
4. `DELETE` of an unknown id (404), twice (200 then 200, one audit event), of an id another source created (404), during
   `extracting`, during `indexing` (the job must not index), and of a file with a version waiting for review.
5. `DELETE` then `PUT` of identical bytes revives with a new version; of a dismissed (archived) file lifts the archive.
6. A trusted source into a review space still waits for review; into a non-review space it indexes with no human; an agent
   version never skips review; flipping `trusted` leaves already-extracted versions as they were.
7. A person moves a synced file (pinned) and the source then replaces it: new version lands in the person's space, the
   file is not moved back; `DELETE` withdraws it and it stays listed.
8. A person withdraws a file and the source re-sends identical bytes: still withdrawn.
9. Source target space archived mid-sync (409), source paused (401 for its tokens), token revoked between two requests.
10. Dismiss: by an editor, a viewer (403), on a pinned file (409 `not_removed`), on a file not removed (409 `not_removed`),
    on a page id (404).
11. A hidden file (another member's Inbox) never appears in review, Updates, tree or chunks for anyone else, and a file link
    for it is the not-found state.
12. The sanitiser against the hostile list above; a Markdown file with `<script>` and `javascript:` links; a DOCX with
    embedded HTML-looking text; a CSV cell containing `<img onerror>` shown as text.
13. A truncated PDF, a zero-page PDF, a corrupt DOCX and XLSX, a 1×1 image, an image over 20 megapixels: each shows the
    fallback or the viewer, never a crash; navigating away mid-load leaves no console error.
14. Upload of 5 files where the 2nd is refused (unsupported) and the 3rd is a duplicate: the others continue, each shows its
    own state; navigating between pages during the queue does not cancel it; a network error shows "Try again".
15. Search result for a file passage with a page number beyond the PDF's pages, with no page, and for a file the person can
    no longer read (404 state, not a blank page).
16. Two members in the same Inbox dropping the same file: neither sees the other's, as in 2a.
17. A viewer-role person asks for a waiting, rejected, withdrawn and superseded version's bytes, text and `?v=`: 404 for each;
    for the indexed one: bytes and text; an editor reads all.
18. A person replaces a pinned source file, then the source sends its old bytes again (`unchanged`) and then new bytes (new
    version); a person archives a source file and the source `PUT`s (409); the source deletes then re-sends it (revived).
19. A move into a review space while a newer version is `extracting`: when it finishes there is one waiting version, not two.
20. The app role cannot `DELETE` from `sources`; `source_items` and `source_tokens` are invisible across tenants and without
    `app.tenant_id`.
21. Keyboard-only use of upload, the "…" menu, the Sources page and the token modal; screen-reader names on the drop zone.

## Delivery order

- **Plan 2b-1 — sources backend.** Contracts; migration 0012; token mint, hash and `'source'` auth mode; admin routes;
  `PUT`/`DELETE` and the delete path; `dismiss-removal`; trusted switch; the in-flight-job guard for source-deleted
  documents; carried-over fixes 2–5; route tests with PGlite, `test:pg` coverage, a shared multi-tenant isolation test.
  Ends green with no console change.
- **Plan 2b-2 — console, viewers, live check.** `documentTarget` and link fixes; upload queue and entry points; file
  page and chunk inspector; review queue and Updates wording; viewers and the sanitiser; Sources page; Playwright specs;
  bundle-size report; live check and operations docs.

## Left to the builder

File and package layout, exact component and hook names, route search-param parsing, the upload queue's data structure, the
chosen XLSX/DOCX/sanitiser/Markdown packages within the Constraints, the sanitiser's exact allow-list beyond the tags named,
icons, empty states, the wording of every new sentence (plain, no codes), column widths and responsive breakpoints for the
file page, and e2e selectors.
