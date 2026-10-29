# Extend UI XLSX preview — design

Status: draft, 2026-10-29. Replaces the text-only XLSX preview on the file page with
`@extend-ai/react-xlsx`'s `XlsxViewer`. GridCraft stays the opt-in editor; see
`2026-10-29-gridcraft-xlsx-editor-design.md`.

## Why

The current preview is `read-excel-file` plus a hand-built table. It cuts every sheet to 200 rows by 26
columns and shows values as text: formulas are not evaluated, fills, number formats, merged cells,
images, charts and frozen panes disappear. Editors who need those things must download the file;
readers get a worse view than a spreadsheet app.

Extend UI renders the workbook in the browser. It supports sheet tabs, frozen panes, formulas,
merged cells, conditional formatting, tables, images, shapes, charts, grid virtualization, search and
keyboard selection. It is MIT-licensed and runs as a normal React component, not a hosted service.

## Goals

1. The normal XLSX preview renders the workbook with formatting, formulas, charts and sheet tabs.
2. The viewer stays a lazy chunk. Opening a page, a PDF or a DOCX must not download it.
3. A corrupt workbook, a file above 25 MB or a read that hangs past 15 s falls back to a download,
   never a blank frame.
4. `<file>?page=N` opens sheet N, as the current preview does.
5. The preview is usable with a screen reader and with the console's light and dark themes.
6. No backend route, storage change or new service.

## Non-goals

- Editing. GridCraft is the opt-in editor; this viewer is always `readOnly`.
- `.xls`, `.xlsm`, `.ods` or macros. The file-type map still sends only `.xlsx` here.
- Preserving the old 200-by-26 table as a second mode. The download card is the fallback.
- A full Excel fidelity guarantee. Extend/Duke may still drop an unsupported feature; the original
  file is untouched and downloadable.

## Measurements

A throwaway Vite/React/Chromium benchmark used real workbooks, production builds and a local
preview server. The viewer-chunk and entry rows below are from the `apps/web` implementation build;
the other assets match the benchmark within about 1%. The numbers are for this Apple-silicon
machine; network delay is separate.

### What the browser downloads on the first XLSX open

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| Viewer chunk (`XlsxViewer-*.js`) | 519,494 | 148,222 |
| Carlito font fallback chunk | 621,419 | 466,914 |
| `duke_sheets_wasm_bg.wasm` | 4,412,299 | 1,663,034 |
| Worker (`xlsx-worker-*.js`) | 113,734 | 34,597 |
| WASM-bindgen JS | 29,687 | 6,647 |
| **Total** | **5,696,633** | **2,319,414** |

The console's existing entry chunk (React and the app shell) is 595,980 raw / 176,414 gzip in this
build and is already loaded. On a 10 Mbps link the XLSX-specific 2.32 MB adds roughly 1.9 s before
parsing.

Optional chart code loads only when the workbook has one:

- bar/line/pie renderer: 140,951 raw / 45,957 gzip;
- 3D surface renderer: 138,719 raw / 46,286 gzip;
- map geography: 1,579,784 raw / 497,712 gzip, only for map charts.

The Carlito chunk is the biggest surprise. Extend loads it on the first workbook to measure text and
column widths. It is cached after that.

### Time to first grid paint

Measured from the click that starts fetching the bytes, on localhost, with the viewer chunk already
cold. `DOM` is the table renderer; `canvas` is Extend's default.

| Workbook | File | Canvas | DOM |
| --- | ---: | ---: | ---: |
| 1,000 × 10 | 64 kB | 163 ms | 245 ms |
| 10,000 × 20 | 1.1 MB | 1.18 s | 1.57 s |
| 50,000 × 20 | 5.5 MB | 6.11 s | 6.54 s |

A warm open of the 1.1 MB workbook was 1.16 s versus 1.18 s cold: parsing and rendering dominate,
not the HTTP cache.

JS heap after load:

| Workbook | Canvas | DOM |
| --- | ---: | ---: |
| 10,000 × 20 | ~25 MB | ~33 MB |
| 50,000 × 20 | ~86 MB | ~120 MB |

Roughly 20–25× the compressed workbook size. The 25 MB preview cap bounds the input, not a hard
heap: the viewer's preflight allows up to 256 MB of worksheet XML, so a crafted workbook can still
use more memory.

A 26 MB workbook is rejected by the viewer with
`File size 26 MB exceeds the configured limit of 25 MB`. In the wiki, `FileViewer` already turns any
file above `PREVIEW_LIMIT_BYTES` into a download card before it fetches the bytes, so that guard is a
second line of defence.

### Cost summary

- No licence fee (MIT). The package is 20.5 MB unpacked plus 4.5 MB for `@dukelib/sheets-wasm`.
- First XLSX open is ~2.3 MB gzip / ~5.7 MB raw, then cached.
- A 200k-cell workbook is ~1.2–1.6 s and ~25–33 MB; a 1M-cell workbook is ~6.1–6.5 s and ~86–120 MB
  on this machine. The 25 MB cap bounds ordinary files, not the worst-case heap.
- Charts add ~46 kB gzip; map charts add ~498 kB gzip.
- The old `read-excel-file` chunk goes away, but it was far smaller; this is a real increase in preview
  cost for a real increase in fidelity.

## Decisions

- **Use `@extend-ai/react-xlsx@0.18.1`.** Exact version, MIT. Use the core `XlsxViewer` and
  `useXlsxViewerController`, not the shadcn wrapper: the wiki's bytes are authenticated and already
  in memory, so `file={ArrayBuffer}` is the right input and `src=` would add a second fetch with no
  credentials.
- **Read-only, worker-backed.** Pass `readOnly`, `useWorker` (default true) and
  `maxFileSizeBytes={PREVIEW_LIMIT_BYTES}`. A read-only controller uses the worker automatically;
  the worker clones the input buffer before transferring it, so the React Query buffer is not
  detached.
- **Use the DOM renderer, not canvas.** `experimentalCanvas={false}` renders a real `<table>` with
  `<td>` cells. The canvas renderer exposes `role="grid"` and keyboard shortcuts but no readable
  cell text, which would regress the current accessible table. The DOM renderer costs ~30% more time
  and ~40% more heap in the measurements above; that is the price of accessibility. The existing
  Playwright `getByRole('cell')` checks continue to work.
- **Preserve `?page=` with the controller.** The viewer has no initial-sheet prop. Call
  `controller.setActiveSheetIndex(initialSheet(controller.sheets.length, page))` after the sheets
  load. `initialSheet` stays in `lib/tablePreview.ts` and keeps its unit tests.
- **Theme from `useResolvedTheme()`.** Pass `isDark={theme === 'dark'}`; the viewer's palette is
  independent of the console CSS tokens.
- **Height `clamp(420px, 70vh, 760px)`.** The grid scrolls inside the viewer; the page keeps its
  existing preview card.
- **Fallbacks are download cards.** `errorState` and `fileTooLargeState` render the existing
  `DownloadCard` with a plain sentence. A `VIEWER_TIMEOUT_MS` watchdog also renders the card if the
  controller is still loading after 15 s. `FileViewer`'s existing >25 MB branch remains the first
  fallback.
- **Lazy chunk.** `FileViewer` already lazy-loads `XlsxViewer`; the Extend import lives inside that
  chunk. Do not import the package in the entry or in `FileViewer`.
- **Remove the old parser.** `read-excel-file`, `capSheet` and the 200×26 preview constants are
  deleted. `columnLabel`, `parseCsvRows` and `initialSheet` stay.
- **Vite needs two settings.** `worker: { format: 'es' }` is required for the worker build; without
  it the production build fails with `Invalid value "iife" for option "output.format"`.
  `optimizeDeps.exclude: ['@extend-ai/react-xlsx', '@dukelib/sheets-wasm']` is required for dev; without
  it Vite prebundles the worker URL and the browser gets
  `/node_modules/.vite/deps/xlsx-worker.js?worker_file&type=module` and `Worker request failed.`
- **Serve compressed WASM.** The web nginx must gzip `.js`, `.mjs`, `.css` and `.wasm` and serve
  `.wasm` as `application/wasm`. Otherwise the browser downloads the 4.4 MB WASM instead of the
  1.66 MB gzip body. Add a `.wasm` location with a one-year immutable cache, like `.mjs`.
- **The e2e fixture needs one change.** Extend rejects the hand-built workbook when the extra
  `fake-extract.txt` zip entry is present. The fake extractor only needs the marker to appear in the
  raw bytes, so append the `FAKE-EXTRACT` text after the ZIP end instead of storing it as a member.
  Extend 0.18.1 opens it and the fake extractor still finds the marker. Strict ZIP readers may reject
  trailing bytes, so keep this workaround test-only.

## Architecture

```
FilePage
  FileViewer (checks MIME and size)
    lazy XlsxViewer
      useXlsxViewerController({ file: bytes, readOnly, maxFileSizeBytes })
      Extend XlsxViewer
        worker -> parse OOXML + Duke WASM
        DOM table renderer (accessible cells)
        optional chart renderer / map geography
```

`FileViewer` passes `{ bytes, version, page }`. `XlsxViewer` reads `version.fileName` for the
viewer's download name and `version` for the fallback card. The controller copies the bytes before
the worker transfer.

## Accessibility

The DOM renderer produces one `<table>` with visible row headers, column headers and `<td>` cells.
Its grid container is `role="grid"` with `aria-rowcount`, `aria-colcount`, `aria-readonly` and
keyboard shortcuts. This is not a perfect ARIA grid, but it is far better than a canvas with no cell
text. The viewer remains keyboard scrollable and the page's existing download action is always
available.

## Failure modes

| Case | Behaviour |
| --- | --- |
| File > 25 MB | `FileViewer` shows the download card; bytes are never fetched. |
| Corrupt or unsupported workbook | Extend calls `errorState`; download card with "This workbook can't be previewed." |
| Worker/WASM fails to load | Same error state; the page keeps working. |
| Parse still running after 15 s | Watchdog unmounts the viewer and shows "This workbook took too long to preview." |
| Browser without module workers | Extend falls back to its main-thread path; the timeout still applies. |
| Reader on an older version | The preview still works; the GridCraft button is absent. |

## Testing

- Unit: `initialSheet` remains covered; `lazyViewers.test.ts` lists `@extend-ai/react-xlsx` and proves
  no screen imports it.
- E2E: the existing workbook test must still find `Income`/`Costs` tabs, `Sales`/`Rent`/`Power`
  cells, `aria-selected`, and `?page=2`. Add a route-intercepted corrupt-bytes case that asserts the
  download card.
- Build: `pnpm web:build` must emit a `.wasm` asset and the xlsx worker; `pnpm bundle:report` must
  show the Extend viewer in a lazy chunk, not the entry.
- Deployment: `curl -H 'Accept-Encoding: gzip' -sI .../assets/<viewer>.js` and `.../<wasm>` show
  `Content-Encoding: gzip`; the WASM is `application/wasm`.
- Manual: open a real workbook with formulas, fills, merged cells and a chart in light and dark
  themes; check the sheet deep link and the download fallback.

## Known limitations

- First open is ~2.3 MB gzip and a 1M-cell workbook is ~6 s / ~86 MB on a fast laptop. This is a
  heavier preview than the old table. The 25 MB cap and the download fallback bound it.
- The DOM renderer is slower and uses more memory than canvas. We choose it for cell text and
  accessibility.
- Extend's first load fetches a 467 kB gzip font chunk. It is cached, but it is part of the cold
  cost.
- The viewer's toolbar is read-only zoom/download only. The page keeps its own download action.
- `?page=` selects a sheet, not a cell or row. The old preview had the same sheet-level behaviour.
- No `.xls`, `.xlsm` or macro support. Those remain downloads.
