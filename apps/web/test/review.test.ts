import { describe, expect, test } from 'vitest';
import type { ReviewItem } from '@living-wiki/contracts';
import { REJECT_NOTE_MAX, approveBlockedReason, rejectNoteState } from '../src/lib/review.js';

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
    expect(reason).toMatch(/can.t approve/i);
    expect(reason).toMatch(/self-approval/i);
  });
});
