import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, documents, spaceGrants, suggestions, versions, withTenantTx } from '@kinote/db';
import type { Actor } from '@kinote/core';
import { decideReviewItem, reviewItems } from '../src/mcp/review/items.js';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** The owner's review list and decisions behind the review panel. */
describe('review items', () => {
  const k = useCaptureKit();

  async function agentOf(w: CaptureWorld, ownerId: string, name = 'Docs bot') {
    const agentId = await createAgent(w.tenant.id, ownerId, { name });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: true }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    return { agentId, call: (name: string, args: object) => callTool(k.app, token, name, args) };
  }

  const ownerActor = (w: CaptureWorld): Actor => ({ tenantId: w.tenant.id, principalType: 'user', principalId: w.owner.userId, tenantRole: 'owner' });

  /** An agent's insert on George, held for review. */
  async function waitingVersion(w: CaptureWorld, call: (n: string, a: object) => Promise<{ text: string }>) {
    const res = await call('kinote_edit', { page_id: short(w.george), edits: [{ after_block_id: null, markdown: 'Launch moved to December.' }] });
    expect(res.text).toContain('waiting for review');
    const [v] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(versions).where(and(eq(versions.documentId, w.george), eq(versions.status, 'pending_review')))
    );
    return v!;
  }

  async function removeSuggestion(w: CaptureWorld, agentId: string) {
    const [row] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .insert(suggestions)
        .values({
          tenantId: w.tenant.id,
          documentId: w.sep29,
          spaceId: w.clients,
          kind: 'remove',
          blockId: 'b1',
          expectedText: 'Hero video notes.',
          reason: 'Out of date.',
          blockedBy: 'removal',
          proposedByType: 'agent',
          proposedBy: agentId,
        })
        .returning()
    );
    return row!;
  }

  test('lists a waiting version with before and after', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const v = await waitingVersion(w, a.call);
    const items = await reviewItems(ownerActor(w), {});
    const item = items.find((i) => i.id === v.id)!;
    expect(item).toMatchObject({
      type: 'version',
      kind: 'version',
      page: { id: w.george, title: 'Client - George', space: 'Clients' },
      proposer: { type: 'agent', name: 'Docs bot' },
      decidable: true,
    });
    expect(item.before).toContain('Launch is in November.');
    expect(item.before).not.toContain('December');
    expect(item.after).toContain('Launch moved to December.');
  });

  test('lists an open suggestion and a delete request', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const rm = await removeSuggestion(w, a.agentId);
    await a.call('kinote_delete', { page_id: short(w.sep29), reason: 'Merged into George.' });
    const items = await reviewItems(ownerActor(w), {});
    expect(items.find((i) => i.id === rm.id)).toMatchObject({ type: 'suggestion', kind: 'remove', before: 'Hero video notes.', after: null, reason: 'Out of date.' });
    expect(items.find((i) => i.kind === 'archive')).toMatchObject({
      type: 'suggestion',
      page: { id: w.sep29, title: '29Sep' },
      before: null,
      after: null,
      sub_pages: 0,
      reason: 'Merged into George.',
      decidable: true,
    });
  });

  test("mine_only keeps this agent's items", async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const b = await agentOf(w, w.owner.userId, 'Other bot');
    await removeSuggestion(w, a.agentId);
    await removeSuggestion(w, b.agentId);
    const mine = await reviewItems(ownerActor(w), { agentId: a.agentId });
    expect(mine.map((i) => i.proposer.name)).toEqual(['Docs bot']);
    expect(await reviewItems(ownerActor(w), {})).toHaveLength(2);
  });

  test('page_id keeps that page', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    await waitingVersion(w, a.call);
    await removeSuggestion(w, a.agentId);
    const items = await reviewItems(ownerActor(w), { pageId: w.sep29 });
    expect(items.map((i) => i.page.id)).toEqual([w.sep29]);
  });

  test("the owner's own agent's suggestion in a review-required space is not decidable", async () => {
    const w = await k.world();
    expect((await k.patch(w.headers, `/api/v1/spaces/${w.clients}`, { review_required: true })).statusCode).toBe(200);
    const a = await agentOf(w, w.owner.userId);
    const rm = await removeSuggestion(w, a.agentId);
    const item = (await reviewItems(ownerActor(w), {})).find((i) => i.id === rm.id)!;
    expect(item.decidable).toBe(false);
    expect(item.why_not).toBe('Your agent proposed this, so someone else decides it.');
  });

  test('approve and reject a version', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const v1 = await waitingVersion(w, a.call);
    const ok = await decideReviewItem(ownerActor(w), { type: 'version', id: v1.id, decision: 'approve' }, k.collab);
    expect(ok.ok).toBe(true);
    const status = async (id: string) => (await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, id))))[0]!.status;
    expect(await status(v1.id)).not.toBe('pending_review');
    const v2 = await waitingVersion(w, a.call);
    const no = await decideReviewItem(ownerActor(w), { type: 'version', id: v2.id, decision: 'reject', note: 'Not yet.' }, k.collab);
    expect(no).toEqual({ ok: true, status: 'rejected' });
    expect(await status(v2.id)).toBe('rejected');
  });

  test('a version rejected without a note gets one', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const v = await waitingVersion(w, a.call);
    expect(await decideReviewItem(ownerActor(w), { type: 'version', id: v.id, decision: 'reject' }, k.collab)).toEqual({ ok: true, status: 'rejected' });
  });

  test('accept and decline a suggestion', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    await a.call('kinote_delete', { page_id: short(w.sep29), reason: 'Merged.' });
    const [req] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(suggestions).where(eq(suggestions.kind, 'archive')));
    expect(await decideReviewItem(ownerActor(w), { type: 'suggestion', id: req!.id, decision: 'approve' }, k.collab)).toEqual({ ok: true, status: 'accepted' });
    const [doc] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, w.sep29)));
    expect(doc!.archivedAt).not.toBeNull();
    const rm = await removeSuggestion(w, a.agentId);
    // sep29 is archived now; a suggestion on George instead.
    await withTenantTx(w.tenant.id, (tx) => tx.update(suggestions).set({ documentId: w.george }).where(eq(suggestions.id, rm.id)));
    expect(await decideReviewItem(ownerActor(w), { type: 'suggestion', id: rm.id, decision: 'reject' }, k.collab)).toEqual({ ok: true, status: 'declined' });
  });

  test('deciding twice answers ok false', async () => {
    const w = await k.world();
    const a = await agentOf(w, w.owner.userId);
    const rm = await removeSuggestion(w, a.agentId);
    await decideReviewItem(ownerActor(w), { type: 'suggestion', id: rm.id, decision: 'reject' }, k.collab);
    const again = await decideReviewItem(ownerActor(w), { type: 'suggestion', id: rm.id, decision: 'reject' }, k.collab);
    expect(again.ok).toBe(false);
    expect(again).toMatchObject({ message: expect.stringMatching(/\.$/) });
  });

  test('an item in a space the owner lost access to answers ok false', async () => {
    const w = await k.world();
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'admin' });
    const a = await agentOf(w, member.userId);
    const rm = await removeSuggestion(w, a.agentId);
    const memberActor: Actor = { tenantId: w.tenant.id, principalType: 'user', principalId: member.userId, tenantRole: 'member' };
    expect((await reviewItems(memberActor, {})).map((i) => i.id)).toContain(rm.id);
    await withTenantTx(w.tenant.id, (tx) => tx.delete(spaceGrants).where(and(eq(spaceGrants.spaceId, w.clients), eq(spaceGrants.principalId, member.userId))));
    const res = await decideReviewItem(memberActor, { type: 'suggestion', id: rm.id, decision: 'approve' }, k.collab);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ message: expect.stringMatching(/\.$/) });
  });
});
