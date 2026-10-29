import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, withTenantTx } from '@kinote/db';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';

/**
 * A page's emoji icon: an editor sets one, the page and its tree node carry it,
 * null clears it, a viewer cannot change it and an archived page is refused.
 */
describe('a page emoji icon', () => {
  const app = buildTestApp();
  useTestDb();

  async function setup() {
    const { tenant, headers } = await bootstrapTenant(app, {
      name: 'Icon Co',
      slug: 'icon-co',
    });
    const space = await post(headers, '/api/v1/spaces', {
      name: 'Docs',
      slug: 'docs',
      review_required: false,
    });
    const editor = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    await grant(headers, space.id, editor.userId, 'editor');
    await grant(headers, space.id, viewer.userId, 'viewer');
    const page = await post(headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Original',
      slug: 'original',
      markdown: 'alpha',
    });
    return { tenant, headers, space, page, editor, viewer };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  async function post(
    headers: Record<string, string>,
    url: string,
    payload: Record<string, unknown>
  ) {
    const res = await app.inject({ method: 'POST', url, headers, payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as any;
  }

  async function grant(
    headers: Record<string, string>,
    spaceId: string,
    userId: string,
    role: 'editor' | 'viewer'
  ) {
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, {
      principal_type: 'user',
      principal_id: userId,
      role,
    });
  }

  function update(headers: Record<string, string>, pageId: string, payload: unknown) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/pages/${pageId}`,
      headers,
      payload: payload as Record<string, unknown>,
    });
  }

  async function details(w: World) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/pages/${w.page.id}`,
      headers: w.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as any;
  }

  async function treeIcon(w: World) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/spaces/${w.space.id}/tree`,
      headers: w.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as any).nodes.find((n: any) => n.id === w.page.id)?.icon;
  }

  async function auditTypes(w: World) {
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({ type: auditEvents.type })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, w.tenant.id))
    );
    return rows.map((r) => r.type);
  }

  test('an editor sets, reads and clears the icon on the page and in the tree', async () => {
    const w = await setup();
    expect(w.page.icon).toBeNull();

    const set = await update(w.editor.headers, w.page.id, { icon: '🚀' });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().icon).toBe('🚀');
    expect((await details(w)).icon).toBe('🚀');
    expect(await treeIcon(w)).toBe('🚀');

    const clear = await update(w.editor.headers, w.page.id, { icon: null });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(clear.json().icon).toBeNull();
    expect((await details(w)).icon).toBeNull();
    expect(await treeIcon(w)).toBeNull();
  });

  test('a multi-codepoint emoji is accepted; a non-emoji and an empty body are refused', async () => {
    const w = await setup();

    const family = await update(w.editor.headers, w.page.id, { icon: '👨‍👩‍👧‍👦' });
    expect(family.statusCode, family.body).toBe(200);
    expect(family.json().icon).toBe('👨‍👩‍👧‍👦');

    for (const icon of ['ab', 'a', 'a'.repeat(17)]) {
      const invalid = await update(w.editor.headers, w.page.id, { icon });
      expect(invalid.statusCode, icon).toBe(400);
      expect(invalid.json().error).toBe('validation_failed');
    }

    const empty = await update(w.editor.headers, w.page.id, {});
    expect(empty.statusCode).toBe(400);
  });

  test('a viewer cannot change the icon', async () => {
    const w = await setup();
    const res = await update(w.viewer.headers, w.page.id, { icon: '🌱' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
    expect((await details(w)).icon).toBeNull();
    expect(await treeIcon(w)).toBeNull();
  });

  test('an archived page cannot take an icon', async () => {
    const w = await setup();
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/archive`,
      headers: w.headers,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const res = await update(w.editor.headers, w.page.id, { icon: '📦' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('page_archived');
  });

  test('the update writes one page.renamed audit event', async () => {
    const w = await setup();
    const res = await update(w.editor.headers, w.page.id, { icon: '🧭' });
    expect(res.statusCode, res.body).toBe(200);

    const types = await auditTypes(w);
    expect(types.filter((t) => t === 'page.renamed')).toHaveLength(1);
    expect(types).toContain('page.created');
  });
});
