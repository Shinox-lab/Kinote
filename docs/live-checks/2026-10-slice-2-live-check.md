# Slice 2 live check, 2026-10-20

What was run on a real stack, what it printed, and what is not covered. Everything below was observed in this
session; anything not run says so.

## Environment

| | |
| --- | --- |
| Code | branch `slice-2-files`, commit `06d8d65`; the three fixes of the final review (`caa1a39`) came after the stack run and are covered by the gates below |
| Host | macOS (Darwin 25.6.0), Docker 29.5.2, Compose 5.1.3, node v22.23.2, 6.3 GiB available to containers |
| Stack | a separate compose project (`docker compose -p lwlive --profile extractor up -d --build`, ports 55600, 59100, 8800, 1300), so the developer's own stack was not touched: Postgres 17 + pgvector, MinIO, the migration, api, collab, worker and the **real Docling extractor** (`EXTRACTOR_MODE=http`) |
| Extractor image | `lwlive-extractor` **5.24 GB** (models baked in). Its layers were cached from the earlier 2a build (15 h old), so the whole `up --build` took **35 s** here; a first build downloads several gigabytes and was not timed |
| Embeddings | `deterministic` (the compose default), so search ranking is lexical plus a fixed vector, not semantic |

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | A two-page PDF becomes searchable; the page-2 passage cites page 2; Ask cites the PDF with page 1 | PASSED (run 2) |
| 2 | An XLSX with two sheets: a cell on sheet 2 is found and cites sheet 2 | PASSED |
| 3 | A DOCX is found | PASSED |
| 4 | A printed page as a PNG is read with OCR and found | PASSED (7.1 s) |
| 5 | A replaced PDF keeps answering until its successor is approved | PASSED |
| 6 | A script's `PUT` creates a file; `DELETE` removes it from search at once; the badge says "Removed at source" | PASSED |
| 7 | A second workspace sees none of it: file route, bytes, search | PASSED by API |
| 8 | A second tenant sees none of it by SQL as the app role | PASSED (counts below) |
| 9 | The extractor has no route to the internet, storage, database or api | PASSED (outputs below) |
| 10 | Extractor down: the upload ends with a plain sentence; Retry recovers it | PASSED |
| 11 | The console on the real stack: upload, Docling, viewers, chunk inspector, search link, Sources page | PASSED (`docs/live-checks/browser-pass.spec.ts`) |
| 12 | `pnpm vitest run`, `pnpm typecheck`, `pnpm e2e:local`, `pnpm test:pg` | see "Gates" |

## Findings from the run

1. **A hand-built PDF with a non-embedded font and no encoding yields no text from Docling** ("Stored · no searchable
   text"). The first run (below) used one, made by the test helper `realPdf` in `e2e/fixtures.ts`. That helper is only
   for browser specs, which use the fake extractor; the live check uses PDFs printed by Chromium (embedded fonts, a text
   layer), which read correctly. The file page's banner for this case read as designed ("No searchable text was found in
   this file. It is kept for download."). A *scanned* PDF (page images, no text layer) was **not run**: whether Docling
   applies OCR to page bitmaps of a PDF in this image was not tested, only OCR of a standalone image.
2. **Found by a browser-spec fixture, fixed in this slice:** extractor text containing a NUL character made the index
   job fail in Postgres ("Index failed", dead-lettered). `extractVersion` now strips NUL characters (test
   `files.extractVersion.test.ts`). Real Docling output was not seen to contain one.
3. **Pre-existing, not fixed (deferred):** when a database error reaches the worker, its log line and `jobs.last_error`
   carry drizzle's whole query with parameters: the tenant's chunk text and embedding. That is how finding 2 became
   visible in a log. It should be reduced to the error's own message.

## First run (kept because it shows finding 1)

```
PASS the PDF upload is accepted
FAIL PDF 2 pages: stopped at "Stored · no searchable text"
FAIL search finds the PDF — got []
FAIL the passage from page 2 cites page 2 — got undefined
FAIL Ask cites the PDF — got []
FAIL the citation carries page 1 — got undefined
INFO Ask answered: No relevant indexed information was found in your accessible spaces.
INFO XLSX 2 sheets: "Indexed · v1" after 1.0 s
PASS search finds the workbook cell
PASS the cell on the second sheet cites sheet 2
INFO DOCX: "Indexed · v1" after 1.0 s
PASS search finds the DOCX text
INFO PNG (OCR): "Indexed · v1" after 9.1 s
INFO OCR text: Check every fire extinguisher is in date. Confirm all exits are unblocked. Sign and file the report.
PASS the picture was read with OCR
FAIL the OCR text contains "Quarterly" — got undefined
PASS search finds the printed page
```
(The run was stopped by hand after the OCR step: the next step waited on a file that was never going to be indexed.)

## Second run, after printing the PDFs with Chromium

```
PASS the PDF upload is accepted
INFO PDF 2 pages: "Indexed · v1" after 3.0 s
PASS search finds the PDF
PASS the passage from page 2 cites page 2
PASS Ask cites the PDF
PASS the citation carries page 1
INFO Ask answered: Based on indexed wiki sources (Field notes.pdf (v1, updated 2026-10-20)): # Field notes.pdf > Section 1
The heronmvgftor0 migrates in autumn. mvgftor0 [Field notes.pdf (v1, updated 2026-10-20)] — # F
INFO XLSX 2 sheets: "Indexed · v1" after 1.0 s
PASS search finds the workbook cell
PASS the cell on the second sheet cites sheet 2
INFO DOCX: "Indexed · v1" after 1.0 s
PASS search finds the DOCX text
INFO PNG (OCR): "Indexed · v1" after 7.1 s
INFO OCR text: Quarterly safety inspection checklist Check every fire extinguisher is in date. Confirm all exits are unblocked. Sign and file the report.
PASS the picture was read with OCR
PASS the OCR text contains "Quarterly"
PASS search finds the printed page
INFO policy v1 waits for review: "Not indexed (awaiting approval)" after 2.0 s
INFO policy v1 approved: "Indexed · v1" after 1.0 s
INFO policy v2 waits for review: "Indexed · v1, v2 awaiting approval" after 2.0 s
PASS while v2 waits, v1 still answers search
PASS while v2 waits, its text is not searchable
INFO policy v2 approved: "Indexed · v2" after 1.0 s
PASS after approval v2 answers search
PASS a script PUT creates the file
INFO source file (trusted: no review): "Indexed · v1" after 1.0 s
PASS the source file is searchable
PASS a script DELETE answers 200
PASS the removed file left search at once
PASS its badge says "Removed at source"
PASS a file of workspace Alpha is a 404 in Beta
PASS its bytes are a 404 in Beta
PASS search in Beta returns nothing of Alpha
PASS a source token opens no ordinary route
INFO {"tenantA":"5a2bf4e4-144b-4c62-94d6-a05ae2cdc38b","tenantB":"328ec16f-556b- …}
ALL CHECKS PASSED
```

## SQL check as the app role (`living_wiki_app`: not superuser, not BYPASSRLS)

`set_config('app.tenant_id', …, true)` then `SELECT count(*)`:

```
== tenant '5a2bf4e4-144b-4c62-94d6-a05ae2cdc38b'
documents: 6
versions: 7
chunks: 7
sources: 1
source_items: 1
source_tokens: 1
== tenant '328ec16f-556b-407f-81cc-33f9cf413523'
documents: 0
versions: 0
chunks: 0
sources: 0
source_items: 0
source_tokens: 0
== tenant '<none>'
documents: 0
versions: 0
chunks: 0
sources: 0
source_items: 0
source_tokens: 0
role: rolsuper=f, rolbypassrls=f
```

## The extractor's network (commands run inside its container)

```
-- extractor -> https://example.com
BLOCKED URLError <urlopen error [Errno -3] Temporary failure in name resolution>
-- extractor -> http://minio:9000/minio/health/live
BLOCKED URLError <urlopen error [Errno -3] Temporary failure in name resolution>
-- extractor -> http://postgres:5432
BLOCKED URLError <urlopen error [Errno -3] Temporary failure in name resolution>
-- extractor -> http://api:8787/api/v1/me
BLOCKED URLError <urlopen error [Errno -3] Temporary failure in name resolution>
-- worker -> extractor
REACHED {"status":"ok"}
-- extractor user: uid=10001(app) gid=10001(app) groups=10001(app)
networks=lwlive_extractor_net  readonly=false caps=[] mem=0
```

## Extractor down, then back

With `docker compose stop extractor`, a PNG upload ended (after the worker's retries, about 45 s) with the badge
`Extraction failed` and the file's error `Extraction failed after 5 attempts: the extractor could not be reached`. After
`docker compose start extractor` and `POST /api/v1/versions/:id/retry` the file reached `Indexed · v1`.

## Timings and memory

Time from upload to indexed: PDF (2 pages) 3.0 s, XLSX 1.0 s, DOCX 1.0 s, PNG with OCR 7.1 s, a trusted source's PDF 1.0 s.
Extractor container memory (`docker stats`; its limit was the Docker VM's 6.3 GiB):

```
at rest: 984.4MiB / 6.277GiB
1.638GiB
lwlive-extractor 5.24GB
```
(Peak while the browser pass uploaded a PDF, a workbook and a picture; "at rest" is after earlier OCR work.) The api
container used about 190 MiB, the worker 155 MiB.

## Bundle (`pnpm web:build && BUNDLE_BASELINE_KB=491.84 pnpm bundle:report`)

The baseline is the entry chunk before this plan (491.84 kB raw, 147.70 kB gzip). The viewers' libraries are separate
chunks; none is in the entry.

```
chunk                                                   raw         gzip  contains
page-0aq9BBP3.js                                 1405.51 kB    424.61 kB   
pdf.worker.min-CjEcRF4W.mjs                      1264.34 kB    376.49 kB   pdf.js
index-ayXRf0S6.js                                 509.37 kB    153.24 kB     <- entry
pdf-WgYdDwYK.js                                   483.75 kB    144.81 kB   pdf.js
native-B5Vb9Oiz.js                                397.41 kB     82.06 kB   mammoth
index-CdPabIgY.js                                 308.21 kB     98.54 kB   mammoth
prose-HPcXaJbp.js                                  80.34 kB     27.00 kB   marked, dompurify
module-BvCTiNll.js                                 77.28 kB     27.78 kB   
index-BfMzIURI.js                                  65.44 kB     19.34 kB   read-excel-file
file-CzYwUAAL.js                                   14.24 kB      5.20 kB   
entry vs baseline 491.84 kB: +3.6% (limit 5%)
```

## Gates on the final tree

Run on the tree of this commit: `pnpm vitest run` 106 files, 1113 tests passed (31 skipped, the real-Postgres files);
`pnpm typecheck` clean; `pnpm e2e:local` 36 of 36 specs; `pnpm test:pg` on a throwaway database on the compose Postgres:
7 files, 28 tests passed.

## Not run

- A scanned (image-only) PDF, and a PDF over 25 MB (the console offers the download instead of a preview; covered by unit tests only).
- A real semantic embedding provider (`EMBEDDING_PROVIDER` other than `deterministic`).
- The console in Firefox or Safari; only Chromium was used.
- A first-time extractor image build (cached layers).
- Concurrency under load (many uploads at once): the queue sends one file at a time per browser tab; the server side was
  exercised by the 2a/2b-1 real-Postgres tests, not at volume.

## How to repeat it

```sh
POSTGRES_HOST_PORT=55600 MINIO_HOST_PORT=59100 MINIO_CONSOLE_HOST_PORT=59101 API_HOST_PORT=8800 COLLAB_HOST_PORT=1300 \
  EXTRACTOR_MODE=http AUTH_RATE_LIMIT_MAX=1000 docker compose -p lwlive --profile extractor up -d --build
LIVE_API=http://127.0.0.1:8800 LIVE_PNG=/path/to/printed-page.png node --import tsx docs/live-checks/slice-2-live-check.ts
LIVE_PNG=/path/to/printed-page.png API_HOST_PORT=8800 COLLAB_HOST_PORT=1300 pnpm exec playwright test -c docs/live-checks/playwright.live.config.ts
docker compose -p lwlive --profile extractor down -v   # removes the check's containers and data
```
