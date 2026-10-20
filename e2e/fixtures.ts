// Files the specs upload, built in code (no binary files in the repo). Office files are zip archives; these
// are written "stored" (uncompressed), so the fake extractor can read the text it finds in the bytes.
import { crc32 } from 'node:zlib';
import type { TestFile } from './support.js';

/** A zip archive with each entry stored uncompressed. */
export function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The marker the fake extractor reads, as its own entry. */
const marker = (text: string) => `\nFAKE-EXTRACT\n${text}\n`;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A small Word document: each string is a paragraph (the first as a heading). `label` makes the bytes unique. */
export function docx(name: string, label: string, ...paragraphs: string[]): TestFile {
  const body = paragraphs
    .map((p, i) => `<w:p>${i === 0 ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const buffer = zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    'fake-extract.txt': marker(`${label}\n${paragraphs.join('\n')}`),
  });
  return { name, mimeType: DOCX_MIME, buffer };
}

/** A zip that passes the upload's type check (it has `word/document.xml`) but is not a Word document. */
export function corruptDocx(name: string, label: string): TestFile {
  return {
    name,
    mimeType: DOCX_MIME,
    buffer: zip({ 'word/document.xml': `this is not xml ${label}`, 'fake-extract.txt': marker(`unreadable ${label}`) }),
  };
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A small workbook: each sheet is a name and rows of text or numbers. `label` makes the bytes unique. */
export function xlsx(name: string, label: string, sheets: { name: string; rows: (string | number)[][] }[]): TestFile {
  const strings: string[] = [];
  const index = (s: string) => {
    const i = strings.indexOf(s);
    return i >= 0 ? i : strings.push(s) - 1;
  };
  const colName = (c: number) => String.fromCharCode(65 + c);
  const sheetXml = (rows: (string | number)[][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((v, c) =>
              typeof v === 'number'
                ? `<c r="${colName(c)}${r + 1}"><v>${v}</v></c>`
                : `<c r="${colName(c)}${r + 1}" t="s"><v>${index(v)}</v></c>`
            )
            .join('')}</row>`
      )
      .join('')}</sheetData></worksheet>`;
  const sheetFiles = sheets.map((s) => sheetXml(s.rows));
  const entries: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  };
  sheetFiles.forEach((xml, i) => (entries[`xl/worksheets/sheet${i + 1}.xml`] = xml));
  entries['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join('')}</sst>`;
  entries['fake-extract.txt'] = marker(`${label}\n${sheets.flatMap((s) => s.rows.map((r) => r.join(' '))).join('\n')}`);
  return { name, mimeType: XLSX_MIME, buffer: zip(entries) };
}
