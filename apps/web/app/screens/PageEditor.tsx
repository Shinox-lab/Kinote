import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { formatApiError } from '../../src/App';
import { api, type ApiError, type PageDetails, type Session } from '../lib/api';

const CURSOR_COLORS = ['#2563eb', '#16a34a', '#9333ea', '#059669', '#ea580c'];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export function PageEditor({ session, pageId }: { session: Session; pageId: string }) {
  const [details, setDetails] = useState<PageDetails | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

  // WS doc name: "{tenantId}:{pageId}" — matches the server onAuthenticate parse.
  // v1 collab token is the opaque actor string "user:{id}:{role}".
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: session.collabBase,
        name: `${session.tenantId}:${pageId}`,
        token: `user:${session.userId}:${session.tenantRole}`,
      }),
    [session, pageId]
  );

  const editor = useCreateBlockNote({
    collaboration: {
      provider,
      // Shared XML fragment name — must stay in sync with the server-side
      // block converters ('document-store' is used by api + worker too).
      fragment: provider.document.getXmlFragment('document-store'),
      user: {
        name: session.userName,
        color: CURSOR_COLORS[Math.abs(hashStr(session.userId)) % CURSOR_COLORS.length],
      },
    },
  });

  const refreshDetails = useCallback(async () => {
    try {
      setDetails(await api.page(session, pageId));
    } catch (err) {
      setLoadError(formatApiError((err as ApiError).code ?? ''));
    }
  }, [session, pageId]);

  useEffect(() => {
    void refreshDetails();
  }, [refreshDetails]);

  async function takeSnapshot() {
    setBusy(true);
    setActionError('');
    try {
      await api.snapshot(session, pageId);
      await refreshDetails();
    } catch (err) {
      setActionError(formatApiError((err as ApiError).code ?? ''));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // Disconnect the websocket when leaving the editor.
    return () => {
      provider.destroy();
    };
  }, [provider]);

  if (loadError) {
    return (
      <div className="center">
        <div className="card">
          <h2>Error</h2>
          <div className="error">{loadError}</div>
          <a href="#/">← back home</a>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="row spread">
        <div className="row gap baseline">
          <a href="#/">← home</a>
          <h1>{details ? details.title : '…'}</h1>
          <span className="badge">{details?.badge || '—'}</span>
        </div>
        <div className="row gap">
          <button onClick={refreshDetails}>Refresh status</button>
          <button onClick={takeSnapshot} disabled={busy}>
            {busy ? 'Snapshotting…' : 'Take snapshot'}
          </button>
        </div>
      </header>

      {actionError && <div className="error">{actionError}</div>}

      <div className="row gap stretch">
        <div className="card editor-main">
          <BlockNoteView editor={editor} theme="light" />
        </div>
        <div className="card editor-side">
          <h2>Versions</h2>
          {details?.versions?.length ? (
            <ul>
              {details.versions.map((v) => (
                <li key={v.id}>
                  <strong>v{v.number}</strong> · {v.status}
                  <div className="muted">reason: {v.reason ?? '—'} · {v.createdAt}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No snapshots yet. Edits are live on the shared Yjs doc; the worker takes a quiet
              snapshot automatically after inactivity, or click “Take snapshot”.
            </p>
          )}
          <p className="muted small">
            Badge and versions are server-computed — “Refresh status” re-reads them after the
            worker runs.
          </p>
        </div>
      </div>
    </div>
  );
}
