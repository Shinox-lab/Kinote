# Extend UI XLSX preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the text-only XLSX preview with `@extend-ai/react-xlsx`'s read-only `XlsxViewer`, keeping the viewer lazy, the existing 25 MB limit, the `?page=` sheet link and a download fallback.

**Architecture:** `FileViewer` lazy-loads `XlsxViewer`. That chunk creates an Extend controller from the in-memory `ArrayBuffer`, parses in a worker with Duke WASM, and renders a DOM table (`experimentalCanvas={false}`) so cells remain readable. The package and its WASM are fingerprinted Vite assets served and gzipped by the web nginx.

**Spec:** `docs/superpowers/specs/2026-10-29-extend-xlsx-preview-design.md`

## Global Constraints

- Pin `@extend-ai/react-xlsx@0.18.1`. Its licence is MIT; do not add a paid service.
- The viewer chunk must stay lazy. Do not import the package from `FileViewer`, a route, or the entry.
- `readOnly`; `useWorker`; `maxFileSizeBytes = PREVIEW_LIMIT_BYTES`; `experimentalCanvas={false}`.
  The DOM renderer is the accessibility choice; do not switch to canvas without an accessible
  cell-text replacement.
- Preserve `?page=N`: `?page=1` is the first sheet. Clamp out-of-range values with `initialSheet`.
- Corrupt, unsupported, too-large or timed-out workbooks show `DownloadCard`, not a blank frame.
- No backend route, storage change or new service.
- `pnpm` only. Stage only the files named in the task; do not stage other sessions' changes.
- Commits end with the project's `Co-Authored-By` line.

## Cost guardrails

- Cold XLSX payload is about 2.33 MB gzip / 5.72 MB raw; do not let it move into the entry chunk.
- A 200k-cell workbook measured 1.18 s canvas / 1.57 s DOM to first paint; a 1M-cell workbook
  6.11 s / 6.54 s on the benchmark machine. The 25 MB cap is deliberate.
- Gzip the WASM. Without it the browser downloads 4.4 MB instead of 1.66 MB.
- The `?page=` effect must not re-run when the user clicks another sheet tab.

---

### Task 1: Add the viewer dependency and serve its assets

**Files:**
- Modify `apps/web/package.json`
- Modify `pnpm-lock.yaml`
- Modify `apps/web/vite.config.ts`
- Modify `apps/web/nginx.conf`

Add the exact dependency:

```bash
pnpm --filter @kinote/web add @extend-ai/react-xlsx@0.18.1
```

In `apps/web/vite.config.ts`, add both settings at the top level of the returned config:

```ts
    // The xlsx viewer creates its worker with new Worker(new URL(...), { type: 'module' }).
    // Vite's default iife worker output cannot code-split the package, and prebundling
    // rewrites the worker URL to a missing .vite/deps file in dev.
    worker: { format: 'es' },
    optimizeDeps: {
      exclude: ['@extend-ai/react-xlsx', '@dukelib/sheets-wasm'],
    },
```

In `apps/web/nginx.conf`, add server-level compression after `server_tokens off;`:

```nginx
  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types application/javascript text/javascript text/css application/json application/wasm image/svg+xml;
```

Add a `.wasm` location beside the existing `.mjs` location:

```nginx
  # The XLSX viewer fetches its WASM from a worker. Serve the right MIME type and
  # cache the fingerprinted file for a year, like the PDF viewer's .mjs worker.
  location ~* \.wasm$ {
    default_type application/wasm;
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
```

The existing `/assets/` prefix location still serves the fingerprinted JS and WASM; the regex
location wins for `.wasm` and gives it the correct type.

**Verify:**

```bash
pnpm web:build
ls apps/web/dist/assets/*.wasm
ls apps/web/dist/assets/xlsx-worker-*.js
pnpm bundle:report
```

The build must not fail with `Invalid value "iife" for option "output.format"`. The report still
shows the old viewer until Task 2; it must show a WASM file and a worker chunk now.

Optionally verify the real nginx config once:

```bash
docker compose build web
docker compose up -d --wait web
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:${WEB_HOST_PORT:-8081}/assets/$(basename apps/web/dist/assets/*.wasm) \
  | grep -iE 'HTTP/|content-type|content-encoding|cache-control'
```

Expect `application/wasm`, `content-encoding: gzip` and a one-year cache header.

**Commit:** `feat(web): add Extend XLSX viewer assets`

---

### Task 2: Replace the table preview with Extend UI

**Files:**
- Modify `apps/web/src/viewers/FileViewer.tsx`
- Modify `apps/web/src/viewers/XlsxViewer.tsx`
- Modify `e2e/fixtures.ts`
- Modify `e2e/files.spec.ts`

In `FileViewer.tsx`, change the XLSX mapping to pass the version:

```tsx
  xlsx: ({ bytes, version, page }) => <XlsxViewer bytes={bytes} version={version} page={page} />,
```

Replace `apps/web/src/viewers/XlsxViewer.tsx` with a small public component and an inner preview
component. The inner component is the only place that creates the controller, so it unmounts (and
releases the workbook) when GridCraft replaces it later:

```tsx
import { useEffect, useState } from 'react';
import type { FileVersion } from '@kinote/contracts';
import { XlsxViewer as ExtendXlsxViewer, useXlsxViewerController } from '@extend-ai/react-xlsx';
import { Loading } from '../components/ui.js';
import { initialSheet } from '../lib/tablePreview.js';
import { PREVIEW_LIMIT_BYTES, VIEWER_TIMEOUT_MS } from '../lib/viewers.js';
import { useResolvedTheme } from '../lib/useResolvedTheme.js';
import { DownloadCard } from './DownloadCard.js';

export default function XlsxViewer({ bytes, version, page }: { bytes: ArrayBuffer; version: FileVersion; page?: number }) {
  return <ExtendPreview bytes={bytes} version={version} page={page} />;
}

function ExtendPreview({ bytes, version, page }: { bytes: ArrayBuffer; version: FileVersion; page?: number }) {
  const theme = useResolvedTheme();
  const controller = useXlsxViewerController({
    file: bytes,
    fileName: version.fileName,
    readOnly: true,
    useWorker: true,
    maxFileSizeBytes: PREVIEW_LIMIT_BYTES,
  });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!controller.isLoading) return;
    const timer = window.setTimeout(() => setTimedOut(true), VIEWER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [controller.isLoading, version.id]);

  // The controller has no initial-sheet prop. Set it after the workbook's sheets arrive;
  // everything else (default first sheet, clamping) is the existing initialSheet rule.
  useEffect(() => {
    if (controller.isLoading || controller.sheets.length === 0) return;
    controller.setActiveSheetIndex(initialSheet(controller.sheets.length, page));
  }, [controller.isLoading, controller.sheets.length, controller.setActiveSheetIndex, page, version.id]);

  if (timedOut) {
    return <DownloadCard version={version} reason="This workbook took too long to preview." />;
  }

  return (
    <ExtendXlsxViewer
      controller={controller}
      height="clamp(420px, 70vh, 760px)"
      isDark={theme === 'dark'}
      experimentalCanvas={false}
      loadingState={<Loading what="workbook" />}
      errorState={<DownloadCard version={version} reason="This workbook can't be previewed." />}
      fileTooLargeState={<DownloadCard version={version} reason="This workbook is too large to preview here." />}
    />
  );
}
```

The timeout is the same 15 s the old viewer used. The controller's worker clones the input buffer,
so the React Query buffer is not detached.

In `e2e/fixtures.ts`, remove the `fake-extract.txt` member from the `xlsx()` archive. Extend rejects
that extra stored entry. Keep the fake extractor working by appending the same marker after the ZIP
end, where the raw-byte scanner can still find it:

```ts
  const workbook = zip(entries);
  const markerText = marker(`${label}\n${sheets.flatMap((s) => s.rows.map((r) => r.join(' '))).join('\n')}`);
  return { name, mimeType: XLSX_MIME, buffer: Buffer.concat([workbook, Buffer.from(markerText)]) };
```

Remove the `entries['fake-extract.txt'] = ...` line. Update the comment above `xlsx()` to say the
marker is deliberately outside the ZIP because Extend treats an extra member as an invalid workbook.

In `e2e/files.spec.ts`, import `XLSX_MIME` and add a fallback test. It needs no new fixture; it routes
the authenticated bytes request to garbage:

```ts
test('a workbook that cannot be read falls back to a download', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const book = await uploadViaApi(
    request,
    world,
    world.owner,
    xlsx('Budget.xlsx', world.suffix, [
      { name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1200]] },
    ])
  );
  await waitForFileBadge(request, world, world.owner, book, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.route(`**/api/v1/versions/${book}/file`, (route) =>
    route.fulfill({ status: 200, contentType: XLSX_MIME, body: Buffer.from('not a workbook') })
  );
  await page.goto(`/w/${world.slug}/f/${book}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByText("This workbook can't be previewed.")).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Download Budget.xlsx' })).toBeVisible();
});
```

The existing workbook test keeps its tab, cell and `?page=2` assertions; the DOM renderer exposes
real `<td>` cells, so they should pass unchanged.

**Verify:**

```bash
pnpm typecheck
pnpm test
pnpm web:build && pnpm bundle:report
pnpm e2e:local e2e/files.spec.ts -g "workbook as tabs"
pnpm e2e:local e2e/files.spec.ts -g "cannot be read"
```

On a real stack, open a workbook with a chart in light and dark themes and check the sheet tabs,
scrolling and download button. The first open is expected to take longer than the old table.

**Commit:** `feat(web): preview XLSX files with Extend UI`

---

### Task 3: Remove the old parser and preview-only code

**Files:**
- Modify `apps/web/package.json`
- Modify `pnpm-lock.yaml`
- Modify `apps/web/src/lib/tablePreview.ts`
- Modify `apps/web/test/tablePreview.test.ts`
- Modify `apps/web/test/lazyViewers.test.ts`
- Modify `scripts/bundle-report.mjs`

Remove the dependency:

```bash
pnpm --filter @kinote/web remove read-excel-file
```

In `apps/web/src/lib/tablePreview.ts`:

- Keep `parseCsvRows`, `columnLabel` and `initialSheet`.
- Delete `SHEET_PREVIEW_ROWS`, `SHEET_PREVIEW_COLUMNS`, `capSheet` and the private `show` helper.
- Update the file comment: it now parses CSV previews and computes the XLSX initial sheet; it no
  longer caps spreadsheet rows.

In `apps/web/test/tablePreview.test.ts`, remove the `capSheet` import and the `describe('capSheet')`
block. Keep the `initialSheet` and CSV tests.

In `apps/web/test/lazyViewers.test.ts`, update the list and comment:

```ts
// The viewers and their libraries (pdf.js, mammoth, Extend UI's XLSX viewer, marked,
// DOMPurify) are heavy: they load only when a file is opened.
const LIBRARIES = ['pdfjs-dist', 'mammoth', '@extend-ai/react-xlsx', 'marked', 'dompurify'];
```

In `scripts/bundle-report.mjs`, replace the `read-excel-file` signature:

```js
  '@extend-ai/react-xlsx': 'react-xlsx-viewer',
```

The literal `react-xlsx-viewer` is the viewer shell class and is present in the built chunk.

**Verify:**

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm web:build && pnpm bundle:report
```

`bundle:report` must label the lazy XLSX chunk with `@extend-ai/react-xlsx` and must not list it on
the entry chunk. The entry chunk should stay within its normal size.

**Commit:** `refactor(web): remove the old XLSX table parser`

---

### Task 4: Document the cost and the deployment requirements

**Files:**
- Modify `docs/operations.md`

After the existing viewers paragraph, add:

```md
The XLSX preview uses `@extend-ai/react-xlsx` 0.18.1 (MIT). It is still a lazy chunk, but a cold
first open downloads about 2.3 MB gzip (viewer JS, the Duke WASM, the worker and a font fallback)
before the workbook. The web nginx must gzip `.js`, `.mjs`, `.css` and `.wasm` and serve `.wasm` as
`application/wasm`; without that the WASM is 4.4 MB instead of 1.66 MB. The preview is capped at the
existing 25 MB `PREVIEW_LIMIT_BYTES`; a larger file is a download card and its bytes are never
fetched. A corrupt or timed-out workbook also falls back to the download card.
```

Mention the measured DOM-renderer cost: a 10k × 20 workbook is about 1.6 s / 33 MB JS heap on the
benchmark machine, and a 50k × 20 workbook about 6.5 s / 120 MB. The 25 MB cap is a memory bound as
well as a network bound.

**Verify:** review the rendered Markdown; no command needed.

**Commit:** `docs: XLSX preview cost and nginx requirements`

---

## Full verification

```bash
pnpm typecheck
pnpm test
pnpm web:build && pnpm bundle:report
pnpm e2e:local
```

The e2e suite must pass the CSV/workbook test, the corrupt-workbook fallback, and the existing file
viewer tests. Check the browser network panel once: the first XLSX open should fetch the viewer
chunk, the worker, the WASM and the font chunk; a second open should use the cache. Check that a
PDF/DOCX page does not fetch any of them.
