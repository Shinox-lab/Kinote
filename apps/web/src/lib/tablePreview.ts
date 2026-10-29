// Parsing for the CSV preview and sheet selection for the XLSX preview. CSV values are plain strings:
// a cell is shown as text, never evaluated (a formula-looking cell is just its characters).

export const CSV_PREVIEW_ROWS = 1000;

/** RFC 4180 records (quotes, doubled quotes, line breaks inside quotes, CRLF, a BOM); keeps the first `maxRows`, counts all. */
export function parseCsvRows(text: string, maxRows = CSV_PREVIEW_ROWS): { rows: string[][]; totalRows: number; truncated: boolean } {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false; // something has been read for the current record

  const endRecord = () => {
    row.push(cell);
    if (started) {
      total += 1;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
    cell = '';
    started = false;
  };

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRecord();
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== '' || row.length > 0) endRecord();
  return { rows, totalRows: total, truncated: total > rows.length };
}

/** A spreadsheet's column name: 0 is A, 25 is Z, 26 is AA. */
export function columnLabel(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Which sheet to open on: `page` is a 1-based sheet number; anything out of range is clamped, the default is the first. */
export function initialSheet(sheetCount: number, page: number | undefined): number {
  if (sheetCount <= 0 || page === undefined || !Number.isInteger(page) || page < 1) return 0;
  return Math.min(page, sheetCount) - 1;
}
