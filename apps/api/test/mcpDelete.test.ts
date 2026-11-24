import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, auditEvents, documents, suggestions, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** kinote_delete: an agent archives a page, or asks a person to; the request is an `archive` suggestion. */
describe('kinote_delete', () => {
  const k = useCaptureKit();

  async function setup(w: CaptureWorld, opts: { role?: 'editor' | 'viewer'; alwaysReview?: boolean } = {}) {
    const res = await k.post(w.headers, '/api/v1/pages', { space_id: w.clients, parent_id: null, title: 'note', slug: 'note', markdown: 'Some text.' });
    expect(res.statusCode, res.body).toBe(201);
    const pageId = res.json().id as string;
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: opts.alwaysReview ?? false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: opts.role ?? 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    const del = (page = pageId, reason = 'It is a duplicate.') => callTool(k.app, token, 'kinote_delete', { page_id: short(page), reason });
    const doc = async (id = pageId) =>
      (await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
    const requests = () =>
      withTenantTx(w.tenant.id, (tx) => tx.select().from(suggestions).where(and(eq(suggestions.documentId, pageId), eq(suggestions.kind, 'archive'))));
    return { pageId, agentId, del, doc, requests };
  }

  const requestId = (text: string) => /request ([0-9a-f]{8})\)/.exec(text)?.[1];

  test('archives at once when nothing needs review', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.del();
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toBe('Deleted "note". A person can restore it from the page.');
    expect((await s.doc()).archivedAt).not.toBeNull();
  });

  test('asks when the agent always reviews', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    const res = await s.del();
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/^Asked to delete "note": waiting for a person \(request [0-9a-f]{8}\)/);
    const [row, ...rest] = await s.requests();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: 'archive', status: 'open', reason: 'It is a duplicate.', proposedByType: 'agent', proposedBy: s.agentId, blockId: null });
    expect((await s.doc()).archivedAt).toBeNull();
  });

  test('asks when the space requires review', async () => {
    const w = await k.world();
    expect((await k.patch(w.headers, `/api/v1/spaces/${w.clients}`, { review_required: true })).statusCode).toBe(200);
    const s = await setup(w);
    const res = await s.del();
    expect(res.text).toMatch(/^Asked to delete "note"/);
    expect((await s.doc()).archivedAt).toBeNull();
  });

  test('a viewer agent is refused', async () => {
    const w = await k.world();
    const s = await setup(w, { role: 'viewer' });
    const res = await s.del();
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no edit access: a person can delete it');
    expect(await s.requests()).toEqual([]);
  });

  test('a page with sub-pages is refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.del(w.george);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('It has 1 sub-pages: delete or move them first.');
  });

  test('an archived page is refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    await s.del();
    const again = await s.del();
    expect(again.isError).toBe(true);
    expect(again.text).toContain('The page is already deleted.');
  });

  test('a second call answers the open request', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    const first = await s.del();
    const second = await s.del();
    expect(requestId(second.text)).toBe(requestId(first.text));
    expect(await s.requests()).toHaveLength(1);
  });

  test('accepting the request archives the page', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    await s.del();
    const [row] = await s.requests();
    const res = await k.post(w.headers, `/api/v1/suggestions/${row!.id}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await s.doc()).archivedAt).not.toBeNull();
    const audits = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.type, 'suggestion.accepted'), eq(auditEvents.subjectId, row!.id)))
    );
    expect(audits[0]?.payload).toMatchObject({ kind: 'archive' });
  });

  test('accepting after a child was added answers has_children and stays open', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    await s.del();
    await k.post(w.headers, '/api/v1/pages', { space_id: w.clients, parent_id: s.pageId, title: 'child', slug: 'child' });
    const [row] = await s.requests();
    const res = await k.post(w.headers, `/api/v1/suggestions/${row!.id}/accept`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('has_children');
    expect((await s.requests())[0]!.status).toBe('open');
    expect((await s.doc()).archivedAt).toBeNull();
  });

  test('accepting when the page was already archived answers suggestion_not_open', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    await s.del();
    expect((await k.post(w.headers, `/api/v1/pages/${s.pageId}/archive`)).statusCode).toBe(200);
    const [row] = await s.requests();
    const res = await k.post(w.headers, `/api/v1/suggestions/${row!.id}/accept`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('suggestion_not_open');
  });

  test('declining keeps the page', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    await s.del();
    const [row] = await s.requests();
    expect((await k.post(w.headers, `/api/v1/suggestions/${row!.id}/decline`)).statusCode).toBe(200);
    expect((await s.doc()).archivedAt).toBeNull();
    expect((await s.requests())[0]!.status).toBe('declined');
  });

  test("archiving closes the page's other open suggestions as stale", async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    await s.del();
    expect((await k.post(w.headers, `/api/v1/pages/${s.pageId}/archive`)).statusCode).toBe(200);
    expect((await s.requests())[0]!.status).toBe('stale');
  });
});
