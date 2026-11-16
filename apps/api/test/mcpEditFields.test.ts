import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, pageFieldValues, spaces, suggestions, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** Field values in kinote_read, and field edits in kinote_edit. */
describe('kinote_edit: fields', () => {
  const k = useCaptureKit();

  async function setup(w: CaptureWorld) {
    const page = async (title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await k.post(w.headers, '/api/v1/pages', { space_id: w.clients, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const accounts = await page('Accounts', 'accounts', 'Our accounts.');
    expect((await k.post(w.headers, `/api/v1/pages/${accounts}/collection`)).statusCode).toBe(201);
    const field = async (body: unknown) => {
      const res = await k.post(w.headers, `/api/v1/collections/${accounts}/fields`, body);
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string };
    };
    const status = await field({
      name: 'Status',
      type: 'select',
      options: { choices: ['Open', 'Done'].map((name) => ({ id: name.toLowerCase(), name, color: 'gray' })) },
    });
    const due = await field({ name: 'Due', type: 'date' });
    const acme = await page('Acme', 'acme', 'Acme buys widgets.', accounts);
    const set = await k.patch(w.headers, `/api/v1/pages/${acme}/fields`, { [status.id]: 'open', [due.id]: { start: '2026-12-01' } });
    expect(set.statusCode, set.body).toBeLessThan(300);

    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const agentId = await createAgent(w.tenant.id, member.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'edit'] });
    const edit = (edits: unknown[], pageId = acme) => callTool(k.app, token, 'kinote_edit', { page_id: short(pageId), edits });
    const valueOf = async (fieldId: string) =>
      (
        await withTenantTx(w.tenant.id, (tx) =>
          tx.select().from(pageFieldValues).where(and(eq(pageFieldValues.pageId, acme), eq(pageFieldValues.fieldId, fieldId)))
        )
      )[0]?.value;
    return { accounts, acme, status, due, token, agentId, edit, valueOf };
  }

  test('read shows field values', async () => {
    const w = await k.world();
    const s = await setup(w);
    for (const level of ['outline', 'full']) {
      const res = await callTool(k.app, s.token, 'kinote_read', { page_id: short(s.acme), level });
      expect(res.text).toMatch(/\nFields: Status: Open · Due: 2026-12-01\b/);
    }
  });

  test('a field edit applies, by field and choice name', async () => {
    const w = await k.world();
    const s = await setup(w);
    // The owner set the fields a moment ago; without a protection window the agent's change applies.
    await withTenantTx(w.tenant.id, (tx) => tx.update(spaces).set({ humanProtectionSeconds: 0 }).where(eq(spaces.id, w.clients)));
    const res = await s.edit([{ field: 'status', value: 'Done' }]);
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain('• field Status — applied · indexing');
    expect(await s.valueOf(s.status.id)).toBe('done');
  });

  test('unknown field, bad value and a page that is not a row are refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([
      { field: 'Priority', value: 'High' },
      { field: 'Due', value: 'next week' },
      { field: 'Status', value: 'Paused' },
    ]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('• field Priority — refused: Unknown field "Priority". Fields: Status, Due');
    expect(res.text).toContain('• field Due — refused: Due expects a date (YYYY-MM-DD)');
    expect(res.text).toContain('• field Status — refused: Status expects one of: Open, Done');
    const notRow = await s.edit([{ field: 'Status', value: 'Done' }], s.accounts);
    expect(notRow.text).toContain('refused: This page is not a collection row');
  });

  test("a person's recent field change makes a suggestion; clearing is a removal", async () => {
    const w = await k.world();
    const s = await setup(w);
    await k.collab.setFields({ tenantId: w.tenant.id, pageId: s.acme, values: { [s.due.id]: { start: '2026-12-02' } }, actor: { type: 'user', id: w.owner.userId }, source: 'human' });
    const res = await s.edit([
      { field: 'Due', value: '2027-01-01' },
      { field: 'Status', value: null },
    ]);
    expect(res.text).toMatch(/• field Due — suggested: .+ edited this field just now/);
    expect(res.text).toContain('• field Status — suggested: removals wait for a person');
    const rows = await withTenantTx(w.tenant.id, (tx) => tx.select().from(suggestions).where(eq(suggestions.documentId, s.acme)));
    expect(rows.map((r) => [r.kind, r.blockedBy, r.proposedMarkdown]).sort()).toEqual([
      ['set_field', 'protection', '{"start":"2027-01-01"}'],
      ['set_field', 'removal', 'null'],
    ]);
    expect(await s.valueOf(s.status.id)).toBe('open');
  });
});
