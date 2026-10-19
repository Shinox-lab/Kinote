import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { api } from '../lib/api.js';
import { collabDocumentName, collabUrl, connectionState, type ConnectionState } from '../lib/collab.js';
import { useWorkspace } from '../lib/queries.js';
import { loadSession } from '../lib/session.js';
import { authorColor } from '../lib/wiki.js';
import { Button, ErrorNote, Loading } from './ui.js';

/** The Y.XmlFragment that holds a page's blocks (BLOCK_FRAGMENT in apps/collab/src/fragment.ts). */
const BLOCK_FRAGMENT = 'document-store';

/** A rejected token is fetched again (the old one may have expired) this many times before the editor shows "offline". */
const AUTH_RETRIES = 3;

const STATE_TEXT: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  offline: 'Offline',
};

interface Live {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}

/** The BlockNote editor bound to the page's Yjs document. Mounted only once the provider exists. */
function BoundEditor({ live, editable }: { live: Live; editable: boolean }) {
  const user = loadSession()?.user;
  const editor = useCreateBlockNote(
    {
      collaboration: {
        // BlockNote only reads the awareness (cursors); the provider types it as nullable.
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.ydoc.getXmlFragment(BLOCK_FRAGMENT),
        user: { name: user?.name ?? 'Someone', color: authorColor(user?.id ?? '').accent },
      },
    },
    [live]
  );
  return <BlockNoteView editor={editor} editable={editable} theme="light" />;
}

/**
 * Live editor of one page. Fetches a collab token, opens a HocuspocusProvider on the
 * collab websocket and binds BlockNote to it. The provider asks for a fresh token on
 * every (re)connect, a refused token is fetched again a few times, and the provider
 * is destroyed on unmount. The editor is read-only when the token says `read` (or the
 * page is archived). `onSynced` fires on every `synced` event.
 */
export function Editor({ pageId, archived, onSynced }: { pageId: string; archived: boolean; onSynced: () => void }) {
  const { tenant } = useWorkspace();
  const [live, setLive] = useState<Live | null>(null);
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [state, setState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const reconnect = useRef<() => void>(() => {});
  // Always the latest callback, without restarting the connection when it changes.
  const synced = useRef(onSynced);
  useEffect(() => {
    synced.current = onSynced;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let provider: HocuspocusProvider | undefined;
    const ydoc = new Y.Doc();

    (async () => {
      let first;
      try {
        first = await api.collabToken(pageId);
      } catch (err) {
        if (!cancelled) setError(err);
        return;
      }
      if (cancelled) return;
      setAccess(first.access);

      const status = { socket: 'connecting' as 'connecting' | 'connected' | 'disconnected', synced: false, authFailed: false };
      let failures = 0;
      const publish = () => setState(connectionState(status));
      // The token fetched above serves the first connect; every later connect fetches its own.
      let primed: string | null = first.token;

      const p = new HocuspocusProvider({
        url: collabUrl(window.location, import.meta.env.VITE_COLLAB_URL),
        name: collabDocumentName(tenant.id, pageId),
        document: ydoc,
        token: async () => {
          if (primed !== null) {
            const token = primed;
            primed = null;
            return token;
          }
          const fresh = await api.collabToken(pageId);
          if (!cancelled) setAccess(fresh.access);
          return fresh.token;
        },
        onStatus: ({ status: s }) => {
          status.socket = s === WebSocketStatus.Connected ? 'connected' : s === WebSocketStatus.Connecting ? 'connecting' : 'disconnected';
          if (status.socket !== 'connected') status.synced = false;
          publish();
        },
        onAuthenticated: () => {
          failures = 0;
          status.authFailed = false;
          publish();
        },
        onAuthenticationFailed: () => {
          failures += 1;
          if (failures > AUTH_RETRIES) {
            status.authFailed = true;
            publish();
            return;
          }
          // Reconnecting asks the token function for a new token.
          const socket = p.configuration.websocketProvider;
          socket.disconnect();
          timer = setTimeout(() => void socket.connect(), 1000 * failures);
        },
        onSynced: () => {
          status.synced = true;
          publish();
          synced.current();
        },
      });
      provider = p;
      reconnect.current = () => {
        failures = 0;
        status.authFailed = false;
        publish();
        const socket = p.configuration.websocketProvider;
        socket.disconnect();
        void socket.connect();
      };
      setLive({ ydoc, provider: p });
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      provider?.destroy();
      ydoc.destroy();
      setLive(null);
    };
  }, [pageId, tenant.id, attempt]);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorNote error={error} />
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const editable = access === 'write' && !archived;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <span role="status" data-connection={state}>
          {STATE_TEXT[state]}
        </span>
        {state === 'offline' && (
          <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => reconnect.current()}>
            Reconnect
          </Button>
        )}
        {!editable && live && <span className="rounded bg-slate-200 px-2 py-0.5 text-slate-800">Read only</span>}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white py-3">
        {live ? <BoundEditor live={live} editable={editable} /> : <Loading what="editor" />}
      </div>
    </div>
  );
}
