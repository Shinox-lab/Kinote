import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, captureFacts, captureMessages, captures, jobs, withTenantTx } from '@kinote/db';
import { answerCapture } from '../src/routes/captures.js';
import { agentCapture, useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { createAgent, signUpMember } from './support/testkit.js';

describe("an agent's owner and its captures", () => {
  const k = useCaptureKit();

  async function agentOf(w: CaptureWorld, ownerId: string) {
    const agentId = await createAgent(w.tenant.id, ownerId, { name: 'Test agent' });
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    return agentId;
  }

  /** An engine question on the capture with one waiting fact (routing's own questions need entity fixtures). */
  async function question(tenantId: string, captureId: string) {
    const choice = '00000000-0000-4000-8000-000000000001';
    const id = await withTenantTx(tenantId, async (tx) => {
      const [q] = await tx
        .insert(captureMessages)
        .values({ tenantId, captureId, author: 'engine', body: 'Which Acme?', options: [{ entityId: choice, label: 'Acme Corp' }] })
        .returning();
      await tx.insert(captureFacts).values({ tenantId, captureId, ordinal: 0, statement: 'Acme renewed.', kind: 'new', waitingQuestionId: q!.id });
      await tx.update(captures).set({ status: 'waiting_for_answer' }).where(eq(captures.id, captureId));
      await tx.delete(jobs);
      return q!.id;
    });
    return { id, choice };
  }

  test("an owner lists and opens their agent's capture; another member does not", async () => {
    const w = await k.world();
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    const agentId = await agentOf(w, member.userId);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    const mine = (await k.get(member.headers, '/api/v1/captures')).json() as Array<{ id: string; senderType: string; senderName: string }>;
    expect(mine.find((c) => c.id === id)).toMatchObject({ senderType: 'agent', senderName: 'Test agent' });
    expect((await k.get(member.headers, `/api/v1/captures/${id}`)).statusCode).toBe(200);

    const other = await signUpMember(k.app, w.tenant.id, 'member');
    expect(((await k.get(other.headers, '/api/v1/captures')).json() as Array<{ id: string }>).map((c) => c.id)).not.toContain(id);
    expect((await k.get(other.headers, `/api/v1/captures/${id}`)).statusCode).toBe(404);
  });

  test("the owner answers the agent's routing question", async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId);
    const id = await agentCapture(w.tenant.id, agentId, 'Acme renewed.');
    const q = await question(w.tenant.id, id);
    const res = await k.post(w.headers, `/api/v1/captures/${id}/answer`, { message_id: q.id, choice: q.choice });
    expect(res.statusCode, res.body).toBe(200);
    const [fact] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, id)));
    expect(fact).toMatchObject({ outcome: 'pending', waitingQuestionId: null });
  });

  test('an agent answers only when the workspace allows it', async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId);
    const id = await agentCapture(w.tenant.id, agentId, 'Acme renewed.');
    const q = await question(w.tenant.id, id);
    const agent = { tenantId: w.tenant.id, principalType: 'agent' as const, principalId: agentId, owner: { userId: w.owner.userId, tenantRole: 'owner' as const } };
    await expect(answerCapture(agent, id, { message_id: q.id, choice: q.choice })).rejects.toMatchObject({
      code: 'forbidden',
      message: "In this workspace only people answer routing questions; the question is on your owner's Capture page.",
    });
    expect((await k.patch(w.headers, '/api/v1/agents/settings', { agents_may_answer: true })).statusCode).toBe(200);
    const detail = await answerCapture(agent, id, { message_id: q.id, choice: q.choice });
    expect(detail.thread.map((m) => m.author)).toEqual(['engine', 'sender']);
  });

  test("an owner places their agent's Needs-a-home fact; another member does not see it", async () => {
    const w = await k.world();
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const agentId = await agentOf(w, member.userId);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    const id = await agentCapture(w.tenant.id, agentId, 'Zebras migrate in spring.');
    await w.run();
    const list = (await k.get(member.headers, '/api/v1/needs-home')).json() as Array<{ factId: string; captureId: string }>;
    const item = list.find((i) => i.captureId === id)!;
    expect(item).toBeDefined();
    const other = await signUpMember(k.app, w.tenant.id, 'member');
    expect(((await k.get(other.headers, '/api/v1/needs-home')).json() as Array<{ captureId: string }>).map((i) => i.captureId)).not.toContain(id);
    const placed = await k.post(member.headers, `/api/v1/capture-facts/${item.factId}/place`, { document_id: w.sep29 });
    expect(placed.statusCode, placed.body).toBe(200);
  });

  test('agent settings', async () => {
    const w = await k.world();
    expect((await k.get(w.headers, '/api/v1/agents/settings')).json()).toEqual({ agentsMayAnswer: false });
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    expect((await k.get(member.headers, '/api/v1/agents/settings')).statusCode).toBe(403);
    expect((await k.patch(member.headers, '/api/v1/agents/settings', { agents_may_answer: true })).statusCode).toBe(403);
    const res = await k.patch(w.headers, '/api/v1/agents/settings', { agents_may_answer: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ agentsMayAnswer: true });
    expect((await k.get(w.headers, '/api/v1/agents/settings')).json()).toEqual({ agentsMayAnswer: true });
  });
});
