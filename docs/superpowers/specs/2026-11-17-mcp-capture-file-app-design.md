# MCP capture of whole files through an MCP App — design

Web Capture can attach a file: routing files its text and decides whether to keep the file under a page.
Over MCP, `kinote_capture` takes text only, and a client such as claude.ai cannot hand the original bytes of
an attached file to a tool (the model sees only extracted text). This adds an MCP App
(https://modelcontextprotocol.io/extensions/apps/overview): a Kinote panel in the conversation where the person
drops the original file, which is uploaded through app-only tools and captured with the agent's filing notes.

## Decisions taken with the user

- A new model-visible tool, `kinote_capture_file`, shows the panel; `kinote_capture` stays text-only.
- No web link: the bytes travel as base64 chunks through app-only tools the host proxies over the agent's
  MCP connection.
- The file lands in the agent owner's Inbox, stored as the owner's upload (Inbox items are visible only to
  their creator); capture accepts it from there for that agent.

## 1. Tools

### `kinote_capture_file` (model-visible)

Scope `capture`, `writes: true`, limit `capture`. Input:

| Arg | Type | Meaning |
| --- | --- | --- |
| `notes` | string, ≤ capture max, default `''` | Filing notes shown in the panel and sent as the capture text ("put it under Clients") |
| `file_as` | `auto \| document \| updates`, default `auto` | As `kinote_capture` |
| `limit_to` | string ≤ 200, optional | As `kinote_capture`; resolved now, so a bad scope is refused before the panel shows |
| `file_name` | string ≤ 255, optional | Hint shown in the panel: "Drop *Q3 report.pdf*" |

`_meta.ui.resourceUri = "ui://kinote/capture-file"`. It creates nothing. It checks credits and that the agent
can edit at least one space (the same gate as `createCapture`), so the panel never shows for a capture that
would be refused. Text result:

> Kinote opened a panel for your user to drop the file. When they press Capture, the receipt appears there and
> is shared with you. If no panel is shown (this client can't show MCP Apps), ask them to attach the file on
> the Capture page: <publicUrl>/w/<slug>/capture

`structuredContent: { notes, file_as, limit_to: <resolved {space_id|page_id}|null>, file_name }`: the panel
reads its arguments from the tool input/result notifications.

### App-only tools (`_meta.ui.visibility: ["app"]`)

All: scope `capture`, `writes: true`, refused while the agent is suspended. Descriptions start "Used by the
Kinote file panel." (a host that ignores `visibility` shows them to the model; they stay harmless).

| Tool | Input | Result |
| --- | --- | --- |
| `kinote_upload_begin` | `{name ≤255, size int > 0, mime ≤255}` | `{upload_id, chunk_bytes: 1048576}` |
| `kinote_upload_chunk` | `{upload_id, index int ≥ 0, data base64}` | `{received_bytes}` |
| `kinote_upload_finish` | `{upload_id, notes, file_as, limit_to?}` | capture receipt (text + `structuredContent`) |
| `kinote_upload_cancel` | `{upload_id}` | `{cancelled: true}` |

`upload_id` is a uuid. An upload belongs to the agent that began it; any other agent (same tenant or not)
gets "Upload not found" — never "forbidden".

**begin** refuses, with the message shown in the panel:
- `size > MAX_UPLOAD_BYTES` → "This file is larger than <N> MB."
- audio/video by `mime` or extension → "Audio and video can't be read yet."
- no credits → the existing credits error text.
- 3 open uploads for this agent already → "Finish or cancel another upload first."

begin first deletes this tenant's expired uploads and their parts (lazy cleanup; there is no periodic
worker job).

**chunk**: `data` decodes to ≤ `chunk_bytes`; every chunk but the last is exactly `chunk_bytes`. `index` must
equal the next expected index; an `index` already received is a no-op returning the current
`received_bytes` (retry after a lost reply); a gap → "Chunk <i> arrived before chunk <n>." Bytes beyond the
declared `size` → refused and the upload is cancelled. Bad base64 → refused.

**finish**: `received_bytes` must equal `size` ("The upload is incomplete: <a> of <b> bytes."). Then, in
order: stream the parts as one `UploadedFile` (hash computed while streaming), store it through `uploadFile`
(the same path as `POST /api/v1/files`) **as the agent's owner** into the Inbox — the person dropped the file,
and Inbox items are visible only to their creator, so the owner must be the creator to see it
(de-duplication by content hash among the owner's Inbox files applies) — delete the parts and the upload
row, then `createCapture(actor, {text: notes, shape: file_as, file_id, ...scope}, {channel: 'mcp',
ownerFile: true})` as the agent. The `mcp.tool_call` audit row records the agent. If capture creation fails
after the file was stored, the file stays in the owner's Inbox and the error is returned. finish then waits
for routing like `kinote_capture` with `wait: true` (up to 30 s), so the receipt can say where the file went.
The reply is the same text `kinote_capture` renders, plus `structuredContent: {capture_id, status,
receipt}` (receipt = that text) for the panel. Counts against the `capture` limit.

**cancel**: deletes the parts and row; unknown id is a no-op returning `{cancelled: true}`.

## 2. Storage

Migration `0049_mcp_uploads.sql`, table `mcp_uploads` (RLS by tenant like other tables):

| Column | |
| --- | --- |
| `id uuid pk`, `tenant_id`, `agent_id` | owner of the upload |
| `name text`, `mime text`, `size bigint` | as declared at begin |
| `received_bytes bigint default 0`, `next_index int default 0` | progress |
| `created_at`, `expires_at` (`created_at + 1 hour`) | |

Parts are objects in the existing storage under `uploads/<upload_id>/<index>` for the tenant. Expired rows
count as not found for chunk/finish.

## 3. Capture accepts the agent's file

Kinote has one Inbox space per workspace; an Inbox item is visible only to its creator (and tenant admins).
`captureFile` in `apps/api/src/routes/captures.ts` accepts an unarchived Inbox file created by the actor, as
now, or — only when `createCapture` is called with the internal option `ownerFile: true` (never reachable
from the HTTP body or a model-visible tool) — one created by the agent actor's owner (`actor.owner.userId`).
Everything after — keep or move the file, receipt, undo — is unchanged. The agent still cannot read the
Inbox (search, read, browse). The owner sees the file in their Inbox like any upload of theirs.

## 4. Limits

- New MCP limit `upload`: 120 calls a minute per agent for begin/chunk/cancel (`MCP_UPLOAD_PER_MINUTE`).
  finish uses `capture`; `kinote_capture_file` uses `capture`.
- Size cap: `MAX_UPLOAD_BYTES` (default 50 MB), checked at begin and on every chunk.
- At most 3 open (unexpired) uploads per agent.

## 5. The panel

One HTML file, `ui://kinote/capture-file`, served by `resources/read` with mime `text/html;profile=mcp-app`
and `_meta.ui.prefersBorder: true`; no CSP domains (everything inline). Written in
`apps/api/src/mcp/app/` (vanilla TypeScript using `@modelcontextprotocol/ext-apps@1.7.5`' `App` class — the
2.x line needs zod 4 and MCP SDK v2, the repo has zod 3 and SDK 1.32). The API runs from source with tsx and
has no build step, so the panel is bundled with esbuild (already installed with tsx and Vite; declared as an
API dependency) on first `resources/read` and cached in memory. The MCP server adds the `resources`
capability with list/read handlers for this one resource; tool `_meta` is included in `tools/list`.

States:
1. **Waiting** — notes from the tool input ("Notes: put it under Clients"), a drop zone with a "Choose file"
   button, the hint "Drop *<file_name>*" when given; Capture disabled until a file is chosen.
2. **Chosen** — name and size; Capture enabled; "Choose another".
3. **Uploading** — progress bar by `received_bytes / size`; Cancel. Each chunk retries twice on error,
   then "Upload stopped — try again" with Try again (starts a new upload).
4. **Refused** — begin's message; Choose another.
5. **Done** — the receipt: changed pages, where the file went (kept under a page / left in Inbox); page
   links open through `ui/open-link`. No Capture button. The panel sends the receipt text to the model with
   `ui/update-model-context`.

Follows the host's light/dark theme through the host context; usable at narrow widths.

## 6. Instructions and docs

- `instructions.ts` (capture-scoped token): "When your user wants a file itself added, call
  kinote_capture_file: they drop the original in Kinote's panel, which keeps the file and files its text."
- README "Connect an agent": a `kinote_capture_file` row; a note that the panel needs a client with MCP Apps
  (claude.ai, Claude Desktop, VS Code Copilot…).

## Testing

1. **claude.ai check** (a stop for the user once the panel works locally, before e2e and docs): the user
   deploys the branch and confirms in claude.ai that a ~1.4 MB `tools/call` from the app passes the host's
   proxy and that a file input works inside its sandbox. If either fails, reduce `chunk_bytes` (one constant)
   or revisit before finishing.
2. **API tests** (`apps/api/test/mcpUpload.test.ts`): begin → chunks → finish creates a capture with the
   file and the file lands in the Inbox created by the agent's owner; routing moves it to its page; repeated
   chunk index is a no-op; gap refused; overflow cancels; size mismatch at finish; expired upload not found;
   another agent's upload not found; read-only token refused; suspended agent refused; too large, audio and
   credits refused at begin; 4th open upload refused; cancel removes parts; expired uploads cleaned at begin.
   `createCapture` with `ownerFile` accepts the owner's Inbox file for the agent; without it (and for another
   member's file) it is `document_not_found`; the HTTP body cannot set it.
3. **Real MCP client test**: `tools/list` carries `_meta.ui` on `kinote_capture_file` and
   `visibility: ["app"]` on the upload tools; `resources/read` returns the panel HTML with the app mime type.
4. **Panel e2e** (`e2e/capture-file-app.spec.ts`): the built panel loaded in a page with a stub host that
   relays the app's `tools/call` to `/mcp` with an agent token; choose a file, see progress, see the receipt,
   and the file is under its page in the web app.
