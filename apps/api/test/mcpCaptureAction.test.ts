import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, captureChanges, captureFacts, captureMessages, captures, jobs, tenantBilling, withTenantTx } from '@kinote/db';
import { agentCapture, useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken, mcpRequest } from './support/mcpkit.js';
import { estimateTokens } from '@kinote/core';
import { createAgent } from './support/testkit.js';

const id8 = (uuid: string) => uuid.replaceAll('-', '').slice(0, 8);

describe('kinote_capture_action', () => {
  const k = useCaptureKit();

  async function agentWith(w: CaptureWorld, name = 'Test agent') {
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'capture'] });
    return { agentId, token };
  }
  const act = (token: string, args: object) => callTool(k.app, token, 'kinote_capture_action', args);
  const changesOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, captureId)));
  const factsOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, captureId)).orderBy(captureFacts.ordinal));

  test('a read and capture token shows the model nine tools within 2,000 tokens', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const res = await mcpRequest(k.app, a.token, 'tools/list');
    const all = res.body.result.tools as Array<{ name: string; _meta?: { ui?: { visibility?: string[] } } }>;
    // The file panel's own tools are app-only: an MCP Apps host does not show them to the model.
    const tools = all.filter((t) => !(t._meta?.ui?.visibility && !t._meta.ui.visibility.includes('model')));
    expect(tools.map((t) => t.name)).toEqual([
      'kinote_browse',
      'kinote_search',
      'kinote_read',
      'kinote_related',
      'kinote_ask',
      'kinote_review',
      'kinote_capture',
      'kinote_capture_action',
      'kinote_upload',
    ]);
    // Annotations are for the host's approval defaults, not the model's prompt: not counted.
    const total = tools.reduce((n, t) => n + estimateTokens(JSON.stringify({ ...t, annotations: undefined })), 0);
    expect(total).toBeLessThan(2000);
  });

  test('status shows the receipt', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const id = await agentCapture(w.tenant.id, a.agentId, 'George launch moved to December.');
    await w.run();
    const res = await act(a.token, { capture_id: id8(id), action: 'status' });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(new RegExp(`^Capture ${id8(id)} · done`));
    expect(res.text).toMatch(/- applied · Client - George/);
  });

  test('undo all, then undo one', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const first = await agentCapture(w.tenant.id, a.agentId, 'George launch moved to December.');
    const second = await agentCapture(w.tenant.id, a.agentId, 'George hero video is final.');
    await w.run();
    const all = await act(a.token, { capture_id: first, action: 'undo' });
    expect(all.text.split('\n')[0]).toBe('Undone: 1 change; 0 left because someone changed them since.');
    const [change] = await changesOf(w.tenant.id, second);
    const one = await act(a.token, { capture_id: second, action: 'undo', change_id: id8(change!.id) });
    expect(one.isError, one.text).toBe(false);
    expect((await changesOf(w.tenant.id, second))[0]!.status).toBe('undone');
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('move a change', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const id = await agentCapture(w.tenant.id, a.agentId, 'George hero video is final.');
    await w.run();
    const [change] = await changesOf(w.tenant.id, id);
    const res = await act(a.token, { capture_id: id, action: 'move', change_id: change!.id, page_id: id8(w.sep29) });
    expect(res.text.split('\n')[0]).toBe(`Moved change ${id8(change!.id)} to ${id8(w.sep29)}; it is filed there when routing finishes.`);
    await w.run();
    expect(await k.pageText(w.tenant.id, w.sep29)).toContain('hero video is final');
    expect((await act(a.token, { capture_id: id, action: 'move' })).text).toBe('move needs change_id and page_id.');
  });

  test('apply with skip and place, and cancel', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    setTimeout(() => void w.run(), 50);
    const made = await callTool(k.app, a.token, 'kinote_capture', {
      text: 'George launch moved to December. George hero video is final.',
      preview: true,
      wait: true,
    });
    const id = made.text.match(/^Capture ([0-9a-f]{8})/)![1]!;
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures));
    const [f1, f2] = await factsOf(w.tenant.id, row!.id);
    const res = await act(a.token, { capture_id: id, action: 'apply', skip: [id8(f1!.id)], place: [{ fact_id: id8(f2!.id), page_id: id8(w.sep29) }] });
    expect(res.text.split('\n')[0]).toBe('Applying the preview; it files when routing finishes.');
    await w.run();
    const [a1, a2] = await factsOf(w.tenant.id, row!.id);
    expect([a1!.outcome, a2!.outcome]).toEqual(['dismissed', 'applied']);

    setTimeout(() => void w.run(), 50);
    const other = await callTool(k.app, a.token, 'kinote_capture', { text: 'George launch moved to December.', preview: true, wait: true });
    const otherId = other.text.match(/^Capture ([0-9a-f]{8})/)![1]!;
    const cancelled = await act(a.token, { capture_id: otherId, action: 'cancel' });
    expect(cancelled.text.split('\n')[0]).toBe('Cancelled; nothing was filed.');
    expect(await act(a.token, { capture_id: otherId, action: 'apply' })).toEqual({ isError: true, text: 'This capture has no preview waiting.' });
  });

  test('answer needs the workspace setting', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const id = await agentCapture(w.tenant.id, a.agentId, 'Acme renewed.');
    const choice = '00000000-0000-4000-8000-0000000000aa';
    const questionId = await withTenantTx(w.tenant.id, async (tx) => {
      const [q] = await tx
        .insert(captureMessages)
        .values({ tenantId: w.tenant.id, captureId: id, author: 'engine', body: 'Which Acme?', options: [{ entityId: choice, label: 'Acme Corp' }] })
        .returning();
      await tx.insert(captureFacts).values({ tenantId: w.tenant.id, captureId: id, ordinal: 0, statement: 'Acme renewed.', kind: 'new', waitingQuestionId: q!.id });
      await tx.update(captures).set({ status: 'waiting_for_answer' }).where(eq(captures.id, id));
      await tx.delete(jobs);
      return q!.id;
    });
    const status = await act(a.token, { capture_id: id, action: 'status' });
    expect(status.text).toContain(`question ${id8(questionId)}: Which Acme? — choices: Acme Corp (${id8(choice)})`);
    const args = { capture_id: id, action: 'answer', question_id: id8(questionId), choice: id8(choice) };
    expect(await act(a.token, args)).toEqual({
      isError: true,
      text: "In this workspace only people answer routing questions; the question is on your owner's Capture page.",
    });
    await k.patch(w.headers, '/api/v1/agents/settings', { agents_may_answer: true });
    const ok = await act(a.token, args);
    expect(ok.text.split('\n')[0]).toBe('Answered; routing continues.');
  });

  test('an agent acts only on its own captures', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const b = await agentWith(w, 'Other agent');
    const owners = (await k.post(w.headers, '/api/v1/captures', { text: 'George launch moved to December.' })).json().id as string;
    const others = await agentCapture(w.tenant.id, b.agentId, 'George hero video is final.');
    for (const id of [owners, others]) {
      expect(await act(a.token, { capture_id: id8(id), action: 'status' })).toEqual({
        isError: true,
        text: `No capture "${id8(id)}" sent by this agent.`,
      });
    }
  });

  test('writes are refused while suspended; status is not', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const id = await agentCapture(w.tenant.id, a.agentId, 'George launch moved to December.');
    await w.run();
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    expect((await act(a.token, { capture_id: id, action: 'status' })).isError).toBe(false);
    expect(await act(a.token, { capture_id: id, action: 'undo' })).toEqual({
      isError: true,
      text: 'This workspace is suspended for billing; it is read-only until the plan is renewed.',
    });
  });
});
