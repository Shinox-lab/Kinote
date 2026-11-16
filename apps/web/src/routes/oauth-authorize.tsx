import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { OAuthAuthorizeParams } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { loadSession } from '../lib/session.js';
import { AuthShell, Button, Checkbox, ErrorNote, Loading, SelectField, TextField } from '../components/ui.js';

const PARAM_NAMES = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
  'state',
] as const;

/** The authorization request exactly as the app sent it: read from the address bar, never re-parsed by the router. */
function requestParams(): OAuthAuthorizeParams {
  const query = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const name of PARAM_NAMES) {
    const v = query.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Leaves for the app's redirect address (a localhost page, an https page or the app's own scheme). */
const leaveFor = (to: string) => window.location.assign(to);

/**
 * Browser sign-in for an MCP client (OAuth): the member picks a workspace, names the agent, picks the spaces it may
 * read, and allows or cancels. Allowing returns a one-time code to the app; the agent is created when the app
 * exchanges it, owned by this member and never able to read more than they can.
 */
export function OAuthAuthorizePage() {
  const params = useMemo(requestParams, []);
  const session = loadSession();
  const check = useQuery({
    queryKey: ['oauth-authorize', params],
    queryFn: () => api.oauthCheck(params),
    retry: false,
    staleTime: Infinity,
  });
  const ask = check.data?.status === 'ask' ? check.data : null;

  const [tenantId, setTenantId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  // Filing captures is opt-in, and offered only when the app asked for it.
  const [capture, setCapture] = useState(false);
  useEffect(() => {
    if (!ask) return;
    const preferred = ask.workspaces.find((w) => w.tenantId === session?.tenantId) ?? ask.workspaces[0];
    setTenantId((t) => t || preferred?.tenantId || '');
    setAgentName((n) => n || ask.client.name.slice(0, 80));
  }, [ask, session?.tenantId]);

  const workspace = ask?.workspaces.find((w) => w.tenantId === tenantId);
  const decide = useMutation({
    mutationFn: (decision: 'allow' | 'deny') =>
      api.oauthDecide(
        params,
        decision === 'allow'
          ? { decision, tenant_id: tenantId, agent_name: agentName.trim(), space_ids: spaceIds, capture }
          : { decision }
      ),
    onSuccess: ({ to }) => leaveFor(to),
  });

  if (check.isPending) {
    return (
      <AuthShell title="Connect an app">
        <Loading what="the sign-in" />
      </AuthShell>
    );
  }
  if (check.error || !check.data) {
    return (
      <AuthShell title="Connect an app">
        <ErrorNote error={check.error} />
      </AuthShell>
    );
  }
  if (check.data.status === 'redirect') {
    // Never followed on its own: anyone can register an app, so an error must not bounce the browser to its address
    // without the person seeing where it goes (RFC 9700, section 4.11.2).
    const back = new URL(check.data.to);
    return (
      <AuthShell title="Connect an app">
        <div className="flex flex-col gap-3">
          <p role="alert" className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            This sign-in request is not valid ({back.searchParams.get('error_description') ?? back.searchParams.get('error')}).
          </p>
          <p className="text-xs text-muted">
            The app asked to return to <code className="break-all">{check.data.to.split('?')[0]}</code>.
          </p>
          <a href={check.data.to} className="text-sm font-medium text-accent-text underline">
            Return to the app
          </a>
        </div>
      </AuthShell>
    );
  }
  if (!ask || decide.isSuccess) {
    return (
      <AuthShell title="Connect an app">
        <p role="status" className="text-sm text-fg">
          Returning to the app. You can close this tab once the app says it is connected.
        </p>
      </AuthShell>
    );
  }

  const toggle = (id: string, on: boolean) => setSpaceIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const canAllow = workspace !== undefined && spaceIds.length > 0 && agentName.trim() !== '' && !decide.isPending;

  return (
    <AuthShell title={`Connect ${ask.client.name}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAllow) decide.mutate('allow');
        }}
      >
        <p className="text-sm text-fg">
          <strong>{ask.client.name}</strong> wants to {ask.scopes.includes('capture') ? 'read and add to' : 'read'} your Kinote
          wiki as an agent. Allow it only if you just started this sign-in from that app.
        </p>
        <p className="text-xs text-muted">
          The app chose its own name; Kinote has not checked it. After you answer, your browser returns to{' '}
          <code className="break-all">{ask.client.redirectUri}</code>.
        </p>

        {ask.workspaces.length === 0 ? (
          <p className="text-sm text-fg">You are not a member of any workspace yet.</p>
        ) : (
          <>
            {ask.workspaces.length > 1 ? (
              <SelectField
                label="Workspace"
                value={tenantId}
                options={ask.workspaces.map((w) => ({ value: w.tenantId, label: w.name }))}
                onChange={(id) => {
                  setTenantId(id);
                  setSpaceIds([]);
                }}
              />
            ) : (
              <p className="text-sm">
                Workspace: <strong>{workspace?.name}</strong>
              </p>
            )}
            <TextField
              label="Agent name"
              value={agentName}
              onChange={setAgentName}
              required
              hint="How the agent appears in page history, the audit log and Settings → Agents."
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{capture ? 'Spaces it can read and file into' : 'Spaces it can read'}</legend>
              {workspace && workspace.spaces.length > 0 ? (
                workspace.spaces.map((s) => (
                  <Checkbox key={s.id} label={s.name} checked={spaceIds.includes(s.id)} onChange={(on) => toggle(s.id, on)} />
                ))
              ) : (
                <p className="text-sm text-muted">You can't read any spaces in this workspace.</p>
              )}
            </fieldset>
            {ask.scopes.includes('capture') && (
              <Checkbox
                label="Also let it file what it learns (Capture)"
                hint="It sends notes and facts that routing files into these spaces, with a receipt and Undo. Its changes wait for review until an admin switches that off. It can file only where you can edit."
                checked={capture}
                onChange={setCapture}
              />
            )}
            <p className="text-xs text-muted">
              {capture
                ? 'It can browse, search and read these spaces, ask questions, and file captures; it never reaches more than you can.'
                : "Read only: it can browse, search and read these spaces and ask questions about them, but it can't change anything, and it never sees more than you can."}{' '}
              Revoke it any time in Settings → Agents.
            </p>
          </>
        )}

        <ErrorNote error={decide.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={!canAllow}>
            {decide.isPending ? 'Allowing…' : 'Allow'}
          </Button>
          <Button variant="secondary" onClick={() => decide.mutate('deny')} disabled={decide.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
