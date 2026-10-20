import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Source, SourceToken, SpaceResponse } from '@living-wiki/contracts';
import { api, errorMessage } from '../../lib/api.js';
import { useRefresh, useSources, useSpaces } from '../../lib/queries.js';
import { lastUsedLabel, sourceStatusLabel, tokenState } from '../../lib/sources.js';
import { relativeTime } from '../../lib/updates.js';
import { whenLabel } from '../../lib/history.js';
import { SourceTokenModal } from '../../components/SourceTokenModal.js';
import { Button, Card, Checkbox, ErrorNote, Loading, SelectField, TextField } from '../../components/ui.js';

const TRUSTED_HINT =
  'Files from this source skip review unless the space requires it. Leave off unless you control what the script sends. Applies to files read from now on.';

/** Spaces a script may deliver into: not the Inbox (it belongs to one person) and not archived. */
const targets = (spaces: readonly SpaceResponse[]) => spaces.filter((s) => s.kind !== 'inbox' && s.archivedAt === null);

function CreateSourceForm({ spaces }: { spaces: readonly SpaceResponse[] }) {
  const refresh = useRefresh();
  const options = targets(spaces);
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const chosen = options.some((s) => s.id === spaceId) ? spaceId : (options[0]?.id ?? '');
  const create = useMutation({
    mutationFn: () => api.createSource({ name: name.trim(), target_space_id: chosen }),
    onSuccess: () => {
      setName('');
      return refresh('sources');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Add a source">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <TextField label="Source name" value={name} onChange={setName} required hint="Shown to people as “System · name” on the files it sends." />
          </div>
          <div className="min-w-56">
            <SelectField label="Files go to space" value={chosen} options={options.map((s) => ({ value: s.id, label: s.name }))} onChange={setSpaceId} />
          </div>
          <Button type="submit" disabled={create.isPending || name.trim() === '' || chosen === ''}>
            Add source
          </Button>
        </div>
        {options.length === 0 && <p className="text-sm text-muted">Create a space first: a source cannot deliver into the Inbox.</p>}
        <ErrorNote error={create.error} />
      </form>
    </Card>
  );
}

function TokenRow({ source, token, now }: { source: Source; token: SourceToken; now: Date }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.revokeSourceToken(source.id, token.id),
    onSuccess: () => {
      setConfirming(false);
      return refresh('sources');
    },
  });
  const state = tokenState(token, now);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
      <span className="min-w-32 font-medium">{token.name}</span>
      <span className="font-mono text-xs text-muted">{token.prefix}…</span>
      <span className="text-muted">Created {relativeTime(token.createdAt, now)}</span>
      <span className="text-muted">{lastUsedLabel(token, now)}</span>
      <span className="text-muted">{token.expiresAt ? `Expires ${whenLabel(token.expiresAt)}` : 'No expiry'}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${state === 'active' ? 'bg-success-bg text-success' : 'bg-hover text-muted'}`}
        aria-label={`Token ${token.name} is ${state}`}
      >
        {state === 'active' ? 'Active' : state === 'revoked' ? 'Revoked' : 'Expired'}
      </span>
      {state === 'active' &&
        (confirming ? (
          <span className="flex items-center gap-2">
            <Button variant="danger" onClick={() => revoke.mutate()} disabled={revoke.isPending} aria-label={`Confirm revoking ${token.name}`}>
              Revoke now
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)} aria-label={`Revoke ${token.name}`}>
            Revoke
          </Button>
        ))}
      <ErrorNote error={revoke.error} />
    </li>
  );
}

function NewTokenForm({ source, onIssued }: { source: Source; onIssued: (token: string) => void }) {
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Not a mutation: its result would sit in the query cache with the secret in it.
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const expires = days.trim() === '' ? undefined : Number(days);
      const out = await api.issueSourceToken(source.id, {
        name: name.trim(),
        ...(expires !== undefined && Number.isInteger(expires) && expires > 0 ? { expires_in_days: expires } : {}),
      });
      setName('');
      setDays('');
      void refresh('sources');
      onIssued(out.token);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="min-w-48 flex-1">
        <TextField label="Token name" value={name} onChange={setName} required />
      </div>
      <div className="w-40">
        <TextField label="Expires in days" value={days} onChange={setDays} pattern="[0-9]*" hint="Leave empty for no expiry." />
      </div>
      <Button type="submit" disabled={busy || name.trim() === ''}>
        New token
      </Button>
      {error !== null && <p role="alert" className="w-full text-sm text-danger">{errorMessage(error)}</p>}
    </form>
  );
}

function SourcePanel({ source, spaces, onIssued }: { source: Source; spaces: readonly SpaceResponse[]; onIssued: (source: Source, token: string) => void }) {
  const refresh = useRefresh();
  const options = targets(spaces);
  const [name, setName] = useState(source.name);
  const [spaceId, setSpaceId] = useState(source.targetSpaceId);
  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateSource>[1]) => api.updateSource(source.id, body),
    onSuccess: () => refresh('sources'),
  });
  const now = new Date();
  const dirty = name.trim() !== source.name || spaceId !== source.targetSpaceId;
  // The space it delivers to now may be archived or the Inbox of nobody: keep it selectable so the form shows the truth.
  const spaceOptions = options.some((s) => s.id === source.targetSpaceId)
    ? options.map((s) => ({ value: s.id, label: s.name }))
    : [{ value: source.targetSpaceId, label: source.targetSpaceName }, ...options.map((s) => ({ value: s.id, label: s.name }))];

  return (
    <li>
      <Card>
        <section aria-label={`Source ${source.name}`} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-base font-semibold">{source.name}</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs ${source.status === 'active' ? 'bg-success-bg text-success' : 'bg-hover text-muted'}`}>
              {sourceStatusLabel(source)}
            </span>
            <span className="text-sm text-muted">
              Delivers to {source.targetSpaceName} · {source.itemCount} {source.itemCount === 1 ? 'file' : 'files'} ·{' '}
              {source.lastSyncAt ? `Last sync ${relativeTime(source.lastSyncAt, now)}` : 'Never synced'} · {source.trusted ? 'Trusted' : 'Not trusted'}
            </span>
          </div>

          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({
                ...(name.trim() !== source.name ? { name: name.trim() } : {}),
                ...(spaceId !== source.targetSpaceId ? { target_space_id: spaceId } : {}),
              });
            }}
          >
            <div className="min-w-48 flex-1">
              <TextField label="Name" value={name} onChange={setName} required />
            </div>
            <div className="min-w-48">
              <SelectField label="Delivers to space" value={spaceId} options={spaceOptions} onChange={setSpaceId} />
            </div>
            <Button type="submit" variant="secondary" disabled={!dirty || update.isPending || name.trim() === ''}>
              Save changes
            </Button>
          </form>
          <p className="-mt-2 text-xs text-muted">A new space receives files sent from now on; files already here stay where they are.</p>

          <div className="flex flex-col gap-1">
            <Checkbox label="Trusted" checked={source.trusted} disabled={update.isPending} onChange={(trusted) => update.mutate({ trusted })} />
            <p className="text-xs text-muted">{TRUSTED_HINT}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: source.status === 'active' ? 'paused' : 'active' })}
            >
              {source.status === 'active' ? 'Pause source' : 'Resume source'}
            </Button>
            {source.status === 'paused' && <span className="text-sm text-muted">A paused source refuses everything its scripts send.</span>}
          </div>
          <ErrorNote error={update.error} />

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Tokens</h3>
            {source.tokens.length === 0 ? (
              <p className="text-sm text-muted">No tokens yet. A script needs one to send files.</p>
            ) : (
              <ul aria-label={`Tokens of ${source.name}`} className="divide-y divide-line">
                {source.tokens.map((t) => (
                  <TokenRow key={t.id} source={source} token={t} now={now} />
                ))}
              </ul>
            )}
            <NewTokenForm source={source} onIssued={(token) => onIssued(source, token)} />
          </div>
        </section>
      </Card>
    </li>
  );
}

/** `/w/$tenantSlug/admin/sources`: the scripts that send files here, and the tokens they use. */
export function SourcesPage() {
  const { data: sources, error, isPending } = useSources();
  const { data: spaces = [] } = useSpaces();
  // The one-time token, held only while its dialog is open.
  const [issued, setIssued] = useState<{ sourceName: string; token: string } | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        A source is a script or tool that sends files into one space through the upload API. Each source has its own tokens.
      </p>
      <CreateSourceForm spaces={spaces} />
      <ErrorNote error={error} />
      {isPending ? (
        <Loading what="sources" />
      ) : sources && sources.length === 0 ? (
        <p className="text-sm text-muted">No sources yet.</p>
      ) : (
        <ul aria-label="Sources" className="flex flex-col gap-4">
          {sources?.map((s) => (
            <SourcePanel key={s.id} source={s} spaces={spaces} onIssued={(src, token) => setIssued({ sourceName: src.name, token })} />
          ))}
        </ul>
      )}
      {issued && <SourceTokenModal sourceName={issued.sourceName} token={issued.token} onClose={() => setIssued(null)} />}
    </div>
  );
}
