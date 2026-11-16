import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, captureChanges, captures, tenantBilling, withTenantTx } from '@kinote/db';
import { agentCapture, useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { issueAgentToken, mcpRequest } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

describe('stop and undo an agent', () => {
  const k = useCaptureKit();

  async function agentWith(w: CaptureWorld) {
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Leaky agent' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'capture'] });
    return { agentId, token };
  }
  const changesOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, captureId)));

  test('stop and undo since a time', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const early = await agentCapture(w.tenant.id, a.agentId, 'George hero video is final.');
    await w.run();
    const hourAgo = new Date(Date.now() - 3_600_000);
    await withTenantTx(w.tenant.id, (tx) => tx.update(captures).set({ createdAt: new Date(hourAgo.getTime() - 60_000) }).where(eq(captures.id, early)));
    const late = await agentCapture(w.tenant.id, a.agentId, 'George launch moved to December.');
    await w.run();
    const queued = await agentCapture(w.tenant.id, a.agentId, 'George shop the look is live.');

    const res = await k.post(w.headers, `/api/v1/agents/${a.agentId}/stop`, { since: hourAgo.toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ undone: 1, changedSince: 0, captures: 2 });
    expect(res.json().agent.disabledAt).not.toBeNull();
    expect((await changesOf(w.tenant.id, late)).map((c) => c.status)).toEqual(['undone']);
    expect((await changesOf(w.tenant.id, early)).map((c) => c.status)).toEqual(['applied']);
    const [q] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, queued)));
    expect(q!.status).toBe('cancelled');
    await w.run();
    const [after] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, queued)));
    expect(after!.status).toBe('cancelled');
    expect((await mcpRequest(k.app, a.token, 'tools/list')).status).toBe(401);
  });

  test('a member cannot stop an agent', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    const res = await k.post(member.headers, `/api/v1/agents/${a.agentId}/stop`, { since: new Date(0).toISOString() });
    expect(res.statusCode).toBe(403);
  });

  test('stop works while suspended', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    await agentCapture(w.tenant.id, a.agentId, 'George launch moved to December.');
    await w.run();
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    const res = await k.post(w.headers, `/api/v1/agents/${a.agentId}/stop`, { since: new Date(0).toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ undone: 1, captures: 1 });
  });
});
