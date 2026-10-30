import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, withTenantTx } from '@kinote/db';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';

/**
 * A page's width (default, wide or full) is a property of the page, so everyone sees the same layout: an editor sets
 * it, the page carries it, a viewer cannot change it, an archived page is refused and the change is audited.
 */
describe('a page width', () => {
  const app = buildTestApp();
  useTestDb();

  async function setup() {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Width Co', slug: 'width-co' });
    const space = await post(headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs', review_required: false });
    const editor = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    await grant(headers, space.id, editor.userId, 'editor');
    await grant(headers, space.id, viewer.userId, 'viewer');
    const page = await post(headers, '/api/v1/pages', { space_id: space.id, title: 'Plan', slug: 'plan', markdown: 'alpha' });
    return { tenant, headers, space, page, editor, viewer };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  async function post(headers: Record<string, string>, url: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url, headers, payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as any;
  }

  async function grant(headers: Record<string, string>, spaceId: string, userId: string, role: 'editor' | 'viewer') {
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, { principal_type: 'user', principal_id: userId, role });
  }

  function update(headers: Record<string, string>, pageId: string, payload: unknown) {
    return app.inject({ method: 'PATCH', url: `/api/v1/pages/${pageId}`, headers, payload: payload as Record<string, unknown> });
  }

  async function width(w: World, headers = w.headers) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${w.page.id}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as any).width;
  }

  test('a new page is default width; an editor makes it wide, then full, and everyone sees it', async () => {
    const w = await setup();
    expect(await width(w)).toBe('default');

    for (const value of ['wide', 'full', 'default'] as const) {
      const res = await update(w.editor.headers, w.page.id, { width: value });
      expect(res.statusCode, res.body).toBe(200);
      expect(await width(w)).toBe(value);
      expect(await width(w, w.viewer.headers)).toBe(value);
    }
  });

  test('a width change leaves the title and icon alone', async () => {
    const w = await setup();
    await update(w.editor.headers, w.page.id, { icon: '🧭' });
    const res = await update(w.editor.headers, w.page.id, { width: 'wide' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('Plan');
    expect(res.json().icon).toBe('🧭');
  });

  test('an unknown width is refused', async () => {
    const w = await setup();
    const res = await update(w.editor.headers, w.page.id, { icon: '🧭', width: 'huge' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  test('a viewer cannot change the width', async () => {
    const w = await setup();
    const res = await update(w.viewer.headers, w.page.id, { width: 'full' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
    expect(await width(w)).toBe('default');
  });

  test('an archived page cannot change width', async () => {
    const w = await setup();
    const archived = await app.inject({ method: 'POST', url: `/api/v1/pages/${w.page.id}/archive`, headers: w.headers });
    expect(archived.statusCode, archived.body).toBe(200);
    const res = await update(w.editor.headers, w.page.id, { width: 'wide' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('page_archived');
  });

  test('the change writes one page.width_changed audit event with both widths', async () => {
    const w = await setup();
    await update(w.editor.headers, w.page.id, { width: 'full' });
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select({ type: auditEvents.type, payload: auditEvents.payload }).from(auditEvents).where(eq(auditEvents.tenantId, w.tenant.id))
    );
    const events = rows.filter((r) => r.type === 'page.width_changed');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ previousWidth: 'default', width: 'full' });
    expect(rows.filter((r) => r.type === 'page.renamed')).toHaveLength(0);
  });
});
