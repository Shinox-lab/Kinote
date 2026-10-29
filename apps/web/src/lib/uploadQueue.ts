import { ERROR_SENTENCES } from '@kinote/contracts';
import { badgeSettles } from './wiki.js';

// The console's upload queue as plain data: files go up one at a time, a file
// that is refused, duplicated or fails never stops the ones behind it, and a file
// the server is still reading is looked at again until it settles (or we give up).

export type UploadStatus = 'waiting' | 'uploading' | 'reading' | 'done' | 'failed' | 'duplicate';

export interface UploadItem {
  id: string;
  fileName: string;
  size: number;
  /** Where it goes: a space (null: the Inbox) and an optional parent page. */
  spaceId: string | null;
  parentId: string | null;
  status: UploadStatus;
  documentId: string | null;
  /** The file's own badge as the server last wrote it. */
  badge: string | null;
  /** A plain sentence for a failed (or given-up) file. */
  message: string | null;
  /** When the file was first seen being read (ms); null before that. */
  readingSince: number | null;
}

export type UploadAction =
  | { type: 'add'; items: UploadItem[] }
  | { type: 'start'; id: string }
  | { type: 'uploaded'; id: string; documentId: string; unchanged: boolean; badge: string; now: number }
  | { type: 'badge'; id: string; badge: string; now: number }
  | { type: 'giveUp'; id: string }
  | { type: 'fail'; id: string; message: string }
  | { type: 'retry'; id: string }
  | { type: 'dismiss'; id: string };

/** How often a file being read is looked at again. */
export const READING_POLL_MS = 2_000;
/** How long a file may stay "being read" before the panel stops waiting for it. */
export const READING_GIVE_UP_MS = 5 * 60_000;
export const GIVE_UP_SENTENCE = 'Still reading — check the file later';

const FINISHED: readonly UploadStatus[] = ['done', 'failed', 'duplicate'];

function patch(state: UploadItem[], id: string, change: (i: UploadItem) => UploadItem): UploadItem[] {
  return state.map((i) => (i.id === id ? change(i) : i));
}

export function reduceUploads(state: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.items];
    case 'start':
      return patch(state, action.id, (i) => (i.status === 'waiting' ? { ...i, status: 'uploading' } : i));
    case 'uploaded':
      return patch(state, action.id, (i) => ({
        ...i,
        documentId: action.documentId,
        badge: action.badge,
        message: null,
        status: action.unchanged ? 'duplicate' : badgeSettles(action.badge) ? 'reading' : 'done',
        readingSince: !action.unchanged && badgeSettles(action.badge) ? action.now : null,
      }));
    case 'badge':
      return patch(state, action.id, (i) =>
        i.status !== 'reading'
          ? i
          : { ...i, badge: action.badge, status: badgeSettles(action.badge) ? 'reading' : 'done' }
      );
    case 'giveUp':
      return patch(state, action.id, (i) => (i.status === 'reading' ? { ...i, status: 'done', message: GIVE_UP_SENTENCE } : i));
    case 'fail':
      return patch(state, action.id, (i) => ({ ...i, status: 'failed', message: action.message }));
    case 'retry':
      return patch(state, action.id, (i) => (i.status === 'failed' ? { ...i, status: 'waiting', message: null } : i));
    case 'dismiss':
      return state.filter((i) => i.id !== action.id || !FINISHED.includes(i.status));
  }
}

/** The next file to send: the first waiting one, and only while none is being sent. */
export function nextToStart(state: readonly UploadItem[]): UploadItem | null {
  if (state.some((i) => i.status === 'uploading')) return null;
  return state.find((i) => i.status === 'waiting') ?? null;
}

/** What to do about a file that is being read: look again, stop waiting, or it has settled. */
export function readingDecision(item: UploadItem, now: number): 'poll' | 'give_up' | 'done' {
  if (item.badge === null || !badgeSettles(item.badge)) return 'done';
  return now - (item.readingSince ?? now) >= READING_GIVE_UP_MS ? 'give_up' : 'poll';
}

/** The one line a row shows under the file's name. */
export function statusLine(item: UploadItem): string {
  switch (item.status) {
    case 'waiting':
      return 'Waiting';
    case 'uploading':
      return 'Uploading';
    case 'reading':
      return 'Reading text';
    case 'duplicate':
      return 'Already here';
    case 'failed':
      return item.message ?? 'Something went wrong. Please try again.';
    case 'done':
      return item.message ?? item.badge ?? 'Done';
  }
}

/** A sentence for a file the server would refuse anyway, so no request is made for it. */
export function localRefusal(file: { size: number }): string | null {
  return file.size === 0 ? ERROR_SENTENCES.empty_file : null;
}
