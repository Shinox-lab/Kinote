# Slice 2: Files — design

Date: 2026-10-20. Builds on Slice 0/1 (merged on `main`, commit `250c072`). Parent spec:
`docs/2026-10-18-living-wiki-standalone-design.md` (the "Files", "Connectors → Upload API", "Index and retrieval" and
"Change and delete handling" sections, and the Slice 2 row of "Delivery slices"). Where this document and the parent differ,
this one wins for Slice 2 and the difference is listed under "Calls made by the author".

## Intent

Today the wiki holds only pages typed in the editor. Slice 2 lets a person, or a script, put a *file* into the wiki (a PDF,
a spreadsheet, a scanned image) and have it behave like a page: it lives in a space, it passes that space's review rules,
and once approved its text is searchable and citable. A person can open it, see exactly what text the index holds for it,
replace it with a newer version, move it, withdraw it, or have it removed when the system it came from deletes it.

The slice proves one story: *a member drops a PDF, an XLSX and a photo of a printed page into a review space; a reviewer
approves them; search finds a sentence from each and cites the right PDF page; the member uploads a corrected PDF and the
old one keeps answering until the new one is approved and indexed; a script deletes a file through the upload API and it
leaves the index at once.*

## Goals

1. **Upload** a file from the console (button and drag-and-drop) and from the API (a source token). A target space is
   required; with none, the file goes to **Inbox**. Default limit 50 MB, a deployment setting.
2. **Safe intake.** Type decided from the file's bytes, not its name or its claimed MIME type. SVG and HTML are refused.
   Empty files, oversize files and unsupported types are refused with plain sentences.
3. **Extraction.** Every extractable file becomes text with structure (sections, tables kept whole, page numbers, OCR for
   images and scans) through an extractor service built on Docling. Plain-text types (TXT, MD, CSV) are read by the worker
   itself without the extractor. Audio and video are stored only.
4. **Same rules as pages.** A file version goes through the same review rules (`review_required`, uploaded by an agent,
   untrusted connector), the same statuses and the same indexing path. Nothing enters the index unapproved.
5. **Search and Ask cover files.** A file's chunks carry its space, so the access filter, the Inbox owner rule and moves
   work without change. A passage from a file names its PDF page or sheet/slide number.
6. **Replace, move, withdraw, archive, restore** for files, with the same lifecycle rules as pages. A person's move *pins*
   a file; a sync never moves a pinned file.
7. **Upload API source.** A tenant admin creates an `upload_api` source for a space and gets a token. A script replaces a
   file by sending the same `external_id` and removes it with `DELETE`. A delete leaves the index in the same transaction.
8. **Viewers** for Markdown, text, CSV, images, PDF, XLSX, DOCX and PPTX, each loaded lazily, each falling back to a
   download link if it fails.
9. **Chunk inspector.** For any version of a file, an editor sees the extracted text and how it was cut into chunks.
10. **Status everywhere.** A file shows a badge like a page does, appears in the sidebar tree with status dots, in the
    Updates feed, and in the review queue with its extracted text.

## Non-goals (this slice)

- Google Drive, WhatsApp and any other connector; the `source_mappings`, `secrets` and cursor machinery they need.
- MCP `upload_file` and agent tokens (Slice 3). The upload API gets its own source-bound token.
- Audio/video transcription, legacy Office formats (`.doc`, `.xls`, `.ppt`), archives, Google Docs.
- Renaming a file (the title is the file name; a rename is a re-upload). Editing file contents in the browser.
- Purging a document, quotas, nightly index-drift repair, orphan-object cleanup (Slice 7).
- Choosing a real embedding provider; the deterministic provider stays the default.
- Citations from pages to files (`citations` table, flags; Slice 3).
- Per-token rate limiting for the upload API (Slice 7); the global limiter still applies.

## Anti-goals (a failure even if it technically works)

- **Leaking what a person may not read.** A duplicate-upload check, an `unchanged` answer, a delete by `external_id`, a
  download, the chunk inspector or a search hit must never reveal that a file exists in a space, or in someone else's
  Inbox, that the person cannot read. A hidden file is indistinguishable from a missing one (404).
- **Executing content.** No uploaded byte is rendered as HTML or script anywhere. A `.png` that contains `<svg` is refused.
  Downloads carry a fixed, server-chosen Content-Type, `nosniff`, `Content-Security-Policy: sandbox` and `no-store`.
- **A half-written file.** A failed upload, extraction or index leaves no version that looks searchable. An old indexed
  version is never removed before its successor is indexed.
- **Silent loss of text.** A file whose text could not be read, or is too large to index, says so on its badge. It is
  never quietly "indexed" with part of its content missing.
- **A wrong status.** The badge and dots come from the server, from the same predicates for pages and files. The browser
  decides nothing.
- Showing a raw error code, an `Error.message`, a stack trace or an extractor's internal text to a person.
- A heavy viewer library in the main bundle, or a viewer crash that takes the page down.
- Breaking Slice 0/1 behaviour, tests or the sidebar console.

## Rules kept from the parent spec

1 (index is derived), 2 (one place for bytes and approval state), 3 (nothing unapproved is indexed), 4 (access belongs to the
space; a move changes who can find a file at once), 5 (a person's move is never undone by a sync), 6 (nothing lost; a
replaced version stays in history), 7 (citations show title, version number and date only), 8 (the title is indexed text),
9 (removing is fast: withdraw, archive and source delete leave the index in the same transaction), 11 (file content never
runs), 12 (permissions inside the search query), 13 (retrieved text is data), 14 (every actor audited; a script's actor is
its source).

## How files fit the existing model

Slice 0/1 already has: `documents.kind = 'file'`, `placement`, `source_id`, `external_id`, `source_deleted_at`; the version
statuses `extracting` and `stored`; the reasons `upload` and `source`; `chunks.page_from/page_to` and `chunks.inbox_owner`;
the leased job queue; the tenant-prefixed `ObjectStorage` (S3 and in-memory) in `packages/shared`; file nodes in the tree
route; MinIO in compose. What exists but is page-only and must be generalised: `indexVersion` (reads `blocks`), the chunker
(reads BlockNote blocks), `movePage`/`archivePage`/`restorePage`/`withdrawPage`, `approveVersion`/`rejectVersion`/
`retryVersion`, the review queue (filters `kind = 'page'`), the badge and attention predicates, search hit shape, the web
review screen and tree. The object storage is not wired into the api or worker yet.

### Schema additions (one Drizzle migration each, never hand-edited)

- **`versions`** gains the file columns of the parent spec: `object_key`, `file_name`, `mime_type`, `size_bytes`,
  `source_revision`, `extracted_key`; all nullable (page versions leave them null). `content_hash` is the sha-256 of the
  bytes for files. A version's `title` for a file is the file name.
- **`sources`** (`id`, `tenant_id`, `kind` = `upload_api` for now, `name`, `target_space_id`, `trusted`, `status`
  `active|paused`, `last_sync_at`, `created_by`, `created_at`) and **`source_items`** (`tenant_id`, `source_id`,
  `external_id`, `document_id`, `content_hash`, `last_seen_at`, `deleted_at`). The parent spec's `config`, `cursor`,
  `last_reconcile_at`, `error` and `unlinked` status are added when a connector needs them. RLS and grants like every table.
- **`source_tokens`** (`id`, `tenant_id`, `source_id`, `token_hash`, `expires_at`, `last_used_at`, `revoked_at`,
  `created_at`). Tokens are random, shown once, stored hashed, scoped to exactly one source and one action set (upload,
  replace, delete).
- A unique index so one `external_id` maps to one document per source already exists on `documents`; `source_items` is the
  record the delete path reads.

### Object keys

`{tenantId}/files/{documentId}/{versionId}/original` and `{tenantId}/files/{documentId}/{versionId}/extracted.json`.
The file name never appears in a key. The version id is generated before the bytes are written.

## Intake rules

| Input | Result |
|---|---|
| Allowed types | PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG, JPEG, WebP, GIF; MP3/WAV/M4A/OGG/MP4/WebM/MOV for storage only |
| Type detection | From magic bytes (and, for OOXML, the zip's entries: `word/`, `xl/`, `ppt/`). The extension must agree. A claimed MIME type is ignored. Disagreement → 415 `unsupported_file_type` |
| SVG, HTML, XHTML, XML-with-svg | Refused by extension and by sniffing the first bytes (after BOM and whitespace: `<svg`, `<html`, `<!doctype html`, `<?xml` followed by `<svg`), whatever the file is called → 415 |
| Zero bytes | 400 `empty_file` |
| Over the limit (`MAX_UPLOAD_BYTES`, default 50 MB) | 413 `file_too_large`, refused while streaming, never fully buffered past the limit |
| File name | Stored as the title: trimmed, control characters removed, path separators replaced, at most 200 characters. Never used in a key or a header unescaped (`Content-Disposition` uses RFC 5987 encoding) |
| Same bytes, same place | `unchanged`: 200 with the existing document and `unchanged: true`, no version, no job. "Same place" means the same document (a replace) or, for a new file, a live file with the same hash in the *target space*; in Inbox, only among the uploader's own items |
| Replace by a person | `POST /files/:id/versions`, editor in the space. Refused with 409 `managed_by_source` when the file is `synced` |
| Space archived | 409 `space_archived` (existing) |

Upload is multipart with one file part. The api writes the bytes to object storage, then in one tenant transaction (document
locked) creates the document if new, the version (`status = extracting`, `reason = upload` for a person or `source` for a
script) and the `file.extract` job. If the transaction fails the object is deleted (best effort; a leftover is harmless and
swept in Slice 7).

## Extraction

- **Interface.** The worker's `file.extract` job (keyed by version id) reads the bytes, calls an `Extractor`, and writes
  `extracted.json`. The extractor contract (a Zod schema in `packages/contracts`, shared by the Node side and tested against
  the Python side with a fixture): `{ pageCount: number|null, sections: [{ headingPath: string[], pageFrom: number|null,
  pageTo: number|null, kind: 'text'|'table', text: string }], ocrUsed: boolean }`. Sheets use sheet number as the page;
  slides use slide number.
- **Real extractor.** A Python service in `apps/extractor` wrapping Docling behind a small HTTP API (`POST /extract` with the
  bytes and the detected type; `GET /health`). Our own response shape, so nothing on the Node side depends on Docling's
  output. Docling and its models are pinned and baked into the image at build time. It has no egress and no storage access:
  the worker sends bytes in and gets JSON out. Compose profile `extractor` (the models are large); the profile is on in the
  live check and `pnpm dev` leaves it off.
- **In-process readers.** TXT, MD and CSV never call the extractor: the worker splits TXT at blank lines, MD at headings,
  and reads CSV as a table (header row repeated when a table is split). Text is decoded as UTF-8 with a BOM stripped.
- **Fake extractor.** A deterministic `Extractor` for tests and for `e2e:local` (`EXTRACTOR_MODE=fake`), driven by fixture
  files whose bytes carry their own text after a marker. The Python service has its own tests (pytest, fixture PDF) and the
  live check runs the real one.
- **Outcomes.**
  - Sections with text → apply the review rules: `pending_review` or `indexing` (and enqueue `version.index`).
  - No text could be read (a blank scan, an image with no recognisable words, a type the extractor does not read) → `stored`
    with a plain reason in `error`; never reviewed, never indexed, viewable and downloadable. The badge says so.
  - Extraction too large (extracted text over `MAX_EXTRACTED_CHARS`, default 2,000,000) → `failed` with a sentence; not
    truncated.
  - Extractor unreachable or erroring → the job retries with backoff; after the last attempt the version is `failed` with
    "Extraction failed after N attempts: …" (the same neutral-text rule as indexing failures). An encrypted or corrupt file
    is a non-retryable failure with its own sentence.
  - `POST /versions/:id/retry` re-runs whichever step failed (extraction if there is no `extracted_key`, else indexing).
- Job lease and retry timing must outlast the extractor's configured timeout (default 4 minutes, at most 4.5, under the worker's 5-minute lease), so a slow PDF is not run
  twice at once.

## Indexing and search

- `indexVersion` loads, for a file version, `extracted.json` from object storage instead of `blocks`, and chunks it with a
  pure `chunkExtracted(title, sections)` using the same size settings as pages. Sections are the cut points; a section
  larger than the target is split on paragraph boundaries; a table is kept whole, or, when larger than the limit, split by
  rows with the header row repeated. Each chunk's indexed text starts with the title and heading path (rule 8). `page_from`
  and `page_to` are set; `block_ids` is empty.
- The three-phase publish, the document lock, "older than indexed", the swap of old chunks for new ones and the
  `inbox_owner` stamp are unchanged. Replacing a file therefore keeps the old version searchable until the new one is
  indexed, then supersedes it in one transaction.
- `SearchPassage` and `AskCitation` gain nullable `documentKind`, `pageFrom` and `pageTo` (additive; page hits unchanged).
  `citeAs` stays "{title} (v{n}, updated {date})". The console links a file passage to the file's viewer at that page.
- Withdraw, archive and source-delete take the document's chunks out in the same transaction as the status change, as for
  pages.

## Lifecycle and review

| Action | Who | Behaviour |
|---|---|---|
| Upload new file | editor | Document + version 1. Review rules decide `pending_review` or `indexing` after extraction |
| Replace | editor | New version; a waiting older version becomes `superseded`; the indexed one stays until the new is indexed |
| Move (`POST /files/:id/move`) | editor in both spaces | Pins the file; may sit under a page or at the top of a space; across spaces updates `chunks.space_id` and `inbox_owner` in the same transaction; into a review space returns the indexed version to `pending_review` unless the mover reviews the target; parent cycle refused as for pages |
| Withdraw | space admin or reviewer | Out of the index, still listed |
| Archive / restore | space admin | Archive refused while the file has children (it has none); restore returns it withdrawn |
| Approve / reject / retry | reviewer / editor | The existing routes, generalised; the author of an upload cannot approve it without `allow_self_approval`; a script's upload has no human author and can be approved by any reviewer |
| Source delete (script `DELETE`) | source token | Indexed version withdrawn and chunks deleted in one transaction; `source_deleted_at` set; a `synced` file shows "Removed at source" until an editor dismisses it (`POST /files/:id/dismiss-removal`, which archives it); a `pinned` file stays withdrawn and listed |
| Re-upload after a delete | source token | Revives the document (clears `source_deleted_at` and the dismissal), new version, normal review rules |

Files move only as whole documents. A page's archive refusal `has_children` counts files beneath it.

## Upload API source

- Admin routes (tenant admin): `POST /api/v1/sources` (kind `upload_api`, name, target space), `GET /api/v1/sources`,
  `PATCH /api/v1/sources/:id` (name, target space, `trusted`, `status`), `POST /api/v1/sources/:id/tokens` (returns the token
  once), `DELETE /api/v1/sources/:id/tokens/:tokenId`.
- Script routes (bearer source token, no session): `PUT /api/v1/source/files/:externalId` (multipart; creates or replaces)
  and `DELETE /api/v1/source/files/:externalId` (runs the delete path; an unknown id is 404). `externalId` is 1–256
  characters, URL-encoded. A paused source or revoked or expired token is refused.
- A script's versions have `created_by_type = 'connector'`, `created_by = source id`, reason `source`, and appear in the
  Updates feed and audit log as "System · {source name}". They follow rule 1 unless the source is `trusted`. Files from the
  source start `placement = synced`; a person's move pins them. Authentication failures all answer 401 with one sentence.
- A "Sources" admin page lists sources, tokens (created, last used), the trusted switch with an explanation, and a copyable
  `curl` example. Tokens are never shown again.

## Console

- **Upload.** A "Upload file" entry beside "New page" in a space's "+" menu, and a drop zone on the space and page-list
  views. Files upload one at a time with a visible state per file ("Uploading", "Reading text", then the badge); failures
  show the plain sentence. Multiple files are allowed.
- **File page** (route sibling to the page route): header with breadcrumb, file name, the badge, a "…" menu (replace, move,
  withdraw, archive, download), the viewer, a version list (reuses the history drawer styling), and **Chunks**
  (inspector). Layout follows the Notion tokens already built; no hard-coded palette classes (the tokens test enforces it).
- **Sidebar.** File rows get a file icon and the same status dots (failed, review). Files never show the purple "editing"
  dot. The tree `attention` rule for files uses the same predicates as the file badge, in `badge.ts`. Updates lists file
  versions with file wording ("uploaded", "replaced", "removed at source"). "On this page" shows, for a file, the badge,
  Replace, Download, History and Chunks.
- **Review queue.** Files appear with name, type, size, page count, how many chunks, the first lines of the extracted text,
  and a link to the viewer and chunk inspector. Approve and reject work as for pages.
- **Viewers.** Markdown (parsed and sanitised; raw HTML is dropped), text, CSV as a table (first 1,000 rows, then a download
  link), images, PDF through pdf.js 4.2.67 or later with `isEvalSupported: false`, XLSX as a sheet preview (first sheet,
  capped rows and columns, sheet tabs), DOCX as sanitised HTML, PPTX as the extracted text per slide. Every viewer is
  `React.lazy`, fetches the bytes from the download route, and renders an error boundary that falls back to a download
  link. The XLSX and DOCX libraries are the builder's choice; avoid the unmaintained npm `xlsx` 0.18.x.
- **Download route.** `GET /api/v1/versions/:id/file`: Content-Type from a fixed table by detected type (text types served
  as `text/plain; charset=utf-8`), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
  `Cache-Control: no-store`, `Content-Disposition` attachment unless `?inline=1` on an image type. Streamed, with the
  permission check before the first byte.

## API additions

All contracts first, replies camelCase, requests snake_case, every reply parsed, every query tenant-filtered inside
`withTenantTx`, permission through the existing gate.

| Route | Who | Notes |
|---|---|---|
| `POST /api/v1/files` | editor | Multipart: file, optional `space_id`, optional `parent_id`. Reply `{ document, version, unchanged }` |
| `POST /api/v1/files/:id/versions` | editor | Replace |
| `GET /api/v1/files/:id` | viewer | Details, badge, versions, source info |
| `GET /api/v1/files/:id/versions` | viewer | History list with who and reason |
| `GET /api/v1/versions/:id/file` | viewer | Download (above) |
| `GET /api/v1/versions/:id/chunks` | editor | Extracted text and chunks computed by the same pure function for any version, with `indexed: boolean`; chunks of unindexed versions are *computed*, never stored (only indexed versions have rows in `chunks`) |
| `POST /api/v1/files/:id/move`, `/withdraw`, `/archive`, `/restore`, `/dismiss-removal` | per table above | Same permission gate as pages |
| Sources routes | tenant admin / source token | Above |

`GET /spaces/:id/tree` returns file nodes with `attention`; `GET /reviews` includes files; `GET /updates` includes file
versions; `GET /pages/:id/...` routes keep answering for pages only, and a file id on a page route is 404.

New error codes and sentences (added to the contracts' sentence table; no raw code is ever shown): `file_too_large` 413,
`unsupported_file_type` 415, `empty_file` 400, `managed_by_source` 409, `extractor_unavailable` 503, plus a sentence for an
unreadable (encrypted or corrupt) file and for extracted text too large. `unchanged` is a successful answer, not an error.

Audit events: `file.uploaded`, `file.moved`, `version.created`, `version.approved`, `version.rejected`, `version.indexed`,
`file.withdrawn`, `file.archived`, `file.restored`, `source.created`, `source.token_issued`,
`source.item_deleted`. Every one records its actor (a person, or the source for a script).

## Constraints

- Stack as built: Node 22, Fastify 5, Drizzle, Zod, React 19, TanStack Router and Query, Tailwind 4 tokens. One new service
  (Python, Docling). New dependencies only where needed: a multipart parser, a file-type sniffer or small hand-written magic
  table, pdf.js, a DOCX-to-HTML library with a sanitiser, an XLSX reader. Every one open source with a permissive licence.
- Two-tenant isolation tests for every new route and for object storage keys; RLS on every new table, with the
  missing-`app.tenant_id` test.
- The existing tests stay green. New behaviour gets tests: pure-function tests (type detection, file-name cleaning,
  `chunkExtracted`, badge and attention for files), route tests with PGlite, an extractor contract test (Node fake against
  the shared schema; Python against a fixture), `pnpm test:pg` for the real-Postgres paths including the swap on replace,
  and Playwright specs (upload through the UI with the fake extractor, review and approve, search hit with page link,
  replace keeps old searchable until approved, viewer fallback on a corrupt file).
- The sidebar console, theme tokens and accessibility already built are kept: focus rings, labelled controls, Escape
  behaviour, reduced motion, contrast tests.
- Slice work happens on a branch; the merge is a separate decision.

## Calls made by the author (to be checked)

- Docling behind our own HTTP shape in a Python service; fake extractor for tests; compose profile for the real one.
- TXT, MD and CSV read in the worker; the extractor is not needed for them.
- Source tokens are their own table, not `agent_tokens`, so Slice 3's agent identity is not decided early.
- File title = file name; no rename in this slice.
- Duplicate check is "same hash in the same space" (and only the uploader's own Inbox items), not tenant-wide.
- Blank or unreadable extraction → `stored` with a reason; over-large extraction → `failed`, never truncated.
- Chunks for unindexed versions are computed on demand for the inspector and review, not stored.
- A script upload to a deleted `external_id` revives the document; "dismiss" on a removed file archives it.
- Files may sit under a page (as children); a page with file children cannot be archived (`has_children`).
- Legacy Office formats and archives are refused rather than stored.
- Viewers cap CSV at 1,000 rows and XLSX at the first sheet's visible window; a download link covers the rest.
- File attention dots reuse red and amber; "editing" never applies to files.

## Edge cases the plan must cover (each needs a named test)

1. Same bytes uploaded by two members into Inbox: the second must not learn the first exists.
2. A file named `../../x.pdf`, with a very long or Unicode name, or `report.pdf.exe`; the name is cleaned and never reaches
   a key or an unescaped header.
3. Claimed MIME and extension lie: HTML bytes named `.png`; SVG named `.txt`; a ZIP named `.docx` with no `word/` entry.
4. Exactly the limit, limit + 1, zero bytes, a multipart request with no file or two files.
5. An encrypted PDF, a corrupt DOCX, a zip bomb, a PDF of 500 pages: each ends in a plain sentence and a retry path, never a
   stuck `extracting` row.
6. A scan with no readable text: `stored` with a reason, not indexed, not in the review queue.
7. Extractor down for the whole retry window, then back: retry recovers without re-uploading.
8. Two simultaneous uploads of the same bytes; two simultaneous replaces; a replace while the previous one waits for review.
9. Replace → reject the new version: the old version keeps answering. Replace → withdraw: nothing answers.
10. A file moved into Inbox, out of Inbox, into a review space, and between tenants' spaces (refused): `chunks.space_id` and
    `inbox_owner` are right after each.
11. Source `DELETE` of an unknown id (404, no leak), of an already-deleted id, then re-upload of the same id.
12. A paused source, a revoked token, an expired token, another tenant's token on the right path.
13. A huge table: a sheet with 200,000 rows hits the extracted-size limit with a sentence; a mid-size table splits by rows
    with the header repeated.
14. A viewer given a truncated PDF or image: the fallback download link shows, the page does not crash.
15. A file under a page: archive refused with `has_children`; moving the page keeps the file with it.

## Live check (written at the end of the slice, against the real stack with Docling)

The real PDF (two pages, a sentence per page), a real XLSX, and a photographed printed page become searchable; Ask cites the
PDF page; a replaced PDF keeps answering until its successor is approved; a script's `PUT` then `DELETE` removes a file
from search at once and the page that held it shows "Removed at source"; a second tenant sees none of it by API or by SQL
with the app role. Real outputs go into `docs/live-checks/2026-10-slice-2-live-check.md`, with "Not run" where something
was not.

## Delivery order (two plans, written one after the other)

- **Plan 2a — ingest backend.** Migrations; config and storage wiring in api and worker; type detection and intake; upload,
  replace, download routes; `file.extract` job, the fake extractor and in-process readers; `chunkExtracted` and
  `indexVersion` generalisation; review, retry, move, withdraw, archive and restore generalised to files; badge and
  attention for files; search and Ask page numbers; the Python extractor service and compose profile. Ends with route and
  `test:pg` coverage and the contract test.
- **Plan 2b — upload API, console and live check.** Sources and tokens, the script routes and delete path; the Sources admin
  page; upload UI, file page, sidebar and Updates changes, review-queue files; viewers and the chunk inspector; Playwright
  specs; the live check and docs (`docs/operations.md`: extractor profile, limits).

## Left to the builder

File and package layout, the exact magic-byte table, the multipart and sniffing libraries, Docling's pipeline options and
which of GIF, WebP, TIFF it reads (anything it cannot read is `stored`), chunk size values (start from the page chunker's),
wording of every new sentence, the exact routes' file names, icons for file types, the viewer libraries, and e2e selectors.
