import { describe, expect, test } from 'vitest';
import type { FileDetails, FileVersion } from '@kinote/contracts';
import { downloadFileName, formatBytes, fileBanner, fileControls, publishedVersionId, type FileControlsInput } from '../src/lib/fileUi.js';

const base: FileControlsInput = {
  role: 'editor',
  spaceArchived: false,
  archived: false,
  placement: 'pinned',
  sourceDeleted: false,
  badge: 'Indexed · v1',
};
const controls = (over: Partial<FileControlsInput> = {}) => fileControls({ ...base, ...over });

describe('fileControls', () => {
  test('a viewer may only read: download is the one thing left', () => {
    expect(controls({ role: 'viewer' })).toEqual({
      replace: false,
      move: false,
      withdraw: false,
      archive: false,
      restore: false,
      retry: false,
      dismissRemoval: false,
      download: true,
      chunks: false,
      managedBy: false,
    });
  });

  test('an editor replaces, moves, retries a failure and inspects chunks', () => {
    expect(controls()).toMatchObject({ replace: true, move: true, withdraw: false, archive: false, chunks: true, retry: false });
    expect(controls({ badge: 'Extraction failed' }).retry).toBe(true);
    expect(controls({ badge: 'Index failed' }).retry).toBe(true);
    expect(controls({ badge: 'Indexed · v1, v2 could not be read' }).retry).toBe(true);
    expect(controls({ badge: 'Indexed · v1, v2 failed to index' }).retry).toBe(true);
  });

  test('a reviewer may also withdraw, an admin also archive', () => {
    expect(controls({ role: 'reviewer' })).toMatchObject({ withdraw: true, archive: false });
    expect(controls({ role: 'admin' })).toMatchObject({ withdraw: true, archive: true, restore: false });
  });

  test('an archived file (or space) is read-only; only an admin may restore the file', () => {
    expect(controls({ archived: true, role: 'admin' })).toMatchObject({
      replace: false,
      move: false,
      withdraw: false,
      archive: false,
      restore: true,
      retry: false,
      download: true,
    });
    expect(controls({ archived: true, role: 'editor' }).restore).toBe(false);
    expect(controls({ spaceArchived: true, role: 'admin' })).toMatchObject({ replace: false, restore: false });
  });

  test('a file a source keeps in sync cannot be replaced by hand, and says who manages it', () => {
    expect(controls({ placement: 'synced' })).toMatchObject({ replace: false, move: true, managedBy: true });
  });

  test('"Removed at source" can be dismissed by an editor of a synced file', () => {
    const removed = { placement: 'synced' as const, sourceDeleted: true, badge: 'Removed at source' };
    expect(controls(removed).dismissRemoval).toBe(true);
    expect(controls({ ...removed, role: 'viewer' }).dismissRemoval).toBe(false);
    expect(controls({ ...removed, archived: true }).dismissRemoval).toBe(false);
    expect(controls({ ...removed, placement: 'pinned' }).dismissRemoval).toBe(false);
  });

  test('an unknown role gets nothing but the download', () => {
    expect(controls({ role: null })).toMatchObject({ replace: false, move: false, chunks: false, download: true });
  });
});

describe('fileBanner', () => {
  const b = (over: Partial<Parameters<typeof fileBanner>[0]> = {}) =>
    fileBanner({ badge: 'Indexed · v1', sourceDeleted: false, placement: 'pinned', hasPublished: true, role: 'editor', ...over });

  test('a healthy indexed file has no banner', () => {
    expect(b()).toBeNull();
  });

  test('removed at source, synced or pinned', () => {
    expect(b({ sourceDeleted: true, placement: 'synced', badge: 'Removed at source' })).toEqual({
      tone: 'muted',
      text: 'This file was removed at its source.',
    });
    expect(b({ sourceDeleted: true, placement: 'pinned', badge: 'Withdrawn' })).toEqual({
      tone: 'muted',
      text: 'The source that sent this file has removed it. It stays here, withdrawn.',
    });
  });

  test('failures say what to do', () => {
    expect(b({ badge: 'Extraction failed' })).toEqual({
      tone: 'danger',
      text: 'This file could not be read. Try again, or upload a corrected copy.',
    });
    expect(b({ badge: 'Indexed · v1, v2 could not be read' })?.text).toBe(
      'This file could not be read. Try again, or upload a corrected copy.'
    );
    expect(b({ badge: 'Index failed' })).toEqual({ tone: 'danger', text: 'This file could not be indexed. Try again.' });
  });

  test('a stored file explains why it cannot be searched', () => {
    expect(b({ badge: 'Stored · no searchable text' })).toEqual({
      tone: 'muted',
      text: 'No searchable text was found in this file. It is kept for download.',
    });
  });

  test('a version waiting for review is said to reviewers only', () => {
    expect(b({ badge: 'Not indexed (awaiting approval)', role: 'reviewer' })).toEqual({
      tone: 'pending',
      text: 'This version is waiting for review.',
    });
    expect(b({ badge: 'Not indexed (awaiting approval)', role: 'editor' })).toBeNull();
  });

  test('a viewer with nothing published is told so, and sees no failure details', () => {
    expect(b({ role: 'viewer', hasPublished: false, badge: 'Extraction failed' })).toEqual({
      tone: 'muted',
      text: 'Nothing has been published yet.',
    });
    expect(b({ role: 'viewer', hasPublished: true, badge: 'Indexed · v1, v2 could not be read' })).toBeNull();
  });
});

function ver(id: string, number: number): FileVersion {
  return {
    id,
    number,
    status: 'indexed',
    reason: 'upload',
    createdAt: '2026-10-20T10:00:00.000Z',
    fileName: 'a.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    hasText: true,
  } as unknown as FileVersion;
}

describe('publishedVersionId', () => {
  const details = (latest: FileVersion | null, indexed: FileVersion | null) =>
    ({ latestVersion: latest, indexedVersion: indexed }) as unknown as FileDetails;

  test('editors read the latest version, viewers only the indexed one', () => {
    const d = details(ver('v2', 2), ver('v1', 1));
    expect(publishedVersionId(d, 'editor')).toBe('v2');
    expect(publishedVersionId(d, 'admin')).toBe('v2');
    expect(publishedVersionId(d, 'viewer')).toBe('v1');
  });

  test('a viewer gets nothing while nothing is indexed, and an unknown role is treated as a viewer', () => {
    expect(publishedVersionId(details(ver('v1', 1), null), 'viewer')).toBeNull();
    expect(publishedVersionId(details(ver('v1', 1), null), null)).toBeNull();
    expect(publishedVersionId(details(null, null), 'editor')).toBeNull();
  });
});

describe('downloadFileName', () => {
  test('keeps the name and extension, drops separators and control characters', () => {
    expect(downloadFileName('Leave report.pdf')).toBe('Leave report.pdf');
    expect(downloadFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(downloadFileName('a\\b\u0000c\n.txt')).toBe('a_bc.txt');
    expect(downloadFileName('   ')).toBe('file');
  });
});

describe('formatBytes', () => {
  test('bytes, then one decimal of KB and MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1,023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
