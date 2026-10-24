import { describe, test, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  withTenantTx,
  versions,
  versionContributors,
  documents,
  pages,
  spaces,
} from '@living-wiki/db';
import { ReviewListSchema, AppError } from '@living-wiki/contracts';
import type { Actor } from '@living-wiki/core';
import { approveVersion } from '../src/routes/pages.js';
import { listReviewQueue } from '../src/routes/reviews.js';
import { canApprove } from '../src/pages/approval.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import {
  bootstrapTenant,
  buildTestApp,
  createAgent,
  signUpMember,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;

describe('review queue: GET /api/v1/reviews', () => {
  const app = buildTestApp();
  useTestDb();

  let w: Awaited<ReturnType<typeof setup>>;
  let slugCounter = 0;

  async function post(headers: Headers, url: string, payload: unknown, status = 201) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  }

  async function makeSpace(
    headers: Headers,
    name: string,
    opts: { allowSelfApproval?: boolean } = {}
  ) {
    return post(headers, '/api/v1/spaces', {
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      review_required: true,
      allow_self_approval: opts.allowSelfApproval ?? false,
    });
  }

  async function grant(headers: Headers, spaceId: string, userId: string, role: string) {
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, {
      principal_type: 'user',
      principal_id: userId,
      role,
    });
  }

  async function createPageAs(
    headers: Headers,
    spaceId: string,
    title: string,
    markdown = 'Some body text.'
  ): Promise<string> {
    slugCounter += 1;
    const res = await post(headers, '/api/v1/pages', {
      space_id: spaceId,
      title,
      slug: `page-${slugCounter}`,
      markdown,
    });
    return res.id;
  }

  async function snapshotAs(headers: Headers, pageId: string) {
    return post(headers, `/api/v1/pages/${pageId}/snapshot`, undefined);
  }

  /** Changes the stored live content, so the next snapshot is a different version. */
  async function rewrite(pageId: string, title: string, markdown: string) {
    const ydocState = await encodePageYDoc(title, markdown);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState })
        .where(and(eq(pages.tenantId, w.tenant.id), eq(pages.documentId, pageId)))
    );
  }

  function list(headers: Headers, query = '') {
    return app.inject({ method: 'GET', url: `/api/v1/reviews${query}`, headers });
  }

  async function queue(headers: Headers, query = '') {
    const res = await list(headers, query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as any[];
  }

  async function setup() {
    const { owner, tenant, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Review Queue Co',
      slug: 'review-queue-co',
    });
    const handbook = await makeSpace(ownerHeaders, 'Handbook');
    const open = await makeSpace(ownerHeaders, 'Open Space', { allowSelfApproval: true });
    // author: reviewer (so a refusal is self_approval, not a missing role).
    const author = await signUpMember(app, tenant.id, 'member', 'author@example.test');
    const reviewer = await signUpMember(app, tenant.id, 'member', 'reviewer@example.test');
    const editor = await signUpMember(app, tenant.id, 'member', 'editor@example.test');
    const viewer = await signUpMember(app, tenant.id, 'member', 'viewer@example.test');
    for (const s of [handbook, open]) {
      await grant(ownerHeaders, s.id, author.userId, 'reviewer');
      await grant(ownerHeaders, s.id, reviewer.userId, 'reviewer');
      await grant(ownerHeaders, s.id, editor.userId, 'editor');
      await grant(ownerHeaders, s.id, viewer.userId, 'viewer');
    }
    return { owner, tenant, ownerHeaders, handbook, open, author, reviewer, editor, viewer };
  }

  beforeEach(async () => {
    slugCounter = 0;
    w = await setup();
  });

  test('a reviewer sees the one pending version with the document, space and contributors', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Onboarding');
    const ver = await snapshotAs(w.author.headers, pageId);

    const items = await queue(w.reviewer.headers);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.version).toMatchObject({ id: ver.id, number: 1, status: 'pending_review' });
    expect(item.document).toEqual({
      id: pageId,
      title: 'Onboarding',
      icon: null,
      kind: 'page',
      spaceId: w.handbook.id,
      spaceName: 'Handbook',
    });
    expect(item.file).toBeNull();
    expect(item.contributors).toEqual([
      { type: 'user', id: w.author.userId, name: 'author', isAgent: false },
    ]);
    expect(item.canApprove).toBe(true);
    ReviewListSchema.parse(items);
  });

  test('the payload carries no heavy columns (exact key sets)', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Keys');
    await snapshotAs(w.author.headers, pageId);

    const [item] = await queue(w.reviewer.headers);
    expect(Object.keys(item).sort()).toEqual(['canApprove', 'contributors', 'document', 'file', 'version']);
    expect(Object.keys(item.version).sort()).toEqual([
      'createdAt',
      'createdBy',
      'createdByName',
      'createdByType',
      'error',
      'id',
      'indexedAt',
      'number',
      'reason',
      'reviewNote',
      'reviewedAt',
      'reviewedBy',
      'status',
    ]);
    expect(Object.keys(item.document).sort()).toEqual(['icon', 'id', 'kind', 'spaceId', 'spaceName', 'title']);
    expect(Object.keys(item.contributors[0]).sort()).toEqual(['id', 'isAgent', 'name', 'type']);
  });

  test('the snapshot author sees it with canApprove false; with self-approval on the space it is true', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Mine');
    await snapshotAs(w.author.headers, pageId);
    const openPage = await createPageAs(w.author.headers, w.open.id, 'Mine Too');
    await snapshotAs(w.author.headers, openPage);

    const items = await queue(w.author.headers);
    const byDoc = new Map(items.map((i) => [i.document.id, i]));
    expect(items).toHaveLength(2);
    expect(byDoc.get(pageId).canApprove).toBe(false);
    expect(byDoc.get(openPage).canApprove).toBe(true);
  });

  test('an editor-only or viewer-only user gets an empty list, not 403', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Hidden from editors');
    await snapshotAs(w.author.headers, pageId);

    for (const who of [w.editor, w.viewer]) {
      const res = await list(who.headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    }
    // A plain member with no grant anywhere.
    const nobody = await signUpMember(app, w.tenant.id, 'member');
    expect(await queue(nobody.headers)).toEqual([]);
  });

  test('a superseded version is excluded; only the newest pending one is listed', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Revised');
    const v1 = await snapshotAs(w.author.headers, pageId);
    await rewrite(pageId, 'Revised', 'A different body.');
    const v2 = await snapshotAs(w.author.headers, pageId);

    const items = await queue(w.reviewer.headers);
    expect(items).toHaveLength(1);
    expect(items[0].version.id).toBe(v2.id);
    expect(items[0].version.id).not.toBe(v1.id);
  });

  test('space_id filters to one space', async () => {
    const a = await createPageAs(w.author.headers, w.handbook.id, 'In handbook');
    await snapshotAs(w.author.headers, a);
    const b = await createPageAs(w.author.headers, w.open.id, 'In open');
    await snapshotAs(w.author.headers, b);

    const only = await queue(w.reviewer.headers, `?space_id=${w.open.id}`);
    expect(only.map((i) => i.document.id)).toEqual([b]);
    expect(await queue(w.reviewer.headers)).toHaveLength(2);
  });

  test('an unreadable space_id is 404 space_not_found with the same body as an unknown uuid or a malformed id', async () => {
    const secret = await makeSpace(w.ownerHeaders, 'Secret Space');
    const stranger = await signUpMember(app, w.tenant.id, 'member');

    const unreadable = await list(stranger.headers, `?space_id=${secret.id}`);
    const unknown = await list(stranger.headers, `?space_id=${randomUUID()}`);
    const malformed = await list(stranger.headers, '?space_id=not-a-uuid');
    expect(unreadable.statusCode).toBe(404);
    expect(unreadable.json().error).toBe('space_not_found');
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unreadable.json()).toEqual(unknown.json());
    expect(malformed.json()).toEqual(unknown.json());
  });

  test('a readable space_id below reviewer is an empty list, not 403', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Editors cannot review');
    await snapshotAs(w.author.headers, pageId);
    const res = await list(w.editor.headers, `?space_id=${w.handbook.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  test('another tenant\'s space_id is 404 space_not_found', async () => {
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const theirs = await makeSpace(other.headers, 'Theirs');
    const res = await list(w.ownerHeaders, `?space_id=${theirs.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('space_not_found');
  });

  test('an agent contributor is listed with isAgent; canApprove is false only for the human author', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Agent touched');
    const ver = await snapshotAs(w.author.headers, pageId);
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Helper Bot' });
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(versionContributors).values({
        tenantId: w.tenant.id,
        versionId: ver.id,
        principalType: 'agent',
        principalId: agentId,
      })
    );

    const forReviewer = await queue(w.reviewer.headers);
    expect(forReviewer[0].contributors).toEqual(
      expect.arrayContaining([
        { type: 'agent', id: agentId, name: 'Helper Bot', isAgent: true },
        { type: 'user', id: w.author.userId, name: 'author', isAgent: false },
      ])
    );
    expect(forReviewer[0].canApprove).toBe(true);
    expect((await queue(w.author.headers))[0].canApprove).toBe(false);

    // The version itself created by the agent: still needs a human who did not write it.
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(versions)
        .set({ createdByType: 'agent', createdBy: agentId })
        .where(and(eq(versions.tenantId, w.tenant.id), eq(versions.id, ver.id)))
    );
    expect((await queue(w.reviewer.headers))[0].canApprove).toBe(true);
  });

  test('a contributor row whose principal is gone falls back to the id as the name', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Ghost');
    const ver = await snapshotAs(w.author.headers, pageId);
    const ghost = randomUUID();
    // No FK on principal_id: an agent row that no longer exists.
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(versionContributors).values({
        tenantId: w.tenant.id,
        versionId: ver.id,
        principalType: 'agent',
        principalId: ghost,
      })
    );
    const [item] = await queue(w.reviewer.headers);
    expect(item.contributors).toContainEqual({ type: 'agent', id: ghost, name: ghost, isAgent: true });
  });

  test('an agent actor gets an empty list', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Not for agents');
    await snapshotAs(w.author.headers, pageId);
    const agentId = await createAgent(w.tenant.id, w.owner.userId);
    const agentActor: Actor = {
      tenantId: w.tenant.id,
      principalType: 'agent',
      principalId: agentId,
    };
    expect(await listReviewQueue(agentActor, {})).toEqual([]);
  });

  test('a tenant admin sees pending versions in every space, the Inbox included', async () => {
    const a = await createPageAs(w.author.headers, w.handbook.id, 'In handbook');
    await snapshotAs(w.author.headers, a);
    const b = await createPageAs(w.author.headers, w.open.id, 'In open');
    await snapshotAs(w.author.headers, b);
    // A member's private Inbox item, forced to pending review.
    const inboxPage = await createPageAs(w.editor.headers, await inboxId(), 'Private note');
    const inboxVer = await snapshotAs(w.editor.headers, inboxPage);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(versions)
        .set({ status: 'pending_review' })
        .where(and(eq(versions.tenantId, w.tenant.id), eq(versions.id, inboxVer.id)))
    );

    const adminItems = await queue(w.ownerHeaders);
    expect(adminItems.map((i) => i.document.id).sort()).toEqual([a, b, inboxPage].sort());
    const inboxItem = adminItems.find((i) => i.document.id === inboxPage);
    expect(inboxItem.document.spaceName).toBeTruthy();
    // The owner did not write any of them.
    expect(adminItems.every((i) => i.canApprove)).toBe(true);

    // A reviewer elsewhere never sees the Inbox item; a user with the admin tenant role does.
    expect((await queue(w.reviewer.headers)).map((i) => i.document.id).sort()).toEqual([a, b].sort());
    const admin = await signUpMember(app, w.tenant.id, 'admin');
    expect((await queue(admin.headers)).map((i) => i.document.id).sort()).toEqual([a, b, inboxPage].sort());
  });

  async function inboxId(): Promise<string> {
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.kind, 'inbox')))
    );
    return rows[0]!.id;
  }

  test('oldest first across two documents', async () => {
    const first = await createPageAs(w.author.headers, w.handbook.id, 'First in line');
    const second = await createPageAs(w.author.headers, w.open.id, 'Second in line');
    // Snapshot the later-created page first: order follows the version's createdAt.
    await snapshotAs(w.author.headers, second);
    await snapshotAs(w.author.headers, first);

    const items = await queue(w.reviewer.headers);
    expect(items.map((i) => i.document.id)).toEqual([second, first]);
    const stamps = items.map((i) => Date.parse(i.version.createdAt));
    expect(stamps[0]).toBeLessThanOrEqual(stamps[1]);
  });

  test('a page in an archived space is not listed', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Soon archived');
    await snapshotAs(w.author.headers, pageId);
    expect(await queue(w.reviewer.headers)).toHaveLength(1);

    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, w.handbook.id)))
    );
    expect(await queue(w.reviewer.headers)).toEqual([]);
    // Archived is unreadable to non-admins, so a filter on it is the unknown-space 404.
    const filtered = await list(w.reviewer.headers, `?space_id=${w.handbook.id}`);
    expect(filtered.statusCode).toBe(404);
    expect(filtered.json().error).toBe('space_not_found');
  });

  test('an archived document is not listed', async () => {
    const pageId = await createPageAs(w.author.headers, w.handbook.id, 'Archived page');
    await snapshotAs(w.author.headers, pageId);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(documents)
        .set({ archivedAt: new Date() })
        .where(and(eq(documents.tenantId, w.tenant.id), eq(documents.id, pageId)))
    );
    expect(await queue(w.reviewer.headers)).toEqual([]);
  });

  test('unauthenticated requests are 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reviews' });
    expect(res.statusCode).toBe(401);
  });

  test('approveVersion rejects exactly when canApprove is false for the same inputs', async () => {
    const actorOf = (
      userId: string,
      tenantRole: Actor['tenantRole']
    ): Actor => ({ tenantId: w.tenant.id, principalType: 'user', principalId: userId, tenantRole });

    const cases: Array<{
      name: string;
      creator: Headers;
      spaceId: string;
      actor: Actor;
      expected: boolean;
    }> = [
      { name: 'author, self-approval off', creator: w.author.headers, spaceId: w.handbook.id, actor: actorOf(w.author.userId, 'member'), expected: false },
      { name: 'other reviewer', creator: w.author.headers, spaceId: w.handbook.id, actor: actorOf(w.reviewer.userId, 'member'), expected: true },
      { name: 'owner who did not write it', creator: w.author.headers, spaceId: w.handbook.id, actor: actorOf(w.owner.userId, 'owner'), expected: true },
      { name: 'owner who created the page', creator: w.ownerHeaders, spaceId: w.handbook.id, actor: actorOf(w.owner.userId, 'owner'), expected: false },
      { name: 'author, self-approval on', creator: w.author.headers, spaceId: w.open.id, actor: actorOf(w.author.userId, 'member'), expected: true },
    ];

    for (const c of cases) {
      const pageId = await createPageAs(c.creator, c.spaceId, `Table ${c.name}`);
      const ver = await snapshotAs(c.creator, pageId);

      const inputs = await withTenantTx(w.tenant.id, async (tx) => {
        const [v] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.tenantId, w.tenant.id), eq(versions.id, ver.id)));
        const contributors = await tx
          .select()
          .from(versionContributors)
          .where(
            and(
              eq(versionContributors.tenantId, w.tenant.id),
              eq(versionContributors.versionId, ver.id)
            )
          );
        const [space] = await tx
          .select()
          .from(spaces)
          .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, c.spaceId)));
        return { v: v!, contributors, space: space! };
      });

      const allowed = canApprove(c.actor, inputs.v, inputs.contributors, inputs.space);
      expect(allowed, c.name).toBe(c.expected);

      let outcome: 'approved' | string = 'approved';
      try {
        await approveVersion(c.actor, ver.id);
      } catch (err) {
        outcome = err instanceof AppError ? err.code : 'unexpected';
      }
      if (allowed) {
        expect(outcome, c.name).toBe('approved');
      } else {
        expect(outcome, c.name).toBe('self_approval');
      }
    }
  });

  test('canApprove is false for an agent actor whatever the space allows', () => {
    const agent: Actor = { tenantId: 't', principalType: 'agent', principalId: 'a' };
    const version = { createdByType: 'user', createdBy: 'someone-else' } as any;
    expect(canApprove(agent, version, [], { allowSelfApproval: true } as any)).toBe(false);
    expect(canApprove(agent, version, [], { allowSelfApproval: false } as any)).toBe(false);
  });
});
