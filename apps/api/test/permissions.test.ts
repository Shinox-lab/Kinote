import { describe, test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, spaces } from '@living-wiki/db';
import type { Actor } from '@living-wiki/core';
import { approveVersion, rejectVersion } from '../src/routes/pages.js';
import { createGroupAndAddMembers } from '../src/routes/foundations.js';
import {
  buildTestApp,
  bootstrapTenant,
  signUp,
  signUpMember,
  createAgent,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * The single permission gate: the tenant `viewer` cap, the Inbox per-item
 * rule, archived spaces, grounded grants, and 404-before-anything for
 * documents the actor cannot read.
 */
describe('permission gate', () => {
  const app = buildTestApp();
  useTestDb();

  async function call(method: 'GET' | 'POST', url: string, headers: Headers, payload?: unknown) {
    return app.inject({ method, url, headers, payload: payload as any });
  }

  async function ok(method: 'GET' | 'POST', url: string, headers: Headers, payload?: unknown) {
    const res = await call(method, url, headers, payload);
    assert.ok(res.statusCode === 200 || res.statusCode === 201, `${method} ${url}: ${res.body}`);
    return res.json();
  }

  function expectError(res: { statusCode: number; json(): any; body: string }, status: number, code: string) {
    expect({ status: res.statusCode, error: res.json().error }, res.body.slice(0, 160)).toEqual({ status, error: code });
  }

  async function createPage(headers: Headers, spaceId: string, slug: string, markdown = '# Hello') {
    return (await ok('POST', '/api/v1/pages', headers, { space_id: spaceId, title: slug, slug, markdown }))
      .document as { id: string; spaceId: string };
  }

  async function grant(headers: Headers, spaceId: string, principal_type: string, principal_id: string, role: string) {
    return call('POST', `/api/v1/spaces/${spaceId}/grants`, headers, { principal_type, principal_id, role });
  }

  async function archiveSpace(tenantId: string, spaceId: string) {
    // No space-archive route yet: set archived_at as the app role in a tenant tx.
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, spaceId)))
        .then(() => undefined)
    );
  }

  async function world() {
    const { owner, tenant, inboxSpace, headers } = await bootstrapTenant(app, {
      name: 'Gate Co',
      slug: 'gate-co',
    });
    const docs = await ok('POST', '/api/v1/spaces', headers, { name: 'Docs', slug: 'docs' });
    const admin = await signUpMember(app, tenant.id, 'admin');
    const memberA = await signUpMember(app, tenant.id, 'member');
    const memberB = await signUpMember(app, tenant.id, 'member');
    const tenantViewer = await signUpMember(app, tenant.id, 'viewer');
    const spaceViewer = await signUpMember(app, tenant.id, 'member');
    const outsider = await signUpMember(app, tenant.id, 'member');
    for (const [userId, role] of [
      [memberA.userId, 'editor'],
      [memberB.userId, 'editor'],
      [tenantViewer.userId, 'editor'],
      [spaceViewer.userId, 'viewer'],
    ] as const) {
      const res = await grant(headers, docs.id, 'user', userId, role);
      assert.equal(res.statusCode, 201, res.body);
    }
    const docsPage = await createPage(headers, docs.id, 'docs-page');
    return { owner, tenant, inbox: inboxSpace, headers, docs, docsPage, admin, memberA, memberB, tenantViewer, spaceViewer, outsider };
  }

  describe('tenant viewer role', () => {
    test('a tenant viewer with an editor grant is a viewer: create page 403, collab-token read, snapshot 403', async () => {
      const w = await world();

      expectError(
        await call('POST', '/api/v1/pages', w.tenantViewer.headers, {
          space_id: w.docs.id,
          title: 'Nope',
          slug: 'nope',
        }),
        403,
        'forbidden'
      );
      // The cap holds in the Inbox too.
      expectError(
        await call('POST', '/api/v1/pages', w.tenantViewer.headers, {
          space_id: w.inbox.id,
          title: 'Nope',
          slug: 'nope',
        }),
        403,
        'forbidden'
      );

      const token = await ok('POST', `/api/v1/pages/${w.docsPage.id}/collab-token`, w.tenantViewer.headers);
      expect(token.access).toBe('read');

      expectError(
        await call('POST', `/api/v1/pages/${w.docsPage.id}/snapshot`, w.tenantViewer.headers),
        403,
        'forbidden'
      );

      const space = await ok('GET', `/api/v1/spaces/${w.docs.id}`, w.tenantViewer.headers);
      expect(space.myRole).toBe('viewer');
      const page = await ok('GET', `/api/v1/pages/${w.docsPage.id}`, w.tenantViewer.headers);
      expect(page.id).toBe(w.docsPage.id);
    });

    test('a grant of editor to a tenant viewer is accepted (capped when read)', async () => {
      const w = await world();
      const res = await grant(w.headers, w.docs.id, 'user', w.tenantViewer.userId, 'editor');
      expect(res.statusCode).toBe(201);
    });

    test('a user with a space viewer grant cannot snapshot: 403 forbidden', async () => {
      const w = await world();
      expectError(
        await call('POST', `/api/v1/pages/${w.docsPage.id}/snapshot`, w.spaceViewer.headers),
        403,
        'forbidden'
      );
      // An editor can.
      await ok('POST', `/api/v1/pages/${w.docsPage.id}/snapshot`, w.memberA.headers);
    });

    test('the Inbox is listed for every member, a tenant viewer included', async () => {
      const w = await world();
      for (const [h, role] of [
        [w.memberB.headers, 'editor'],
        [w.outsider.headers, 'editor'],
        [w.tenantViewer.headers, 'viewer'],
        [w.admin.headers, 'admin'],
      ] as const) {
        const list = (await ok('GET', '/api/v1/spaces', h)) as Array<{ id: string; myRole: string }>;
        expect(list.find((s) => s.id === w.inbox.id)?.myRole).toBe(role);
      }
    });
  });

  describe('Inbox items are visible to their creator and tenant admins only', () => {
    test("a member opening A's Inbox page by id gets 404 page_not_found everywhere", async () => {
      const w = await world();
      const item = await createPage(w.memberA.headers, w.inbox.id, 'a-note');
      const v1 = await ok('POST', `/api/v1/pages/${item.id}/snapshot`, w.memberA.headers);

      for (const h of [w.memberB.headers, w.tenantViewer.headers]) {
        expectError(await call('GET', `/api/v1/pages/${item.id}`, h), 404, 'page_not_found');
        expectError(await call('POST', `/api/v1/pages/${item.id}/collab-token`, h), 404, 'page_not_found');
        expectError(await call('POST', `/api/v1/pages/${item.id}/snapshot`, h), 404, 'page_not_found');
        expectError(
          await call('POST', `/api/v1/pages/${item.id}/move`, h, { target_space_id: w.docs.id }),
          404,
          'page_not_found'
        );
        expectError(await call('POST', `/api/v1/pages/${item.id}/withdraw`, h), 404, 'page_not_found');
        expectError(await call('POST', `/api/v1/pages/${item.id}/archive`, h), 404, 'page_not_found');
        expectError(await call('POST', `/api/v1/versions/${v1.id}/approve`, h, {}), 404, 'version_not_found');
        expectError(
          await call('POST', `/api/v1/versions/${v1.id}/reject`, h, { review_note: 'no' }),
          404,
          'version_not_found'
        );
        expectError(await call('POST', `/api/v1/versions/${v1.id}/retry`, h), 404, 'version_not_found');
      }
    });

    test('the creator and a tenant admin keep access to an Inbox page', async () => {
      const w = await world();
      const item = await createPage(w.memberA.headers, w.inbox.id, 'a-note');

      await ok('POST', `/api/v1/pages/${item.id}/snapshot`, w.memberA.headers);
      for (const h of [w.memberA.headers, w.admin.headers, w.headers]) {
        const page = await ok('GET', `/api/v1/pages/${item.id}`, h);
        expect(page.id).toBe(item.id);
        const token = await ok('POST', `/api/v1/pages/${item.id}/collab-token`, h);
        expect(token.access).toBe('write');
        // Past the access check: nothing changed since the creator's snapshot.
        expectError(await call('POST', `/api/v1/pages/${item.id}/snapshot`, h), 409, 'no_changes');
      }
      // A tenant admin can withdraw and archive someone else's Inbox page.
      await ok('POST', `/api/v1/pages/${item.id}/withdraw`, w.admin.headers);
      await ok('POST', `/api/v1/pages/${item.id}/archive`, w.admin.headers);
    });

    test('moving a page into the Inbox makes it invisible to other members; creator and admins keep it', async () => {
      const w = await world();
      const page = await createPage(w.memberA.headers, w.docs.id, 'to-inbox');
      // Before the move another editor of the space reads it.
      await ok('GET', `/api/v1/pages/${page.id}`, w.memberB.headers);

      await ok('POST', `/api/v1/pages/${page.id}/move`, w.memberA.headers, { target_space_id: w.inbox.id });

      expectError(await call('GET', `/api/v1/pages/${page.id}`, w.memberB.headers), 404, 'page_not_found');
      expectError(
        await call('POST', `/api/v1/pages/${page.id}/collab-token`, w.memberB.headers),
        404,
        'page_not_found'
      );
      for (const h of [w.memberA.headers, w.admin.headers, w.headers]) {
        expect((await ok('GET', `/api/v1/pages/${page.id}`, h)).spaceId).toBe(w.inbox.id);
      }
    });
  });

  describe('archived spaces', () => {
    test('member 404, admin may read but not write (409 space_archived)', async () => {
      const w = await world();
      const old = await ok('POST', '/api/v1/spaces', w.headers, { name: 'Old', slug: 'old' });
      expect((await grant(w.headers, old.id, 'user', w.memberA.userId, 'editor')).statusCode).toBe(201);
      const oldPage = await createPage(w.headers, old.id, 'old-page');
      await archiveSpace(w.tenant.id, old.id);

      // A member cannot see it at all.
      expectError(await call('GET', `/api/v1/spaces/${old.id}`, w.memberA.headers), 404, 'space_not_found');
      expectError(await call('GET', `/api/v1/pages/${oldPage.id}`, w.memberA.headers), 404, 'page_not_found');
      const memberList = (await ok('GET', '/api/v1/spaces', w.memberA.headers)) as Array<{ id: string }>;
      expect(memberList.map((s) => s.id)).not.toContain(old.id);

      // A tenant admin reads it.
      const space = await ok('GET', `/api/v1/spaces/${old.id}`, w.admin.headers);
      expect(space.id).toBe(old.id);
      await ok('GET', `/api/v1/pages/${oldPage.id}`, w.admin.headers);
      const token = await ok('POST', `/api/v1/pages/${oldPage.id}/collab-token`, w.admin.headers);
      expect(token.access).toBe('read');

      // ...but cannot change it.
      expectError(
        await call('POST', '/api/v1/pages', w.admin.headers, { space_id: old.id, title: 'New', slug: 'new' }),
        409,
        'space_archived'
      );
      expectError(
        await call('POST', `/api/v1/pages/${w.docsPage.id}/move`, w.admin.headers, { target_space_id: old.id }),
        409,
        'space_archived'
      );
      expectError(
        await call('POST', `/api/v1/pages/${oldPage.id}/snapshot`, w.admin.headers),
        409,
        'space_archived'
      );
      expectError(
        await grant(w.headers, old.id, 'user', w.memberB.userId, 'viewer'),
        409,
        'space_archived'
      );
    });
  });

  describe('grants must name a principal of this tenant', () => {
    test('unknown, foreign, non-member and disabled principals are 404 principal_not_found', async () => {
      const w = await world();
      const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
      const otherMember = await signUpMember(app, other.tenant.id, 'member');
      const nonMember = await signUp(app);
      const otherGroup = await createGroupAndAddMembers(
        { tenantId: other.tenant.id, principalType: 'user', principalId: other.owner.userId, tenantRole: 'owner' },
        'Other group',
        []
      );
      const otherAgent = await createAgent(other.tenant.id, other.owner.userId);
      const disabledAgent = await createAgent(w.tenant.id, w.owner.userId, { disabled: true });

      for (const [type, id] of [
        ['user', other.owner.userId],
        ['user', otherMember.userId],
        ['user', nonMember.userId],
        ['user', '00000000-0000-0000-0000-000000000123'],
        ['group', otherGroup.id],
        ['group', '00000000-0000-0000-0000-000000000124'],
        ['agent', otherAgent],
        ['agent', disabledAgent],
        ['agent', '00000000-0000-0000-0000-000000000125'],
      ] as const) {
        expectError(await grant(w.headers, w.docs.id, type, id, 'viewer'), 404, 'principal_not_found');
      }
    });

    test('a member, a group of this tenant and an enabled agent can be granted', async () => {
      const w = await world();
      const group = await createGroupAndAddMembers(
        { tenantId: w.tenant.id, principalType: 'user', principalId: w.owner.userId, tenantRole: 'owner' },
        'Writers',
        [{ principalType: 'user', principalId: w.outsider.userId }]
      );
      const agent = await createAgent(w.tenant.id, w.owner.userId);
      expect((await grant(w.headers, w.docs.id, 'user', w.outsider.userId, 'viewer')).statusCode).toBe(201);
      expect((await grant(w.headers, w.docs.id, 'group', group.id, 'editor')).statusCode).toBe(201);
      expect((await grant(w.headers, w.docs.id, 'agent', agent, 'editor')).statusCode).toBe(201);
    });
  });

  describe('approve and reject check access first', () => {
    async function reviewWorld() {
      const w = await world();
      const review = await ok('POST', '/api/v1/spaces', w.headers, { name: 'Review', slug: 'review', review_required: true });
      const secret = await ok('POST', '/api/v1/spaces', w.headers, { name: 'Secret', slug: 'secret', review_required: true });
      const agentId = await createAgent(w.tenant.id, w.owner.userId);
      expect((await grant(w.headers, review.id, 'agent', agentId, 'editor')).statusCode).toBe(201);

      const readablePage = await createPage(w.headers, review.id, 'readable');
      const readableVersion = await ok('POST', `/api/v1/pages/${readablePage.id}/snapshot`, w.headers);
      expect(readableVersion.status).toBe('pending_review');
      const secretPage = await createPage(w.headers, secret.id, 'hidden');
      const secretVersion = await ok('POST', `/api/v1/pages/${secretPage.id}/snapshot`, w.headers);
      expect(secretVersion.status).toBe('pending_review');

      const agent: Actor = { tenantId: w.tenant.id, principalType: 'agent', principalId: agentId };
      return { ...w, review, secret, agent, readableVersion, secretVersion };
    }

    test('an agent approving or rejecting in a readable space gets 403 forbidden', async () => {
      const w = await reviewWorld();
      await expect(approveVersion(w.agent, w.readableVersion.id)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        rejectVersion(w.agent, w.readableVersion.id, { review_note: 'no' })
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    test('an agent approving or rejecting in an unreadable space gets 404 version_not_found', async () => {
      const w = await reviewWorld();
      await expect(approveVersion(w.agent, w.secretVersion.id)).rejects.toMatchObject({ code: 'version_not_found' });
      await expect(
        rejectVersion(w.agent, w.secretVersion.id, { review_note: 'no' })
      ).rejects.toMatchObject({ code: 'version_not_found' });
    });
  });

  test('a page in an unreadable space is the not-found code on every document route', async () => {
    const w = await world();
    const v1 = await ok('POST', `/api/v1/pages/${w.docsPage.id}/snapshot`, w.headers);
    const h = w.outsider.headers;
    const id = w.docsPage.id;

    expectError(await call('GET', `/api/v1/pages/${id}`, h), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/pages/${id}/collab-token`, h), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/pages/${id}/snapshot`, h), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/pages/${id}/move`, h, { target_space_id: w.inbox.id }), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/pages/${id}/withdraw`, h), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/pages/${id}/archive`, h), 404, 'page_not_found');
    expectError(await call('POST', `/api/v1/versions/${v1.id}/retry`, h), 404, 'version_not_found');
    expectError(await call('POST', `/api/v1/versions/${v1.id}/approve`, h, {}), 404, 'version_not_found');
    expectError(
      await call('POST', `/api/v1/versions/${v1.id}/reject`, h, { review_note: 'no' }),
      404,
      'version_not_found'
    );
  });

  test('an archived page in an unreadable space is 404 on move, not 409 page_archived', async () => {
    const w = await world();
    await ok('POST', `/api/v1/pages/${w.docsPage.id}/archive`, w.headers);
    expectError(
      await call('POST', `/api/v1/pages/${w.docsPage.id}/move`, w.outsider.headers, { target_space_id: w.inbox.id }),
      404,
      'page_not_found'
    );
  });
});
