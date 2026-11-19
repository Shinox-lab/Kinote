import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, documents, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** kinote_create, kinote_move, kinote_restore and kinote_browse { archived }: arranging the tree. */
describe('MCP tree tools', () => {
  const k = useCaptureKit();

  async function setup(w: CaptureWorld, role: 'editor' | 'viewer' = 'editor') {
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    const call = (name: string, args: object) => callTool(k.app, token, name, args);
    const doc = async (id: string) => (await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
    const page = async (title: string, slug: string, parentId: string | null = null) => {
      const res = await k.post(w.headers, '/api/v1/pages', { space_id: w.clients, parent_id: parentId, title, slug, markdown: 'Text.' });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const archive = async (id: string) => expect((await k.post(w.headers, `/api/v1/pages/${id}/archive`)).statusCode).toBe(200);
    return { agentId, call, doc, page, archive };
  }

  test('create under a page', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_create', { title: 'Handoff', under: short(w.george), markdown: 'Who takes over.' });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/^Created "Handoff" \([0-9a-f]{8}\) under "Client - George" — (waiting for review|indexing)\.$/);
    const id = /\(([0-9a-f]{8})\)/.exec(res.text)![1]!;
    const [made] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.title, 'Handoff')));
    expect(short(made!.id)).toBe(id);
    expect(made!.parentId).toBe(w.george);
    expect(await k.pageText(w.tenant.id, made!.id)).toContain('Who takes over.');
  });

  test('create at the top of a space', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_create', { title: 'Index', under: 'Clients' });
    expect(res.text).toMatch(/^Created "Index" \([0-9a-f]{8}\) under the top of Clients — /);
    const [made] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.title, 'Index')));
    expect(made!.parentId).toBeNull();
    expect(made!.spaceId).toBe(w.clients);
  });

  test('create is refused for a viewer', async () => {
    const w = await k.world();
    const s = await setup(w, 'viewer');
    const res = await s.call('kinote_create', { title: 'Nope', under: 'Clients' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no edit access: a person can add pages there');
  });

  test('move within a space', async () => {
    const w = await k.world();
    const s = await setup(w);
    const a = await s.page('a', 'a');
    const b = await s.page('b', 'b');
    const res = await s.call('kinote_move', { page_id: short(a), under: short(b) });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toBe('Moved "a" under "b".');
    expect((await s.doc(a)).parentId).toBe(b);
  });

  test('a move to another space that needs review goes back to review', async () => {
    const w = await k.world();
    const s = await setup(w);
    const fin = await k.post(w.headers, '/api/v1/spaces', { name: 'Finance', slug: 'finance', review_required: true });
    const finance = fin.json().id as string;
    await k.post(w.headers, `/api/v1/spaces/${finance}/grants`, { principal_type: 'agent', principal_id: s.agentId, role: 'editor' });
    expect((await s.doc(w.sep29)).indexedVersionId).not.toBeNull();
    const res = await s.call('kinote_move', { page_id: short(w.sep29), under: 'Finance' });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toBe('Moved "29Sep" under the top of Finance. It waits for review again.');
    const moved = await s.doc(w.sep29);
    expect(moved.spaceId).toBe(finance);
    expect(moved.indexedVersionId).toBeNull();
  });

  test('a move under its own sub-page is refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_move', { page_id: short(w.george), under: short(w.sep29) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("A page can't go inside itself or its own sub-pages.");
    expect((await s.doc(w.george)).parentId).toBeNull();
  });

  test('restore an archived page', async () => {
    const w = await k.world();
    const s = await setup(w);
    const b = await s.page('b', 'b');
    const a = await s.page('a', 'a', b);
    await s.archive(a);
    const res = await s.call('kinote_restore', { page_id: short(a) });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toBe('Restored "a" under "b". It waits for review before it is searchable again.');
    expect((await s.doc(a)).archivedAt).toBeNull();
  });

  test('restore when the parent is still archived puts it at the top', async () => {
    const w = await k.world();
    const s = await setup(w);
    const b = await s.page('b', 'b');
    const a = await s.page('a', 'a', b);
    await s.archive(a);
    await s.archive(b);
    const res = await s.call('kinote_restore', { page_id: short(a) });
    expect(res.text).toBe('Restored "a" under the top of Clients. It waits for review before it is searchable again.');
    expect((await s.doc(a)).parentId).toBeNull();
  });

  test('restore of a live page is not found', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.call('kinote_restore', { page_id: short(w.george) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('No page');
  });

  test('browse archived lists the archived pages only', async () => {
    const w = await k.world();
    const s = await setup(w);
    const a = await s.page('Old plan', 'old-plan');
    await s.archive(a);
    const res = await s.call('kinote_browse', { space: 'Clients', archived: true });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(new RegExp(`- Old plan \\(${short(a)}\\) — archived \\d{4}-\\d{2}-\\d{2}`));
    expect(res.text).not.toContain('Client - George');
  });
});
