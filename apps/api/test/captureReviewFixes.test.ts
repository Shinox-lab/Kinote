import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, captureChanges, captureFacts, captures, spaceGrants, withTenantTx } from '@kinote/db';
import { routeCapture, type Actor } from '@kinote/core';
import { createCapture } from '../src/routes/captures.js';
import { applyCapturePreview } from '../src/routes/capturePreview.js';
import { agentCapture, useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

/** Fixes from the final review of the capture path. */
describe('capture path: review fixes', () => {
  const k = useCaptureKit();
  const row = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(captures).where(eq(captures.id, id))))[0]!;
  const ownerActor = (w: CaptureWorld): Actor => ({ tenantId: w.tenant.id, principalType: 'user', principalId: w.owner.userId, tenantRole: 'owner' });

  async function memberAgent(w: CaptureWorld) {
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const agentId = await createAgent(w.tenant.id, member.userId, { name: 'Member agent' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    return { member, agentId };
  }

  test("applying a preview never edits a space the owner can no longer edit", async () => {
    const w = await k.world();
    const { member, agentId } = await memberAgent(w);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.', { preview: true });
    await w.run();
    expect((await row(w.tenant.id, id)).status).toBe('previewed');
    await withTenantTx(w.tenant.id, (tx) =>
      tx.delete(spaceGrants).where(and(eq(spaceGrants.tenantId, w.tenant.id), eq(spaceGrants.principalId, member.userId)))
    );
    await applyCapturePreview({ tenantId: w.tenant.id, principalType: 'user', principalId: member.userId, tenantRole: 'member' }, id, {});
    await w.run();
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
    const facts = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, id)));
    expect(facts.map((f) => f.outcome)).not.toContain('applied');
  });

  test('a preview is used once: a document placed by a person later is created, and the plan is cleared', async () => {
    const w = await k.world();
    const made = await createCapture(ownerActor(w), { text: 'George kickoff\n- Hero video is final.\n- Shop the look.\n- Launch in December.' }, { preview: true });
    await w.run();
    const r = await row(w.tenant.id, made.id);
    const plan = { ...(r.previewPlan as object), document: { status: 'needs_home', reason: 'No place fits.', options: [] } };
    await withTenantTx(w.tenant.id, (tx) => tx.update(captures).set({ previewPlan: plan }).where(eq(captures.id, made.id)));
    await applyCapturePreview(ownerActor(w), made.id, {});
    await w.run();
    expect(await row(w.tenant.id, made.id)).toMatchObject({ documentOutcome: 'needs_home', previewPlan: null });
    const res = await k.post(w.headers, `/api/v1/captures/${made.id}/document/place`, { parent_page_id: w.george });
    expect(res.statusCode, res.body).toBe(200);
    await w.run();
    expect((await row(w.tenant.id, made.id)).documentOutcome).toBe('created');
  });

  test('a capture cancelled while it routes files nothing and stays cancelled', async () => {
    const w = await k.world();
    const { agentId } = await memberAgent(w);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    const result = await routeCapture(
      { tenantId: w.tenant.id, captureId: id, holder: 'test-run' },
      {
        model: k.model,
        embedder: k.embedder,
        collab: k.collab,
        hooks: {
          // Stopped mid-run: after planning, before anything is applied.
          afterPlan: async () => {
            await withTenantTx(w.tenant.id, (tx) => tx.update(captures).set({ status: 'cancelled' }).where(eq(captures.id, id)));
          },
        },
      }
    );
    expect(result).toBe('done');
    expect((await row(w.tenant.id, id)).status).toBe('cancelled');
    expect(await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, id)))).toEqual([]);
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('status checks do not use up the capture limit', async () => {
    const w = await k.world();
    const { agentId } = await memberAgent(w);
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'capture'] });
    const first = await callTool(k.app, token, 'kinote_capture', { text: 'George launch moved to December.' });
    const id = first.text.match(/^Capture ([0-9a-f]{8})/)![1]!;
    for (let i = 0; i < 12; i++) {
      expect((await callTool(k.app, token, 'kinote_capture_action', { capture_id: id, action: 'status' })).isError).toBe(false);
    }
    expect((await callTool(k.app, token, 'kinote_capture', { text: 'George hero video is final.' })).isError).toBe(false);
  });

  test('a preview never shows titles of pages the agent can no longer read', async () => {
    const w = await k.world();
    const { agentId } = await memberAgent(w);
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'capture'] });
    setTimeout(() => void w.run(), 50);
    const made = await callTool(k.app, token, 'kinote_capture', { text: 'George launch moved to December.', preview: true, wait: true });
    expect(made.text).toContain('Client - George');
    const id = made.text.match(/^Capture ([0-9a-f]{8})/)![1]!;
    await withTenantTx(w.tenant.id, (tx) =>
      tx.delete(spaceGrants).where(and(eq(spaceGrants.tenantId, w.tenant.id), eq(spaceGrants.principalId, agentId)))
    );
    const status = await callTool(k.app, token, 'kinote_capture_action', { capture_id: id, action: 'status' });
    expect(status.text).not.toContain('Client - George');
    expect(status.text).not.toContain('29Sep');
  });
});
