import type { FileDetails, SpaceRole } from '@living-wiki/contracts';
import type { BadgeTone } from './wiki.js';

// What the file screen offers each role, and what it says about a file's state.
// The server enforces every rule again; this only keeps people from being offered
// what would be refused, and words the state in plain sentences.

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, reviewer: 2, admin: 3 };
const rankOf = (role: SpaceRole | null): number => (role === null ? -1 : RANK[role]);

export interface FileControlsInput {
  role: SpaceRole | null;
  spaceArchived: boolean;
  archived: boolean;
  placement: FileDetails['placement'];
  /** The file's source has removed it (`sourceDeletedAt` is set). */
  sourceDeleted: boolean;
  badge: string;
}

export interface FileControls {
  replace: boolean;
  move: boolean;
  withdraw: boolean;
  archive: boolean;
  restore: boolean;
  retry: boolean;
  dismissRemoval: boolean;
  download: boolean;
  chunks: boolean;
  /** A source keeps this file in sync: say so instead of offering Replace. */
  managedBy: boolean;
}

const READ_FAILED = /^Extraction failed$| could not be read$/;
const INDEX_FAILED = /^Index failed$| failed to index$/;
const STORED = /^Stored · no searchable text$| has no searchable text$/;

export function fileControls({ role, spaceArchived, archived, placement, sourceDeleted, badge }: FileControlsInput): FileControls {
  const rank = rankOf(role);
  const live = !archived && !spaceArchived;
  const editor = live && rank >= RANK.editor;
  return {
    replace: editor && placement !== 'synced',
    move: editor,
    withdraw: live && rank >= RANK.reviewer,
    archive: live && rank >= RANK.admin,
    restore: archived && !spaceArchived && rank >= RANK.admin,
    retry: editor && (READ_FAILED.test(badge) || INDEX_FAILED.test(badge)),
    dismissRemoval: editor && placement === 'synced' && sourceDeleted,
    download: true,
    chunks: rank >= RANK.editor,
    managedBy: placement === 'synced',
  };
}

export interface FileBannerInput {
  badge: string;
  sourceDeleted: boolean;
  placement: FileDetails['placement'];
  /** A version is published (indexed) for everyone to read. */
  hasPublished: boolean;
  role: SpaceRole | null;
}

/** The one sentence above a file's preview when something needs saying; null for a healthy file. */
export function fileBanner({ badge, sourceDeleted, placement, hasPublished, role }: FileBannerInput): { tone: BadgeTone; text: string } | null {
  const rank = rankOf(role);
  if (sourceDeleted) {
    return placement === 'synced'
      ? { tone: 'muted', text: 'This file was removed at its source.' }
      : { tone: 'muted', text: 'The source that sent this file has removed it. It stays here, withdrawn.' };
  }
  if (rank < RANK.editor) {
    return hasPublished ? null : { tone: 'muted', text: 'Nothing has been published yet.' };
  }
  if (READ_FAILED.test(badge)) {
    return { tone: 'danger', text: 'This file could not be read. Try again, or upload a corrected copy.' };
  }
  if (INDEX_FAILED.test(badge)) return { tone: 'danger', text: 'This file could not be indexed. Try again.' };
  if (STORED.test(badge)) {
    return { tone: 'muted', text: 'No searchable text was found in this file. It is kept for download.' };
  }
  if (rank >= RANK.reviewer && /awaiting approval\)?$/.test(badge)) {
    return { tone: 'pending', text: 'This version is waiting for review.' };
  }
  return null;
}

/** The version the screen opens on: editors the latest, everyone else only the published one. */
export function publishedVersionId(details: Pick<FileDetails, 'latestVersion' | 'indexedVersion'>, role: SpaceRole | null): string | null {
  return rankOf(role) >= RANK.editor ? (details.latestVersion?.id ?? null) : (details.indexedVersion?.id ?? null);
}

/** A name safe to hand to the browser's save dialog: no path separators, no control characters. */
export function downloadFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' ? 'file' : cleaned;
}

/** A size for people: bytes up to 1 KB, then one decimal of KB, MB or GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
