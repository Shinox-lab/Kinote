import { describe, expect, test, vi } from 'vitest';
import type { CommentThread } from '@living-wiki/contracts';
import { ApiThreadStore, WikiThreadAuth, type ThreadApi } from '../src/lib/threadStore.js';

const PAGE = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const body = [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', styles: {} }] }];

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: T1,
  documentId: PAGE,
  blockId: 'b1',
  quote: 'launch',
  createdBy: ME,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
  comments: [
    { id: C1, authorId: ME, authorName: 'Me', body, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', deletedAt: null },
  ],
  ...over,
});

function fakeApi(threads: CommentThread[] = [thread()]): ThreadApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: vi.fn(async () => threads),
    create: vi.fn(async (_page, req) => {
      calls.push(`create:${req.block_id}:${req.quote}`);
      return thread({ id: T1 });
    }),
    reply: vi.fn(async () => thread()),
    update: vi.fn(async () => thread()),
    removeComment: vi.fn(async () => undefined),
    removeThread: vi.fn(async () => undefined),
    resolve: vi.fn(async () => thread({ resolved: true, resolvedBy: ME, resolvedAt: '2026-10-28T01:00:00.000Z' })),
    unresolve: vi.fn(async () => thread()),
  };
}

describe('ApiThreadStore', () => {
  test('loads the page threads as BlockNote thread data, and tells subscribers', async () => {
    const api = fakeApi();
    const store = new ApiThreadStore(PAGE, api, new WikiThreadAuth(ME, { canEdit: true, moderates: false }), () => ({ blockId: null, quote: null }));
    const seen = vi.fn();
    store.subscribe(seen);
    await store.refresh();
    const t = store.getThread(T1);
    expect(t).toMatchObject({ type: 'thread', id: T1, resolved: false, metadata: { blockId: 'b1', quote: 'launch' } });
    expect(t.comments[0]).toMatchObject({ type: 'comment', id: C1, userId: ME, body, reactions: [] });
    expect(t.createdAt).toBeInstanceOf(Date);
    expect(seen).toHaveBeenCalledWith(store.getThreads());
    expect(store.userName(ME)).toBe('Me');
  });

  test('a new thread carries the block and text it was started on', async () => {
    const api = fakeApi([]);
    const store = new ApiThreadStore(PAGE, api, new WikiThreadAuth(ME, { canEdit: true, moderates: false }), () => ({
      blockId: 'b9',
      quote: 'the text',
    }));
    const created = await store.createThread({ initialComment: { body } });
    expect(api.calls).toEqual(['create:b9:the text']);
    expect(created.id).toBe(T1);
    expect(store.getThreads().has(T1)).toBe(true);
  });

  test('a deleted comment has no body', async () => {
    const api = fakeApi([
      thread({ comments: [{ ...thread().comments[0]!, body: null, deletedAt: '2026-10-28T02:00:00.000Z' }] }),
    ]);
    const store = new ApiThreadStore(PAGE, api, new WikiThreadAuth(ME, { canEdit: true, moderates: false }), () => ({ blockId: null, quote: null }));
    await store.refresh();
    expect(store.getThread(T1).comments[0]).toMatchObject({ body: undefined, deletedAt: expect.any(Date) });
  });

  test('reactions are not offered', async () => {
    const store = new ApiThreadStore(PAGE, fakeApi(), new WikiThreadAuth(ME, { canEdit: true, moderates: false }), () => ({ blockId: null, quote: null }));
    await expect(store.addReaction()).rejects.toThrow();
  });
});

describe('WikiThreadAuth', () => {
  const mine = { userId: ME } as any;
  const theirs = { userId: OTHER } as any;
  const t = { createdBy: ME } as any;

  test('editors start, reply and resolve; authors edit and delete their own', () => {
    const auth = new WikiThreadAuth(ME, { canEdit: true, moderates: false });
    expect(auth.canCreateThread()).toBe(true);
    expect(auth.canAddComment()).toBe(true);
    expect(auth.canResolveThread()).toBe(true);
    expect(auth.canUpdateComment(mine)).toBe(true);
    expect(auth.canUpdateComment(theirs)).toBe(false);
    expect(auth.canDeleteComment(theirs)).toBe(false);
    expect(auth.canAddReaction()).toBe(false);
  });

  test('viewers only read; a space admin may delete what others wrote', () => {
    const viewer = new WikiThreadAuth(ME, { canEdit: false, moderates: false });
    expect(viewer.canCreateThread()).toBe(false);
    expect(viewer.canAddComment()).toBe(false);
    expect(viewer.canResolveThread()).toBe(false);
    const admin = new WikiThreadAuth(ME, { canEdit: true, moderates: true });
    expect(admin.canDeleteComment(theirs)).toBe(true);
    expect(admin.canUpdateComment(theirs)).toBe(false);
    expect(admin.canDeleteThread({ ...t, createdBy: OTHER })).toBe(true);
  });
});
