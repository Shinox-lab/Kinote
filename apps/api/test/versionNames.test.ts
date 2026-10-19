import { describe, test, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenantTx, versions, memberships } from '@living-wiki/db';
import { VersionListSchema } from '@living-wiki/contracts';
import { bootstrapTenant, buildTestApp, createAgent, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** GET /api/v1/pages/:id/versions names each version's author for every role that can read the page. */
describe('version list author names', () => {
  const app = buildTestApp();
  useTestDb();

  let w: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const { owner, tenant, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Names Co', slug: 'names-co' });
    const space = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/spaces',
        headers: ownerHeaders,
        payload: { name: 'Handbook', slug: 'handbook', review_required: false },
      })
    ).json() as { id: string };
    const editor = await signUpMember(app, tenant.id, 'member', 'editor@example.test');
    const viewer = await signUpMember(app, tenant.id, 'member', 'viewer@example.test');
    const leaver = await signUpMember(app, tenant.id, 'member', 'leaver@example.test');
    for (const [m, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${space.id}/grants`,
        headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: m.userId, role },
      });
    }
    const page = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers: ownerHeaders,
        payload: { space_id: space.id, title: 'Notes', slug: 'notes', markdown: 'Body.' },
      })
    ).json() as { id: string };
    const agentId = await createAgent(tenant.id, owner.userId, { name: 'Support bot' });
    return { owner, tenant, ownerHeaders, editor, viewer, leaver, page, agentId };
  }

  async function addVersion(number: number, by: { type: 'user' | 'agent' | 'connector'; id: string }) {
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(versions).values({
        tenantId: w.tenant.id,
        documentId: w.page.id,
        number,
        title: 'ignored',
        status: 'superseded',
        contentHash: `hash-${randomUUID()}`,
        reason: 'submit',
        createdByType: by.type,
        createdBy: by.id,
      })
    );
  }

  async function names(headers: Headers): Promise<Map<number, string>> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${w.page.id}/versions`, headers });
    expect(res.statusCode, res.body).toBe(200);
    const list = VersionListSchema.parse(res.json());
    return new Map(list.map((v) => [v.number, v.createdByName]));
  }

  beforeEach(async () => {
    w = await setup();
    await addVersion(1, { type: 'user', id: w.editor.userId });
    await addVersion(2, { type: 'agent', id: w.agentId });
    await addVersion(3, { type: 'connector', id: randomUUID() });
    await addVersion(4, { type: 'user', id: w.leaver.userId });
    await addVersion(5, { type: 'user', id: randomUUID() });
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.leaver.userId)))
    );
  });

  test('a viewer, an editor and an admin all see names, not ids', async () => {
    for (const headers of [w.viewer.headers, w.editor.headers, w.ownerHeaders]) {
      const byNumber = await names(headers);
      expect(byNumber.get(1)).toBe('editor');
      expect(byNumber.get(2)).toBe('Support bot');
      expect(byNumber.get(3)).toBe('System');
    }
  });

  test('a user who left, and a user the tenant never had, read as Former member', async () => {
    const byNumber = await names(w.viewer.headers);
    expect(byNumber.get(4)).toBe('Former member');
    expect(byNumber.get(5)).toBe('Former member');
  });
});
