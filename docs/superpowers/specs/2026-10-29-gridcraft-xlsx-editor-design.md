# GridCraft XLSX editor — design

Status: draft, 2026-10-29. Adds a real spreadsheet editor to the existing file page. The normal
preview is defined by `2026-10-29-extend-xlsx-preview-design.md`; execute that plan first. Follows the
file viewer work in `apps/web/src/viewers/` and the one-origin deployment in `docs/operations.md`.

## Why

The normal XLSX preview uses Extend UI's read-only `XlsxViewer`: it renders formulas, formatting,
charts and sheet tabs. Editors who need to change the workbook still have to download it, edit it
elsewhere, and upload it again through Replace.

GridCraft is a WASM spreadsheet with an official host bridge for embedding. Its v0.13.0 web build
opens `.xlsx`, renders formulas, fills, number formats, merged cells, filters, charts and sheet tabs
in the cases tested, and hands an edited workbook back to the parent page; our smoke save produced
a valid `.xlsx` that reopened with openpyxl. It is the closest fit for the file page without adding
a multi-gigabyte document server.

## Goals

1. An editor viewing the latest version of an `.xlsx` can open GridCraft in the file page, edit the
   workbook, and save it as a new version of the same wiki file.
2. The Extend UI read-only preview remains the default. GridCraft loads only after an explicit
   **Edit in GridCraft** click, so a casual view does not download the ~20 MB WASM build.
3. Saving uses the existing version endpoint. The previous version stays available; no bytes are
   overwritten and no new backend route is introduced.
4. The console stays on one public origin. GridCraft is served under `/gridcraft/` behind the web
   nginx, not from a second domain.
5. GridCraft never receives the wiki session. The editor iframe runs with an opaque origin and
   cannot read the console's `localStorage` token.
6. Every unsupported case keeps working: viewers, reviewers in the review dialog, older versions,
   synced files, large files, unsupported browsers, and a failed editor load all fall back to the
   Extend UI preview or download.

## Non-goals

- A read-only GridCraft view. GridCraft has no read-only mode; viewers keep the Extend UI preview.
- Opening GridCraft automatically on every XLSX page. *(my call: the 20 MB alpha editor is opt-in;
  the fast preview stays the default. Auto-open can be a later preference.)*
- Editing older versions, files kept in sync by a source, files in review dialogs, or XLSX embeds.
- Replacing the Extend UI preview from this plan. The preview spec owns that surface; GridCraft
  only adds the edit path.
- Preserving the `?page=` sheet deep link in GridCraft. The host bridge has no command to open a
  specific sheet; the preview keeps the deep link, and the editor opens the workbook at its first
  sheet. *(my call: ship this limitation rather than fork GridCraft.)*
- Real-time collaboration inside GridCraft. The wiki's page collaboration is unchanged; the
  spreadsheet editor is single-user, and saves are versioned snapshots.
- `.xls`, `.xlsm`, `.ods` or macros. The wiki's file type map still only sends `.xlsx` to this path.
- Patching GridCraft or building the WASM from source.

## Decisions

- **Host the official v0.13.0 web build, pinned by checksum.** Release zip:
  `gridcraft-web-0.13.0.zip`, SHA-256
  `e232edde1898459f13568ca7b1f3feecb4037f0cbb8f6aec86de1a3c096af5dc`. Do not use the unofficial
  `gridcraft-embed` package.
- **One origin, one static path.** Add a small internal `gridcraft` service and proxy
  `/gridcraft/` from the web nginx. The gridcraft service gets no Coolify domain and no public
  host mapping; only `127.0.0.1:${GRIDCRAFT_HOST_PORT:-8082}` is published for local Vite work.
- **Sandbox the iframe with `allow-scripts` only.** `allow-same-origin` is forbidden: the console
  keeps its bearer token in `localStorage`, and a same-origin iframe could read it. The opaque
  sandbox origin is what makes same-origin hosting safe.
- **CORS on the GridCraft assets only.** An opaque-origin iframe fetches module scripts and WASM
  cross-origin, so `/gridcraft/` responses need `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin`. The wiki API keeps its same-origin, token-based
  auth; no CORS is added there.
- **Use the official host bridge.** Parent sends `gridcraft:open` with `targetOrigin: '*'` (the
  iframe origin is opaque) and a copy of the workbook bytes. Parent accepts messages only when
  `event.source === iframe.contentWindow` and `event.origin === 'null'`.
- **Use `?host=parent&webgl&chrome=none`.** Compact mode hides the duplicate title bar and the File
  tab. The parent supplies the file identity and shows the save instruction. The user saves with
  Ctrl+S, which the bridge turns into `gridcraft:save`. This avoids exposing GridCraft's File > Open
  (which could load an unrelated workbook) and its Autosave toggle.
- **Save through the existing `POST /api/v1/files/:id/versions`.** Reuse the file page's `replace`
  mutation. The server detects the type, stores the bytes, creates version N, updates the latest
  pointer, and runs extraction/review exactly as it does for Replace. The old version remains.
- **Only editors on the latest version get the button.** Gate on `fileControls(...).replace`,
  `shown.id === file.latestVersion?.id`, and the file being XLSX. Viewers, synced files, archived
  files, older versions and review previews get the Extend UI preview.
- **Guard what GridCraft hands back.** Upload only when the save name is the same `.xlsx` name that
  was opened. A PDF export or a differently named file is downloaded as a copy, not uploaded over
  the wiki file. A same-named workbook dropped into the editor is indistinguishable by name and
  would become a new version, with the old version preserved; the File tab is hidden to make that
  path less likely. The filename used for the upload is the original version's `fileName`, not an
  arbitrary name from the iframe.
- **Treat the editor as untrusted UI.** Validate message origin, source, type and payload; never
  put the session token in the URL, storage or message. The iframe has no `allow-same-origin`,
  `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-downloads`.
- **Keep saves in the existing review flow.** A review space's new version becomes
  `pending_review`; the editor says "Saved as version N. The new version is being read." The
  current published version remains visible to readers until the new one is indexed.
- **Dirty edits are guarded.** The editor reports dirty state to the file page. The page uses
  TanStack Router's `useBlocker` (with `enableBeforeUnload` on) and asks before discarding. A
  failed upload keeps the page's unsaved state even if GridCraft reports itself saved, and offers
  a download of the bytes.

## Architecture

```
Browser, one origin (https://wiki)

  FilePage
    XlsxViewer (Extend UI read-only default)
      [Edit in GridCraft]  (editors, latest version only)
        GridCraftEditor (lazy chunk)
          <iframe sandbox="allow-scripts"
                  src="/gridcraft/?host=parent&webgl&chrome=none&author=...">
            GridCraft WASM (opaque origin, no wiki storage/cookies)
          </iframe>
          postMessage: ready / open / save / dirty / failed
    replace mutation
      POST /api/v1/files/:id/versions  ->  new FileVersion, latest pointer

  nginx
    /gridcraft/  ->  gridcraft:80 (pinned static files)
```

The static service is internal. The web nginx is the only public listener. The browser sees the
GridCraft URL on the wiki origin; the sandbox makes its security origin opaque, so it is treated
as cross-origin for storage and CORS.

## Hosting and build

`apps/gridcraft/Dockerfile` fetches the pinned release into an nginx image:

- `ARG GRIDCRAFT_VERSION=0.13.0`
- `ARG GRIDCRAFT_SHA256=e232...`
- Download `https://github.com/storytold/gridcraft/releases/download/v${GRIDCRAFT_VERSION}/gridcraft-web-${GRIDCRAFT_VERSION}.zip`
- Verify `sha256sum -c -`; unzip; copy the `gridcraft-web-${GRIDCRAFT_VERSION}` directory into
  `/usr/share/nginx/html`.
- Include the release's `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` files.

`apps/gridcraft/nginx.conf`:

- `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin` on every
  response, including the HTML.
- `application/wasm` for `.wasm`.
- Gzip for WASM, JS and CSS.
- Hashed JS/WASM assets cached for a year; `index.html` revalidated.
- `try_files $uri $uri/ =404`, so a missing asset does not return the HTML shell.

`docker-compose.yml`:

- Add `gridcraft`, built from `./apps/gridcraft`, exposing port 80, with a `wget` healthcheck.
- Publish only `127.0.0.1:${GRIDCRAFT_HOST_PORT:-8082}:80` for local Vite work.
- Make `web` depend on `gridcraft` being healthy.

`apps/web/nginx.conf`:

```nginx
set $gridcraft http://gridcraft:80;

location ^~ /gridcraft/ {
  rewrite ^/gridcraft/(.*)$ /$1 break;
  proxy_pass $gridcraft;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;
}
```

The `^~` prefix is required so the existing `\.mjs$` regex does not steal a GridCraft asset. The
rewrite strips `/gridcraft/`; the app's relative asset URLs then resolve back through the same
prefix.

For `vite dev` and `vite preview`, add `/gridcraft` to `server.proxy` using a `gridcraftUrl` from
`dev-targets.ts` (default `http://127.0.0.1:8082`, overridable with `GRIDCRAFT_URL`), with the same
prefix rewrite. Vite's preview server inherits `server.proxy`, so this also covers the local e2e
harness.

## The host bridge

Parent -> iframe:

- On `gridcraft:ready`, send
  `{ type: 'gridcraft:open', name: version.fileName, bytes: copy }` with `targetOrigin: '*'` and
  transfer `copy`. Copy with `bytes.slice(0)` so the React Query cache's buffer is not detached.
- The iframe URL includes `host=parent`, `webgl`, `chrome=none`, and `author=<signed-in name>`.

Iframe -> parent, accepted only after the source/origin checks:

- `gridcraft:ready` — send the workbook.
- `gridcraft:dirty` `{ dirty: boolean }` — update the page's unsaved state.
- `gridcraft:save` `{ name, bytes }` — validate and upload.
- `gridcraft:failed` `{ error }` — show the error and the preview fallback.

`parseGridCraftMessage(data)` validates the shape and normalizes `ArrayBuffer`/typed-array bytes.
`isSpreadsheetSave(name, originalName)` accepts only a name that ends in `.xlsx` and matches the
opened name case-insensitively after trimming.

## Save flow

1. The user edits a cell; GridCraft sends `gridcraft:dirty {dirty:true}`. The editor shows
   "Unsaved changes" and the file page's blocker is armed.
2. The user presses Ctrl+S. GridCraft sends `gridcraft:save` with the workbook bytes and its
   current name.
3. `GridCraftEditor` checks the name. A non-XLSX or mismatched name is offered as a browser
   download; it is not uploaded.
4. A valid save is queued one at a time. The editor builds
   `new File([bytes], version.fileName, { type: version.mimeType })` and calls the file page's
   `replace.mutateAsync(form)`.
5. The API creates the new version and returns `UploadFileResponse`. The file page shows
   "Saved as version N. The new version is being read." and invalidates the file/versions queries.
6. The editor clears its dirty state only after the upload succeeds. If the upload fails, it keeps
   the bytes and shows "Couldn't save. Download a copy." The file page's `replace.error` also shows
   the API error.
7. The page may switch to the new latest version and remount the editor. That is acceptable for v1;
   the saved bytes are the current workbook. A later refinement can hold the editor mount.

## Permissions and version rules

`canEditSpreadsheet` is true only when all of these hold:

- `fileControls({ role, spaceArchived, archived, placement, sourceDeleted, badge }).replace` is true
  (editor or higher, live, not synced);
- `shown` is present and `shown.id === file.latestVersion?.id`;
- `shown.mimeType` maps to XLSX.

The button is hidden below `md` because the desktop ribbon is not usable on a phone; the preview
remains. The API still enforces the role on save, so the UI gate is convenience, not security.

When `shown` is an older version, the page shows "Viewing an older version. Open the latest version
to edit it." and passes no `onSave`.

## UX states

- **Preview:** Extend UI's read-only workbook, plus a secondary **Edit in GridCraft** button for
  eligible editors.
- **Loading:** "Loading GridCraft…" and a **Back to preview** button.
- **Editing:** "Editing <name>. Press Ctrl+S to save a new version." Persistent and visible.
- **Dirty:** "Unsaved changes."
- **Saving:** "Saving…"; the save icon is not available, so Ctrl+S remains the action.
- **Saved:** "Saved as version N." The page-level status remains after the editor remounts.
- **Invalid save:** "GridCraft is bound to <original>. Downloaded a copy instead."
- **Failed:** "GridCraft couldn't start: <error>. Use the read-only preview." or
  "Couldn't save: <error>. Your edits are still here; download a copy."
- **Navigation with unsaved changes:** `window.confirm('Discard unsaved spreadsheet changes?')`;
  Cancel keeps the page, Discard proceeds.

## Security

- The sandbox is the boundary. Without `allow-same-origin`, the iframe cannot read the wiki's
  `localStorage`, cookies, DOM or opener. `localStorage` in the iframe throws a `SecurityError`;
  GridCraft logs "preferences: browser storage is unavailable" and uses defaults.
- The iframe can still run WASM, WebGL, canvas and `postMessage`; clipboard copy/paste works (paste
  opens GridCraft's Paste Special dialog).
- CORS `*` is limited to public static assets. The wiki API is not CORS-enabled and the session
  bearer token never reaches the iframe.
- The iframe cannot navigate the top page, open popups, submit forms or download. The parent owns
  the only download action.
- The pinned release is verified at build time. Upgrading is an explicit version + checksum change.
- The editor is alpha. Saves create a new version; the original remains available. Test real
  workbooks before enabling it for a team. Unsupported Excel features may be dropped in a saved
  copy, but the old version is never overwritten.

## Testing

- Unit: message parser/normalizer, save-name guard, iframe URL, dev target.
- E2E (fake iframe, no WASM in CI): editor opens and saves through the bridge; a message from the
  wrong source is ignored; viewers and older versions see no editor; dirty navigation prompts;
  non-XLSX saves download instead of upload. The fake page implements the same `ready/open/save/
  dirty` protocol and is served by Playwright routing `/gridcraft/**`.
- The existing XLSX preview e2e runs against Extend UI's DOM renderer: tabs, cells and `?page=2`
  must still pass before the GridCraft tests are relevant.
- Manual smoke against the real v0.13.0 build: a workbook with formulas, fills, number formats,
  merged cells, a filter and a chart; edit, Ctrl+S, version 2, download, reopen with openpyxl; check
  the old version and the sandbox in DevTools.
- Build/typecheck/bundle report and the existing file viewer tests.

## Known limitations

- GridCraft is alpha (~50% ready for real work by its own roadmap). It has had fast-input and
  fidelity bugs. The versioned save is the safety net.
- No read-only mode; viewers stay on the Extend UI preview.
- `?page=` is preview-only. The editor opens the first sheet.
- Preferences and theme choices do not persist in the sandbox; GridCraft follows the OS theme.
- The editor is not real-time collaborative. Two people saving the same file create two versions.
- The File tab is hidden, but GridCraft still accepts drag-and-drop. A differently named dropped
  workbook is downloaded; a same-named one can become a new version, with the old version preserved.
- A failed save keeps the bytes only in the open page; the user must download a copy before
  leaving if they want to keep the edits.
- The alpha build's `chrome=none` has no visible save icon; Ctrl+S is the documented save action.
