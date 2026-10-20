import { MIME } from './mime.js';

// Which viewer opens a file, and the limits every viewer works within. The choice follows the
// MIME type the server stored (it read the bytes), never the file name.

export type ViewerKind = 'markdown' | 'text' | 'csv' | 'image' | 'pdf' | 'xlsx' | 'docx' | 'pptx' | 'download';

/** Above this size a file is offered for download instead of being opened in the browser. */
export const PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;
/** How long a viewer may take to read a file before it gives up and offers the download. */
export const VIEWER_TIMEOUT_MS = 15_000;
/** The most characters of a text file the page shows. */
export const TEXT_PREVIEW_CHARS = 1_000_000;

const KIND: Record<string, ViewerKind> = {
  [MIME.md]: 'markdown',
  [MIME.txt]: 'text',
  [MIME.csv]: 'csv',
  [MIME.png]: 'image',
  [MIME.jpeg]: 'image',
  [MIME.gif]: 'image',
  [MIME.webp]: 'image',
  [MIME.pdf]: 'pdf',
  [MIME.xlsx]: 'xlsx',
  [MIME.docx]: 'docx',
  [MIME.pptx]: 'pptx',
};

/** True for a file the page will not open in the browser, whatever its type. */
export const tooBigToPreview = (sizeBytes: number): boolean => sizeBytes > PREVIEW_LIMIT_BYTES;

export function viewerFor(mimeType: string, sizeBytes: number): ViewerKind {
  if (tooBigToPreview(sizeBytes)) return 'download';
  return Object.hasOwn(KIND, mimeType) ? KIND[mimeType]! : 'download';
}

/** The first `max` characters of `text`, never ending in half of a surrogate pair. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** What a viewer's work is rejected with when it takes longer than allowed. */
export class ViewerTimeout extends Error {
  constructor() {
    super('The preview took too long.');
    this.name = 'ViewerTimeout';
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ViewerTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
