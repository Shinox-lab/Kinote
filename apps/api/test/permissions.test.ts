import { describe, test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenantTx, spaces, pages, documents, groups, groupMembers } from '@kinote/db';
import { ERROR_SENTENCES } from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { approveVersion, rejectVersion } from '../src/routes/pages.js';
import {
  buildTestApp,
  bootstrapTenant,
  signUp,
  signUpMember,
  createAgent,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;

/** Inserts a group (and its user members) directly; the admin routes have their own tests. */
async function createGroupWithUsers(
  tenantId: string,
  name: string,
  userIds: string[]
): Promise<{ id: string }> {
  return withTenantTx(tenantId, async (tx) => {
    const [group] = await tx.insert(groups).values({ tenantId, name }).returning();
    for (const principalId of userIds) {
      await tx
        .insert(groupMembers)
        .values({ tenantId, groupId: group.id, principalType: 'user', principalId });
    }
    return group;
  });
}

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
    return (await ok('POST', '/api/v1/pages', headers, { space_id: spaceId, title: slug, slug, markdown })) as {
      id: string;
      spaceId: string;
    };
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
      const otherGroup = await createGroupWithUsers(other.tenant.id, 'Other group', []);
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
      const group = await createGroupWithUsers(w.tenant.id, 'Writers', [w.outsider.userId]);
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
      // The 403 comes from the gate (agents are capped at editor), with the gate's message.
      const gate = { code: 'forbidden', message: 'You do not have permission to perform this action.' };
      await expect(approveVersion(w.agent, w.readableVersion.id)).rejects.toMatchObject(gate);
      await expect(
        rejectVersion(w.agent, w.readableVersion.id, { review_note: 'no' })
      ).rejects.toMatchObject(gate);
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

  describe('hidden documents are indistinguishable from missing ones (whole response body)', () => {
    type Route = { name: string; method: 'GET' | 'POST'; url: (id: string) => string; payload?: (w: any) => unknown };
    const pageRoutes: Route[] = [
      { name: 'get', method: 'GET', url: (id) => `/api/v1/pages/${id}` },
      { name: 'collab-token', method: 'POST', url: (id) => `/api/v1/pages/${id}/collab-token` },
      { name: 'snapshot', method: 'POST', url: (id) => `/api/v1/pages/${id}/snapshot` },
      { name: 'move', method: 'POST', url: (id) => `/api/v1/pages/${id}/move`, payload: (w) => ({ target_space_id: w.inbox.id }) },
      { name: 'archive', method: 'POST', url: (id) => `/api/v1/pages/${id}/archive` },
      { name: 'withdraw', method: 'POST', url: (id) => `/api/v1/pages/${id}/withdraw` },
    ];
    const versionRoutes: Route[] = [
      { name: 'retry', method: 'POST', url: (id) => `/api/v1/versions/${id}/retry` },
      { name: 'approve', method: 'POST', url: (id) => `/api/v1/versions/${id}/approve`, payload: () => ({}) },
      { name: 'reject', method: 'POST', url: (id) => `/api/v1/versions/${id}/reject`, payload: () => ({ review_note: 'no' }) },
    ];

    async function hiddenWorld() {
      const w = await world();
      const item = await createPage(w.memberA.headers, w.inbox.id, 'a-private');
      const itemVersion = await ok('POST', `/api/v1/pages/${item.id}/snapshot`, w.memberA.headers);
      const docsVersion = await ok('POST', `/api/v1/pages/${w.docsPage.id}/snapshot`, w.headers);
      return { ...w, item, itemVersion, docsVersion };
    }

    async function body(route: Route, w: any, headers: Headers, id: string) {
      const res = await call(route.method, route.url(id), headers, route.payload?.(w));
      return { status: res.statusCode, body: res.json() };
    }

    for (const route of pageRoutes) {
      test(`page route ${route.name}: another member's Inbox page and an unreadable-space page answer exactly like an unknown id`, async () => {
        const w = await hiddenWorld();
        const unknown = await body(route, w, w.memberB.headers, randomUUID());
        expect(unknown).toEqual({
          status: 404,
          body: { error: 'page_not_found', message: ERROR_SENTENCES.page_not_found },
        });
        expect(await body(route, w, w.memberB.headers, w.item.id)).toEqual(unknown);
        expect(await body(route, w, w.outsider.headers, w.docsPage.id)).toEqual(unknown);
      });
    }

    for (const route of versionRoutes) {
      test(`version route ${route.name}: another member's Inbox version and an unreadable-space version answer exactly like an unknown id`, async () => {
        const w = await hiddenWorld();
        const unknown = await body(route, w, w.memberB.headers, randomUUID());
        expect(unknown).toEqual({
          status: 404,
          body: { error: 'version_not_found', message: ERROR_SENTENCES.version_not_found },
        });
        expect(await body(route, w, w.memberB.headers, w.itemVersion.id)).toEqual(unknown);
        expect(await body(route, w, w.outsider.headers, w.docsVersion.id)).toEqual(unknown);
      });
    }
  });

  describe('a hidden Inbox page cannot be used as a parent', () => {
    test('create and move with a hidden parent answer exactly like an unknown parent, and attach nothing', async () => {
      const w = await world();
      const hidden = await createPage(w.memberA.headers, w.inbox.id, 'a-parent');
      const mine = await createPage(w.memberB.headers, w.inbox.id, 'b-page');

      const create = async (parent_id: string) => {
        const res = await call('POST', '/api/v1/pages', w.memberB.headers, {
          space_id: w.inbox.id,
          parent_id,
          title: 'Child',
          slug: 'child',
        });
        return { status: res.statusCode, body: res.json() };
      };
      const unknownCreate = await create(randomUUID());
      expect(unknownCreate).toEqual({
        status: 404,
        body: { error: 'parent_not_found', message: ERROR_SENTENCES.parent_not_found },
      });
      expect(await create(hidden.id)).toEqual(unknownCreate);

      const move = async (target_parent_id: string) => {
        const res = await call('POST', `/api/v1/pages/${mine.id}/move`, w.memberB.headers, {
          target_space_id: w.inbox.id,
          target_parent_id,
        });
        return { status: res.statusCode, body: res.json() };
      };
      const unknownMove = await move(randomUUID());
      expect(unknownMove).toEqual(unknownCreate);
      expect(await move(hidden.id)).toEqual(unknownMove);

      // Nothing was attached under A's page: it has no children and an admin can archive it.
      const children = await withTenantTx(w.tenant.id, (tx) =>
        tx
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.tenantId, w.tenant.id), eq(documents.parentId, hidden.id)))
      );
      expect(children).toEqual([]);
      await ok('POST', `/api/v1/pages/${hidden.id}/archive`, w.admin.headers);
    });

    test('the creator can still use their own Inbox page as a parent', async () => {
      const w = await world();
      const parent = await createPage(w.memberA.headers, w.inbox.id, 'a-parent');
      const child = await ok('POST', '/api/v1/pages', w.memberA.headers, {
        space_id: w.inbox.id,
        parent_id: parent.id,
        title: 'Child',
        slug: 'child',
      });
      expect(child.parentId).toBe(parent.id);
    });
  });

  describe('Inbox slugs are unique per creator', () => {
    async function slugScopeOf(tenantId: string, pageId: string) {
      const [row] = await withTenantTx(tenantId, (tx) =>
        tx
          .select({ slugScope: pages.slugScope })
          .from(pages)
          .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
      );
      return row!.slugScope;
    }

    test('two members may both have an Inbox page "notes"; one member cannot have two', async () => {
      const w = await world();
      const a = await createPage(w.memberA.headers, w.inbox.id, 'notes');
      const b = await createPage(w.memberB.headers, w.inbox.id, 'notes');
      expect(a.id).not.toBe(b.id);
      expect(await slugScopeOf(w.tenant.id, a.id)).toBe(`user:${w.memberA.userId}`);
      expect(await slugScopeOf(w.tenant.id, b.id)).toBe(`user:${w.memberB.userId}`);

      expectError(
        await call('POST', '/api/v1/pages', w.memberA.headers, { space_id: w.inbox.id, title: 'Again', slug: 'notes' }),
        409,
        'slug_taken'
      );
      // A normal space keeps one slug per space.
      expect(await slugScopeOf(w.tenant.id, w.docsPage.id)).toBe('');
      expectError(
        await call('POST', '/api/v1/pages', w.memberA.headers, { space_id: w.docs.id, title: 'Dup', slug: 'docs-page' }),
        409,
        'slug_taken'
      );
    });

    test('moving an Inbox page into a space that already has the slug is 409 slug_taken', async () => {
      const w = await world();
      await createPage(w.headers, w.docs.id, 'notes');
      const mine = await createPage(w.memberA.headers, w.inbox.id, 'notes');
      expectError(
        await call('POST', `/api/v1/pages/${mine.id}/move`, w.memberA.headers, { target_space_id: w.docs.id }),
        409,
        'slug_taken'
      );
      expect(await slugScopeOf(w.tenant.id, mine.id)).toBe(`user:${w.memberA.userId}`);
    });

    test("moving into the Inbox sets the scope to the document's creator; moving out clears it", async () => {
      const w = await world();
      const page = await createPage(w.memberA.headers, w.docs.id, 'plan');
      // An admin moves A's page: the scope is A's, not the admin's.
      await ok('POST', `/api/v1/pages/${page.id}/move`, w.admin.headers, { target_space_id: w.inbox.id });
      expect(await slugScopeOf(w.tenant.id, page.id)).toBe(`user:${w.memberA.userId}`);
      // B's Inbox slugs are independent of A's.
      await createPage(w.memberB.headers, w.inbox.id, 'plan');

      await ok('POST', `/api/v1/pages/${page.id}/move`, w.memberA.headers, { target_space_id: w.docs.id });
      expect(await slugScopeOf(w.tenant.id, page.id)).toBe('');
    });
  });

  describe('move target checks', () => {
    test('a creator moving their Inbox page into a space where they are only a viewer gets 403 forbidden', async () => {
      const w = await world();
      const mine = await createPage(w.spaceViewer.headers, w.inbox.id, 'mine');
      expectError(
        await call('POST', `/api/v1/pages/${mine.id}/move`, w.spaceViewer.headers, { target_space_id: w.docs.id }),
        403,
        'forbidden'
      );
    });

    test('a non-admin moving into an archived space gets 404 space_not_found', async () => {
      const w = await world();
      const old = await ok('POST', '/api/v1/spaces', w.headers, { name: 'Old', slug: 'old' });
      expect((await grant(w.headers, old.id, 'user', w.memberA.userId, 'editor')).statusCode).toBe(201);
      await archiveSpace(w.tenant.id, old.id);
      const page = await createPage(w.memberA.headers, w.docs.id, 'movable');
      expectError(
        await call('POST', `/api/v1/pages/${page.id}/move`, w.memberA.headers, { target_space_id: old.id }),
        404,
        'space_not_found'
      );
    });
  });
});
