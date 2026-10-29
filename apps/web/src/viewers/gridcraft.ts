export type GridCraftMessage =
  | { type: 'ready' }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'save'; name: string; bytes: ArrayBuffer }
  | { type: 'failed'; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the editor sent, if it is one of the host messages we understand. */
export function parseGridCraftMessage(data: unknown): GridCraftMessage | null {
  if (!isRecord(data)) return null;

  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'dirty':
      return typeof data.dirty === 'boolean' ? { type: 'dirty', dirty: data.dirty } : null;
    case 'save': {
      const { name, bytes } = data;
      if (typeof name !== 'string' || name.trim() === '') return null;
      if (bytes instanceof ArrayBuffer) return { type: 'save', name, bytes };
      if (!ArrayBuffer.isView(bytes)) return null;
      // A structured-cloned view can point into a larger buffer; copy only the view's range.
      const copy = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
      return { type: 'save', name, bytes: copy.buffer };
    }
    case 'failed':
      return typeof data.error === 'string' ? { type: 'failed', error: data.error } : null;
    default:
      return null;
  }
}

/** Only a same-named .xlsx may replace the open workbook; anything else is a download. */
export function isSpreadsheetSave(name: string, originalName: string): boolean {
  const next = name.trim().toLowerCase();
  const original = originalName.trim().toLowerCase();
  return next.length > 0 && original.length > 0 && next.endsWith('.xlsx') && original.endsWith('.xlsx') && next === original;
}

export function gridcraftUrl(author?: string): string {
  const authorParam = author ? `&author=${encodeURIComponent(author)}` : '';
  return `/gridcraft/?host=parent&webgl&chrome=none${authorParam}`;
}
