import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, documents, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** Renaming a page with kinote_edit's {title} edit. */
describe('kinote_edit: title', () => {
  const k = useCaptureKit();

  async function setup(w: CaptureWorld, role: 'editor' | 'viewer' = 'editor') {
    const res = await k.post(w.headers, '/api/v1/pages', { space_id: w.clients, parent_id: null, title: 'note', slug: 'note', markdown: '# Handoff\n\nWho takes over.' });
    expect(res.statusCode, res.body).toBe(201);
    const pageId = res.json().id as string;
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    const edit = (edits: unknown[]) => callTool(k.app, token, 'kinote_edit', { page_id: short(pageId), edits });
    const title = async () =>
      (await withTenantTx(w.tenant.id, (tx) => tx.select({ title: documents.title }).from(documents).where(eq(documents.id, pageId))))[0]!.title;
    return { pageId, edit, title };
  }

  test('a title edit renames the page', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([{ title: 'Handoff page' }]);
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toMatch(/• title — applied · (indexing|waiting for review)/);
    expect(await s.title()).toBe('Handoff page');
  });

  test('a blank title is refused', async () => {
    const w = await k.world();
    const blank = await (await setup(w)).edit([{ title: '   ' }]);
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain('• title — refused: A title needs 1 to 200 characters');
  });

  test('an agent that can only read cannot rename', async () => {
    const w = await k.world();
    const reader = await setup(w, 'viewer');
    const res = await reader.edit([{ title: 'Handoff page' }]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('• title — refused: no edit access: a person can rename it');
    expect(await reader.title()).toBe('note');
  });

  test('one title edit per call', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([{ title: 'One' }, { title: 'Two' }]);
    expect(res.text).toContain('• title — refused: one title edit per call');
    expect(await s.title()).toBe('One');
  });
});
