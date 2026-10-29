import { test, describe, beforeEach, expect } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getCollabTokenSecret, verifyCollabToken } from '@kinote/shared';
import { asUser, bootstrapTenant, buildTestApp, signUp, signUpMember, useTestDb } from './support/testkit.js';

describe('POST /api/v1/pages/:id/collab-token', () => {
  const app = buildTestApp();

  useTestDb();

  async function post(headers: Record<string, string>, url: string, payload: unknown) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  async function world() {
    const { owner, tenant, headers } = await bootstrapTenant(app, {
      name: 'Token Co',
      slug: 'token-co',
    });
    const space = await post(headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs' });
    const page = await post(headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'P',
      slug: 'p',
      markdown: '# P',
    });
    const editor = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${space.id}/grants`, {
      principal_type: 'user',
      principal_id: editor.userId,
      role: 'editor',
    });
    await post(headers, `/api/v1/spaces/${space.id}/grants`, {
      principal_type: 'user',
      principal_id: viewer.userId,
      role: 'viewer',
    });
    return { owner, tenant, headers, space, page, editor, viewer };
  }

  const issue = (headers: Record<string, string>, id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/pages/${id}/collab-token`, headers });

  test('a viewer gets a read token, an editor a write token', async () => {
    const w = await world();

    const v = await issue(w.viewer.headers, w.page.id);
    expect(v.statusCode).toBe(200);
    const vb = v.json();
    expect(vb.access).toBe('read');
    const vClaims = verifyCollabToken(vb.token, getCollabTokenSecret());
    expect(vClaims).toMatchObject({
      tenantId: w.tenant.id,
      pageId: w.page.id,
      principalType: 'user',
      principalId: w.viewer.userId,
      access: 'read',
    });
    expect(new Date(vb.expiresAt).getTime()).toBe(vClaims!.exp * 1000);

    const e = await issue(w.editor.headers, w.page.id);
    expect(e.statusCode).toBe(200);
    expect(e.json().access).toBe('write');

    const o = await issue(w.headers, w.page.id);
    expect(o.json().access).toBe('write');
  });

  test('an archived page still yields a token', async () => {
    const w = await world();
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/archive`,
      headers: w.headers,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    const res = await issue(w.viewer.headers, w.page.id);
    expect(res.statusCode).toBe(200);
  });

  test('another tenant, unknown, unreadable and malformed page ids are 404 page_not_found', async () => {
    const w = await world();
    const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });

    for (const [headers, id] of [
      [other.headers, w.page.id],
      [w.headers, randomUUID()],
      [w.headers, 'not-a-uuid'],
    ] as const) {
      const res = await issue(headers, id);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('page_not_found');
    }

    // A member with no grant in the space cannot read the page: 404, not 403,
    // and the same code as an unknown page, so the page's existence never leaks.
    const nobody = await signUpMember(app, w.tenant.id, 'member');
    const res = await issue(nobody.headers, w.page.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('page_not_found');
  });

  test('requires a session', async () => {
    const w = await world();
    const none = await app.inject({ method: 'POST', url: `/api/v1/pages/${w.page.id}/collab-token` });
    expect(none.statusCode).toBe(401);
    const stranger = await signUp(app);
    const noTenant = await issue(asUser(stranger), w.page.id);
    expect(noTenant.statusCode).toBe(404);
  });
});
