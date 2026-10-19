import { describe, test, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenantTx, versions, documents, spaces, memberships } from '@living-wiki/db';
import { UpdatesResponseSchema, type UpdateItem } from '@living-wiki/contracts';
import {
  bootstrapTenant,
  buildTestApp,
  createAgent,
  signUpMember,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;
type VersionStatus = typeof versions.$inferInsert.status;

/** GET /api/v1/updates: the workspace feed of recent page versions. */
describe('workspace updates feed', () => {
  const app = buildTestApp();
  useTestDb();

  let w: Awaited<ReturnType<typeof setup>>;
  let slugCounter = 0;
  const T0 = Date.parse('2026-10-19T10:00:00.000Z');
  /** Version times are set explicitly (minutes after T0) so ordering is exact. */
  const at = (minutes: number) => new Date(T0 + minutes * 60_000);

  async function post(headers: Headers, url: string, payload: unknown, status = 201) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  }

  async function makeSpace(headers: Headers, name: string) {
    return post(headers, '/api/v1/spaces', {
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      review_required: false,
    });
  }

  async function grant(headers: Headers, spaceId: string, userId: string, role: string) {
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, {
      principal_type: 'user',
      principal_id: userId,
      role,
    });
  }

  async function createPageAs(headers: Headers, spaceId: string, title: string): Promise<string> {
    slugCounter += 1;
    const res = await post(headers, '/api/v1/pages', {
      space_id: spaceId,
      title,
      slug: `page-${slugCounter}`,
      markdown: 'Some body text.',
    });
    return res.id;
  }

  /** Inserts a version row directly, so status, author and time are exact. */
  async function addVersion(
    tenantId: string,
    documentId: string,
    opts: {
      number: number;
      status: VersionStatus;
      minutes: number;
      by?: { type: 'user' | 'agent' | 'connector'; id: string };
      reason?: 'quiet' | 'submit' | 'agent' | 'restore' | 'upload' | 'source' | 'transcript';
    }
  ): Promise<string> {
    const id = randomUUID();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(versions).values({
        id,
        tenantId,
        documentId,
        number: opts.number,
        title: 'ignored',
        status: opts.status,
        contentHash: `hash-${id}`,
        reason: opts.reason ?? 'submit',
        createdByType: opts.by?.type ?? 'user',
        createdBy: opts.by?.id ?? w.owner.userId,
        createdAt: at(opts.minutes),
      })
    );
    return id;
  }

  function feed(headers: Headers, query = '') {
    return app.inject({ method: 'GET', url: `/api/v1/updates${query}`, headers });
  }

  async function updates(headers: Headers, query = ''): Promise<UpdateItem[]> {
    const res = await feed(headers, query);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    return UpdatesResponseSchema.parse(body);
  }

  async function setup() {
    const { owner, tenant, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Updates Co',
      slug: 'updates-co',
    });
    const handbook = await makeSpace(ownerHeaders, 'Handbook');
    const secret = await makeSpace(ownerHeaders, 'Secret Plans');
    const editor = await signUpMember(app, tenant.id, 'member', 'editor@example.test');
    const viewer = await signUpMember(app, tenant.id, 'member', 'viewer@example.test');
    const outsider = await signUpMember(app, tenant.id, 'member', 'outsider@example.test');
    await grant(ownerHeaders, handbook.id, editor.userId, 'editor');
    await grant(ownerHeaders, handbook.id, viewer.userId, 'viewer');
    return { owner, tenant, ownerHeaders, inbox: inboxSpace, handbook, secret, editor, viewer, outsider };
  }

  beforeEach(async () => {
    slugCounter = 0;
    w = await setup();
  });

  test('returns the newest versions first across spaces, default 8, limit narrows it', async () => {
    const a = await createPageAs(w.ownerHeaders, w.handbook.id, 'Alpha');
    const b = await createPageAs(w.ownerHeaders, w.secret.id, 'Beta');
    for (let i = 1; i <= 5; i++) {
      await addVersion(w.tenant.id, i % 2 ? a : b, { number: i, status: 'indexed', minutes: i });
    }
    const all = await updates(w.ownerHeaders);
    expect(all.map((u) => u.number)).toEqual([5, 4, 3, 2, 1]);
    expect(all.map((u) => u.document.title)).toEqual(['Alpha', 'Beta', 'Alpha', 'Beta', 'Alpha']);
    expect(all[0]!.document.spaceName).toBe('Handbook');

    const two = await updates(w.ownerHeaders, '?limit=2');
    expect(two.map((u) => u.number)).toEqual([5, 4]);
  });

  test('the default is 8 rows and the limit is 1..30', async () => {
    const a = await createPageAs(w.ownerHeaders, w.handbook.id, 'Alpha');
    for (let i = 1; i <= 10; i++) {
      await addVersion(w.tenant.id, a, { number: i, status: 'indexed', minutes: i });
    }
    expect(await updates(w.ownerHeaders)).toHaveLength(8);
    expect(await updates(w.ownerHeaders, '?limit=10')).toHaveLength(10);
    for (const bad of ['0', '31', 'abc', '-1', '1.5']) {
      const res = await feed(w.ownerHeaders, `?limit=${bad}`);
      expect(res.statusCode, `limit=${bad}`).toBe(400);
    }
  });

  test('a viewer sees only the spaces they can read; an outsider sees nothing', async () => {
    const a = await createPageAs(w.ownerHeaders, w.handbook.id, 'Alpha');
    const b = await createPageAs(w.ownerHeaders, w.secret.id, 'Secret page');
    await addVersion(w.tenant.id, a, { number: 1, status: 'indexed', minutes: 1 });
    await addVersion(w.tenant.id, b, { number: 1, status: 'indexed', minutes: 2 });

    expect((await updates(w.viewer.headers)).map((u) => u.document.title)).toEqual(['Alpha']);
    expect((await updates(w.editor.headers)).map((u) => u.document.title)).toEqual(['Alpha']);
    expect(await updates(w.outsider.headers)).toEqual([]);
    expect((await updates(w.ownerHeaders)).map((u) => u.document.title)).toEqual(['Secret page', 'Alpha']);
  });

  test("an Inbox item is visible only to its creator and tenant admins, and never shortens the page of results", async () => {
    const mine = await createPageAs(w.editor.headers, w.inbox.id, 'Editor private');
    const shared = await createPageAs(w.ownerHeaders, w.handbook.id, 'Shared page');
    await addVersion(w.tenant.id, shared, { number: 1, status: 'indexed', minutes: 1 });
    await addVersion(w.tenant.id, mine, {
      number: 1,
      status: 'pending_review',
      minutes: 2,
      by: { type: 'user', id: w.editor.userId },
    });

    // The owner (an admin) sees both; the creator sees both.
    expect((await updates(w.ownerHeaders)).map((u) => u.document.title)).toEqual(['Editor private', 'Shared page']);
    expect((await updates(w.editor.headers)).map((u) => u.document.title)).toEqual(['Editor private', 'Shared page']);
    // Another reader of the handbook never sees it, and limit=1 still returns the visible row.
    expect((await updates(w.viewer.headers)).map((u) => u.document.title)).toEqual(['Shared page']);
    expect((await updates(w.viewer.headers, '?limit=1')).map((u) => u.document.title)).toEqual(['Shared page']);
  });

  test('archived pages, pages in archived spaces and files are left out', async () => {
    const live = await createPageAs(w.ownerHeaders, w.handbook.id, 'Live page');
    const gone = await createPageAs(w.ownerHeaders, w.handbook.id, 'Archived page');
    const inArchivedSpace = await createPageAs(w.ownerHeaders, w.secret.id, 'Page in archived space');
    await addVersion(w.tenant.id, live, { number: 1, status: 'indexed', minutes: 1 });
    await addVersion(w.tenant.id, gone, { number: 1, status: 'indexed', minutes: 2 });
    await addVersion(w.tenant.id, inArchivedSpace, { number: 1, status: 'indexed', minutes: 3 });
    const [file] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .insert(documents)
        .values({
          tenantId: w.tenant.id,
          spaceId: w.handbook.id,
          kind: 'file',
          title: 'Quarterly report.pdf',
          createdByType: 'user',
          createdBy: w.owner.userId,
        })
        .returning({ id: documents.id })
    );
    await addVersion(w.tenant.id, file!.id, { number: 1, status: 'indexed', minutes: 4, reason: 'upload' });

    await post(w.ownerHeaders, `/api/v1/pages/${gone}/archive`, undefined, 200);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, w.secret.id)))
    );

    // Not even a tenant admin sees them.
    expect((await updates(w.ownerHeaders)).map((u) => u.document.title)).toEqual(['Live page']);
  });

  test("another tenant's versions never appear", async () => {
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const space = await makeSpace(other.headers, 'Other Handbook');
    const page = await createPageAs(other.headers, space.id, 'Other tenant page');
    await addVersion(other.tenant.id, page, {
      number: 1,
      status: 'indexed',
      minutes: 9,
      by: { type: 'user', id: other.owner.userId },
    });
    const mine = await createPageAs(w.ownerHeaders, w.handbook.id, 'Mine');
    await addVersion(w.tenant.id, mine, { number: 1, status: 'indexed', minutes: 1 });

    expect((await updates(w.ownerHeaders)).map((u) => u.document.title)).toEqual(['Mine']);
    expect((await updates(other.headers)).map((u) => u.document.title)).toEqual(['Other tenant page']);
  });

  test('only pending_review, indexed, rejected, withdrawn and failed versions are shown', async () => {
    const page = await createPageAs(w.ownerHeaders, w.handbook.id, 'Statuses');
    const statuses: VersionStatus[] = [
      'extracting',
      'pending_review',
      'indexing',
      'indexed',
      'superseded',
      'rejected',
      'withdrawn',
      'failed',
      'stored',
    ];
    for (const [i, status] of statuses.entries()) {
      await addVersion(w.tenant.id, page, { number: i + 1, status, minutes: i + 1 });
    }
    const shown = await updates(w.ownerHeaders, '?limit=30');
    expect(shown.map((u) => u.status).sort()).toEqual(
      ['failed', 'indexed', 'pending_review', 'rejected', 'withdrawn']
    );
  });

  test('actor: a member by name, an agent by name, a connector as System, a former member as such', async () => {
    const page = await createPageAs(w.ownerHeaders, w.handbook.id, 'Authors');
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Support bot' });
    await addVersion(w.tenant.id, page, {
      number: 1,
      status: 'indexed',
      minutes: 1,
      by: { type: 'user', id: w.editor.userId },
    });
    await addVersion(w.tenant.id, page, {
      number: 2,
      status: 'pending_review',
      minutes: 2,
      by: { type: 'agent', id: agentId },
      reason: 'agent',
    });
    await addVersion(w.tenant.id, page, {
      number: 3,
      status: 'indexed',
      minutes: 3,
      by: { type: 'connector', id: randomUUID() },
      reason: 'source',
    });
    await addVersion(w.tenant.id, page, {
      number: 4,
      status: 'indexed',
      minutes: 4,
      by: { type: 'user', id: w.outsider.userId },
    });
    // The outsider leaves the workspace: their versions stay, the name goes.
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.outsider.userId)))
    );

    const byNumber = new Map((await updates(w.ownerHeaders)).map((u) => [u.number, u.actor]));
    expect(byNumber.get(1)).toEqual({ type: 'user', id: w.editor.userId, name: 'editor' });
    expect(byNumber.get(2)).toEqual({ type: 'agent', id: agentId, name: 'Support bot' });
    expect(byNumber.get(3)).toEqual({ type: 'system', id: null, name: 'System' });
    expect(byNumber.get(4)).toEqual({ type: 'user', id: w.outsider.userId, name: 'Former member' });
  });

  test('the payload carries exactly the contract keys (no markdown, blocks or ydoc)', async () => {
    const page = await createPageAs(w.ownerHeaders, w.handbook.id, 'Keys');
    const versionId = await addVersion(w.tenant.id, page, { number: 1, status: 'indexed', minutes: 1 });
    const res = await feed(w.ownerHeaders);
    const [item] = res.json() as Record<string, any>[];
    expect(Object.keys(item!).sort()).toEqual(
      ['actor', 'createdAt', 'document', 'number', 'reason', 'status', 'versionId']
    );
    expect(Object.keys(item!.document).sort()).toEqual(['id', 'spaceId', 'spaceName', 'title']);
    expect(Object.keys(item!.actor).sort()).toEqual(['id', 'name', 'type']);
    expect(item).toMatchObject({
      versionId,
      number: 1,
      status: 'indexed',
      reason: 'submit',
      createdAt: at(1).toISOString(),
    });
  });

  test('requires a signed-in workspace member', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/updates' });
    expect(res.statusCode).toBe(401);
  });
});
