# Slice 2a — Files: ingest backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can upload and replace a file through the API; it is read (text-native types in the worker, everything else by the Docling extractor), passes the space's review rules, is chunked and indexed, and search and Ask cite it with page numbers. Files can be moved, withdrawn, archived, restored, retried, downloaded and inspected.

**Architecture:** Files reuse the page registry and version pipeline. A new `file.extract` job sits before `version.index`; `indexVersion` learns to chunk extracted text instead of blocks. Pure logic (type detection, chunking, readers) and DB logic (version insert, extraction outcomes) live in `packages/core`; routes live in `apps/api/src/routes/files.ts`; the worker gains one handler and two dependencies (object storage, extractor). The Python extractor is a separate service behind an HTTP contract shared by a JSON fixture.

**Tech Stack:** Node 22, Fastify 5 (+ `@fastify/multipart`), Drizzle, Zod, Vitest + PGlite, aws-sdk S3 client (already in `packages/shared`), Python 3.12 + Docling + FastAPI (extractor only).

**Spec:** `docs/superpowers/specs/2026-10-20-slice-2-files-design.md` (this plan covers its "Plan 2a" scope; the upload-API source, console, viewers and live check are Plan 2b).

## Global Constraints

- Contracts first: a route's Zod schema is written before its handler; every reply goes through `parseReply`; replies camelCase, request bodies snake_case.
- Every query filters `tenant_id` and runs inside `withTenantTx`; permissions only through `requireSpaceRole` / `requireDocumentRole`; a hidden file is a 404, never a 403.
- Lock order: the document row first (`lockDocument`), then version rows. Every writer that changes what a document publishes takes the document lock.
- No raw error code or `Error.message` reaches a person: failures stored in `versions.error` use contract sentences (`failedVersionError` rule).
- Page behaviour, page routes and the 12-key `VersionSummary` do not change. Existing tests stay green (`pnpm vitest run`, `pnpm typecheck`).
- Layering: `packages/*` never import from `apps/*`; apps never import each other (`layering.test.ts`).
- File content never runs: server-chosen Content-Type, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work stays on branch `slice-2-files`.
- Object keys: `{tenantId}/files/{documentId}/{versionId}/original` and `.../extracted.json`, built from `fileObjectPath`; the file name never appears in a key.
- Limits: `MAX_UPLOAD_BYTES` default 52428800; `MAX_EXTRACTED_CHARS` default 2000000; `EXTRACTOR_TIMEOUT_MS` default 240000 and at most 270000 (the worker lease is 300 s, `LEASE_SECONDS`).

## Rulings recorded before execution

- Spec said the extractor timeout defaults to 10 minutes; the queue lease is 300 s, so a slower call would run twice. Ruling: default 240 s, validated at most 270 s (Task 1 edits the spec line).
- Two new error codes are needed for stored failure sentences: `file_unreadable` (422) and `file_text_too_large` (422). Every other error reuses an existing code (`document_not_found` for file ids, `page_archived` with a file-specific message for archived files).
- A connector's versions always need review in 2a (`trusted` arrives with `sources` in Plan 2b, which changes that one rule in `extractVersion`).
- Tree `attention` for files: `failed` and `review` only, from the latest version's status (spec's sidebar note "files get null" is superseded).

## Review Focus (inputs the spec implies; each is pinned by a named test below)

1. Same bytes uploaded by two members into the Inbox: the second learns nothing (Task 11).
2. Disguised content: HTML named `.png`, SVG named `.txt`, ZIP named `.docx` with no `word/` entry (Task 4).
3. Exactly the limit, limit + 1, zero bytes, a multipart request with no file part (Task 11).
4. Extractor down, then back: a retry recovers with no re-upload; an unreadable file fails once with a plain sentence (Tasks 8, 9, 12).
5. Replace then reject, replace then withdraw: the old version keeps answering only while it should (Tasks 10, 12, 17).

## File structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/config.ts`, `objectStorage.ts` | New settings; `createObjectStorage`, `ensureBucket` |
| `packages/db/src/schema/pages_and_index.ts` + migration `0011_*` | File columns on `versions`, hash index |
| `packages/contracts/src/files.ts`, `errors.ts` | File schemas; two error codes |
| `packages/core/src/files/detect.ts` | `detectFileType`, `cleanFileName`, zip entry listing |
| `packages/core/src/files/textNative.ts` | TXT / MD / CSV readers |
| `packages/core/src/files/chunkExtracted.ts` | Chunking of extracted sections |
| `packages/core/src/files/extractor.ts` | `Extractor`, `FakeExtractor`, `HttpExtractor`, `createExtractor` |
| `packages/core/src/files/versions.ts` | `fileObjectPath`, `insertFileVersion` |
| `packages/core/src/files/extractVersion.ts` | Extraction outcome and review decision |
| `packages/core/src/indexing/indexVersion.ts` | Index file versions (modify) |
| `apps/worker/src/registry.ts`, `runner.ts`, `main.ts` | `file.extract` handler and wiring |
| `apps/api/src/documents/lifecycle.ts` | Helpers extracted from `pages.ts`, shared with files |
| `apps/api/src/routes/files.ts` | Upload, replace, details, history, download, chunks, move, withdraw, archive, restore |
| `apps/api/src/pages/badge.ts` | `computeFileBadge`, `fileAttention` |
| `apps/extractor/` | Python service, Dockerfile, tests |

---

### Task 1: Settings, storage factory, bucket bootstrap

**Files:**
- Modify: `packages/shared/src/config.ts`, `packages/shared/src/objectStorage.ts`, `packages/shared/src/index.ts`, `docker-compose.yml`, `.env.example`, `docs/operations.md`, `docs/superpowers/specs/2026-10-20-slice-2-files-design.md` (the "default 10 minutes" sentence → "default 4 minutes, at most 4.5, below the worker lease")
- Test: `packages/shared/test/config.test.ts`, `packages/shared/test/objectStorage.test.ts`

**Interfaces:**
- Produces: `Config` gains `MAX_UPLOAD_BYTES: number`, `MAX_EXTRACTED_CHARS: number`, `EXTRACTOR_MODE: 'off' | 'fake' | 'http'`, `EXTRACTOR_URL?: string`, `EXTRACTOR_TIMEOUT_MS: number`.
- Produces: `createObjectStorage(config: Pick<Config,'S3_ENDPOINT'|'S3_BUCKET'|'S3_ACCESS_KEY'|'S3_SECRET_KEY'|'S3_REGION'>): S3ObjectStorage`; `S3ObjectStorage#ensureBucket(): Promise<void>` (HeadBucket, CreateBucket on 404).

- [ ] **Step 1: Write failing tests.** config: defaults are 52428800 / 2000000 / `off` / 240000; `EXTRACTOR_MODE=http` without `EXTRACTOR_URL` throws naming `EXTRACTOR_URL`; `EXTRACTOR_TIMEOUT_MS=300000` throws; `MAX_UPLOAD_BYTES=0` throws. objectStorage: `createObjectStorage` throws an Error naming `S3_BUCKET` when it is missing; the env-gated S3 test calls `ensureBucket()` twice on a fresh bucket name and then `put`/`get` round-trips.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the fields (with a `superRefine` for the http/URL rule) and the two functions. Compose: pass `MAX_UPLOAD_BYTES`, `MAX_EXTRACTED_CHARS`, `EXTRACTOR_MODE: ${EXTRACTOR_MODE:-off}`, `EXTRACTOR_URL: ${EXTRACTOR_URL:-}`, `EXTRACTOR_TIMEOUT_MS` into `x-app-env`. Document each in `.env.example` and `docs/operations.md` (a "Files" section: limits, extractor modes).
- [ ] **Step 4: Run** `pnpm vitest run packages/shared && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: file upload settings, storage factory and bucket bootstrap`.

### Task 2: Schema for file versions, error codes

**Files:**
- Modify: `packages/db/src/schema/pages_and_index.ts`, `packages/contracts/src/errors.ts`
- Create: `packages/db/migrations/0011_*.sql` (+ meta) via `pnpm db:generate`
- Test: `packages/db/test/client.test.ts` (or a new `packages/db/test/fileColumns.test.ts`), `apps/api/test/errors.test.ts`

**Interfaces:**
- Produces: `versions.objectKey`, `fileName`, `mimeType` (text, nullable), `sizeBytes` (bigint, `mode: 'number'`, nullable), `sourceRevision`, `extractedKey` (text, nullable); index `versions_tenant_hash_idx` on `(tenant_id, content_hash)`.
- Produces: error codes `file_unreadable` ("This file could not be read. It may be encrypted or damaged.") and `file_text_too_large` ("This file has more text than can be indexed."), both HTTP 422.

- [ ] **Step 1: Write failing tests.** A test inserts a `versions` row with all six file columns through `createTestDb` and reads them back (`sizeBytes` is a JS number); a page version leaves them null; `ERROR_STATUS.file_unreadable === 422`, each new code has a sentence.
- [ ] **Step 2: Run** `pnpm vitest run packages/db apps/api/test/errors.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the schema edit, then `pnpm db:generate`; open the generated SQL and confirm it only adds the six columns and the index (never hand-edit). Add the codes, sentences and status overrides.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS (existing suites included).
- [ ] **Step 5: Commit** `feat(db): file columns on versions; file_unreadable and file_text_too_large`.

### Task 3: File contracts

**Files:**
- Create: `packages/contracts/src/files.ts`; Modify: `packages/contracts/src/index.ts` (re-export)
- Test: `packages/contracts/test/files.test.ts`; Create fixture `packages/contracts/fixtures/extracted-sample.json`

**Interfaces — Produces** (all Zod, with inferred types):
- `FILE_TYPES = ['pdf','docx','pptx','xlsx','csv','txt','md','png','jpeg','webp','gif','audio','video']`, `FileTypeSchema`.
- `ExtractedSectionSchema {headingPath: string[]; pageFrom: int>0|null; pageTo: int>0|null; kind: 'text'|'table'; text: string}`; `ExtractedDocumentSchema {pageCount: int>=0|null; sections: ExtractedSection[]; ocrUsed: boolean}`.
- `UploadFileFieldsSchema {space_id?: uuid; parent_id?: uuid}`.
- `FileVersionSchema = VersionSummarySchema.extend({fileName: string; mimeType: string; sizeBytes: int; hasText: boolean})`.
- `FileVersionListSchema = z.array(FileVersionSchema.extend({createdByName: string}))`.
- `FileDetailsSchema {id, spaceId, parentId|null, title, archivedAt|null, placement: 'pinned'|'synced', sourceDeletedAt|null, badge: string, latestVersion: FileVersion|null, indexedVersion: FileVersion|null}`.
- `UploadFileResponseSchema {document: DocumentSummary, version: FileVersion, unchanged: boolean}`.
- `MoveFileRequestSchema` = the existing `MovePageRequestSchema` shape (re-exported under the new name).
- `ChunkInspectorSchema {versionId, indexed: boolean, ready: boolean, pageCount: int|null, ocrUsed: boolean, sections: ExtractedSection[], chunks: {ordinal, headingPath: string[], pageFrom: int|null, pageTo: int|null, text, tokenCount}[]}`.

- [ ] **Step 1: Write failing tests:** the fixture (a two-page PDF-like document: a heading section on page 1, a table section on page 2, `ocrUsed: false`) parses; a section with `pageFrom: 0` is rejected; `UploadFileResponseSchema` rejects a missing `unchanged`; `FileTypeSchema` rejects `'svg'` and `'html'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/contracts` — Expected: FAIL.
- [ ] **Step 3: Implement** the schemas and the fixture (the Python tests in Task 16 read the same file).
- [ ] **Step 4: Run** `pnpm vitest run packages/contracts && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): file schemas`.

### Task 4: Type detection and file-name cleaning

**Files:** Create `packages/core/src/files/detect.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/test/files.detect.test.ts`

**Interfaces — Produces:**
```ts
export type FileHandling = 'text' | 'extractor' | 'stored';
export interface DetectedFile { type: FileType; mimeType: string; extension: string; handling: FileHandling }
export type DetectResult = { ok: true; file: DetectedFile } | { ok: false; reason: 'empty' | 'unsupported' };
export function detectFileType(fileName: string, bytes: Uint8Array): DetectResult;
export function listZipEntries(bytes: Uint8Array): string[] | null; // central directory only, never inflates; null if malformed; at most 10_000 entries
export function cleanFileName(raw: string): string;                  // trim, strip control chars, `/` and `\` → `_`, collapse spaces, ≤200 chars, `'file'` when empty
```
Rules: handling `text` for txt/md/csv; `stored` for audio/video; `extractor` for the rest. Detection is by bytes (PDF `%PDF-` within the first 1024 bytes; PNG, JPEG `FFD8FF`, GIF87a/89a, WebP `RIFF....WEBP`; DOCX/XLSX/PPTX = zip containing `word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`; MP3 `ID3`/`FFEx`, WAV `RIFF....WAVE`, M4A/MP4/MOV bytes 4–8 `ftyp`, OGG `OggS`, WebM `1A45DFA3`); text types need no NUL in the first 8 KB. The extension must agree with the detected type (`.jpg`/`.jpeg`, `.md`/`.markdown`). Any file whose head, after a BOM and whitespace, starts with `<svg`, `<html`, `<!doctype html`, or `<?xml` followed by `<svg` within 1 KB is `unsupported`, whatever its name; extensions `svg html htm xhtml xml` are `unsupported`. Zero bytes → `empty`.

- [ ] **Step 1: Write failing tests (table-driven):** a valid fixture per allowed type detects with the expected `type`, `mimeType`, `handling`; `empty`; HTML bytes named `a.png` → unsupported; SVG bytes named `a.txt` → unsupported; a ZIP named `a.docx` with no `word/document.xml` → unsupported; a real PNG named `a.pdf` → unsupported (extension disagrees); `.doc` and `.exe` → unsupported; a text file with a NUL → unsupported; `listZipEntries` returns the names of a small zip built in the test and `null` for random bytes; `cleanFileName('../../x\u0000.pdf')` contains no `/` or NUL, a 500-character name is cut to 200 characters, `'   '` → `'file'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/files.detect.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with a single table of types (extension, mime, magic check, handling). Parse the zip end-of-central-directory record (signature `0x06054b50`, searched in the last 65 557 bytes) and walk the central directory records (`0x02014b50`) reading names only.
- [ ] **Step 4: Run** the test, then `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): file type detection from bytes`.

### Task 5: Text-native readers and the extracted-text chunker

**Files:** Create `packages/core/src/files/textNative.ts`, `packages/core/src/files/chunkExtracted.ts`; Modify `packages/core/src/index.ts`, `packages/core/src/indexing/chunkPage.ts` (extend `RawChunk` with optional `pageFrom?: number | null`, `pageTo?: number | null`); Test `packages/core/test/files.chunk.test.ts`

**Interfaces — Produces:**
```ts
export function readTextNative(type: 'txt' | 'md' | 'csv', bytes: Uint8Array): ExtractedDocument;
export function parseCsv(text: string): string[][];   // RFC 4180: quotes, doubled quotes, newlines inside quotes
export function chunkExtracted(title: string, sections: ExtractedSection[], opts?: ChunkOptions): RawChunk[]; // blockIds always []
```
Rules. **Readers:** UTF-8 decode, BOM stripped. TXT → one `text` section. MD → sections split at ATX headings outside fenced code, `headingPath` is the heading stack, the heading line is not in the text. CSV → one `table` section whose text is each record's cells joined by ` | `, one record per line; `pageCount` null, `ocrUsed` false for all three. **Chunker:** same `DEFAULT_CHUNK_OPTIONS`; consecutive text sections with the same `headingPath` fill one chunk up to `targetWords`; a paragraph above `maxWords` is split on sentence boundaries, then on words; a table at or under `maxWords` is one chunk; a larger table splits on lines with its first line repeated at the top of every chunk; each chunk text is `# {title}` (plus ` > {headingPath joined}`) + blank line + body; `tokenCount` is the word count, `contentHash` the sha-256 of the text (as `chunkPageBlocks`); `pageFrom`/`pageTo` are the min and max over the sections in the chunk (null when none); whitespace-only sections are dropped; no chunk has an empty body.

- [ ] **Step 1: Write failing tests:** MD with `# A`, text, `## B`, text, and a fenced block containing `# not a heading` → sections with paths `[A]`, `[A,B]` and the fence kept as text; CSV with a quoted comma and a quoted newline → the right cell counts; chunker: two short paragraphs under one heading → one chunk; headings differ → two chunks; a 1500-word paragraph → several chunks, none above `maxWords`, concatenation holds every word; a 40-row table over the limit → every chunk starts with the header line; page numbers span `[2,3]` for sections on pages 2 and 3; the existing `chunking.test.ts` still passes unchanged.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/files.chunk.test.ts packages/core/test/chunking.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** both modules and the `RawChunk` extension (page chunker output must stay byte-for-byte equal: do not add keys to its chunks).
- [ ] **Step 4: Run** `pnpm vitest run packages/core && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): text-native readers and extracted-text chunking`.

### Task 6: Extractor interface, fake and HTTP client

**Files:** Create `packages/core/src/files/extractor.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/test/files.extractor.test.ts`

**Interfaces — Produces:**
```ts
export interface ExtractInput { bytes: Uint8Array; fileName: string; file: DetectedFile }
export interface Extractor { extract(input: ExtractInput): Promise<ExtractedDocument> }
export class FakeExtractor implements Extractor {}
export class HttpExtractor implements Extractor { constructor(opts: { url: string; timeoutMs: number; fetchImpl?: typeof fetch }) }
export class UnavailableExtractor implements Extractor {}   // always throws AppError('extractor_unavailable')
export function createExtractor(cfg: { EXTRACTOR_MODE: 'off'|'fake'|'http'; EXTRACTOR_URL?: string; EXTRACTOR_TIMEOUT_MS: number }): Extractor;
```
`FakeExtractor` reads the bytes as UTF-8 after a first line `FAKE-EXTRACT`: the rest is JSON matching `ExtractedDocumentSchema` when it starts with `{`, else plain text split on `\f` into one section per page (`pageFrom = pageTo = n`); first line `FAKE-EXTRACT-DOWN` → `AppError('extractor_unavailable')`; `FAKE-EXTRACT-EMPTY` → zero sections; no marker → `AppError('file_unreadable')`. `HttpExtractor` POSTs the bytes to `{url}/extract` (`Content-Type: application/octet-stream`, `X-File-Name` URL-encoded, `X-File-Type` the `FileType`): 200 → body parsed by `ExtractedDocumentSchema` (a body that fails to parse → `AppError('extractor_unavailable')` with the cause); 422 → `file_unreadable`; 413 → `file_text_too_large`; any other status, a network error or a timeout (AbortController) → `extractor_unavailable` with the cause attached.

- [ ] **Step 1: Write failing tests** (a local `http.createServer` for the client): 200 with the contract fixture; 422; 413; 500; a server that never answers with `timeoutMs: 50`; a 200 with `{}`; the fake in each marker mode; `createExtractor({EXTRACTOR_MODE:'off',...}).extract` rejects with `extractor_unavailable`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/files.extractor.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** it plus `pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(core): extractor interface, fake and HTTP client`.

### Task 7: Creating a file version

**Files:** Create `packages/core/src/files/versions.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/test/files.versions.test.ts`

**Interfaces — Produces:**
```ts
export function fileObjectPath(documentId: string, versionId: string, name: 'original' | 'extracted.json'): string; // files/{doc}/{ver}/{name}
export interface InsertFileVersionParams {
  tenantId: string; doc: DocumentRow; versionId: string;
  file: { name: string; mimeType: string; sizeBytes: number; contentHash: string; objectKey: string; handling: FileHandling };
  actor: { type: 'user' | 'agent' | 'connector'; id: string };
  reason: 'upload' | 'source'; sourceRevision?: string | null;
}
export async function insertFileVersion(tx: DbTransaction, p: InsertFileVersionParams): Promise<VersionRow>;
```
Behaviour (caller holds the document lock): next number = latest + 1; a latest version that is `pending_review` or `extracting` becomes `superseded`; insert with `id = versionId`, `status` `stored` for `handling: 'stored'` (with `error` "Kept for download. No text is read from audio or video.") else `extracting`; `title = file.name`; `contentHash` as given; a `version_contributors` row for a `user` actor; `documents.latest_version_id` updated; audit `version.created` (payload documentId, number, reason, fileName); a `file.extract` job keyed `extract:{versionId}` unless stored. The document's `title` is not changed here (indexing sets it).

- [ ] **Step 1: Write failing tests (PGlite, `useTestDb`-style with `createTestDb`):** first version is number 1 `extracting` with a queued `file.extract` job and a contributor row; second upload supersedes an `extracting` first and a `pending_review` first, but not an `indexed` one; `stored` handling inserts `stored` and no job; `fileObjectPath` has the exact shape and never contains the file name.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run packages/core && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(core): insert file versions`.

### Task 8: Extraction outcome and the review decision

**Files:** Create `packages/core/src/files/extractVersion.ts`; Modify `packages/core/src/index.ts`; Test `packages/core/test/files.extractVersion.test.ts`

**Interfaces — Produces:**
```ts
export type ExtractVersionResult =
  | { outcome: 'extracted'; status: 'pending_review' | 'indexing' | 'stored' }
  | { outcome: 'skipped'; reason: 'not_extracting' | 'superseded' | 'archived' };
export interface ExtractDeps { storage: ObjectStorage; extractor: Extractor; maxChars: number }
export async function extractVersion(params: { tenantId: string; versionId: string }, deps: ExtractDeps): Promise<ExtractVersionResult>;
```
Three phases like `indexVersion`: **A** (tx) load the version; skip unless `extracting` (`not_extracting`). **B** (no tx) `storage.get` the bytes, re-run `detectFileType` (an `unsupported` result throws `AppError('file_unreadable')`), then `readTextNative` for `handling: 'text'` or `deps.extractor.extract`; total section characters over `maxChars` → `AppError('file_text_too_large')`; `storage.put` the validated JSON at `fileObjectPath(...,'extracted.json')`. **C** (tx, document locked) re-check the version is still `extracting`; document archived → version `withdrawn`, skip `archived`; `doc.latestVersionId !== versionId` → `superseded`, skip; set `extractedKey`; no non-blank text in any section → `stored` with `error` "No text could be read from this file."; else review rule: `space.reviewRequired || createdByType === 'agent' || createdByType === 'connector'` → `pending_review`, otherwise `indexing` and a `version.index` job keyed `index:{versionId}`; audit `file.extracted`.

- [ ] **Step 1: Write failing tests (fake extractor, in-memory storage):** a TXT in a no-review space → `indexing` with an index job and `extracted.json` stored; same file in a review space → `pending_review`; agent-created version in a no-review space → `pending_review`; `FAKE-EXTRACT-EMPTY` → `stored` with the reason; `FAKE-EXTRACT-DOWN` rejects with `extractor_unavailable` and leaves the version `extracting`; no marker → rejects `file_unreadable`; extracted text over `maxChars: 10` → rejects `file_text_too_large`; running twice on the same version is a no-op the second time (`not_extracting`); a newer version inserted meanwhile → first is `superseded`; document archived → `withdrawn`.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run packages/core && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(core): extract file versions and decide review`.

### Task 9: The worker's `file.extract` job

**Files:** Modify `apps/worker/src/registry.ts`, `apps/worker/src/runner.ts`, `apps/worker/src/main.ts`; Test `apps/worker/test/fileExtract.test.ts`

**Interfaces:**
- `JobContext` gains `storage: ObjectStorage`, `extractor: Extractor`, `maxExtractedChars: number`; `RunnerOptions` gains optional `storage`, `extractor`, `maxExtractedChars` (defaults: an `InMemoryObjectStorage`, `UnavailableExtractor`, 2_000_000).
- `failedVersionError(attempts, error, thrown?, stage: 'Indexing' | 'Extraction' = 'Indexing')`.
- New handler `handlers['file.extract']`: `run` calls `extractVersion`; `onDeadLetter` marks the version `failed` only while it is still `extracting`, with `failedVersionError(..., 'Extraction')`. `handlers['version.index']` passes `ctx.storage` to `indexVersion`.
- `main.ts`: `createObjectStorage(config)` then `ensureBucket()`, `createExtractor(config)`, pass all to `runWorkerLoop`.

- [ ] **Step 1: Write failing tests (PGlite):** upload-shaped fixture (document + version via `insertFileVersion`, bytes in storage) → one runner pass completes `file.extract` and leaves the version `indexing` with a queued `version.index` job; with `FAKE-EXTRACT-DOWN` the job is retried (status `queued`, attempts 1) and after exhausting attempts the version is `failed` with an error starting "Extraction failed after 3 attempts:" and containing the extractor-unavailable sentence's cause; an unreadable file dead-letters at once (non-retryable `AppError` below 500) with `error` containing the `file_unreadable` sentence; an `indexing` page job still behaves as before (existing `runner.test.ts` passes).
- [ ] **Step 2: Run** `pnpm vitest run apps/worker` — Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** `pnpm vitest run apps/worker && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(worker): file.extract job`.

### Task 10: Index file versions

**Files:** Modify `packages/core/src/indexing/indexVersion.ts`, `packages/core/src/index.ts`; Create `packages/core/src/files/loadChunks.ts`; Test `packages/core/test/indexVersion.files.test.ts`

**Interfaces:**
- `indexVersion(params, provider = defaultEmbeddingProvider, deps: { storage?: ObjectStorage } = {})` — page behaviour unchanged.
- `loadFileChunks(storage: ObjectStorage, tenantId: string, ver: { title: string; extractedKey: string | null }): Promise<{ extracted: ExtractedDocument; chunks: RawChunk[] }>` — reads `extracted.json`, validates it with `ExtractedDocumentSchema`, runs `chunkExtracted(ver.title, ...)`. A missing `extractedKey` or storage → `NonRetryableError`.

Change: a version with `objectKey !== null` is a file version. Phase A reads the version in a first transaction; for a file version the chunks come from `loadFileChunks` (outside any transaction), then a second short transaction reads the cached embeddings. Zero chunks → `NonRetryableError('version has no indexable content')` as for pages. Phase C writes `pageFrom`/`pageTo` from the raw chunks (null for pages) and `blockIds: []` for files; the swap, the supersede, the `inbox_owner` stamp and the audit event are unchanged.

- [ ] **Step 1: Write failing tests:** a two-page extracted document indexes into chunks whose `pageFrom/pageTo` are right, `blockIds` empty, space and `inbox_owner` set (Inbox file → creator key); re-indexing the same text reuses cached embeddings (provider `callCount` unchanged); replace: v1 indexed, v2 `indexing` → after `indexVersion(v2)` chunks belong to v2 only, v1 is `superseded`, `documents.indexedVersionId` is v2; v2 indexing failing with `embedding_unavailable` leaves v1's chunks in place; a file version with storage omitted rejects as non-retryable; all existing `indexVersion*.test.ts` pass.
- [ ] **Step 2: Run** — Expected: new tests FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run packages/core apps/worker && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(core): index file versions with page numbers`.

### Task 11: Upload and replace

**Files:** Create `apps/api/src/routes/files.ts`; Modify `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/errors.ts`, `apps/api/package.json` (`@fastify/multipart`); Test `apps/api/test/filesUpload.test.ts`

**Interfaces:**
- `ApiServerOptions` gains `storage?: ObjectStorage`, `maxUploadBytes?: number` (default 52428800). Without `storage` the file routes answer `internal_error`.
- `uploadFile(actor, input: { fields: unknown; file: { name: string; bytes: Uint8Array } }, deps: { storage: ObjectStorage }): Promise<{ status: 'created' | 'unchanged'; response: UploadFileResponse }>`
- `replaceFile(actor, fileId: string, file: { name: string; bytes: Uint8Array }, deps): Promise<same>`
- `toFileVersion(row): FileVersion` (the 12 summary keys plus `fileName`, `mimeType`, `sizeBytes`, `hasText = extractedKey !== null`).
- Routes: `POST /api/v1/files` (multipart: one file part, optional text fields `space_id`, `parent_id`) → 201 with a created version, 200 when unchanged; `POST /api/v1/files/:id/versions` (multipart, one file part). Multipart limits: `fileSize: maxUploadBytes`, `files: 1`, `fields: 4`; a file over the limit → 413 `file_too_large` (map the plugin's `FST_REQ_FILE_TOO_LARGE`), a request with no file part → 400 `validation_failed`.

Flow (`uploadFile`): parse fields → `detectFileType` (`empty` → `empty_file`, `unsupported` → `unsupported_file_type`) → read-only transaction: target space = `space_id` or the tenant's Inbox, `requireSpaceRole(..., 'editor')`, parent via the shared parent check (a page in the same space), duplicate check (a non-archived, non-source-deleted file in the same space whose latest version has the same `content_hash` and is not `withdrawn`; **in the Inbox only the actor's own files count**) → if duplicate, return `unchanged` with that document and its latest version (no object written) → `storage.put(tenantId, fileObjectPath(docId, versionId, 'original'), bytes, detected.mimeType)` with ids generated up front → main transaction: take `pg_advisory_xact_lock(hashtextextended(tenantId || spaceId || hash, 0))`, re-run the duplicate check (a loser deletes its object and returns `unchanged`), `requireSpaceRole(..., { lock: 'share' })`, insert the document (`kind 'file'`, `title = cleanFileName(name)`, `placement 'pinned'`, creator = actor), `insertFileVersion(reason 'upload')`, audit `file.uploaded` → any failure after `put` deletes the object (best effort). `replaceFile`: lock the document, `requireDocumentRole(..., 'editor', { notFound: 'document_not_found' })`; kind must be `file`; archived → `page_archived` ("This file is archived. Restore it before making changes."); `placement === 'synced'` → `managed_by_source`; same hash as a non-withdrawn latest version → `unchanged`; else `put`, `insertFileVersion`.

- [ ] **Step 1: Write failing tests (`app.inject` multipart, in-memory storage; build bodies with a small helper in `support/`):** member uploads a TXT into a normal space → 201, `version.status === 'extracting'`, object exists under `{tenant}/files/{doc}/{ver}/original`, a `file.extract` job queued, audit rows; no `space_id` → the document is in the Inbox; same bytes again in the same space → 200 `unchanged: true`, still one document and one object; **Inbox: member A uploads, member B uploads the same bytes → B gets a new document (201) and cannot see A's** (Review Focus 1); viewer role → 403; unreadable space → 404; HTML named `x.png` → 415; zero bytes → 400 `empty_file`; exactly `maxUploadBytes` accepted, +1 → 413; no file part → 400; a parent that is a file or in another space → 404 `parent_not_found`; replace creates v2 and supersedes a pending v1; replace of a `synced` file → 409 `managed_by_source`; replace of an archived file → 409; two concurrent uploads of identical bytes yield one document (`Promise.all`); a forced failure after `put` (storage double that makes the transaction throw) leaves no object behind; another tenant's file id → 404.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/filesUpload.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** (share `requireVisibleParent` by moving it to `apps/api/src/documents/lifecycle.ts` in Task 12; for this task export it from `pages.ts` and import it, Task 12 relocates it). Wire `main.ts`: `createObjectStorage`, `ensureBucket`, `maxUploadBytes`.
- [ ] **Step 4: Run** `pnpm vitest run apps/api && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(api): upload and replace files`.

### Task 12: Shared lifecycle helpers, file lifecycle, generalised retry

**Files:** Create `apps/api/src/documents/lifecycle.ts`; Modify `apps/api/src/routes/pages.ts` (import the helpers), `apps/api/src/routes/files.ts`, `apps/api/src/server.ts`; Test `apps/api/test/filesLifecycle.test.ts`

**Interfaces:**
- Move unchanged from `pages.ts` to `documents/lifecycle.ts` and export: `withdrawLiveVersions`, `returnToReview`, `wouldCreateCycle`, `requireVisibleParent`. `withdrawLiveVersions` now also withdraws `extracting` versions (page behaviour unchanged: pages never have that status).
- `files.ts` adds `moveFile(actor, id, input)`, `withdrawFile(actor, id)`, `archiveFile(actor, id)`, `restoreFile(actor, id)`; each returns `DocumentSummary`. Routes: `POST /api/v1/files/:id/move|withdraw|archive|restore`.
- `retryVersion` (pages.ts) for a file version with `extractedKey === null`: status → `extracting`, `file.extract` job `extract:{id}` re-enqueued; otherwise as today. Archived-file message as in Task 11.

Rules: move = `movePage` minus slugs (editor on both spaces, Inbox only for the creator or an admin, parent must be a live page in the target space the actor can see, cycle refused, pins the file, cross-space into a review space by a non-reviewer calls `returnToReview`, other cross-space moves update `chunks.space_id` and `inbox_owner`); withdraw needs reviewer, archive and restore need space admin; archive has no children to check but still refuses with `has_children` if a live child exists; audit `file.moved|withdrawn|archived|restored`. A page with a file child cannot be archived (the existing check already counts any child; add the test).

- [ ] **Step 1: Write failing tests:** move within and across spaces (chunks follow after indexing: `space_id` and `inbox_owner` right after a move into and out of the Inbox); move into a review space as a plain editor returns the indexed version to `pending_review` and removes its chunks; move of a file by someone who cannot read the target → 404; withdraw empties chunks and leaves `indexedVersionId` null; withdraw while `extracting` → version `withdrawn` and, after the worker runs, the extract job skips; archive then restore returns the file withdrawn; page with a file child → archive `has_children`; **retry** of a version that failed in extraction re-queues `file.extract` and a run with a healthy extractor ends `indexing` (Review Focus 4); retry of a failed index version still re-queues `version.index`; all existing `lifecycle.test.ts`, `retry.test.ts` pass.
- [ ] **Step 2: Run** — Expected: new tests FAIL. **Step 3: Implement** (refactor first, run `pnpm vitest run apps/api` green, then add file functions). **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(api): file lifecycle and extraction retry`.

### Task 13: Reading files: details, history, download, chunk inspector

**Files:** Modify `apps/api/src/routes/files.ts`, `apps/api/src/server.ts`; Test `apps/api/test/filesRead.test.ts`

**Interfaces — Produces:**
- `getFileDetails(actor, id): Promise<FileDetails>` (viewer; `badge` from `computeFileBadge`, Task 14 — until then a fixed string is not acceptable, so this task's tests import the function from Task 14: implement Task 14's badge function first or in the same commit series; execute Task 14 Step 1–4 before this task's Step 3).
- `listFileVersions(actor, id): Promise<FileVersionList>` (viewer; `createdByName` through `resolveActorNames`; a connector shows "System").
- `downloadVersionFile(actor, versionId, opts: { inline: boolean }, deps): Promise<{ bytes: Uint8Array; headers: Record<string,string> }>` (viewer). Content-Type from the version's server-detected `mimeType` except `text/markdown` and `text/csv`, which go out as `text/plain; charset=utf-8`; `X-Content-Type-Options: nosniff`; `Content-Security-Policy: sandbox`; `Cache-Control: no-store`; `Content-Disposition: attachment; filename*=UTF-8''{percent-encoded cleaned name}` unless `inline` and the type is png/jpeg/webp/gif. A page version or a version without `objectKey` → 404 `version_not_found`.
- `getVersionChunks(actor, versionId, deps): Promise<ChunkInspector>` (editor): `ready = extractedKey !== null`; when not ready `chunks: []`, `sections: []`; otherwise `loadFileChunks`; `indexed = (doc.indexedVersionId === versionId)`.
- Routes: `GET /api/v1/files/:id`, `GET /api/v1/files/:id/versions`, `GET /api/v1/versions/:id/file` (query `inline=1`), `GET /api/v1/versions/:id/chunks`.

- [ ] **Step 1: Write failing tests:** details of an indexed file report `Indexed · v1`; a member of another tenant and a member who cannot read the space both get 404 on every route; **an Inbox file is 404 for another member and 200 for an admin**; download of a TXT returns the exact bytes with all four security headers and `text/plain; charset=utf-8`; a filename with quotes and Unicode is percent-encoded (no raw `"` in the header); `inline=1` is honoured for a PNG and ignored for a PDF; download of a page version → 404; viewer role cannot read chunks (403) but editor can; chunks of a not-yet-indexed version are returned with `indexed: false` and equal what indexing later stores (same `contentHash`es); `ready: false` while extracting.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** (order: Task 14 badge first). **Step 4: Run** `pnpm vitest run apps/api && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(api): read files, download and chunk inspector`.

> **Execution order note:** run Task 14 before Task 13.

### Task 14: Badge, tree dots, review queue and updates for files

**Files:** Modify `apps/api/src/pages/badge.ts`, `apps/api/src/routes/foundations.ts` (tree), `apps/api/src/routes/reviews.ts`, `apps/api/src/routes/updates.ts`, `packages/contracts/src/index.ts` (`ReviewItem.document.kind`, `ReviewItem.file`, `UpdateItem.document.kind`); Test `apps/api/test/fileStatus.test.ts` (+ updates to `reviews.test.ts`, `updates.test.ts`, `tree.test.ts` expectations)

**Interfaces — Produces:**
```ts
export interface FileBadgeInput {
  latestVersion: { number: number; status: string; hasText: boolean } | null;
  indexedVersion: { number: number } | null;
  sourceDeleted: boolean; placement: 'pinned' | 'synced';
}
export function computeFileBadge(input: FileBadgeInput): string;
export function fileAttention(input: Pick<FileBadgeInput,'latestVersion'>): 'failed' | 'review' | null;
```
Badge text, first match wins: `sourceDeleted && placement === 'synced'` → "Removed at source"; latest `withdrawn` → "Withdrawn"; `failed` → `hasText ? 'Index failed' : 'Extraction failed'`; `extracting` → "Reading text…"; `indexing` → "Indexing…"; `pending_review` → indexed exists ? `Indexed · v{n}, v{latest} awaiting approval` : "Not indexed (awaiting approval)"; `rejected` → `Not indexed · v{latest} rejected` (when an indexed version exists: `Indexed · v{n}, v{latest} rejected`); `stored` → "Stored · no searchable text"; else `Indexed · v{indexed}`. `fileAttention`: `failed` → `'failed'`; `pending_review` → `'review'`; else null.
Tree: file nodes use `fileAttention` (archived stays null). Reviews: drop the `kind = 'page'` filter; `document.kind` added; `file: { fileName, mimeType, sizeBytes } | null` (null for pages). Updates: include file versions (same status set), `document.kind` added.

- [ ] **Step 1: Write failing tests:** a table test over every badge branch above; tree: a file with a pending version has `attention: 'review'`, a failed one `'failed'`, an indexed one `null`, an archived one `null`; reviews list a pending file version with `document.kind: 'file'` and the `file` block, still hide Inbox files from other members and admin-only rules unchanged; updates list an upload as a version with `document.kind: 'file'`; existing page cases unchanged (update fixtures only where a new key appears).
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(api): file badge, dots, review queue and updates`.

### Task 15: Search and Ask show where in a file

**Files:** Modify `packages/contracts/src/index.ts` (`SearchPassageSchema`, `AskCitationSchema`: add `documentKind: 'page'|'file'`, `pageFrom: int|null`, `pageTo: int|null`), `apps/api/src/search/hybridSearch.ts`, `apps/api/src/search/ask.ts`; Test `apps/api/test/searchFiles.test.ts` (+ fixture updates in `search.test.ts`, `search.pg.test.ts`)

Rules: `searchSql` also selects `c.page_from`, `c.page_to` and `d.kind` (join `documents d` on `d.id = c.document_id AND d.tenant_id = c.tenant_id` for the final top rows only — the ranking branches stay on `chunks` alone). `citeAs` is unchanged (title, version, date). Ask passes the three fields into each citation.

- [ ] **Step 1: Write failing tests:** after indexing a file with a sentence on page 2 (fake extractor JSON), a search for that sentence returns a passage with `documentKind: 'file'`, `pageFrom: 2`, `pageTo: 2`, `blockIds: []`, `citeAs` of the form `{name} (v1, updated YYYY-MM-DD)`; page passages have `documentKind: 'page'` and null pages; a file in another member's Inbox never appears; a withdrawn file never appears; Ask cites the file with its page.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run && pnpm typecheck` — Expected: PASS. **Step 5: Commit** `feat(search): file passages carry page numbers`.

### Task 16: The Python extractor service

**Files:** Create `apps/extractor/pyproject.toml` (pinned versions), `apps/extractor/app/main.py`, `apps/extractor/app/mapping.py`, `apps/extractor/tests/test_contract.py`, `apps/extractor/tests/test_mapping.py`, `apps/extractor/tests/test_docling.py` (skipped unless `EXTRACTOR_DOCLING_TESTS=1`), `apps/extractor/Dockerfile`, `apps/extractor/README.md`; Modify `docker-compose.yml` (service `extractor`, `profiles: ["extractor"]`, network `extractor_net` with `internal: true` shared only with `worker`; worker also on the default network; `EXTRACTOR_MODE`/`EXTRACTOR_URL` already passed by Task 1, default URL `http://extractor:8000`), `docs/operations.md`, `.env.example`; Test: a Node test `packages/contracts/test/extractorFixture.test.ts` reads the same fixture.

**Interfaces:** `GET /health` → `{"status":"ok"}`. `POST /extract` — body = the file bytes, headers `X-File-Name`, `X-File-Type` (a `FileType`): 200 with an `ExtractedDocument` JSON (camelCase keys exactly as the Zod schema); 422 `{"error":"unreadable"}` for encrypted, corrupt or unsupported input; 413 `{"error":"too_large"}` when extracted text exceeds `MAX_EXTRACTED_CHARS` (env); 5xx never carries file content. `mapping.py` exposes `to_extracted(docling_document, file_type) -> dict` (sheet number or slide number is the page for xlsx/pptx; tables become `kind: "table"` sections whose text is rows joined by ` | `, one per line; the heading stack is `headingPath`; `ocrUsed` true when any OCR text was produced).

Steps: before coding, read Docling's current docs for the pinned version (use the context7 tools or the project's README) to confirm `DocumentConverter`, the document item iteration API, OCR options, and which of the image types it reads (anything it cannot read answers 422, the worker then marks the version `failed` with the unreadable sentence; widening to `stored` is a later decision). Images and models: the Dockerfile downloads models at build time and sets `HF_HUB_OFFLINE=1`, runs as a non-root user, exposes 8000, has no egress at runtime (compose network).

- [ ] **Step 1: Write failing tests:** `test_contract.py` loads `packages/contracts/fixtures/extracted-sample.json` and validates it against a pydantic model mirroring the schema, and `to_extracted` over a hand-built stub document reproduces a fixture-shaped result (page numbers, a table section, heading path); the HTTP tests (FastAPI `TestClient`, converter monkeypatched) cover 200, 422 on a converter error, 413 over the char limit, and that the response never echoes the file name or bytes in an error; the Docling-gated test converts a one-page PDF fixture and finds its sentence. The Node test parses the same fixture with `ExtractedDocumentSchema`.
- [ ] **Step 2: Run** `cd apps/extractor && python -m pytest -q` and `pnpm vitest run packages/contracts` — Expected: FAIL.
- [ ] **Step 3: Implement** the service, Dockerfile and compose entry. **Step 4: Run** pytest (gated test skipped) and `docker compose --profile extractor config` — Expected: PASS and a valid config; then build the image once (`docker compose --profile extractor build extractor`) and run the gated test inside it — record the output in the commit body.
- [ ] **Step 5: Commit** `feat(extractor): Docling service behind our extraction contract`.

### Task 17: Whole-pipeline tests, real-Postgres coverage, local e2e plumbing

**Files:** Create `apps/api/test/filesPipeline.test.ts`, `apps/api/test/filesPipeline.pg.test.ts`; Modify `e2e/harness/local-stack.ts` (give the in-process api and worker one `InMemoryObjectStorage` and a `FakeExtractor`), `docs/operations.md`

- [ ] **Step 1: Write the tests (PGlite, fake extractor, in-memory storage, worker driven with `runPendingJobsForTenant`):**
  1. *Happy path:* member uploads a fake PDF (two pages, a distinct sentence per page) into a normal space → worker pass → badge `Indexed · v1` → search for page 2's sentence returns the file with `pageFrom: 2` → Ask cites it.
  2. *Review space:* upload → `pending_review` and **not searchable** → reviewer approves (a different user than the uploader) → index job → searchable; the uploader approving gets `self_approval`.
  3. *Replace keeps answering (Review Focus 5):* indexed v1 (review space off) → replace with v2 → before the worker runs, search still finds v1's sentence; after, only v2's; in a review space, v2 pending → v1 still answers → reject v2 → v1 still answers → replace again and withdraw → nothing answers.
  4. *Failure and recovery (Review Focus 4):* `FAKE-EXTRACT-DOWN` bytes → run the worker past the retry window → badge `Extraction failed`, `error` starts "Extraction failed after 3 attempts"; replace the stored bytes' behaviour by swapping the extractor for a healthy one and `POST /versions/:id/retry` → `Indexed`.
  5. *Isolation:* tenant B can read none of tenant A's routes (404) and `storage.get` with B's tenant id on A's key throws; direct SQL as the app role without `app.tenant_id` sees no `versions` rows with file columns.
  6. *Stored:* audio file → `Stored · …`, never in the review queue, downloadable.
  The `.pg.test.ts` repeats scenario 3 against real Postgres (skipped unless `TEST_DATABASE_URL`, as `search.pg.test.ts` does) and asserts the chunk swap is atomic: a concurrent search loop during the swap never sees zero chunks for the document.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/filesPipeline.test.ts` — Expected: FAIL until the plumbing exists; then fix only plumbing, not assertions.
- [ ] **Step 3: Implement** the harness wiring and the operations notes. **Step 4: Run** the full gate: `pnpm vitest run && pnpm typecheck && pnpm web:build && pnpm e2e:local` — Expected: all exit 0 (the existing 17 specs unchanged); then, with the stack up, `pnpm test:pg` — Expected: PASS.
- [ ] **Step 5: Commit** `test: files pipeline end to end`.

## Self-review notes

- Spec coverage for 2a: upload, intake rules, extraction (real and fake), review rules, indexing with pages, search/Ask pages, replace, move, withdraw, archive, restore, retry, download, inspector, badge/dots/review/updates (Tasks 1–17). Deferred to 2b by design: sources and tokens, script routes and delete path, Sources page, upload UI, file page, sidebar rows, review-screen UI, viewers, Playwright specs, live check.
- Names used across tasks: `DetectedFile`, `FileHandling`, `insertFileVersion`, `extractVersion`, `loadFileChunks`, `fileObjectPath`, `computeFileBadge`, `fileAttention`, `FileVersion`, `ChunkInspector` — each defined once in the task that produces it.
- Task 13 depends on Task 14's badge function; the note under Task 13 fixes the order (14 before 13).
