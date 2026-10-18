import { useState, type FormEvent } from 'react';
import { createTenant, defaults, saveSession, type Session } from '../lib/api';

export function Bootstrap() {
  const [name, setName] = useState('Docs');
  const [slug, setSlug] = useState('docs');
  const [email, setEmail] = useState('owner@example.com');
  const [ownerName, setOwnerName] = useState('Owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await createTenant(
        { name, slug, owner_email: email, owner_name: ownerName },
        defaults.apiBase
      );
      const session: Session = {
        apiBase: defaults.apiBase,
        collabBase: defaults.collabBase,
        tenantId: res.tenant.id,
        tenantSlug: res.tenant.slug,
        userId: res.owner.id,
        userName: res.owner.name,
        tenantRole: 'owner',
      };
      saveSession(session);
      window.location.hash = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card wide">
        <h1>Living Wiki</h1>
        <p className="muted">Create a workspace (tenant). An Inbox space and owner account are set up for you.</p>
        <form onSubmit={submit}>
          <label>Workspace name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>Slug<input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9-]+" required /></label>
          <label>Owner email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Owner name<input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required /></label>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
        </form>
      </div>
    </div>
  );
}
