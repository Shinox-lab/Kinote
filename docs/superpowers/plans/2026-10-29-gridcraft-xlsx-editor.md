# GridCraft XLSX editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An editor viewing the latest `.xlsx` can open the official GridCraft v0.13.0 editor inline, edit the workbook, and save it as a new version of the wiki file. Everyone else keeps the Extend UI read-only preview.

**Architecture:** GridCraft is a pinned static service behind the existing web nginx at `/gridcraft/`. It runs in an iframe with `sandbox="allow-scripts"` so its opaque origin cannot read the console's `localStorage` session. The parent uses GridCraft's `postMessage` host bridge and saves through the existing `POST /api/v1/files/:id/versions` endpoint. No backend route changes.

**Spec:** `docs/superpowers/specs/2026-10-29-gridcraft-xlsx-editor-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-10-29-extend-xlsx-preview.md` must be implemented
first. This plan adds the editor to that viewer; it does not rework the preview.

## Global Constraints

- One public origin. GridCraft is only at `/gridcraft/`; no Coolify domain for the `gridcraft` service.
- The iframe sandbox is exactly `allow-scripts`. Never add `allow-same-origin`.
- The GridCraft static assets send `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin`; the wiki API does not get CORS.
- Pin `GRIDCRAFT_VERSION=0.13.0` and SHA-256
  `e232edde1898459f13568ca7b1f3feecb4037f0cbb8f6aec86de1a3c096af5dc`.
- Iframe URL: `/gridcraft/?host=parent&webgl&chrome=none&author=<encoded user name>`.
- Editor only when `fileControls(...).replace`, the shown version is `file.latestVersion`, and the
  MIME is XLSX. Viewers, older versions, synced files, review dialogs and embeds stay read-only.
- Save only the same-name `.xlsx`. A PDF or differently named file is downloaded as a copy. A
  same-named dropped workbook is indistinguishable by name and would create a new version; the old
  version is preserved.
- Save with the file page's existing `replace` mutation. Do not add an API route or change
  `replaceFile`/`insertFileVersion`.
- The GridCraft embed adds no package dependency; the Extend UI preview dependency is covered by
  the preview plan. The iframe, `postMessage` and `File`/`Blob` APIs are platform features.
- The Extend UI preview is the default; the ~20 MB GridCraft build loads only after the edit click.
- Tests use a Playwright-routed fake iframe. The real WASM build is a manual smoke test, not CI.
- Commits end with the project's `Co-Authored-By` line. Stage only the files named in the task;
  do not stage other sessions' files.

## Review Focus

1. The iframe really has an opaque origin: `sandbox="allow-scripts"`, no `allow-same-origin`, and
   the parent accepts only `event.origin === 'null'` with `event.source === iframe.contentWindow`.
2. A PDF or a different-named workbook cannot replace the wiki file; the old version remains.
3. Only editors on the latest XLSX see the button; viewers and older versions do not.
4. A failed upload keeps the page dirty and preserves the edited bytes for download.
5. `/gridcraft/` is proxied with the prefix stripped, serves `application/wasm`, and loads inside
   the sandbox with CORS headers.

---

### Task 1: Pin and serve the GridCraft static build

**Files:**
- Create `apps/gridcraft/Dockerfile`
- Create `apps/gridcraft/nginx.conf`
- Create `apps/gridcraft/README.md`
- Modify `docker-compose.yml`
- Modify `apps/web/nginx.conf`
- Modify `apps/web/dev-targets.ts`
- Modify `apps/web/vite.config.ts`
- Modify `apps/web/test/devTargets.test.ts`
- Modify `.env.example`

**Build the image:**

```dockerfile
FROM alpine:3.20 AS fetch
ARG GRIDCRAFT_VERSION=0.13.0
ARG GRIDCRAFT_SHA256=e232edde1898459f13568ca7b1f3feecb4037f0cbb8f6aec86de1a3c096af5dc
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/gridcraft.zip \
    "https://github.com/storytold/gridcraft/releases/download/v${GRIDCRAFT_VERSION}/gridcraft-web-${GRIDCRAFT_VERSION}.zip" \
 && echo "${GRIDCRAFT_SHA256}  /tmp/gridcraft.zip" | sha256sum -c - \
 && unzip -q /tmp/gridcraft.zip -d /tmp/gridcraft \
 && mv "/tmp/gridcraft/gridcraft-web-${GRIDCRAFT_VERSION}" /site

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=fetch /site /usr/share/nginx/html
EXPOSE 80
```

`apps/gridcraft/nginx.conf` serves the app with:

- `add_header Access-Control-Allow-Origin "*" always;`
- `add_header Cross-Origin-Resource-Policy "cross-origin" always;`
- `gzip on;` and `gzip_types application/wasm application/javascript text/css;`
- a `.wasm` location with `default_type application/wasm` and `expires 1y`;
- hashed JS/CSS/WASM cached for a year; `index.html` revalidated;
- `location / { try_files $uri $uri/ =404; }` so a missing asset is not HTML.

Add the service to `docker-compose.yml`:

```yaml
  gridcraft:
    build:
      context: ./apps/gridcraft
    ports:
      - "127.0.0.1:${GRIDCRAFT_HOST_PORT:-8082}:80"
    expose:
      - "80"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1/ || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
```

Add `gridcraft: { condition: service_healthy }` to the `web` service's `depends_on`.

In `apps/web/nginx.conf`, add `set $gridcraft http://gridcraft:80;` beside the api/collab sets,
and before `location /`:

```nginx
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

The `^~` keeps the existing `\.mjs$` regex from taking a GridCraft asset. The rewrite strips the
prefix; the app's relative asset URLs resolve back through `/gridcraft/`.

Add `gridcraftUrl` to `devTargets`:

```ts
const DEFAULT_GRIDCRAFT_PORT = 8082;
return {
  apiUrl: ...,
  collabUrl: ...,
  gridcraftUrl: env.GRIDCRAFT_URL || `http://127.0.0.1:${parsePort(env.GRIDCRAFT_HOST_PORT) ?? DEFAULT_GRIDCRAFT_PORT}`,
};
```

Add the proxy in `vite.config.ts`:

```ts
'/gridcraft': {
  target: gridcraftUrl,
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/gridcraft/, ''),
},
```

Update `apps/web/test/devTargets.test.ts` so every expected object includes `gridcraftUrl`; add a
case for `GRIDCRAFT_URL` and `GRIDCRAFT_HOST_PORT`. Vite preview inherits `server.proxy`, so the
local e2e harness needs no separate `preview.proxy`.

Add to `.env.example`:

```dotenv
# Local console only: the GridCraft static service for `vite dev`.
GRIDCRAFT_HOST_PORT=8082
```

`apps/gridcraft/README.md` records the release URL, version, checksum and the upgrade rule: change
the version and checksum together, rebuild, smoke-test, then deploy.

**Verify:**

```bash
docker compose build gridcraft
docker compose up -d --wait gridcraft web
curl -sI http://127.0.0.1:${WEB_HOST_PORT:-8081}/gridcraft/ | grep -iE 'HTTP/|access-control|cross-origin'
curl -s http://127.0.0.1:${WEB_HOST_PORT:-8081}/gridcraft/ | grep -o 'gridcraft-web-[^"]*\.js' | head -1
```

Take the asset name from the last command and check `content-type` and cache headers on the JS and
the WASM. `pnpm exec vitest run apps/web/test/devTargets.test.ts`.

**Commit:** `feat(web): serve pinned GridCraft static build`

---

### Task 2: Validated host-message helpers

**Files:**
- Create `apps/web/src/viewers/gridcraft.ts`
- Create `apps/web/src/viewers/gridcraft.test.ts`

Create the pure helpers:

```ts
export type GridCraftMessage =
  | { type: 'ready' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'save'; name: string; bytes: ArrayBuffer }
  | { type: 'failed'; error: string };

export function parseGridCraftMessage(data: unknown): GridCraftMessage | null;
export function isSpreadsheetSave(name: string, originalName: string): boolean;
export function gridcraftUrl(author?: string): string;
```

Rules:

- `ready`: object with `type: 'ready'`; extra fields ignored.
- `dirty`: `dirty` must be a boolean.
- `save`: `name` a non-empty string; `bytes` an `ArrayBuffer` or `ArrayBufferView`; normalize a view
  to a fresh `ArrayBuffer` covering exactly its byte range.
- `failed`: `error` a string.
- Unknown type, null, arrays, missing fields and wrong types return `null`.
- `isSpreadsheetSave` trims both names, compares case-insensitively, and requires `.xlsx` on both.
  `Budget.pdf`, `Other.xlsx` and an empty name are false.
- `gridcraftUrl('Ada Lovelace')` is
  `/gridcraft/?host=parent&webgl&chrome=none&author=Ada%20Lovelace`.

Test every branch, including a `Uint8Array` offset view and the invalid-name cases.

**Verify:** `pnpm exec vitest run apps/web/src/viewers/gridcraft.test.ts`

**Commit:** `feat(web): GridCraft host message helpers`

---

### Task 3: The GridCraft editor component

**Files:**
- Create `apps/web/src/viewers/GridCraftEditor.tsx`

Default component with this interface:

```ts
export interface GridCraftEditorProps {
  bytes: ArrayBuffer;
  version: FileVersion;
  onSave: (file: File) => Promise<UploadFileResponse>;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}
```

Behavior:

- Render an iframe with `sandbox="allow-scripts"`, `allow="clipboard-read; clipboard-write"`,
  `title={`${version.fileName} spreadsheet editor`}`, and
  `src={gridcraftUrl(loadSession()?.user.name)}`. Height `h-[70vh] min-h-[520px] w-full`.
- Add one `message` listener in an effect. Accept only
  `event.source === frame.current?.contentWindow && event.origin === 'null'`; parse with
  `parseGridCraftMessage`. Keep `onSave`/`onDirtyChange`/`version` in refs so the listener is
  installed once.
- On `ready`, send `gridcraft:open` with the version's `fileName` and `bytes.slice(0)`, using
  `targetOrigin: '*'` and transferring the copy. Do not transfer the React Query buffer.
- On `dirty`, keep local dirty state and call `onDirtyChange(dirty)`.
- On `save`, call `isSpreadsheetSave(data.name, version.fileName)`. If false, create a browser
  download of the bytes named from the message (fall back to `version.fileName`) and show a status;
  do not call `onSave`.
- For a valid save, enqueue on a single promise chain so two Ctrl+S messages cannot upload out of
  order. Build `new File([bytes], version.fileName, { type: version.mimeType })`, await `onSave`,
  and show `Saved as version ${response.version.number}`. A second queued save after the first is
  `unchanged` at the API if the bytes did not change.
- Keep the parent dirty while a save is in flight and after a failed or rejected save, even if
  GridCraft sends `dirty:false`; clear only after a successful upload. On a failed save, keep the
  bytes for a **Download a copy** action.
- On `failed`, show "GridCraft couldn't start: <error>." and keep **Back to preview** available.
- Status bar with `role="status" aria-live="polite"`: loading, "Editing <name>. Press Ctrl+S to
  save a new version.", "Unsaved changes", "Saving…", saved version, and errors. The parent still
  shows the save hint if the iframe has not sent status yet.
- **Back to preview** calls `onClose`; if dirty or save-failed, ask
  `window.confirm('Discard unsaved spreadsheet changes?')` first.
- Effect cleanup removes the listener and calls `onDirtyChange(false)`.
- Do not add any `allow-same-origin`, top-navigation, popup, form or download sandbox token.

**Verify:** `pnpm typecheck`

**Commit:** `feat(web): GridCraft editor host bridge`

---

### Task 4: Wire the editor into the latest XLSX only

**Files:**
- Modify `apps/web/src/viewers/FileViewer.tsx`
- Modify `apps/web/src/viewers/XlsxViewer.tsx`
- Modify `apps/web/src/routes/file.tsx`

`FileViewer.tsx`:

- Add optional props to `ViewerProps`:
  `onSave?: (file: File) => Promise<UploadFileResponse>` and
  `onDirtyChange?: (dirty: boolean) => void`.
- Add them to `FileViewer`'s props, pass them through `Bytes` to `VIEWERS`, and add them to the
  XLSX mapping (which already passes `version` and `page` from the preview plan).
- Do not change `FileReviewPreview` or `FileEmbedView`; they pass no save callback, so they keep
  the read-only preview.

`XlsxViewer.tsx` (already the Extend UI viewer from the prerequisite plan):

- Change the props to
  `{ bytes: ArrayBuffer; version: FileVersion; page?: number; onSave?: ...; onDirtyChange?: ... }`.
- Keep the Extend UI preview in an inner `ExtendPreview` component. The controller lives there, so
  opening GridCraft unmounts it and does not keep a second parsed workbook in memory.
- Add `const [editing, setEditing] = useState(false);` and lazy-import the editor so its chunk
  loads only on the click:
  `const GridCraftEditor = lazy(() => import('./GridCraftEditor.js'));`
- When `editing && onSave`, render `<Suspense fallback={<Loading what="editor" />}><GridCraftEditor
  bytes={bytes} version={version} onSave={onSave} onDirtyChange={onDirtyChange}
  onClose={() => setEditing(false)} /></Suspense>`.
- Otherwise render a small "Read-only preview" line and a secondary **Edit in GridCraft** button
  (`max-md:hidden`) when `onSave` exists, then `<ExtendPreview ... />`.
- The button sits outside the Extend error state. If the preview cannot parse the workbook, an
  editor can still try GridCraft with the same bytes; this is deliberate.
- Keep the Extend preview's 15 s watchdog and its download fallbacks. Do not add any old table or
  parser code back.

`file.tsx`:

- Import `MIME` from `../lib/mime.js` and `useBlocker` from `@tanstack/react-router`.
- Add `const [editorDirty, setEditorDirty] = useState(false);`.
- Add `saveEditedFile`:
  ```ts
  const saveEditedFile = async (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    return replace.mutateAsync(form);
  };
  ```
- Add the blocker before the early returns (hooks must be unconditional):
  ```ts
  const { status, proceed, reset } = useBlocker({ shouldBlockFn: () => editorDirty, withResolver: true });
  const leavePrompted = useRef(false);
  useEffect(() => {
    if (status !== 'blocked') {
      leavePrompted.current = false;
      return;
    }
    if (leavePrompted.current) return;
    leavePrompted.current = true;
    if (window.confirm('Discard unsaved spreadsheet changes?')) proceed();
    else reset();
  }, [status, proceed, reset]);
  ```
  The ref prevents a second prompt if the resolver functions change identity. `enableBeforeUnload`
  stays at its default (true), covering reload/close.
- Reset `editorDirty` when the file or shown version changes.
- After `controls` and `shown` are known:
  ```ts
  const canEditSpreadsheet =
    controls.replace &&
    shown !== null &&
    shown.id === file.latestVersion?.id &&
    shown.mimeType === MIME.xlsx;
  ```
- Pass `onSave={canEditSpreadsheet ? saveEditedFile : undefined}` and
  `onDirtyChange={canEditSpreadsheet ? setEditorDirty : undefined}` to `FileViewer`.
- Add a page-level saved status next to the existing `replace.data.unchanged` note:
  ```tsx
  {replace.data && !replace.data.unchanged && (
    <p role="status" className="text-sm text-muted">
      Saved as version {replace.data.version.number}. The new version is being read.
    </p>
  )}
  ```
- When an editor is viewing an older XLSX, show
  "Viewing an older version. Open the latest version to edit it." above the preview.
- The existing `replace.error` note covers save failures; the editor keeps its own error and
  download-copy action.

**Verify:** `pnpm typecheck`, `pnpm exec vitest run apps/web/src/viewers/gridcraft.test.ts`.

**Commit:** `feat(web): edit latest spreadsheet in GridCraft`

---

### Task 5: Browser tests with a fake GridCraft iframe

**Files:**
- Create `e2e/gridcraft.spec.ts`
- Modify `e2e/support.ts` to add `replaceViaApi(request, world, account, fileId, file)` (the same
  auth headers as `uploadViaApi`, multipart POST to `/files/:id/versions`, returns the parsed
  `UploadFileResponse`)

Add a Playwright-routed fake page for `**/gridcraft/**`. It implements the same protocol and has
no WASM:

- On load, `parent.postMessage({ type: 'gridcraft:ready' }, '*')`.
- On `gridcraft:open`, show `Opened <name> (<byteLength> bytes)` in `#opened`.
- `#dirty` posts `{ type: 'gridcraft:dirty', dirty: true }`; `#clean` posts false.
- `#save` posts `{ type: 'gridcraft:save', name: 'Budget.xlsx', bytes }` with the base64-injected
  valid XLSX from `xlsx('Budget.xlsx', world.suffix + '-edited', ...)`, transferred.
- `#save-pdf` posts `{ type: 'gridcraft:save', name: 'Budget.pdf', bytes }`.
- The fake page is served with `contentType: 'text/html'`; its script is inline so the sandbox needs
  no module CORS.

Tests:

1. **editor opens and saves a new version**
   - Seed a world, upload `xlsx('Budget.xlsx', ...)`, wait for `Indexed`.
   - Route `/gridcraft/**`; open the file as the owner; assert the Extend UI preview is visible
     (the workbook's cells are readable) and the **Edit in GridCraft** button exists.
   - Click Edit; assert the iframe has `sandbox="allow-scripts"`, its `src` contains `host=parent`
     and `chrome=none`, and the fake shows the opened name and byte length.
   - Send a `gridcraft:save` from the page (not the iframe) with the top-level
     `window.postMessage`; assert the version count stays 1. This proves the source check.
   - In the iframe, click `#save`; expect the file page's `Saved as version 2. The new version is
     being read.` The versions API has version 2 first and version 1 still present; wait for the new
     file badge to index.

2. **viewers and older versions stay read-only**
   - Add a viewer with `addMember`; upload an XLSX as the owner; wait for `Indexed`.
   - Open as the viewer: assert the Extend UI preview is visible (the cells are readable) and there is
     no **Edit in GridCraft**.
   - As the owner, create a second version through the API (add a small `replaceViaApi` helper using
     multipart), open `?v=<version 1 id>`, and assert there is no edit button and the older-version
     note is visible.

3. **unsaved changes prompt before leaving**
   - With the fake editor open, click `#dirty`.
   - Click the breadcrumb's space link (`nav[aria-label="Breadcrumb"]` -> link with the space name).
   - Wait for a dialog with `Discard unsaved spreadsheet changes?`; dismiss it; assert the URL is
     still the file page. Click `#clean`, click the link, and assert navigation completes.

4. **a non-XLSX save downloads instead of uploading**
   - With the fake editor open, click `#save-pdf`; wait for the download and assert the suggested
     name is `Budget.pdf`; assert the versions API still has one version.

Keep the real 20 MB WASM out of CI. The manual smoke test in Task 6 covers it.

**Verify:** `pnpm e2e:local e2e/gridcraft.spec.ts`

**Commit:** `test(e2e): GridCraft spreadsheet editing`

---

### Task 6: Operations, manual smoke and full verification

**Files:**
- Modify `docs/operations.md`

Add a **GridCraft** section to `docs/operations.md`:

- v0.13.0, pinned SHA-256, official release URL; `apps/gridcraft/Dockerfile` is the upgrade point.
- Internal service `gridcraft:80`; web nginx owns `/gridcraft/`; no Coolify domain and no public
  port. `GRIDCRAFT_HOST_PORT` (default 8082) is local-only for `vite dev`.
- One origin still: the only CORS is on the public GridCraft static assets, needed because the
  sandboxed iframe has an opaque origin. The API remains same-origin and token-authenticated.
- `sandbox="allow-scripts"` is deliberate; never add `allow-same-origin` (the console's bearer
  token is in `localStorage`).
- Save behavior: Ctrl+S creates a new version, keeps the old one, and follows the space's review
  rules. Only editors on the latest XLSX see the editor. Viewers and older versions stay read-only.
- Alpha caveat: test representative real workbooks; unsupported Excel features may be dropped in a
  saved copy. Never overwrite the only copy.
- `?page=` stays on the preview; the GridCraft editor opens the first sheet. Preferences do not
  persist in the sandbox.
- Upgrade steps: bump `GRIDCRAFT_VERSION` and `GRIDCRAFT_SHA256` together, rebuild, re-run the
  smoke test, deploy, verify CORS and WASM MIME.

Manual smoke checklist against the real build:

1. `docker compose up -d --build --wait`; open a real workbook with formulas, fills, number
   formats, merged cells, a filter and a chart.
2. Verify the preview still renders, click **Edit in GridCraft**, and check the same features in
   GridCraft.
3. Edit one cell, press Ctrl+S, wait for `Saved as version 2`, and confirm version 1 is still in the
   rail.
4. Download version 2, open it with openpyxl, and check the edited cell plus which formulas, fills
   and chart survived; record any fidelity loss.
5. In DevTools, run `document.querySelector('iframe').contentWindow.localStorage` and confirm it
   throws; confirm the sandbox attribute is `allow-scripts`. Confirm the GridCraft console warns
   that browser storage is unavailable but the editor works.
6. Check `curl -sI <web>/gridcraft/<asset>.js` has `Access-Control-Allow-Origin: *` and
   `Cross-Origin-Resource-Policy: cross-origin`; check the WASM is `application/wasm`.
7. As a viewer, confirm no edit button. Open an older version as an editor and confirm the
   older-version note and no editor.

Full verification:

```bash
pnpm typecheck
pnpm test
pnpm web:build && pnpm bundle:report
pnpm e2e:local
```

The bundle report should show the entry chunk unchanged within its tolerance; GridCraft's assets are
outside the Vite bundle and the editor wrapper loads only with the XLSX viewer.

**Commit:** `docs: GridCraft editor operations`
