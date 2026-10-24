import { describe, expect, test } from 'vitest';
import type { ReviewItem } from '@living-wiki/contracts';
import { REJECT_NOTE_MAX, approveBlockedReason, fileMeta, rejectNoteState } from '../src/lib/review.js';

describe('rejectNoteState', () => {
  test('a note of 1 to 300 characters is valid', () => {
    expect(rejectNoteState('x')).toEqual({ length: 1, valid: true });
    expect(rejectNoteState('x'.repeat(REJECT_NOTE_MAX))).toEqual({ length: 300, valid: true });
  });

  test('an empty note, or one past 300, is not', () => {
    expect(rejectNoteState('')).toEqual({ length: 0, valid: false });
    expect(rejectNoteState('x'.repeat(REJECT_NOTE_MAX + 1))).toEqual({ length: 301, valid: false });
  });

  test('surrounding whitespace is trimmed first, as the API does', () => {
    expect(rejectNoteState('   \n\t ')).toEqual({ length: 0, valid: false });
    expect(rejectNoteState(`  ${'x'.repeat(300)}  `)).toEqual({ length: 300, valid: true });
    expect(rejectNoteState('  a b  ').length).toBe(3);
  });
});

describe('approveBlockedReason', () => {
  const item = (canApprove: boolean) => ({ canApprove }) as Pick<ReviewItem, 'canApprove'>;

  test('is null when the server says the actor can approve', () => {
    expect(approveBlockedReason(item(true))).toBeNull();
  });

  test('is a plain sentence about the authorship rule otherwise', () => {
    const reason = approveBlockedReason(item(false));
    expect(reason).toMatch(/You proposed this change/);
    expect(reason).toMatch(/someone who didn.t write it/);
  });
});

describe('fileMeta', () => {
  const file = (mimeType: string, sizeBytes: number) =>
    ({ file: { fileName: 'x', mimeType, sizeBytes } }) as Pick<ReviewItem, 'file'>;
  const OOXML = 'application/vnd.openxmlformats-officedocument';

  test('names the type and the size', () => {
    expect(fileMeta(file('application/pdf', 2.4 * 1024 * 1024))).toBe('PDF · 2.4 MB');
    expect(fileMeta(file(`${OOXML}.wordprocessingml.document`, 1536))).toBe('DOCX · 1.5 KB');
    expect(fileMeta(file(`${OOXML}.spreadsheetml.sheet`, 0))).toBe('XLSX · 0 B');
    expect(fileMeta(file(`${OOXML}.presentationml.presentation`, 1023))).toBe('PPTX · 1,023 B');
    expect(fileMeta(file('text/csv', 10))).toBe('CSV · 10 B');
    expect(fileMeta(file('text/plain', 10))).toBe('TXT · 10 B');
    expect(fileMeta(file('text/markdown', 10))).toBe('Markdown · 10 B');
    expect(fileMeta(file('image/png', 10))).toBe('PNG · 10 B');
    expect(fileMeta(file('image/jpeg', 10))).toBe('JPEG · 10 B');
  });

  test('an unknown type is just a file, and a page has no file line', () => {
    expect(fileMeta(file('application/x-brand-new', 10))).toBe('File · 10 B');
    expect(fileMeta({ file: null })).toBeNull();
  });
});
