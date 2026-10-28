import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import { api } from './api.js';
import { loadSession } from './session.js';
import { ApiThreadStore, WikiThreadAuth, type ThreadApi } from './threadStore.js';

/** How often an open page asks for its threads again (others' comments show up within this). */
const THREADS_POLL_MS = 20_000;

const threadApi: ThreadApi = {
  list: (pageId) => api.pageThreads(pageId),
  create: (pageId, req) => api.createThread(pageId, req),
  reply: (threadId, body) => api.replyToThread(threadId, body),
  update: (commentId, body) => api.updateComment(commentId, body),
  removeComment: (commentId) => api.deleteComment(commentId),
  removeThread: (threadId) => api.deleteThread(threadId),
  resolve: (threadId) => api.resolveThread(threadId),
  unresolve: (threadId) => api.unresolveThread(threadId),
};

/**
 * The comment store of one open page, shared by its editor (the marks and
 * floating threads) and its comments panel. Asked again on a timer and on focus.
 */
export function usePageThreadStore(pageId: string, rights: { canEdit: boolean; moderates: boolean }): ApiThreadStore {
  const userId = loadSession()?.user.id ?? '';
  const store = useMemo(
    () => new ApiThreadStore(pageId, threadApi, new WikiThreadAuth(userId, rights), () => ({ blockId: null, quote: null })),
    // Rights change rarely (a role change); a new store re-reads the threads.
    [pageId, userId, rights.canEdit, rights.moderates]
  );
  useEffect(() => {
    const refresh = () => void store.refresh().catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, THREADS_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [store]);
  return store;
}

/** The store's threads, re-rendering when they change. */
export function useThreads(store: ApiThreadStore): Map<string, ThreadData> {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getThreads()
  );
}
