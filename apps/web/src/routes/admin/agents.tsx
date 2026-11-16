import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AGENT_SCOPES, type Agent, type AgentScope, type AgentToken, type SpaceResponse } from '@kinote/contracts';
import { api, errorMessage } from '../../lib/api.js';
import { useAgentSettings, useAgents, useRefresh, useSpaces } from '../../lib/queries.js';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { lastUsedLabel, tokenState } from '../../lib/sources.js';
import { relativeTime } from '../../lib/updates.js';
import { whenLabel } from '../../lib/history.js';
import { AgentTokenModal } from '../../components/AgentTokenModal.js';
import { Button, Checkbox, ErrorNote, Loading, SelectField, TextField } from '../../components/ui.js';

const DEFAULT_DAILY_AI = 100;

const SCOPE_LABELS: Record<AgentScope, { label: string; hint: string }> = {
  read: { label: 'Read', hint: 'Browse, search, read pages, see what relates, ask questions.' },
  capture: { label: 'Capture', hint: 'Send notes and facts to be placed in the wiki (arrives later).' },
  edit: { label: 'Edit', hint: 'Change pages within its grants (arrives later).' },
};

/** Spaces an agent may be granted: not the Inbox and not archived. */
const grantable = (spaces: readonly SpaceResponse[]) => spaces.filter((s) => s.kind !== 'inbox' && s.archivedAt === null);

/** The most recent use of any of the agent's tokens. */
function lastUsedOf(agent: Agent): string | null {
  let latest: string | null = null;
  for (const t of agent.tokens) if (t.lastUsedAt && (latest === null || t.lastUsedAt > latest)) latest = t.lastUsedAt;
  return latest;
}

function CreateAgentForm({ onCreated }: { onCreated: (agent: Agent) => void }) {
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createAgent({ name: name.trim() }),
    onSuccess: (agent) => {
      setName('');
      void refresh('agents');
      onCreated(agent);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-fg">Add an agent</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <TextField label="Agent name" value={name} onChange={setName} required hint="It belongs to you and never reaches more than you can." />
        </div>
        <Button type="submit" disabled={create.isPending || name.trim() === ''}>
          Add agent
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}

function GrantRow({ agent, space }: { agent: Agent; space: SpaceResponse }) {
  const refresh = useRefresh();
  const current = agent.grants.find((g) => g.spaceId === space.id)?.role ?? 'none';
  const change = useMutation({
    mutationFn: (role: 'none' | 'viewer' | 'editor') =>
      role === 'none'
        ? api.deleteGrant(space.id, 'agent', agent.id)
        : api.upsertGrant(space.id, { principal_type: 'agent', principal_id: agent.id, role }),
    onSuccess: () => refresh('agents'),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-1.5 text-sm">
      <span>{space.name}</span>
      <div className="w-36">
        <SelectField
          compact
          label={`Access to ${space.name}`}
          value={current}
          disabled={change.isPending}
          options={[
            { value: 'none', label: 'None' },
            { value: 'viewer', label: 'Viewer' },
            { value: 'editor', label: 'Editor' },
          ]}
          onChange={(role) => change.mutate(role)}
        />
      </div>
      <ErrorNote error={change.error} />
    </li>
  );
}

function TokenRow({ agent, token, now }: { agent: Agent; token: AgentToken; now: Date }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.revokeAgentToken(agent.id, token.id),
    onSuccess: () => {
      setConfirming(false);
      return refresh('agents');
    },
  });
  const state = tokenState(token, now);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
      <span className="min-w-32 font-medium">{token.name}</span>
      <span className="font-mono text-xs text-muted">{token.prefix}…</span>
      <span className="text-muted">{token.scopes.join(', ')}</span>
      <span className="text-muted">Created {relativeTime(token.createdAt, now)}</span>
      <span className="text-muted">{lastUsedLabel(token, now)}</span>
      <span className="text-muted">{token.expiresAt ? `Expires ${whenLabel(token.expiresAt)}` : 'Never expires'}</span>
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

function NewTokenForm({ agent, onIssued }: { agent: Agent; onIssued: (token: string) => void }) {
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<AgentScope[]>(['read']);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Not a mutation: its result would sit in the query cache with the secret in it.
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const expires = days.trim() === '' ? undefined : Number(days);
      const out = await api.issueAgentToken(agent.id, {
        name: name.trim(),
        scopes,
        ...(expires !== undefined && Number.isInteger(expires) && expires > 0 ? { expires_in_days: expires } : {}),
      });
      setName('');
      void refresh('agents');
      onIssued(out.token);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <TextField label="Token name" value={name} onChange={setName} required hint="Where it is used, e.g. “Claude Code on my laptop”." />
        </div>
        <div className="w-40">
          <TextField label="Expires in days" value={days} onChange={setDays} pattern="[0-9]*" hint="1 to 365." />
        </div>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">What it may do</legend>
        {AGENT_SCOPES.map((scope) => (
          <Checkbox
            key={scope}
            label={SCOPE_LABELS[scope].label}
            hint={SCOPE_LABELS[scope].hint}
            checked={scopes.includes(scope)}
            onChange={(on) => setScopes((s) => (on ? [...s, scope] : s.filter((x) => x !== scope)))}
          />
        ))}
      </fieldset>
      <div>
        <Button type="submit" disabled={busy || name.trim() === '' || scopes.length === 0}>
          New token
        </Button>
      </div>
      {error !== null && <p role="alert" className="w-full text-sm text-danger">{errorMessage(error)}</p>}
    </form>
  );
}

function AgentPanel({ agent, spaces, onIssued }: { agent: Agent; spaces: readonly SpaceResponse[]; onIssued: (agent: Agent, token: string) => void }) {
  const refresh = useRefresh();
  const [name, setName] = useState(agent.name);
  const [limit, setLimit] = useState(agent.dailyAiLimit === null ? '' : String(agent.dailyAiLimit));
  // Shown at once when ticked; the saved value takes over when the agent is loaded again.
  const [alwaysReview, setAlwaysReview] = useState(agent.alwaysReview);
  useEffect(() => setAlwaysReview(agent.alwaysReview), [agent.alwaysReview]);
  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateAgent>[1]) => api.updateAgent(agent.id, body),
    onSuccess: () => refresh('agents'),
  });
  const now = new Date();
  const limitValue = limit.trim() === '' ? null : Number(limit);
  const dirty = name.trim() !== agent.name || limitValue !== agent.dailyAiLimit;
  const lastUsed = lastUsedOf(agent);

  return (
    <section aria-label={`Agent ${agent.name}`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">{agent.name}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs ${agent.disabledAt === null ? 'bg-success-bg text-success' : 'bg-hover text-muted'}`}>
          {agent.disabledAt === null ? 'Active' : 'Disabled'}
        </span>
        <span className="text-sm text-muted">
          Owner {agent.owner.name}
          {agent.owner.role === null && <span className="text-warn-text"> (no longer in this workspace: its tokens cannot sign in)</span>} ·{' '}
          {lastUsed ? `Last used ${relativeTime(lastUsed, now)}` : 'Never used'}
        </span>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({
            ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
            ...(limitValue !== agent.dailyAiLimit ? { daily_ai_limit: limitValue } : {}),
          });
        }}
      >
        <div className="min-w-48 flex-1">
          <TextField label="Name" value={name} onChange={setName} required />
        </div>
        <div className="w-44">
          <TextField label="AI actions a day" value={limit} onChange={setLimit} pattern="[0-9]*" hint={`Empty: ${DEFAULT_DAILY_AI}.`} />
        </div>
        <Button type="submit" variant="secondary" disabled={!dirty || update.isPending || name.trim() === ''}>
          Save changes
        </Button>
      </form>

      <Checkbox
        label="Always review its changes"
        hint="Its captures wait for review even in spaces without review."
        checked={alwaysReview}
        disabled={update.isPending}
        onChange={(checked) => {
          setAlwaysReview(checked);
          update.mutate({ always_review: checked }, { onError: () => setAlwaysReview(agent.alwaysReview) });
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ disabled: agent.disabledAt === null })}>
          {agent.disabledAt === null ? 'Disable agent' : 'Enable agent'}
        </Button>
        {agent.disabledAt !== null && <span className="text-sm text-muted">A disabled agent's tokens cannot sign in.</span>}
      </div>
      <ErrorNote error={update.error} />

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Spaces</h3>
        <p className="text-xs text-muted">An agent sees only the spaces granted here, and only where its owner can also go.</p>
        <ul aria-label={`Spaces of ${agent.name}`} className="divide-y divide-line">
          {grantable(spaces).map((space) => (
            <GrantRow key={space.id} agent={agent} space={space} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Tokens</h3>
        {agent.tokens.length === 0 ? (
          <p className="text-sm text-muted">No tokens yet. An MCP client needs one to connect.</p>
        ) : (
          <ul aria-label={`Tokens of ${agent.name}`} className="divide-y divide-line">
            {agent.tokens.map((t) => (
              <TokenRow key={t.id} agent={agent} token={t} now={now} />
            ))}
          </ul>
        )}
        <NewTokenForm agent={agent} onIssued={(token) => onIssued(agent, token)} />
      </div>
    </section>
  );
}

/** The workspace's switch for agents answering routing questions themselves. */
function AgentSettingsForm() {
  const { data } = useAgentSettings();
  const refresh = useRefresh();
  const [mayAnswer, setMayAnswer] = useState<boolean | null>(null);
  useEffect(() => setMayAnswer(data?.agentsMayAnswer ?? null), [data?.agentsMayAnswer]);
  const save = useMutation({
    mutationFn: (agentsMayAnswer: boolean) => api.updateAgentSettings({ agents_may_answer: agentsMayAnswer }),
    onSuccess: () => refresh('agents', 'settings'),
    onError: () => setMayAnswer(data?.agentsMayAnswer ?? null),
  });
  if (!data || mayAnswer === null) return null;
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        label="Agents may answer routing questions"
        hint="Off: questions go to the agent's owner on the Capture page."
        checked={mayAnswer}
        disabled={save.isPending}
        onChange={(checked) => {
          setMayAnswer(checked);
          save.mutate(checked);
        }}
      />
      <ErrorNote error={save.error} />
    </div>
  );
}

/** `/w/$tenantSlug/admin/agents`: rows of agents, and the selected agent's grants and tokens in a docked pane. */
export function AgentsPage() {
  const { data: agents, error, isPending } = useAgents();
  const { data: spaces = [] } = useSpaces();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The one-time token, held only while its dialog is open.
  const [issued, setIssued] = useState<{ agentName: string; token: string } | null>(null);
  const wide = useMediaQuery('(min-width: 1200px)');
  const pane = useRef<HTMLDivElement>(null);
  const current = agents?.find((a) => a.id === selected) ?? null;
  const now = new Date();
  const paneOpen = creating || current !== null;
  const closePane = () => {
    setCreating(false);
    setSelected(null);
  };
  useFocusTrap(pane, !wide && paneOpen, closePane);
  useEffect(() => {
    if (wide || !paneOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [wide, paneOpen]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {agents?.length ?? 0} {agents?.length === 1 ? 'agent' : 'agents'}
        </p>
        <Button
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
          disabled={creating}
        >
          Add agent
        </Button>
      </div>
      <p className="text-xs text-muted">
        An agent is an AI tool, such as Claude Code, that reads this wiki over MCP with its own token, and can file what it learns through Capture, within the spaces you grant it. Members can also connect a client by signing in from it; that adds a read-only agent owned by them here.
      </p>
      <AgentSettingsForm />
      <ErrorNote error={error} />
      {isPending ? (
        <Loading what="agents" />
      ) : (
        <div className="grid gap-5 min-[1200px]:grid-cols-[minmax(0,1fr)_440px] min-[1200px]:items-start">
          <ul aria-label="Agents" className="flex flex-col">
            {agents?.length === 0 && !creating && <li className="py-2 text-sm text-muted">No agents yet.</li>}
            {agents?.map((agent) => {
              const active = agent.id === selected;
              const lastUsed = lastUsedOf(agent);
              return (
                <li key={agent.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setCreating(false);
                      setSelected(agent.id);
                    }}
                    className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-3 text-left max-md:min-h-11 ${active ? 'bg-active' : 'hover:bg-hover'}`}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`size-1.5 rounded-full ${agent.disabledAt === null ? 'bg-success' : 'bg-muted'}`} aria-hidden="true" />
                      <span className="text-sm font-medium text-fg">{agent.name}</span>
                      <span className="text-xs text-muted">{agent.owner.name}</span>
                    </span>
                    <span className="text-[10.5px] text-muted">
                      {agent.disabledAt === null ? 'Active' : 'Disabled'} · {lastUsed ? `Last used ${relativeTime(lastUsed, now)}` : 'Never used'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {(creating || current) && (
            <div
              ref={pane}
              role={wide ? undefined : 'dialog'}
              aria-modal={wide ? undefined : 'true'}
              aria-label={creating ? 'Add an agent' : 'Agent settings'}
              tabIndex={-1}
              className="fixed inset-0 z-30 overflow-y-auto bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none min-[1200px]:static min-[1200px]:z-auto min-[1200px]:rounded-lg min-[1200px]:border min-[1200px]:border-line min-[1200px]:p-4"
            >
              <button
                type="button"
                onClick={closePane}
                className="mb-3 rounded-md px-1 py-1 text-xs font-medium text-accent-text hover:underline min-[1200px]:hidden"
              >
                Close
              </button>
              {creating ? (
                <CreateAgentForm
                  onCreated={(agent) => {
                    setCreating(false);
                    setSelected(agent.id);
                  }}
                />
              ) : current ? (
                <AgentPanel key={current.id} agent={current} spaces={spaces} onIssued={(agent, token) => setIssued({ agentName: agent.name, token })} />
              ) : null}
            </div>
          )}
        </div>
      )}
      {issued && <AgentTokenModal agentName={issued.agentName} token={issued.token} onClose={() => setIssued(null)} />}
    </div>
  );
}
