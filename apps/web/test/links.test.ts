import { describe, expect, test, vi } from 'vitest';
import type { DocumentTitle, LinkTarget } from '@living-wiki/contracts';
import { blockSourcesOf, connectionCount, createTitleBatcher, linkMenuEntries, parsePeekSearch } from '../src/lib/links.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const target = (over: Partial<LinkTarget>): LinkTarget => ({
  id: ID,
  title: 'Client - George',
  icon: null,
  spaceId: ID2,
  spaceName: 'Clients',
  parentTitle: null,
  ...over,
});

describe('parsePeekSearch', () => {
  test('keeps a peeked page id, lower-cased', () => {
    expect(parsePeekSearch({ peek: ID.toUpperCase() })).toEqual({ peek: ID });
  });
  test('drops anything that is not a page id', () => {
    expect(parsePeekSearch({ peek: 'nope' })).toEqual({});
    expect(parsePeekSearch({})).toEqual({});
  });
});

describe('createTitleBatcher', () => {
  test('asks once for the ids requested together, and answers each', async () => {
    const titles: DocumentTitle[] = [{ id: ID, kind: 'page', title: 'A', icon: null }];
    const fetch = vi.fn(async () => titles);
    const load = createTitleBatcher(fetch);
    const [a, b] = await Promise.all([load(ID), load(ID2)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith([ID, ID2]);
    expect(a).toEqual(titles[0]);
    expect(b).toBeNull();
  });

  test('a failed request fails every id in it', async () => {
    const load = createTitleBatcher(async () => {
      throw new Error('down');
    });
    await expect(Promise.all([load(ID), load(ID2)])).rejects.toThrow('down');
  });

  test('splits more than 100 ids into several requests', async () => {
    const fetch = vi.fn(async () => [] as DocumentTitle[]);
    const load = createTitleBatcher(fetch);
    const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await Promise.all(ids.map(load));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('linkMenuEntries', () => {
  test('lists targets with where they live, then offers a new page named by the query', () => {
    const entries = linkMenuEntries([target({ parentTitle: 'Clients home' })], 'George notes', { canCreate: true, selfId: null });
    expect(entries).toEqual([
      { kind: 'target', target: expect.objectContaining({ id: ID }), title: 'Client - George', subtext: 'Clients / Clients home' },
      { kind: 'new', title: 'New page "George notes"', newTitle: 'George notes' },
    ]);
  });

  test('no new-page entry for an empty query, an exact title match, or without edit rights', () => {
    expect(linkMenuEntries([target({})], '  ', { canCreate: true, selfId: null }).map((e) => e.kind)).toEqual(['target']);
    expect(linkMenuEntries([target({})], 'client - george', { canCreate: true, selfId: null }).map((e) => e.kind)).toEqual(['target']);
    expect(linkMenuEntries([target({})], 'x', { canCreate: false, selfId: null }).map((e) => e.kind)).toEqual(['target']);
  });

  test('the page being edited is not offered as a target', () => {
    expect(linkMenuEntries([target({})], '', { canCreate: true, selfId: ID })).toEqual([]);
  });
});

describe('connectionCount', () => {
  test('counts the pages a page is connected to', () => {
    expect(
      connectionCount({
        linkedFrom: [{ pageId: ID, title: 'a', icon: null, spaceName: 's', blockId: 'b', excerpt: '' }],
        updatedBy: [],
        updated: [{ pageId: ID2, title: 'b', icon: null, spaceName: 's', captureId: ID, sections: 2 }],
      })
    ).toBe(2);
  });
});

describe('blockSourcesOf', () => {
  test('one chip entry per block a document page updated', () => {
    expect(
      blockSourcesOf({
        linkedFrom: [],
        updated: [],
        updatedBy: [{ pageId: ID, title: 'Oct 14 meeting', icon: null, spaceName: 's', blockIds: ['b1', 'b2'] }],
      })
    ).toEqual([
      { blockId: 'b1', pageId: ID, title: 'Oct 14 meeting' },
      { blockId: 'b2', pageId: ID, title: 'Oct 14 meeting' },
    ]);
  });
});
