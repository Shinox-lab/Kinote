import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatApiError } from '../../src/App';
import {
  api,
  loadRecentPages,
  rememberPage,
  type ApiError,
  type RecentPage,
  type Session,
  type Space,
} from '../lib/api';

function slugify(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

export function Home({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [recent, setRecent] = useState<RecentPage[]>(() => loadRecentPages(session.tenantId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // create-page form state
  const [spaceId, setSpaceId] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageSlug, setPageSlug] = useState('');

  // create-space form state
  const [spaceName, setSpaceName] = useState('');
  const [spaceSlug, setSpaceSlug] = useState('');

  const refreshSpaces = useCallback(async () => {
    try {
      const list = await api.listSpaces(session);
      setSpaces(list);
      // default target for the page form: first non-inbox space, else inbox
      if (!spaceId && list.length > 0) setSpaceId(list[0].id);
    } catch (err) {
      setError(formatApiError((err as ApiError).code ?? ''));
    }
  }, [session, spaceId]);

  useEffect(() => {
    void refreshSpaces();
  }, []);

  useEffect(() => setPageSlug(slugify(pageTitle)), [pageTitle]);

  async function createSpace(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createSpace(session, { name: spaceName, slug: slugify(spaceName) || spaceSlug });
      setSpaceName('');
      setSpaceSlug('');
      const list = await api.listSpaces(session);
      setSpaces(list);
    } catch (err) {
      setError(formatApiError((err as ApiError).code ?? ''));
    } finally {
      setBusy(false);
    }
  }

  async function createPage(e: FormEvent) {
    e.preventDefault();
    if (!spaceId) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.createPage(session, { space_id: spaceId, title: pageTitle, slug: pageSlug });
      const page: RecentPage = {
        id: res.document.id,
        title: pageTitle,
        spaceId,
        slug: pageSlug,
      };
      rememberPage(session.tenantId, page);
      setRecent(loadRecentPages(session.tenantId));
      window.location.hash = `#/page/${res.document.id}`;
    } catch (err) {
      setError(formatApiError((err as ApiError).code ?? ''));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    onSignOut();
    window.location.hash = '';
    setSpaces([]);
  }

  return (
    <div className="center col">
      <header className="row spread">
        <div>
          <h1>Living Wiki</h1>
          <p className="muted">
            Workspace <strong>{session.tenantSlug}</strong> · signed in as {session.userName} ({session.tenantRole})
          </p>
        </div>
        <button onClick={signOut}>Switch workspace</button>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2>Spaces</h2>
        {spaces.length === 0 ? (
          <p className="muted">No spaces yet.</p>
        ) : (
          <ul>
            {spaces.map((sp) => (
              <li key={sp.id}>
                <strong>{sp.name}</strong>
                <span className="muted"> · {sp.slug} · {sp.kind}{sp.myRole ? ` · ${sp.myRole}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {/* backend pages API currently has no list-documents endpoint; a space
            selector in the create form is the quickest way to target a space */}
        <h3>New page</h3>
        <form onSubmit={createPage} className="row gap">
          <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            {spaces.map((sp) => (
              <option key={sp.id} value={sp.id}>{sp.name}</option>
            ))}
          </select>
          <input placeholder="Page title" value={pageTitle} onChange={(e) => setPageTitle(e.target.value)} required />
          <input placeholder="slug" value={pageSlug} onChange={(e) => setPageSlug(e.target.value)} pattern="[a-z0-9-]+" required />
          <button type="submit" disabled={busy || !spaceId}>Create page</button>
        </form>

        <h3>New space</h3>
        <form onSubmit={createSpace} className="row gap">
          <input placeholder="Space name" value={spaceName} onChange={(e) => setSpaceName(e.target.value)} required />
          <button type="submit" disabled={busy}>Create space</button>
        </form>
      </div>

      <div className="card">
        <h2>Recent pages</h2>
        {recent.length === 0 ? (
          <p className="muted">No pages yet — create one above.</p>
        ) : (
          <ul>
            {recent.map((p) => (
              <li key={p.id}>
                <a href={`#/page/${p.id}`}>{p.title || p.slug}</a>
                <a href={`#/page/${p.id}`} className="muted"> · open editor</a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
