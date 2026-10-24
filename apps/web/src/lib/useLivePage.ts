import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { api } from './api.js';
import { collabDocumentName, collabUrl, connectionState, type ConnectionState } from './collab.js';
import { useWorkspace } from './queries.js';
import { loadSession } from './session.js';

/** A rejected token is fetched again (the old one may have expired) this many times before the editor shows "offline". */
const AUTH_RETRIES = 3;

export interface Live {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}

export interface LivePage {
  live: Live | null;
  access: 'read' | 'write';
  state: ConnectionState;
  error: unknown;
  retry: () => void;
  reconnect: () => void;
}

/**
 * The page's live connection: fetches a collab token, opens one Hocuspocus
 * provider and shares it with the editor and the presence strip. The provider
 * asks for a fresh token on every (re)connect, a refused token is fetched again
 * a few times, and the provider/doc are destroyed on unmount or page change.
 * The awareness carries the person's id and name (BlockNote already carries
 * their name and colour for the cursors).
 */
export function useLivePage(pageId: string, onSynced: () => void): LivePage {
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
    setLive(null);
    setAccess('read');
    setState('connecting');
    setError(null);

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
      const user = loadSession()?.user;
      if (user) p.awareness?.setLocalStateField('lwUser', { id: user.id, name: user.name });
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

  return {
    live,
    access,
    state,
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
    reconnect: () => reconnect.current(),
  };
}
