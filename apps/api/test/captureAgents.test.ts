import { describe, test, expect } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { agents, captureFacts, captures, versions, withTenantTx } from '@kinote/db';
import { agentCapture, useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { createAgent, signUpMember } from './support/testkit.js';

describe('captures sent by agents', () => {
  const k = useCaptureKit();

  async function agentOf(w: CaptureWorld, ownerId: string, role: 'editor' | 'viewer' = 'editor', alwaysReview?: boolean) {
    const agentId = await createAgent(w.tenant.id, ownerId, { name: 'Test agent' });
    if (alwaysReview !== undefined) {
      await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview }).where(eq(agents.id, agentId)));
    }
    const res = await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role });
    expect(res.statusCode, res.body).toBe(201);
    return agentId;
  }
  const factsOf = (tenantId: string, captureId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, captureId)));
  const captureRow = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(captures).where(eq(captures.id, id))))[0]!;

  test("routing caps an agent at its owner's reach at routing time", async () => {
    const w = await k.world();
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'viewer' });
    const agentId = await agentOf(w, member.userId, 'editor', false);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    await w.run();
    expect(await k.pageText(w.tenant.id, w.george)).toContain('November');
    const facts = await factsOf(w.tenant.id, id);
    expect(facts.map((f) => f.outcome)).not.toContain('applied');
    expect(facts.map((f) => f.outcome)).toContain('suggested');
  });

  test("a disabled agent's capture fails", async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId, 'editor', false);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ disabledAt: new Date() }).where(eq(agents.id, agentId)));
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    await w.run();
    expect(await captureRow(w.tenant.id, id)).toMatchObject({
      status: 'failed',
      error: 'The agent that sent this is disabled or its owner left the workspace.',
    });
  });

  test("an always-review agent's change waits for review in a space without review", async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    await w.run();
    expect((await factsOf(w.tenant.id, id)).map((f) => f.outcome)).toEqual(['waiting_review']);
    const [latest] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(versions).where(and(eq(versions.documentId, w.george))).orderBy(desc(versions.createdAt)).limit(1)
    );
    expect(latest!.status).toBe('pending_review');
  });

  test('with always_review off, the same change is applied', async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId);
    const res = await k.patch(w.headers, `/api/v1/agents/${agentId}`, { always_review: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().alwaysReview).toBe(false);
    const listed = (await k.get(w.headers, '/api/v1/agents')).json() as Array<{ id: string; alwaysReview: boolean }>;
    expect(listed.find((a) => a.id === agentId)?.alwaysReview).toBe(false);
    const id = await agentCapture(w.tenant.id, agentId, 'George launch moved to December.');
    await w.run();
    expect((await factsOf(w.tenant.id, id)).map((f) => f.outcome)).toEqual(['applied']);
    expect(await k.pageText(w.tenant.id, w.george)).toContain('December');
  });

  test("a capture of an agent's waiting for a person notifies its owner", async () => {
    const w = await k.world();
    const agentId = await agentOf(w, w.owner.userId, 'editor', false);
    const id = await agentCapture(w.tenant.id, agentId, 'Zebras migrate in spring.');
    await w.run();
    const box = (await k.get(w.headers, '/api/v1/notifications')).json() as { items: Array<{ kind: string; captureId: string | null }> };
    expect(box.items.filter((n) => n.kind === 'capture_waiting').map((n) => n.captureId)).toEqual([id]);
  });
});
