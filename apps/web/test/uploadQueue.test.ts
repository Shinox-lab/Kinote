import { describe, expect, test } from 'vitest';
import { ERROR_SENTENCES } from '@kinote/contracts';
import {
  READING_GIVE_UP_MS,
  localRefusal,
  nextToStart,
  readingDecision,
  reduceUploads,
  statusLine,
  type UploadItem,
} from '../src/lib/uploadQueue.js';

const NOW = 1_000_000;

function item(over: Partial<UploadItem> = {}): UploadItem {
  return {
    id: 'u1',
    fileName: 'report.pdf',
    size: 100,
    spaceId: 's1',
    parentId: null,
    status: 'waiting',
    documentId: null,
    badge: null,
    message: null,
    readingSince: null,
    ...over,
  };
}

const run = (state: UploadItem[], ...actions: Parameters<typeof reduceUploads>[1][]) =>
  actions.reduce((s, a) => reduceUploads(s, a), state);

describe('the queue order', () => {
  test('adding files makes them wait, and the first one starts', () => {
    const state = run([], { type: 'add', items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] });
    expect(state.map((i) => i.status)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(nextToStart(state)?.id).toBe('a');
  });

  test('nothing else starts while one is uploading', () => {
    const state = run([], { type: 'add', items: [item({ id: 'a' }), item({ id: 'b' })] }, { type: 'start', id: 'a' });
    expect(state[0]!.status).toBe('uploading');
    expect(nextToStart(state)).toBeNull();
  });

  test('a file that is only being read does not hold the next one back', () => {
    const state = run(
      [],
      { type: 'add', items: [item({ id: 'a' }), item({ id: 'b' })] },
      { type: 'start', id: 'a' },
      { type: 'uploaded', id: 'a', documentId: 'd1', unchanged: false, badge: 'Reading text…', now: NOW }
    );
    expect(state[0]!.status).toBe('reading');
    expect(nextToStart(state)?.id).toBe('b');
  });

  test('a refused file, a duplicate and a good one: the others still complete', () => {
    let state = run([], { type: 'add', items: ['a', 'b', 'c', 'd', 'e'].map((id) => item({ id })) });
    const finish = (id: string, action: Parameters<typeof reduceUploads>[1]) => {
      expect(nextToStart(state)?.id).toBe(id);
      state = run(state, { type: 'start', id }, action);
    };
    finish('a', { type: 'uploaded', id: 'a', documentId: 'd1', unchanged: false, badge: 'Indexed · v1', now: NOW });
    finish('b', { type: 'fail', id: 'b', message: ERROR_SENTENCES.unsupported_file_type });
    finish('c', { type: 'uploaded', id: 'c', documentId: 'd2', unchanged: true, badge: 'Indexed · v1', now: NOW });
    finish('d', { type: 'uploaded', id: 'd', documentId: 'd3', unchanged: false, badge: 'Reading text…', now: NOW });
    finish('e', { type: 'uploaded', id: 'e', documentId: 'd4', unchanged: false, badge: 'Not indexed (awaiting approval)', now: NOW });
    expect(state.map((i) => i.status)).toEqual(['done', 'failed', 'duplicate', 'reading', 'done']);
    expect(nextToStart(state)).toBeNull();
  });
});

describe('settling', () => {
  test('a badge that is still moving keeps the file in reading, anything else is done', () => {
    const base = run([], { type: 'add', items: [item()] }, { type: 'start', id: 'u1' });
    const reading = run(base, { type: 'uploaded', id: 'u1', documentId: 'd', unchanged: false, badge: 'Reading text…', now: NOW });
    expect(reading[0]).toMatchObject({ status: 'reading', readingSince: NOW, badge: 'Reading text…', documentId: 'd' });
    const done = run(reading, { type: 'badge', id: 'u1', badge: 'Indexed · v1', now: NOW + 2000 });
    expect(done[0]).toMatchObject({ status: 'done', badge: 'Indexed · v1' });
    const failed = run(reading, { type: 'badge', id: 'u1', badge: 'Extraction failed', now: NOW + 2000 });
    expect(failed[0]!.status).toBe('done');
  });

  test('a later badge never reopens a finished file', () => {
    const done = item({ status: 'done', badge: 'Indexed · v1' });
    expect(run([done], { type: 'badge', id: 'u1', badge: 'Reading text…', now: NOW })[0]).toEqual(done);
  });

  test('readingDecision polls, gives up after five minutes, and reports done once settled', () => {
    const reading = item({ status: 'reading', badge: 'Reading text…', readingSince: NOW });
    expect(readingDecision(reading, NOW + 2_000)).toBe('poll');
    expect(readingDecision(reading, NOW + READING_GIVE_UP_MS - 1)).toBe('poll');
    expect(readingDecision(reading, NOW + READING_GIVE_UP_MS)).toBe('give_up');
    expect(readingDecision({ ...reading, badge: 'Indexed · v1' }, NOW + 1)).toBe('done');
  });

  test('giving up leaves a plain sentence and keeps the link to the file', () => {
    const reading = item({ status: 'reading', badge: 'Reading text…', readingSince: NOW, documentId: 'd' });
    const out = run([reading], { type: 'giveUp', id: 'u1' })[0]!;
    expect(out.status).toBe('done');
    expect(out.message).toBe('Still reading — check the file later');
    expect(out.documentId).toBe('d');
  });
});

describe('retry and dismiss', () => {
  test('retry puts a failed file back to waiting and clears its message', () => {
    const out = run([item({ status: 'failed', message: 'x' })], { type: 'retry', id: 'u1' })[0]!;
    expect(out).toMatchObject({ status: 'waiting', message: null });
  });

  test('retry does nothing to a file that is not failed', () => {
    const uploading = item({ status: 'uploading' });
    expect(run([uploading], { type: 'retry', id: 'u1' })[0]).toEqual(uploading);
  });

  test('dismiss removes finished rows only, never one in flight', () => {
    for (const status of ['done', 'failed', 'duplicate'] as const) {
      expect(run([item({ status })], { type: 'dismiss', id: 'u1' })).toEqual([]);
    }
    for (const status of ['waiting', 'uploading', 'reading'] as const) {
      expect(run([item({ status })], { type: 'dismiss', id: 'u1' })).toHaveLength(1);
    }
  });
});

describe('what each row says', () => {
  test('one line per status', () => {
    expect(statusLine(item({ status: 'waiting' }))).toBe('Waiting');
    expect(statusLine(item({ status: 'uploading' }))).toBe('Uploading');
    expect(statusLine(item({ status: 'reading', badge: 'Reading text…' }))).toBe('Reading text');
    expect(statusLine(item({ status: 'done', badge: 'Not indexed (awaiting approval)' }))).toBe('Not indexed (awaiting approval)');
    expect(statusLine(item({ status: 'done', badge: null, message: 'Still reading — check the file later' }))).toBe(
      'Still reading — check the file later'
    );
    expect(statusLine(item({ status: 'failed', message: 'This file exceeds your plan size limit.' }))).toBe(
      'This file exceeds your plan size limit.'
    );
    expect(statusLine(item({ status: 'duplicate' }))).toBe('Already here');
  });
});

describe('local refusals', () => {
  test('an empty file is refused with the contract sentence, without a request', () => {
    expect(localRefusal({ size: 0 })).toBe(ERROR_SENTENCES.empty_file);
    expect(localRefusal({ size: 1 })).toBeNull();
  });
});
