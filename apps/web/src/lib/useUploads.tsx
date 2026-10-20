import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { api, errorMessage } from './api.js';
import { useRefresh } from './queries.js';
import {
  READING_POLL_MS,
  localRefusal,
  nextToStart,
  readingDecision,
  reduceUploads,
  type UploadItem,
} from './uploadQueue.js';

/** Where a batch of files goes: a space (null: the Inbox) and an optional parent page. */
export interface UploadTarget {
  spaceId: string | null;
  parentId: string | null;
}

interface Uploads {
  uploads: readonly UploadItem[];
  /** Queues the files, in the order given; they go up one at a time. */
  enqueue: (files: readonly File[], target: UploadTarget) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
}

const UploadsContext = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const value = useContext(UploadsContext);
  if (!value) throw new Error('useUploads outside UploadsProvider');
  return value;
}

let counter = 0;

/**
 * The workspace's upload queue. It lives above the router outlet, so moving around
 * the console does not stop it; it is keyed by workspace, so a switch starts clean.
 */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const [uploads, dispatch] = useReducer(reduceUploads, []);
  // The File objects stay out of the reducer (plain data only), keyed by upload id.
  const files = useRef(new Map<string, File>());
  // Upload attempts already sent (an effect may run twice), by id and attempt.
  const sent = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
  const refresh = useRefresh();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const enqueue = useCallback((picked: readonly File[], target: UploadTarget) => {
    const items: UploadItem[] = [];
    const refused: { id: string; message: string }[] = [];
    for (const file of picked) {
      const id = `u${++counter}`;
      files.current.set(id, file);
      items.push({
        id,
        fileName: file.name,
        size: file.size,
        spaceId: target.spaceId,
        parentId: target.parentId,
        status: 'waiting',
        documentId: null,
        badge: null,
        message: null,
        readingSince: null,
      });
      const message = localRefusal(file);
      if (message) refused.push({ id, message });
    }
    dispatch({ type: 'add', items });
    for (const r of refused) dispatch({ type: 'fail', id: r.id, message: r.message });
  }, []);

  // Send the next waiting file when nothing is being sent.
  const next = nextToStart(uploads);
  useEffect(() => {
    if (!next) return;
    const attempt = `${next.id}:${retries.current.get(next.id) ?? 0}`;
    if (sent.current.has(attempt)) return;
    sent.current.add(attempt);
    const file = files.current.get(next.id);
    dispatch({ type: 'start', id: next.id });
    if (!file) {
      dispatch({ type: 'fail', id: next.id, message: errorMessage(null) });
      return;
    }
    const form = new FormData();
    form.set('file', file, file.name);
    if (next.spaceId) form.set('space_id', next.spaceId);
    if (next.parentId) form.set('parent_id', next.parentId);
    void (async () => {
      try {
        const out = await api.uploadFile(form);
        // The reply says what was stored; the badge says what became of it.
        const badge = await api
          .getFile(out.document.id)
          .then((f) => f.badge)
          .catch(() => 'Reading text…');
        dispatch({ type: 'uploaded', id: next.id, documentId: out.document.id, unchanged: out.unchanged, badge, now: Date.now() });
        files.current.delete(next.id);
      } catch (err) {
        dispatch({ type: 'fail', id: next.id, message: errorMessage(err) });
      } finally {
        for (const part of ['tree', 'reviews', 'updates']) void refreshRef.current(part);
      }
    })();
    // `next` changes identity with each state; its id is what decides a new send.
  }, [next?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Look again at files the server is still reading.
  const readingKey = uploads.filter((u) => u.status === 'reading').map((u) => u.id).join(',');
  const latest = useRef(uploads);
  latest.current = uploads;
  useEffect(() => {
    if (readingKey === '') return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const item of latest.current.filter((u) => u.status === 'reading' && u.documentId)) {
        const decision = readingDecision(item, now);
        if (decision === 'give_up') {
          dispatch({ type: 'giveUp', id: item.id });
          continue;
        }
        void api
          .getFile(item.documentId!)
          .then((f) => {
            dispatch({ type: 'badge', id: item.id, badge: f.badge, now: Date.now() });
            for (const part of ['file', 'tree', 'reviews', 'updates']) void refreshRef.current(part);
          })
          .catch(() => {
            // Not reachable right now: the next tick (or the give-up) decides.
          });
      }
    }, READING_POLL_MS);
    return () => clearInterval(timer);
  }, [readingKey]);

  const value = useMemo<Uploads>(
    () => ({
      uploads,
      enqueue,
      retry: (id) => {
        retries.current.set(id, (retries.current.get(id) ?? 0) + 1);
        dispatch({ type: 'retry', id });
      },
      dismiss: (id) => {
        files.current.delete(id);
        dispatch({ type: 'dismiss', id });
      },
    }),
    [uploads, enqueue]
  );
  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}
