// The types the server stores (see `packages/core/src/files/detect.ts`): the console picks a label and a
// viewer from the MIME type the server recorded, never from the file name.

const OOXML = 'application/vnd.openxmlformats-officedocument';

export const MIME = {
  pdf: 'application/pdf',
  docx: `${OOXML}.wordprocessingml.document`,
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  pptx: `${OOXML}.presentationml.presentation`,
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

const LABEL: Record<string, string> = {
  [MIME.pdf]: 'PDF',
  [MIME.docx]: 'DOCX',
  [MIME.xlsx]: 'XLSX',
  [MIME.pptx]: 'PPTX',
  [MIME.csv]: 'CSV',
  [MIME.txt]: 'TXT',
  [MIME.md]: 'Markdown',
  [MIME.png]: 'PNG',
  [MIME.jpeg]: 'JPEG',
  [MIME.gif]: 'GIF',
  [MIME.webp]: 'WebP',
};

/** A short name for a stored type: "PDF", "Markdown"; "File" for one the console does not know. */
export function mimeLabel(mimeType: string): string {
  return Object.hasOwn(LABEL, mimeType) ? LABEL[mimeType]! : 'File';
}
