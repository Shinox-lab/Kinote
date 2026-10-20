import { describe, expect, test } from 'vitest';
import { openPdf, type PdfTask } from '../src/viewers/pdfOpen.js';

// pdf.js starts a Web Worker and parses a copy of the file for every document it opens. A viewer that is closed
// while it is still opening (navigating away, React StrictMode's second mount) must not leave either behind.

function fake() {
  const log: string[] = [];
  const doc = { numPages: 3 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const start = (): PdfTask<typeof doc> => {
    log.push('started');
    return { promise: gate.then(() => doc), destroy: async () => void log.push('task destroyed') };
  };
  return { log, doc, release, start };
}

describe('openPdf', () => {
  test('opens a document and keeps it', async () => {
    const f = fake();
    f.release();
    const out = await openPdf(async () => f.start, () => false, 1000, () => {});
    expect(out).toBe(f.doc);
    expect(f.log).toEqual(['started']);
  });

  test('cancelled while the library loads: nothing is started', async () => {
    const f = fake();
    let cancelled = false;
    const out = await openPdf(
      async () => {
        cancelled = true;
        return f.start;
      },
      () => cancelled,
      1000,
      () => {}
    );
    expect(out).toBeNull();
    expect(f.log).toEqual([]);
  });

  test('cancelled while the document opens: its loading task (and with it the worker and the copy) is destroyed', async () => {
    const f = fake();
    let cancelled = false;
    const pending = openPdf(async () => f.start, () => cancelled, 1000, () => {});
    await Promise.resolve();
    await Promise.resolve();
    cancelled = true;
    f.release();
    expect(await pending).toBeNull();
    expect(f.log).toEqual(['started', 'task destroyed']);
  });

  test('a document with no pages is refused and its task destroyed', async () => {
    const f = fake();
    f.doc.numPages = 0;
    f.release();
    await expect(openPdf(async () => f.start, () => false, 1000, () => {})).rejects.toThrow();
    expect(f.log).toContain('task destroyed');
  });

  test('a document that never opens is given up on, and its task destroyed', async () => {
    const log: string[] = [];
    const start = (): PdfTask<{ numPages: number; destroy: () => void }> => ({
      promise: new Promise(() => {}),
      destroy: async () => void log.push('task destroyed'),
    });
    await expect(openPdf(async () => start, () => false, 20, () => {})).rejects.toThrow();
    expect(log).toEqual(['task destroyed']);
  });
});
