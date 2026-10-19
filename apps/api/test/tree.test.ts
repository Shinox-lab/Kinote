import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versions, documents, auditEvents } from '@living-wiki/db';
import {
  buildTestApp,
  bootstrapTenant,
  signUpMember,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;
type Node = {
  id: string;
  parentId: string | null;
  position: string;
  kind: string;
  title: string;
  slug: string | null;
};

/** Tree, archived list, space archive and page restore. */
describe('tree, archived list, space archive, page restore', () => {
  const app = buildTestApp();
  useTestDb();

  let ctx: Awaited<ReturnType<typeof setup>>;

  async function createSpace(headers: Headers, slug: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: slug, slug, review_required: false },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  }

  async function grant(headers: Headers, spaceId: string, userId: string, role: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${spaceId}/grants`,
      headers,
      payload: { principal_type: 'user', principal_id: userId, role },
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  async function setup() {
    const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Tree Co',
      slug: 'tree-co',
    });
    const docs = await createSpace(ownerHeaders, 'docs');
    const editor = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    const spaceAdmin = await signUpMember(app, tenant.id, 'member');
    const outsider = await signUpMember(app, tenant.id, 'member');
    const other = await signUpMember(app, tenant.id, 'member');
    await grant(ownerHeaders, docs.id, editor.userId, 'editor');
    await grant(ownerHeaders, docs.id, viewer.userId, 'viewer');
    await grant(ownerHeaders, docs.id, spaceAdmin.userId, 'admin');
    return { tenant, owner, ownerHeaders, inbox: inboxSpace, docs, editor, viewer, spaceAdmin, outsider, other };
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  async function createPage(
    headers: Headers,
    spaceId: string,
    slug: string,
    title = `Page ${slug}`,
    parentId: string | null = null
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title, slug, markdown: 'Some text.', parent_id: parentId },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().document.id;
  }

  function post(headers: Headers, url: string) {
    return app.inject({ method: 'POST', url, headers });
  }

  function archivePage(headers: Headers, pageId: string) {
    return post(headers, `/api/v1/pages/${pageId}/archive`);
  }

  async function tree(headers: Headers, spaceId: string) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/spaces/${spaceId}/tree`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as { nodes: Node[] }).nodes;
  }

  async function archivedList(headers: Headers, spaceId: string) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/spaces/${spaceId}/archived`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as { nodes: Node[] }).nodes;
  }

  async function auditTypes(type: string, subjectId: string) {
    const rows = await withTenantTx(ctx.tenant.id, (tx) =>
      tx
        .select({ type: auditEvents.type })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, ctx.tenant.id), eq(auditEvents.subjectId, subjectId)))
    );
    return rows.filter((r) => r.type === type).length;
  }

  describe('GET /spaces/:id/tree', () => {
    test('nodes are ordered by position then title and link to their parents', async () => {
      const h = ctx.editor.headers;
      const root = await createPage(h, ctx.docs.id, 'root', 'Root');
      const zed = await createPage(h, ctx.docs.id, 'zed', 'Zed');
      const alpha = await createPage(h, ctx.docs.id, 'alpha', 'Alpha');
      const child = await createPage(h, ctx.docs.id, 'child', 'Child', root);

      // Positions: Zed gets 'a0' (default) like Root and Alpha; push Root last.
      const moved = await app.inject({
        method: 'POST',
        url: `/api/v1/pages/${root}/move`,
        headers: h,
        payload: { target_space_id: ctx.docs.id, position: 'b0' },
      });
      assert.equal(moved.statusCode, 200, moved.body);

      const nodes = await tree(ctx.viewer.headers, ctx.docs.id);
      assert.deepEqual(
        nodes.map((n) => n.title),
        ['Alpha', 'Child', 'Zed', 'Root']
      );
      const byId = new Map(nodes.map((n) => [n.id, n]));
      assert.equal(byId.get(child)!.parentId, root);
      assert.equal(byId.get(root)!.parentId, null);
      assert.equal(byId.get(alpha)!.parentId, null);
      assert.equal(byId.get(zed)!.kind, 'page');
      assert.equal(byId.get(zed)!.slug, 'zed');
      assert.equal(byId.get(zed)!.position, 'a0');
      assert.deepEqual(Object.keys(byId.get(zed)!).sort(), [
        'id',
        'kind',
        'parentId',
        'position',
        'slug',
        'title',
      ]);
    });

    test('an archived page is absent from the tree and present in the archived list', async () => {
      const keep = await createPage(ctx.editor.headers, ctx.docs.id, 'keep', 'Keep');
      const gone = await createPage(ctx.editor.headers, ctx.docs.id, 'gone', 'Gone');
      const archived = await archivePage(ctx.spaceAdmin.headers, gone);
      assert.equal(archived.statusCode, 200, archived.body);

      assert.deepEqual((await tree(ctx.viewer.headers, ctx.docs.id)).map((n) => n.id), [keep]);
      const list = await archivedList(ctx.spaceAdmin.headers, ctx.docs.id);
      assert.deepEqual(list.map((n) => n.id), [gone]);
      assert.equal(list[0].title, 'Gone');
      assert.equal(list[0].slug, 'gone');
    });

    test('the archived list is ordered by title', async () => {
      const b = await createPage(ctx.editor.headers, ctx.docs.id, 'b', 'Bravo');
      const a = await createPage(ctx.editor.headers, ctx.docs.id, 'a', 'Alpha');
      for (const id of [b, a]) {
        assert.equal((await archivePage(ctx.spaceAdmin.headers, id)).statusCode, 200);
      }
      assert.deepEqual((await archivedList(ctx.ownerHeaders, ctx.docs.id)).map((n) => n.title), [
        'Alpha',
        'Bravo',
      ]);
    });

    test('the Inbox tree shows a member only their own pages and a tenant admin all of them', async () => {
      const mine = await createPage(ctx.editor.headers, ctx.inbox.id, 'mine', 'Mine');
      const theirs = await createPage(ctx.other.headers, ctx.inbox.id, 'theirs', 'Theirs');

      assert.deepEqual((await tree(ctx.editor.headers, ctx.inbox.id)).map((n) => n.id), [mine]);
      assert.deepEqual((await tree(ctx.other.headers, ctx.inbox.id)).map((n) => n.id), [theirs]);
      assert.deepEqual(
        (await tree(ctx.ownerHeaders, ctx.inbox.id)).map((n) => n.id).sort(),
        [mine, theirs].sort()
      );
    });

    test('a user with no access gets the same 404 as for an unknown space', async () => {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${ctx.docs.id}/tree`,
        headers: ctx.outsider.headers,
      });
      const unknown = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${randomUUID()}/tree`,
        headers: ctx.outsider.headers,
      });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.json().error, 'space_not_found');
      assert.deepEqual(denied.json(), unknown.json());
    });
  });

  describe('GET /spaces/:id/archived', () => {
    test('requires space admin: an editor gets 403, an outsider 404', async () => {
      const editor = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${ctx.docs.id}/archived`,
        headers: ctx.editor.headers,
      });
      assert.equal(editor.statusCode, 403, editor.body);
      assert.equal(editor.json().error, 'forbidden');
      const outsider = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${ctx.docs.id}/archived`,
        headers: ctx.outsider.headers,
      });
      assert.equal(outsider.statusCode, 404, outsider.body);
      assert.equal(outsider.json().error, 'space_not_found');
    });
  });

  describe('POST /spaces/:id/archive', () => {
    test('is refused while a page remains and succeeds once every page is archived', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p', 'P');
      const refused = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error, 'has_children');

      assert.equal((await archivePage(ctx.spaceAdmin.headers, page)).statusCode, 200);
      const ok = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.notEqual(ok.json().archivedAt, null);
      assert.equal(ok.json().id, ctx.docs.id);
      assert.equal(ok.json().myRole, 'admin');
      assert.equal(await auditTypes('space.archived', ctx.docs.id), 1);

      // Invisible to a member, still readable by the tenant admin.
      const member = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${ctx.docs.id}`,
        headers: ctx.editor.headers,
      });
      assert.equal(member.statusCode, 404, member.body);
      const admin = await app.inject({
        method: 'GET',
        url: `/api/v1/spaces/${ctx.docs.id}`,
        headers: ctx.ownerHeaders,
      });
      assert.equal(admin.statusCode, 200, admin.body);

      // Nothing can be created in it.
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers: ctx.ownerHeaders,
        payload: { space_id: ctx.docs.id, title: 'T', slug: 't', markdown: '' },
      });
      assert.equal(create.statusCode, 409, create.body);
      assert.equal(create.json().error, 'space_archived');
    });

    test('a space admin (not tenant admin) can archive; an editor gets 403', async () => {
      const forbidden = await post(ctx.editor.headers, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(forbidden.statusCode, 403, forbidden.body);
      assert.equal(forbidden.json().error, 'forbidden');
      const ok = await post(ctx.spaceAdmin.headers, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().myRole, 'admin');
    });

    test('archived documents (and only those) do not block it', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p');
      const child = await createPage(ctx.editor.headers, ctx.docs.id, 'c', 'C', page);
      assert.equal((await archivePage(ctx.ownerHeaders, child)).statusCode, 200);
      const refused = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal((await archivePage(ctx.ownerHeaders, page)).statusCode, 200);
      const ok = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(ok.statusCode, 200, ok.body);
    });

    test('the Inbox cannot be archived (403 forbidden)', async () => {
      const res = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.inbox.id}/archive`);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json().error, 'forbidden');
    });

    test('archiving twice is 409 space_archived', async () => {
      const first = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(first.statusCode, 200, first.body);
      const second = await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(second.json().error, 'space_archived');
    });

    test('an unknown or unreadable space is 404 space_not_found', async () => {
      const res = await post(ctx.outsider.headers, `/api/v1/spaces/${ctx.docs.id}/archive`);
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'space_not_found');
    });
  });

  describe('POST /pages/:id/restore', () => {
    async function pageBadge(headers: Headers, pageId: string) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}`, headers });
      assert.equal(res.statusCode, 200, res.body);
      return res.json() as {
        badge: string;
        archivedAt: string | null;
        parentId: string | null;
        versions: Array<{ status: string }>;
      };
    }

    test('returns the page Withdrawn with its versions still withdrawn', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p', 'P');
      const snap = await post(ctx.editor.headers, `/api/v1/pages/${page}/snapshot`);
      assert.equal(snap.statusCode, 201, snap.body);
      assert.equal((await archivePage(ctx.spaceAdmin.headers, page)).statusCode, 200);

      const res = await post(ctx.spaceAdmin.headers, `/api/v1/pages/${page}/restore`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().id, page);
      assert.equal(res.json().archivedAt, null);

      const details = await pageBadge(ctx.spaceAdmin.headers, page);
      assert.equal(details.archivedAt, null);
      assert.equal(details.badge, 'Withdrawn');
      assert.ok(details.versions.length > 0);
      assert.ok(details.versions.every((v) => v.status === 'withdrawn'));
      const rows = await withTenantTx(ctx.tenant.id, (tx) =>
        tx.select({ s: versions.status }).from(versions).where(eq(versions.tenantId, ctx.tenant.id))
      );
      assert.ok(rows.every((r) => r.s === 'withdrawn'));

      assert.equal(await auditTypes('page.restored', page), 1);
      // Back in the tree, out of the archived list.
      assert.deepEqual((await tree(ctx.viewer.headers, ctx.docs.id)).map((n) => n.id), [page]);
      assert.deepEqual(await archivedList(ctx.spaceAdmin.headers, ctx.docs.id), []);
    });

    test('re-parents to the root when the parent is archived', async () => {
      const parent = await createPage(ctx.editor.headers, ctx.docs.id, 'parent', 'Parent');
      const child = await createPage(ctx.editor.headers, ctx.docs.id, 'child', 'Child', parent);
      assert.equal((await archivePage(ctx.spaceAdmin.headers, child)).statusCode, 200);
      assert.equal((await archivePage(ctx.spaceAdmin.headers, parent)).statusCode, 200);

      const res = await post(ctx.spaceAdmin.headers, `/api/v1/pages/${child}/restore`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().parentId, null);
      assert.equal((await pageBadge(ctx.spaceAdmin.headers, child)).parentId, null);
    });

    test('keeps a live parent', async () => {
      const parent = await createPage(ctx.editor.headers, ctx.docs.id, 'parent', 'Parent');
      const child = await createPage(ctx.editor.headers, ctx.docs.id, 'child', 'Child', parent);
      assert.equal((await archivePage(ctx.spaceAdmin.headers, child)).statusCode, 200);
      const res = await post(ctx.spaceAdmin.headers, `/api/v1/pages/${child}/restore`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().parentId, parent);
    });

    test('a space editor gets 403 forbidden', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p');
      assert.equal((await archivePage(ctx.spaceAdmin.headers, page)).statusCode, 200);
      const res = await post(ctx.editor.headers, `/api/v1/pages/${page}/restore`);
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json().error, 'forbidden');
      assert.notEqual((await pageBadge(ctx.spaceAdmin.headers, page)).archivedAt, null);
    });

    test('restoring a page that is not archived is a 200 no-op', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p');
      const res = await post(ctx.spaceAdmin.headers, `/api/v1/pages/${page}/restore`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().id, page);
      assert.equal(res.json().archivedAt, null);
      assert.equal(await auditTypes('page.restored', page), 0);
    });

    test('an unknown page, or one the actor cannot see, is 404 page_not_found', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p');
      const unknown = await post(ctx.outsider.headers, `/api/v1/pages/${randomUUID()}/restore`);
      const hidden = await post(ctx.outsider.headers, `/api/v1/pages/${page}/restore`);
      assert.equal(unknown.statusCode, 404, unknown.body);
      assert.equal(hidden.statusCode, 404, hidden.body);
      assert.equal(hidden.json().error, 'page_not_found');
      assert.deepEqual(hidden.json(), unknown.json());
    });

    test('in an archived space a tenant admin gets 409 space_archived', async () => {
      const page = await createPage(ctx.editor.headers, ctx.docs.id, 'p');
      assert.equal((await archivePage(ctx.ownerHeaders, page)).statusCode, 200);
      assert.equal(
        (await post(ctx.ownerHeaders, `/api/v1/spaces/${ctx.docs.id}/archive`)).statusCode,
        200
      );
      const res = await post(ctx.ownerHeaders, `/api/v1/pages/${page}/restore`);
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json().error, 'space_archived');
      const [row] = await withTenantTx(ctx.tenant.id, (tx) =>
        tx.select().from(documents).where(and(eq(documents.tenantId, ctx.tenant.id), eq(documents.id, page)))
      );
      assert.notEqual(row.archivedAt, null);
    });
  });
});
