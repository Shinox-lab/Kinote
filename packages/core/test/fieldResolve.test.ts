import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { collectionFields, collections, withTenantTx } from '@kinote/db';
import type { FieldDef, FieldType } from '@kinote/contracts';
import { collectionFieldDefs, resolveFieldValue } from '../src/index.js';
import { addMember, buildTestApp, bootstrapTenant, signUp, useTestDb } from '../../../apps/api/test/support/testkit.js';

/** The routing engine's field values, as a model phrases them, become stored values (C10). */
describe('resolveFieldValue', () => {
  const app = buildTestApp();
  useTestDb();

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Resolve Co', slug: 'resolve-co' });
    const space = async (name: string, slug: string) =>
      (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers, payload: { name, slug } })).json().id as string;
    const clientsSpace = await space('Clients', 'clients');
    const otherSpace = await space('Other', 'other');
    const page = async (spaceId: string, title: string, slug: string, parentId: string | null = null) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers,
        payload: { space_id: spaceId, parent_id: parentId, title, slug, markdown: `${title} notes.` },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page(clientsSpace, 'Clients', 'clients');
    const acme = await page(clientsSpace, 'Acme', 'acme');
    const elsewhere = await page(otherSpace, 'Elsewhere', 'elsewhere');
    const ana = await signUp(app, `ana-${Date.now()}@example.test`, 'Ana Lim');
    const bo1 = await signUp(app, `bo1-${Date.now()}@example.test`, 'Bo Tan');
    const bo2 = await signUp(app, `bo2-${Date.now()}@example.test`, 'Bo Tan');
    for (const u of [ana, bo1, bo2]) await addMember(tenant.id, u.userId, 'member');
    const choices = [
      { id: 'c-lead', name: 'Lead', color: 'gray' },
      { id: 'c-active', name: 'Active', color: 'green' },
    ];
    const spec: Array<{ name: string; type: FieldType; options?: Record<string, unknown> }> = [
      { name: 'Notes', type: 'text' },
      { name: 'Budget', type: 'number' },
      { name: 'Launch date', type: 'date' },
      { name: 'Status', type: 'select', options: { choices } },
      { name: 'Tags', type: 'multi_select', options: { choices } },
      { name: 'Signed', type: 'checkbox' },
      { name: 'Owner', type: 'person' },
      { name: 'Related', type: 'page' },
    ];
    await withTenantTx(tenant.id, async (tx) => {
      await tx.insert(collections).values({ tenantId: tenant.id, documentId: clients, createdBy: owner.userId });
      await tx.insert(collectionFields).values(
        spec.map((f, i) => ({ tenantId: tenant.id, collectionId: clients, name: f.name, type: f.type, position: `a${i}`, options: f.options ?? {} }))
      );
    });
    const defs = await withTenantTx(tenant.id, (tx) => collectionFieldDefs(tx, tenant.id, clients));
    const def = (name: string) => defs.find((d) => d.name === name)!;
    const resolve = (name: string, raw: unknown) =>
      withTenantTx(tenant.id, (tx) => resolveFieldValue(tx, tenant.id, def(name), raw, clientsSpace));
    return { tenant, clients, clientsSpace, acme, elsewhere, ana, bo1, def, resolve };
  }

  test('null clears any field', async () => {
    const w = await world();
    expect(await w.resolve('Status', null)).toEqual({ ok: true, value: null });
  });

  test('text is trimmed, inner whitespace kept', async () => {
    const w = await world();
    expect(await w.resolve('Notes', '  two  words ')).toEqual({ ok: true, value: 'two  words' });
    expect(await w.resolve('Notes', 3)).toEqual({ ok: false });
  });

  test('numbers accept plain numbers, thousands separators, currency and percent', async () => {
    const w = await world();
    expect(await w.resolve('Budget', 1200)).toEqual({ ok: true, value: 1200 });
    expect(await w.resolve('Budget', '1,200')).toEqual({ ok: true, value: 1200 });
    expect(await w.resolve('Budget', '$1,200.50')).toEqual({ ok: true, value: 1200.5 });
    expect(await w.resolve('Budget', '15%')).toEqual({ ok: true, value: 15 });
    expect(await w.resolve('Budget', 'lots')).toEqual({ ok: false });
    expect(await w.resolve('Budget', Number.POSITIVE_INFINITY)).toEqual({ ok: false });
  });

  test('dates accept YYYY-MM-DD and { start, end }', async () => {
    const w = await world();
    expect(await w.resolve('Launch date', '2026-12-01')).toEqual({ ok: true, value: { start: '2026-12-01' } });
    expect(await w.resolve('Launch date', { start: '2026-12-01', end: '2026-12-03' })).toEqual({
      ok: true,
      value: { start: '2026-12-01', end: '2026-12-03' },
    });
    expect(await w.resolve('Launch date', 'December 1st')).toEqual({ ok: false });
  });

  test('an impossible date such as 2026-02-30 is rejected', async () => {
    const w = await world();
    expect(await w.resolve('Launch date', '2026-02-30')).toEqual({ ok: false });
  });

  test('a select takes a choice name or id', async () => {
    const w = await world();
    expect(await w.resolve('Status', 'active')).toEqual({ ok: true, value: 'c-active' });
    expect(await w.resolve('Status', 'c-lead')).toEqual({ ok: true, value: 'c-lead' });
  });

  test('" Active " resolves to the Active choice id', async () => {
    const w = await world();
    expect(await w.resolve('Status', ' Active ')).toEqual({ ok: true, value: 'c-active' });
  });

  test('a choice name that is not a choice is rejected, never created', async () => {
    const w = await world();
    expect(await w.resolve('Status', 'Paused')).toEqual({ ok: false });
    const [row] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(collectionFields).where(and(eq(collectionFields.tenantId, w.tenant.id), eq(collectionFields.id, w.def('Status').id)))
    );
    expect((row!.options as { choices: unknown[] }).choices).toHaveLength(2);
  });

  test('a multi-select takes names or ids, de-duplicated in order; empty clears', async () => {
    const w = await world();
    expect(await w.resolve('Tags', ['Active', 'lead', 'c-active'])).toEqual({ ok: true, value: ['c-active', 'c-lead'] });
    expect(await w.resolve('Tags', 'Lead')).toEqual({ ok: true, value: ['c-lead'] });
    expect(await w.resolve('Tags', [])).toEqual({ ok: true, value: null });
    expect(await w.resolve('Tags', ['Lead', 'Paused'])).toEqual({ ok: false });
  });

  test('a checkbox takes booleans and yes/no words', async () => {
    const w = await world();
    expect(await w.resolve('Signed', true)).toEqual({ ok: true, value: true });
    expect(await w.resolve('Signed', 'Yes')).toEqual({ ok: true, value: true });
    expect(await w.resolve('Signed', 'unchecked')).toEqual({ ok: true, value: false });
    expect(await w.resolve('Signed', 'maybe')).toEqual({ ok: false });
  });

  test('a person takes member names or member ids', async () => {
    const w = await world();
    expect(await w.resolve('Owner', 'ana lim')).toEqual({ ok: true, value: [w.ana.userId] });
    expect(await w.resolve('Owner', [w.ana.userId])).toEqual({ ok: true, value: [w.ana.userId] });
    expect(await w.resolve('Owner', 'Nobody Here')).toEqual({ ok: false });
  });

  test('a member name shared by two members is rejected', async () => {
    const w = await world();
    expect(await w.resolve('Owner', 'Bo Tan')).toEqual({ ok: false });
    expect(await w.resolve('Owner', w.bo1.userId)).toEqual({ ok: true, value: [w.bo1.userId] });
  });

  test('a page takes titles or ids of live pages in the row space', async () => {
    const w = await world();
    expect(await w.resolve('Related', 'ACME')).toEqual({ ok: true, value: [w.acme] });
    expect(await w.resolve('Related', [w.acme])).toEqual({ ok: true, value: [w.acme] });
  });

  test('a page title in another space is rejected', async () => {
    const w = await world();
    expect(await w.resolve('Related', 'Elsewhere')).toEqual({ ok: false });
    expect(await w.resolve('Related', w.elsewhere)).toEqual({ ok: false });
  });

  test('every resolved value fits its field', async () => {
    const w = await world();
    const { fieldValueFits } = await import('@kinote/contracts');
    const res = await w.resolve('Launch date', { start: '2026-12-03', end: '2026-12-01' });
    expect(res).toEqual({ ok: false });
    const ok = (await w.resolve('Status', 'Lead')) as { ok: true; value: unknown };
    expect(fieldValueFits(w.def('Status') as FieldDef, ok.value)).toBe(true);
  });
});
