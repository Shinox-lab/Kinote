import { describe, test, expect } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { agents, auditEvents, versions, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callToolFull, issueAgentToken, listToolNames, mcpRequest } from './support/mcpkit.js';
import { createAgent } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** kinote_review (model-visible) and the panel's app-only kinote_review_list / kinote_review_decide. */
describe('kinote_review', () => {
  const k = useCaptureKit();

  async function setup(w: CaptureWorld, opts: { approveInClient?: boolean } = {}) {
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(agents).set({ alwaysReview: true, approveInClient: opts.approveInClient ?? true }).where(eq(agents.id, agentId))
    );
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    const call = (name: string, args: object = {}) => callToolFull(k.app, token, name, args);
    await call('kinote_edit', { page_id: short(w.george), edits: [{ after_block_id: null, markdown: 'Launch moved to December.' }] });
    await call('kinote_delete', { page_id: short(w.sep29), reason: 'Merged into George.' });
    const [v] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(versions).where(and(eq(versions.documentId, w.george), eq(versions.status, 'pending_review')))
    );
    return { agentId, token, call, version: v! };
  }

  test('lists the items as text and names the panel', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_review');
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain('• version on "Client - George" by Docs bot');
    expect(res.text).toContain('• archive on "29Sep" by Docs bot — Merged into George.');
    expect(res.text).toContain('Kinote opened a review panel for your user.');
    expect(res.structured).toEqual({ page_id: null, mine_only: false });
  });

  test('review_list answers the items as the owner', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_review_list', {});
    const out = res.structured as { items: Array<{ type: string }>; can_decide_here: boolean };
    expect(out.items.map((i) => i.type).sort()).toEqual(['suggestion', 'version']);
    expect(out.can_decide_here).toBe(true);
  });

  test('decide approves a version as the owner', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_review_decide', { type: 'version', id: s.version.id, decision: 'approve' });
    expect(res.structured).toMatchObject({ ok: true });
    const [v] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, s.version.id)));
    expect(v!.status).not.toBe('pending_review');
    expect(v!.reviewedBy).toBe(w.owner.userId);
    const [audit] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.type, 'review.decided_in_client')).orderBy(desc(auditEvents.createdAt))
    );
    expect(audit).toMatchObject({ actorType: 'user', actorId: w.owner.userId, payload: { via: 'mcp_app', agentId: s.agentId } });
  });

  test('with approve_in_client off, decide is refused and the panel cannot decide', async () => {
    const w = await k.world();
    const s = await setup(w, { approveInClient: false });
    const list = await s.call('kinote_review_list', {});
    expect((list.structured as { can_decide_here: boolean }).can_decide_here).toBe(false);
    const res = await s.call('kinote_review_decide', { type: 'version', id: s.version.id, decision: 'approve' });
    // The test app has no PUBLIC_URL, so the link is the page's name.
    expect(res.structured).toEqual({ ok: false, message: 'Approve this in Kinote: its Reviews page.' });
    const [v] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, s.version.id)));
    expect(v!.status).toBe('pending_review');
  });

  test('the review tools are app-only, kinote_review shows the panel', async () => {
    const w = await k.world();
    const s = await setup(w);
    expect(await listToolNames(k.app, s.token)).toEqual(expect.arrayContaining(['kinote_review', 'kinote_review_decide', 'kinote_review_list']));
    const res = await mcpRequest(k.app, s.token, 'tools/list');
    const tools = res.body.result.tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }>;
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta;
    expect(meta('kinote_review')).toEqual({ ui: { resourceUri: 'ui://kinote/review' } });
    expect(meta('kinote_review_list')).toEqual({ ui: { visibility: ['app'] } });
    expect(meta('kinote_review_decide')).toEqual({ ui: { visibility: ['app'] } });
  });
});
