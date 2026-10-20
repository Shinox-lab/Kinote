import { afterEach, describe, expect, test, vi } from 'vitest';
import { MIME } from '../src/lib/mime.js';
import {
  PREVIEW_LIMIT_BYTES,
  TEXT_PREVIEW_CHARS,
  VIEWER_TIMEOUT_MS,
  ViewerTimeout,
  capText,
  viewerFor,
  withTimeout,
} from '../src/lib/viewers.js';

describe('viewerFor', () => {
  test('every type the server stores has its viewer', () => {
    expect(viewerFor(MIME.md, 10)).toBe('markdown');
    expect(viewerFor(MIME.txt, 10)).toBe('text');
    expect(viewerFor(MIME.csv, 10)).toBe('csv');
    expect(viewerFor(MIME.png, 10)).toBe('image');
    expect(viewerFor(MIME.jpeg, 10)).toBe('image');
    expect(viewerFor(MIME.gif, 10)).toBe('image');
    expect(viewerFor(MIME.webp, 10)).toBe('image');
    expect(viewerFor(MIME.pdf, 10)).toBe('pdf');
    expect(viewerFor(MIME.xlsx, 10)).toBe('xlsx');
    expect(viewerFor(MIME.docx, 10)).toBe('docx');
    expect(viewerFor(MIME.pptx, 10)).toBe('pptx');
  });

  test('anything else, media included, is a download', () => {
    for (const mime of ['audio/mpeg', 'video/mp4', 'image/svg+xml', 'text/html', 'application/zip', 'application/x-new', '']) {
      expect(viewerFor(mime, 10)).toBe('download');
    }
  });

  test('the choice follows the stored type, not a look-alike', () => {
    expect(viewerFor('Application/PDF', 10)).toBe('download');
    expect(viewerFor('application/pdf; charset=binary', 10)).toBe('download');
  });

  test('a file over 25 MB is a download whatever its type', () => {
    expect(PREVIEW_LIMIT_BYTES).toBe(25 * 1024 * 1024);
    expect(viewerFor(MIME.pdf, PREVIEW_LIMIT_BYTES)).toBe('pdf');
    expect(viewerFor(MIME.pdf, PREVIEW_LIMIT_BYTES + 1)).toBe('download');
    expect(viewerFor(MIME.png, 26 * 1024 * 1024)).toBe('download');
  });
});

describe('capText', () => {
  test('short text is whole, long text is cut and says so', () => {
    expect(capText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(TEXT_PREVIEW_CHARS).toBe(1_000_000);
  });

  test('a cut never splits a surrogate pair', () => {
    expect(capText('a😀b', 2)).toEqual({ text: 'a', truncated: true });
  });
});

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  test('a promise that settles in time passes through', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  test('a promise that hangs is rejected with ViewerTimeout', async () => {
    vi.useFakeTimers();
    const outcome = withTimeout(new Promise(() => {}), VIEWER_TIMEOUT_MS).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(VIEWER_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(ViewerTimeout);
    expect(VIEWER_TIMEOUT_MS).toBe(15_000);
  });
});
