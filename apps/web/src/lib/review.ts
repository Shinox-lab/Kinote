import type { ReviewItem } from '@living-wiki/contracts';
import { formatBytes } from './fileUi.js';
import { mimeLabel } from './mime.js';

// Pure helpers behind the review queue: the reject note rule and why Approve is off.
// Whether the actor may approve is the server's (`canApprove`); nothing is derived here.

/** The API's limit for a review note (RejectVersionRequestSchema). */
export const REJECT_NOTE_MAX = 300;

/** The note as the API sees it (trimmed): its length, and whether it is 1 to 300 characters. */
export function rejectNoteState(note: string): { length: number; valid: boolean } {
  const length = note.trim().length;
  return { length, valid: length >= 1 && length <= REJECT_NOTE_MAX };
}

/** Why Approve is disabled, in plain words; null when the server says the actor may approve. */
export function approveBlockedReason(item: Pick<ReviewItem, 'canApprove'>): string | null {
  return item.canApprove
    ? null
    : "You proposed this change — approve needs someone who didn't write it.";
}

/** "PDF · 2.4 MB" for a file item of the queue; null for a page. */
export function fileMeta(item: Pick<ReviewItem, 'file'>): string | null {
  return item.file ? `${mimeLabel(item.file.mimeType)} · ${formatBytes(item.file.sizeBytes)}` : null;
}
