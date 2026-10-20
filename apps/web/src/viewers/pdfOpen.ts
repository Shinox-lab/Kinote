import { withTimeout } from '../lib/viewers.js';

export interface PdfTask<D> {
  promise: Promise<D>;
  destroy: () => Promise<void> | void;
}

/**
 * Opens a PDF and hands back the document, or null when `isCancelled` turned true on the way. Nothing is left
 * running in that case: pdf.js starts a worker and parses a copy of the file for each document, so a document that
 * finished opening after the viewer was gone is destroyed (destroying its loading task releases both), and the library is never started for a viewer that is
 * already gone. `onTask` receives the loading task as soon as it exists, so the caller can destroy it on unmount.
 */
export async function openPdf<D extends { numPages: number }>(
  loadLibrary: () => Promise<() => PdfTask<D>>,
  isCancelled: () => boolean,
  timeoutMs: number,
  onTask: (task: PdfTask<D>) => void
): Promise<D | null> {
  const start = await loadLibrary();
  if (isCancelled()) return null;
  const task = start();
  onTask(task);
  let doc: D;
  try {
    doc = await withTimeout(task.promise, timeoutMs);
  } catch (err) {
    await task.destroy();
    throw err;
  }
  if (isCancelled()) {
    await task.destroy();
    return null;
  }
  if (doc.numPages < 1) {
    await task.destroy();
    throw new Error('empty document');
  }
  return doc;
}
