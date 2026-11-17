# MCP capture-file app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person in an MCP Apps client (claude.ai) drops an original file into a Kinote panel; it is uploaded in chunks through app-only tools, stored as their Inbox upload, and captured with the agent's filing notes.

**Architecture:** The MCP layer learns tool `_meta` (UI resource, visibility), structured results, an `upload` rate limit and `resources/list|read`. An upload store (`mcp_uploads` + object-storage parts) assembles chunks into an `UploadedFile` that goes through the existing `uploadFile` as the agent's owner, then `createCapture` with an internal `ownerFile` option. The panel is TypeScript using `@modelcontextprotocol/ext-apps@1.7.5`, bundled by esbuild on first read.

**Tech Stack:** Fastify 5, MCP SDK 1.32 low-level `Server`, Drizzle + hand-written migrations, Vitest on PGlite, Playwright, esbuild 0.18, ext-apps 1.7.5.

**Spec:** `docs/superpowers/specs/2026-11-17-mcp-capture-file-app-design.md`

## Global Constraints

- Tool names: `kinote_capture_file` (model-visible), `kinote_upload_begin`, `kinote_upload_chunk`, `kinote_upload_finish`, `kinote_upload_cancel` (`_meta.ui.visibility: ["app"]`). All scope `capture`, `writes: true`.
- Resource URI `ui://kinote/capture-file`, mime `text/html;profile=mcp-app`, `_meta.ui.prefersBorder: true`, no CSP domains.
- `chunk_bytes` = 1048576 (one exported constant `UPLOAD_CHUNK_BYTES`). Upload expiry 1 hour. At most 3 open uploads per agent. Size cap `MAX_UPLOAD_BYTES` (deps `maxUploadBytes`, default 52 428 800).
- `MCP_UPLOAD_PER_MINUTE = 120` for begin/chunk/cancel; finish and `kinote_capture_file` use `capture`.
- App-only tool descriptions start "Used by the Kinote file panel."
- Exact refusal copy: "This file is larger than <N> MB." · "Audio and video can't be read yet." · "Finish or cancel another upload first." · "Upload not found" · "Chunk <i> arrived before chunk <n>." · "The upload is incomplete: <a> of <b> bytes."
- The file is stored **as the agent's owner** (`ownerActorOf(actor)`); `ownerFile` is never settable from an HTTP body or a model-visible tool.
- Dependencies: `@modelcontextprotocol/ext-apps` exactly `1.7.5`, `esbuild` exactly `0.18.20` (the hoisted version), both in `apps/api/package.json`.
- Migration `0049_mcp_uploads.sql` with journal entry idx 49; RLS via `packages/db/scripts/gen-rls.mjs` output style (tenant_isolation_policy).

## Review Focus

- A chunk retried after a lost reply (same index, same bytes) must not corrupt or double-count the file → test in Task 2.
- The agent must never see or capture another member's Inbox file, nor its owner's other Inbox files by id through any public path → test in Task 3 (HTTP body with `ownerFile`, `kinote_capture` cannot reach it).
- The last chunk shorter than `chunk_bytes` and a file of exactly `k × chunk_bytes` bytes both finish → test in Task 2.
- A duplicate file (same bytes already in the owner's Inbox) still captures, using the existing file → test in Task 3.
- A host that ignores `visibility` lists the upload tools to the model; calling `finish` without chunks must refuse cleanly, not crash → test in Task 3.

---

### Task 1: MCP plumbing — tool `_meta`, structured results, `upload` limit, resources

**Files:**
- Modify: `apps/api/src/mcp/tool.ts`, `apps/api/src/mcp/route.ts`, `apps/api/src/server.ts:744-756`
- Create: `apps/api/src/mcp/resources.ts`
- Test: `apps/api/test/mcpAppsPlumbing.test.ts`

**Interfaces:**
- Produces:
  - `ToolDef.meta?: { ui?: { resourceUri?: string; visibility?: Array<'model' | 'app'> } }` — emitted as `_meta` in `tools/list`.
  - `ToolDef.limit` / `limitOf` union gains `'upload'`; `export const MCP_UPLOAD_PER_MINUTE = 120`.
  - `ToolDef.run` returns `Promise<string | { text: string; structured: Record<string, unknown> }>`; the object form becomes `{content:[{type:'text',text}], structuredContent: structured}`. Audit/capResult use `text`.
  - `resources.ts`: `export interface AppResource { uri: string; name: string; description: string; html(): Promise<string> }`, `export const APP_MIME = 'text/html;profile=mcp-app'`. `registerMcpRoute(app, deps, { tools?, resources? })` — default `resources` = `APP_RESOURCES` (empty array in this task; Task 4 adds the panel). Server capabilities become `{ tools: {}, resources: {} }`; `resources/list` → `{resources:[{uri,name,description,mimeType:APP_MIME}]}`; `resources/read` → `{contents:[{uri,mimeType:APP_MIME,text,_meta:{ui:{prefersBorder:true}}}]}`; unknown uri → JSON-RPC error with message `Resource not found`.
  - `McpDeps` gains `storage: ObjectStorage`, `maxUploadBytes: number`, `uploadTmpDir?: string` (wired from `server.ts` opts the same way `/api/v1/files` gets them).

- [ ] **Step 1: Write the failing tests** — with `registerMcpRoute(app, deps, { path: '/mcp-test', tools: [fakeTool], resources: [fakeResource] })` on the test app (follow how existing MCP tests inject `tools`):
  - `tools/list` entry for a tool with `meta: {ui:{resourceUri:'ui://t/x', visibility:['app']}}` has `_meta` deep-equal `{ui:{resourceUri:'ui://t/x', visibility:['app']}}`; a tool without `meta` has no `_meta` key.
  - a tool returning `{text:'hi', structured:{a:1}}` → result `content[0].text === 'hi'`, `structuredContent` deep-equals `{a:1}`.
  - a tool with `limit: 'upload'` refuses its 121st call in a minute with text starting `Too many`.
  - `resources/list` returns one entry with `mimeType: 'text/html;profile=mcp-app'`; `resources/read` returns `contents[0].text === '<p>x</p>'` and `_meta.ui.prefersBorder === true`; reading `ui://nope` is a JSON-RPC error containing `Resource not found`.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/mcpAppsPlumbing.test.ts` — Expected: FAIL (no `_meta`, no `structuredContent`, resources method not found).
- [ ] **Step 3: Implement** the Interfaces above. Use the SDK's `ListResourcesRequestSchema` / `ReadResourceRequestSchema`; throw `McpError(ErrorCode.InvalidParams, 'Resource not found')` for an unknown uri. Resources are listed for every token (the panel is harmless HTML).
- [ ] **Step 4: Run** the test file, then `pnpm vitest run apps/api/test/mcp*.test.ts` and `pnpm typecheck` — Expected: PASS, typecheck exit 0.
- [ ] **Step 5: Commit** `feat(mcp): tool _meta, structured results, upload limit and app resources`

### Task 2: Upload store

**Files:**
- Create: `packages/db/migrations/0049_mcp_uploads.sql`; modify `packages/db/migrations/meta/_journal.json`, `packages/db/src/schema/routing.ts` (export `mcpUploads`), `packages/db/src/index.ts` if schema exports are listed
- Create: `apps/api/src/mcp/upload/store.ts`
- Test: `apps/api/test/mcpUploadStore.test.ts`

**Interfaces:**
- Consumes: `McpDeps.storage`, `maxUploadBytes`, `uploadTmpDir` (Task 1); `spoolUpload` from `apps/api/src/uploadedFile.ts`.
- Produces (all throw `ToolError` with the Global Constraints copy):
  - `export const UPLOAD_CHUNK_BYTES = 1_048_576; export const UPLOAD_TTL_MS = 3_600_000; export const MAX_OPEN_UPLOADS = 3;`
  - `beginUpload(deps, actor, agentId, {name, size, mime}, now = new Date()): Promise<{ uploadId: string; chunkBytes: number }>` — deletes this tenant's expired rows and their parts first; refuses size > max, audio/video (`/^(audio|video)\//` on mime, or extension in `mp3 m4a wav ogg flac aac mp4 mov webm mkv avi`), 3 open.
  - `putChunk(deps, actor, agentId, uploadId, index, base64, now?): Promise<{ receivedBytes: number }>`
  - `takeUpload(deps, actor, agentId, uploadId, now?): Promise<{ file: UploadedFile; row: McpUploadRow }>` — checks completeness, streams parts in order into `spoolUpload(row.name, stream, deps.uploadTmpDir)`, then deletes parts and row. Caller disposes `file`.
  - `cancelUpload(deps, actor, agentId, uploadId): Promise<void>` — idempotent.
  - Part key: `deps.storage.put(tenantId, \`uploads/${uploadId}/${index}\`, bytes, 'application/octet-stream')`; storage keys are `${tenantId}/${relativePath}`, so `partKey(tenantId, uploadId, i) = \`${tenantId}/uploads/${uploadId}/${i}\`` is recomputed for get/delete (indexes `0..next_index-1`); nothing is stored per part.
- Table `mcp_uploads`: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references tenants`, `agent_id uuid not null`, `name text not null`, `mime text not null`, `size bigint not null`, `received_bytes bigint not null default 0`, `next_index int not null default 0`, `created_at timestamptz not null default now()`, `expires_at timestamptz not null`; index `(tenant_id, agent_id)`; RLS block as in Global Constraints.

- [ ] **Step 1: Write the failing tests** (PGlite + `InMemoryObjectStorage`, a tenant and agent from testkit):
  - `begin → 3 chunks (1 MiB, 1 MiB, 10 bytes) → take` yields a file whose `sizeBytes === 2*1048576+10` and `contentHash` equals sha256 of the joined bytes; afterwards the row and all part objects are gone.
  - a file of exactly `2 × 1048576` bytes finishes.
  - repeating chunk index 1 with the same data returns the same `receivedBytes` and the final hash is unchanged.
  - chunk 2 before chunk 1 → `Chunk 2 arrived before chunk 1.`; a non-last chunk shorter than 1 MiB → refused; bytes past `size` → refused and a later `putChunk` gives `Upload not found`.
  - take before complete → `The upload is incomplete: 1048576 of 2097162 bytes.`
  - another agent's id → `Upload not found`; an expired upload (now + 61 min) → `Upload not found`.
  - begin with size 52_428_801 → `This file is larger than 50 MB.`; mime `audio/mpeg` and name `talk.mp4` → `Audio and video can't be read yet.`; a 4th open upload → `Finish or cancel another upload first.`
  - begin at now+61 min deletes the earlier expired row and its parts.
  - cancel twice is fine and removes parts.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/mcpUploadStore.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** migration, schema, and `store.ts`. Chunk validation: decode with `Buffer.from(b64, 'base64')` and reject when re-encoding does not round-trip (bad base64). Update `received_bytes`/`next_index` with a conditional `UPDATE … WHERE next_index = :index` so two concurrent identical chunks cannot both count.
- [ ] **Step 4: Run** the test file and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): chunked upload store for the file panel`

### Task 3: Tools — upload tools, `kinote_capture_file`, owner-file capture

**Files:**
- Create: `apps/api/src/mcp/tools/captureFile.ts`
- Modify: `apps/api/src/mcp/tools/index.ts`, `apps/api/src/mcp/tools/capture.ts` (export `scopeOf`), `apps/api/src/routes/captures.ts` (`createCapture` opts, `captureFile`), `apps/api/src/mcp/instructions.ts`
- Test: `apps/api/test/mcpUpload.test.ts`, extend `apps/api/test/mcpInstructions*.test.ts` if one exists (else assert in `mcpUpload.test.ts`)

**Interfaces:**
- Consumes: Task 1 `meta`, structured results, `'upload'` limit; Task 2 store functions; `renderCapture`, `waitForCapture`, `scopeOf` from `tools/capture.ts`; `uploadFile` from `routes/files.ts`; `ownerActorOf` from `@kinote/core`; `assertCredits`.
- Produces:
  - `createCapture(actor, body, opts: {channel?, sourceRef?, preview?, ownerFile?: boolean})`; `captureFile(tx, actor, fileId, ownerFile)` accepts creator === actor, or (when `ownerFile` and `actor.owner`) creator === `{type:'user', id: actor.owner.userId}`.
  - `export const CAPTURE_FILE_RESOURCE = 'ui://kinote/capture-file'`; `captureFileTool` (meta `{ui:{resourceUri: CAPTURE_FILE_RESOURCE}}`, limit `capture`) and `uploadBeginTool`, `uploadChunkTool`, `uploadCancelTool` (limit `upload`), `uploadFinishTool` (limit `capture`), all exported as `CAPTURE_FILE_TOOLS` and added to `ALL_TOOLS`.
  - `kinote_capture_file` input/structured result and fallback text exactly as spec §1 (`<publicUrl>/w/<slug>/capture`; when `publicUrl` unset, "the Capture page in Kinote"). It runs `assertCredits` and the `createCapture` edit gate (`senderAccess(tx, actor).editable.length === 0` → the same message) and resolves `limit_to` via `scopeOf`.
  - finish: `takeUpload` → `uploadFile(ownerActorOf(actor)!, {fields:{}, file}, {storage})` (Inbox default) → `createCapture(actor, {text: notes, shape: file_as, file_id, ...scope}, {channel:'mcp', ownerFile:true})` → `waitForCapture` → `{text: renderCapture(...), structured: {capture_id, status, receipt: text}}`; `file.dispose()` in `finally`.
  - Instruction line for capture-scoped tokens, verbatim: "When your user wants a file itself added, call kinote_capture_file: they drop the original in Kinote's panel, which keeps the file and files its text."

- [ ] **Step 1: Write the failing tests** in `mcpUpload.test.ts` (use `useCaptureKit`, an agent owned by the world owner with editor on Clients, token scopes `['read','capture']`; a helper `uploadAll(token, name, bytes)` that begins, chunks and returns the upload id):
  - `tools/list` shows `kinote_capture_file` with `_meta.ui.resourceUri === 'ui://kinote/capture-file'` and the four upload tools with `_meta.ui.visibility` `['app']`; a read-only token lists none of them.
  - `kinote_capture_file {notes:'put it under Clients', file_name:'Q3.pdf'}` → not an error; text contains `opened a panel`; `structuredContent` equals `{notes:'put it under Clients', file_as:'auto', limit_to:null, file_name:'Q3.pdf'}`. With `limit_to:'Clients'` the structured `limit_to` is `{space_id:<clients id>}`; `limit_to:'Nope'` is an error.
  - upload a text file "George renewed in December." then finish `{notes:'', file_as:'auto'}` → not an error; `structuredContent.capture_id` is a uuid; the capture row has `file_id` set, `sender_type 'agent'`; the file document is in the Inbox with `created_by_type 'user'`, `created_by` = owner; after `w.run()` the receipt text names a page.
  - the owner sees the file through `GET /api/v1/files/:id` (200); a second member gets 404.
  - uploading the same bytes twice captures twice, both referencing the same file id.
  - `POST /api/v1/captures` as the agent's owner with `{file_id: <another member's inbox file>, ownerFile: true}` → `document_not_found` (the body key is ignored); `kinote_capture` has no file path at all (assert its input schema has no `file_id`).
  - finish with an unknown id → error `Upload not found`; finish after one of two chunks → `The upload is incomplete`.
  - suspended workspace → begin refused with the suspension text; an agent with no editable space → `kinote_capture_file` refused with "You need to be able to edit at least one space to capture."
  - `initialize` instructions for a capture token contain the instruction line above.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/mcpUpload.test.ts` — Expected: FAIL (tools missing).
- [ ] **Step 3: Implement** per Interfaces. App-only tools' `data` arg: `z.string().max(1_500_000)` (base64 of 1 MiB is 1 398 104 chars).
- [ ] **Step 4: Run** the test file, `pnpm vitest run apps/api/test/capture*.test.ts apps/api/test/mcp*.test.ts`, `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): kinote_capture_file and upload tools file the original into the owner's Inbox`

### Task 4: The panel

**Files:**
- Modify: `apps/api/package.json` (deps), `pnpm-lock.yaml`, `apps/api/src/mcp/resources.ts` (`APP_RESOURCES` gains the panel)
- Create: `apps/api/src/mcp/app/capturePanel.ts` (DOM + `App` wiring), `apps/api/src/mcp/app/panelLogic.ts` (pure), `apps/api/src/mcp/app/panelHtml.ts`
- Test: `apps/api/test/capturePanel.test.ts`

**Interfaces:**
- Consumes: Task 1 `AppResource`; Task 3 tool names and structured shapes.
- Produces:
  - `panelLogic.ts`: `chunkCount(size, chunkBytes): number`; `toBase64(bytes: Uint8Array): string` (browser-safe, no `Buffer`); `uploadFile(file: {size:number; slice(a:number,b:number): {arrayBuffer(): Promise<ArrayBuffer>}}, call: (name, args) => Promise<{isError?: boolean; structuredContent?: any; content: Array<{text:string}>}>, onProgress: (sent:number,total:number)=>void, form: {notes, file_as, limit_to}): Promise<{ok:true; receipt:string} | {ok:false; message:string; stage:'begin'|'upload'|'finish'}>` — begin, chunks with 2 retries each, finish; `linkify(text): Array<{text:string} | {url:string}>`.
  - `panelHtml.ts`: `capturePanelHtml(): Promise<string>` — esbuild `build({ entryPoints:[capturePanel.ts], bundle:true, write:false, format:'iife', target:'es2020', minify:true })`, inlined into a small HTML shell with inline CSS using `light-dark()`/`prefers-color-scheme`; memoised promise.
  - `capturePanel.ts` uses the `App` class from `@modelcontextprotocol/ext-apps/app-with-deps` (check the 1.7.5 `.d.ts` for the exact handler and method names: tool input/result handlers, `callServerTool`, `updateModelContext`, `openLink`, host context theme). States and copy as spec §5.

- [ ] **Step 1: Write the failing tests** in `capturePanel.test.ts`:
  - `chunkCount(0,1048576)===0`, `(1,…)===1`, `(1048576,…)===1`, `(1048577,…)===2`; `toBase64` matches `Buffer.from(x).toString('base64')` for random 3000 bytes.
  - `uploadFile` with a fake `call`: 2.5 MiB file → calls `kinote_upload_begin`, 3 × `kinote_upload_chunk` with indexes 0,1,2, `kinote_upload_finish` with the form; progress ends at total; returns `{ok:true, receipt}` from `structuredContent.receipt`.
  - a chunk failing twice then succeeding → ok; failing three times → `{ok:false, stage:'upload', message:'Upload stopped — try again'}` and `kinote_upload_cancel` called.
  - begin returning `isError` with "This file is larger than 50 MB." → `{ok:false, stage:'begin', message:'This file is larger than 50 MB.'}`, no chunk calls.
  - `linkify('See https://k.example/p/1 now')` → three parts with the url in the middle.
  - `capturePanelHtml()` resolves to a string starting `<!doctype html>`, containing `<script>` and no `src=` attribute; `resources/read` of `ui://kinote/capture-file` over `/mcp` returns that HTML with mime `text/html;profile=mcp-app`.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/test/capturePanel.test.ts` — Expected: FAIL.
- [ ] **Step 3: Add deps** `pnpm --filter @kinote/api add @modelcontextprotocol/ext-apps@1.7.5 esbuild@0.18.20` (exact versions; confirm the lockfile keeps zod 3 and SDK 1.32). Implement the three files and register the resource.
- [ ] **Step 4: Run** the test file, `pnpm typecheck` — Expected: PASS. Typecheck must cover `apps/api/src/mcp/app/*.ts` (DOM lib: add a `/// <reference lib="dom" />` at the top of `capturePanel.ts` and `panelLogic.ts` if the API tsconfig lacks DOM).
- [ ] **Step 5: Commit** `feat(mcp): the capture-file panel as an MCP App`
- [ ] **Step 6: STOP — claude.ai check (spec Testing 1).** Ask the user to deploy the branch and, in claude.ai with a capture token, ask Claude to add a file larger than 2 MB. Record in the ledger: panel shown (y/n), file picker opens (y/n), upload finished (y/n), any host error text. If chunks fail on size, lower `UPLOAD_CHUNK_BYTES` (and the `data` max in Task 3) with a ledgered ruling before continuing.

### Task 5: End-to-end panel, docs

**Files:**
- Create: `e2e/capture-file-app.spec.ts`
- Modify: `README.md` ("Connect an agent" section and the tools table)

**Interfaces:**
- Consumes: everything above; `e2e/support.ts` (`seedWorld`, `call`, `openAs`) as in `e2e/edit-agents.spec.ts`.

- [ ] **Step 1: Write the e2e test** `a person drops a file into the Kinote panel and it is filed`:
  - Seed a world (review off), an agent with editor on the space and a `['read','capture']` token.
  - `page.route(baseURL + '/__stub-host', …)` fulfils an HTML page with an `<iframe id="panel" sandbox="allow-scripts allow-same-origin">` whose `srcdoc` is the panel HTML (fetched in the test via `resources/read`), and a small inline host script: answers `ui/initialize` with `{protocolVersion:'2026-01-26', hostCapabilities:{serverTools:{}}, hostInfo:{name:'stub',version:'0'}, hostContext:{theme:'light'}}`; after `ui/notifications/initialized` sends `ui/notifications/tool-input` with `{arguments:{notes:'put it under Clients', file_as:'auto'}}`; proxies `tools/call` to `fetch('/mcp')` with the bearer token and posts the JSON-RPC result back; acknowledges `ui/update-model-context` and records it on `window.__context`.
  - In the frame: expect text `put it under Clients`; `setInputFiles` on the file input with `notes.txt` ("George renewed in December."), click **Capture**, expect the receipt text, and `window.__context` non-empty.
  - As the owner in the web app, the file is visible (Inbox or under its page, per the receipt).
- [ ] **Step 2: Run** `pnpm e2e:local e2e/capture-file-app.spec.ts` — Expected: PASS (it exercises Tasks 1–4; if it fails, debug the panel, not the test).
- [ ] **Step 3: README** — tools table row: "`kinote_capture_file` | Shows a Kinote panel in clients with MCP Apps (claude.ai, Claude Desktop, VS Code Copilot…): your user drops the original file, which is kept and its text filed." and one paragraph under "Capture from an agent" explaining the panel, that the file is stored as the user's Inbox upload, and the 50 MB cap.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: green apart from the known `linkSites` failure on main.
- [ ] **Step 5: Commit** `test: a person drops a file into the Kinote panel; docs for kinote_capture_file`
