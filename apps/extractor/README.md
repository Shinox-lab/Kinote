# Extractor

Docling behind one endpoint. The worker sends a file's bytes and gets text with structure back; the service has no
storage, no database and no tenant knowledge, and in compose no network except the worker's.

- `POST /extract`: body = the file bytes; headers `X-File-Type` (`pdf docx pptx xlsx png jpeg webp gif`) and
  `X-File-Name` (URL-encoded, never trusted or logged). `200` with an `ExtractedDocument`
  (`packages/contracts`, `ExtractedDocumentSchema`), `422 {"error":"unreadable"}` for a file that is encrypted,
  damaged or of a type this service does not read, `413 {"error":"too_large"}` when the text exceeds
  `MAX_EXTRACTED_CHARS`, `500 {"error":"internal"}` for anything else (never with file content).
- `GET /health`.
- Pages: the page for a PDF, the sheet number for a spreadsheet, the slide number for a deck.
- `ocrUsed` is true for image uploads; Docling does not say whether a scanned PDF page needed OCR.
- TXT, MD and CSV never come here (the worker reads them); audio and video are only stored.

Run the unit tests: `pip install -r requirements-dev.txt && python -m pytest` (the real-pipeline tests in
`tests/test_docling.py` need the models: `EXTRACTOR_DOCLING_TESTS=1`, easiest inside the image:
`docker build -f apps/extractor/Dockerfile --target test -t lw-extractor-test . &&
docker run --rm -e EXTRACTOR_DOCLING_TESTS=1 lw-extractor-test`).
