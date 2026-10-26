import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { withTenantTx, versions, pages, spaces, documents } from '@living-wiki/db';
import { AppError, VersionSummarySchema } from '@living-wiki/contracts';
import { signCollabToken, getCollabTokenSecret, documentName } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { fragmentText } from '../../collab/test/support/blocks.js';
import { waitFor } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import type { CollabClient } from '@living-wiki/shared';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * POST /api/v1/pages/:id/versions/:n/restore over a real collab server: the
 * old content comes back as a NEW version, history stays as it was.
 */
describe('restore a version', () => {
  let server: CollabServer;
  let port: number;
  let app: ReturnType<typeof buildTestApp>;
  const clients: ConnectedClient[] = [];

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    app = buildTestApp({ collab: new InProcessCollabClient(server) });
  });
  useTestDb();
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  async function post(headers: Headers, url: string, payload?: unknown, status = 201) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  }

  /** A tenant, a space, an editor, a viewer and a page whose live content says `alpha`. */
  async function setup(opts: { reviewRequired?: boolean } = {}) {
    const { owner, tenant, headers } = await bootstrapTenant(app, {
      name: 'Restore Co',
      slug: 'restore-co',
    });
    const space = await post(headers, '/api/v1/spaces', {
      name: 'Docs',
      slug: 'docs',
      review_required: opts.reviewRequired ?? false,
      allow_self_approval: true,
    });
    const grant = (userId: string, role: string) =>
      post(headers, `/api/v1/spaces/${space.id}/grants`, {
        principal_type: 'user',
        principal_id: userId,
        role,
      });
    const editor = await signUpMember(app, tenant.id, 'member');
    await grant(editor.userId, 'editor');
    const viewer = await signUpMember(app, tenant.id, 'member');
    await grant(viewer.userId, 'viewer');
    const stranger = await signUpMember(app, tenant.id, 'member');
    const page = await post(headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Original',
      slug: 'restore-me',
      markdown: 'alpha',
    });
    return { owner, tenant, headers, space, editor, viewer, stranger, page };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  async function snapshot(w: World, headers: Headers = w.headers) {
    return post(headers, `/api/v1/pages/${w.page.id}/snapshot`);
  }

  /** Changes the stored live content, so the next snapshot is a new version. */
  async function rewrite(w: World, title: string, markdown: string) {
    const ydocState = await encodePageYDoc(title, markdown);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState })
        .where(and(eq(pages.tenantId, w.tenant.id), eq(pages.documentId, w.page.id)))
    );
  }

  /** v1 `alpha` ("Original"), then v2 `beta` ("Renamed"), each indexed by the worker. */
  async function twoIndexedVersions(w: World) {
    await snapshot(w);
    await runPendingJobsForTenant(w.tenant.id);
    await rewrite(w, 'Renamed', 'beta');
    await snapshot(w);
    await runPendingJobsForTenant(w.tenant.id);
  }

  const restore = (w: World, headers: Headers, n: number | string, pageId = w.page.id) =>
    app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/versions/${n}/restore`, headers });

  async function history(w: World) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/pages/${w.page.id}/versions`,
      headers: w.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as any[];
  }

  async function versionRows(w: World) {
    return withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({
          number: versions.number,
          title: versions.title,
          markdown: versions.markdown,
          blocks: versions.blocks,
          contentHash: versions.contentHash,
          status: versions.status,
          createdAt: versions.createdAt,
        })
        .from(versions)
        .where(and(eq(versions.tenantId, w.tenant.id), eq(versions.documentId, w.page.id)))
        .orderBy(asc(versions.number))
    );
  }

  async function agentChangedAt(w: World) {
    const [row] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({ at: pages.agentChangedAt })
        .from(pages)
        .where(and(eq(pages.tenantId, w.tenant.id), eq(pages.documentId, w.page.id)))
    );
    return row!.at;
  }

  test('restoring v1 adds v3 with the old markdown; v1 and v2 are untouched; the worker indexes v3 and supersedes v2', async () => {
    const w = await setup();
    await twoIndexedVersions(w);
    const before = await versionRows(w);
    expect(before.map((v) => v.status)).toEqual(['superseded', 'indexed']);

    const res = await restore(w, w.editor.headers, 1);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(VersionSummarySchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'createdBy',
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
    expect(body).toMatchObject({
      number: 3,
      status: 'indexing',
      reason: 'restore',
      createdByType: 'user',
      createdBy: w.editor.userId,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/versions/${body.id}`,
      headers: w.headers,
    });
    expect(detail.json().markdown).toBe('alpha');

    // Three versions, newest first; the older ones are exactly as they were.
    expect((await history(w)).map((v) => v.number)).toEqual([3, 2, 1]);
    const after = await versionRows(w);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]!.markdown).toBe('alpha');
    expect(after[2]!.title).toBe('Original');

    await runPendingJobsForTenant(w.tenant.id);
    expect((await versionRows(w)).map((v) => v.status)).toEqual(['superseded', 'superseded', 'indexed']);

    // The title came back with the content.
    const [doc] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({ title: documents.title })
        .from(documents)
        .where(and(eq(documents.tenantId, w.tenant.id), eq(documents.id, w.page.id)))
    );
    expect(doc!.title).toBe('Original');
  });

  test('in a review space the restored version waits as pending_review', async () => {
    const w = await setup({ reviewRequired: true });
    const v1 = await snapshot(w);
    await post(w.headers, `/api/v1/versions/${v1.id}/approve`, {}, 200);
    await runPendingJobsForTenant(w.tenant.id);
    await rewrite(w, 'Renamed', 'beta');
    await snapshot(w);
    expect((await versionRows(w)).map((v) => v.status)).toEqual(['indexed', 'pending_review']);

    const res = await restore(w, w.editor.headers, 1);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ number: 3, status: 'pending_review', reason: 'restore' });
    // The pending v2 it replaced is superseded; the indexed v1 is not touched.
    expect((await versionRows(w)).map((v) => v.status)).toEqual(['indexed', 'superseded', 'pending_review']);
  });

  test('restoring content the latest version already has is 409 no_changes and adds nothing', async () => {
    const w = await setup();
    await twoIndexedVersions(w);

    // v2 is the latest.
    const same = await restore(w, w.editor.headers, 2);
    expect(same.statusCode).toBe(409);
    expect(same.json().error).toBe('no_changes');
    expect((await history(w)).map((v) => v.number)).toEqual([2, 1]);

    // After restoring v1, the latest (v3) equals v1.
    expect((await restore(w, w.editor.headers, 1)).statusCode).toBe(201);
    const again = await restore(w, w.editor.headers, 1);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('no_changes');
    expect((await history(w)).map((v) => v.number)).toEqual([3, 2, 1]);
  });

  test('after a withdraw, restoring the latest (withdrawn) version adds a new version and indexes it again', async () => {
    const w = await setup();
    await twoIndexedVersions(w);
    await post(w.headers, `/api/v1/pages/${w.page.id}/withdraw`, undefined, 200);
    expect((await versionRows(w)).map((v) => v.status)).toEqual(['superseded', 'withdrawn']);

    const res = await restore(w, w.editor.headers, 2);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ number: 3, status: 'indexing', reason: 'restore' });

    await runPendingJobsForTenant(w.tenant.id);
    expect((await versionRows(w)).map((v) => v.status)).toEqual(['superseded', 'withdrawn', 'indexed']);
  });

  test('a viewer is 403; a user who cannot read it, an unknown page and a malformed id are the same 404', async () => {
    const w = await setup();
    await twoIndexedVersions(w);

    const viewer = await restore(w, w.viewer.headers, 1);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toBe('forbidden');

    const hidden = await restore(w, w.stranger.headers, 1);
    const unknown = await restore(w, w.stranger.headers, 1, randomUUID());
    const malformed = await restore(w, w.stranger.headers, 1, 'not-a-uuid');
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).toBe('page_not_found');
    expect(unknown.json()).toEqual(hidden.json());
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual(hidden.json());
    expect((await history(w)).map((v) => v.number)).toEqual([2, 1]);

    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/versions/1/restore`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  test('an unknown or malformed version number is the same 404 version_not_found', async () => {
    const w = await setup();
    await twoIndexedVersions(w);

    const unknown = await restore(w, w.editor.headers, 99);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('version_not_found');
    for (const n of ['0', '-1', '1.5', '1e0', 'abc', '01', '99999999999', '2147483648', '3']) {
      const res = await restore(w, w.editor.headers, n);
      expect(res.statusCode, n).toBe(404);
      expect(res.json(), n).toEqual(unknown.json());
    }
    expect((await history(w)).map((v) => v.number)).toEqual([2, 1]);
  });

  test('a connected client sees the restored blocks live', async () => {
    const w = await setup();
    await twoIndexedVersions(w);
    const client = await connectClient({
      port,
      documentName: documentName(w.tenant.id, w.page.id),
      token: signCollabToken(
        {
          tenantId: w.tenant.id,
          pageId: w.page.id,
          principalType: 'user',
          principalId: w.editor.userId,
          access: 'write',
        },
        getCollabTokenSecret()
      ),
    });
    clients.push(client);
    expect(fragmentText(client.doc)).toContain('beta');

    const res = await restore(w, w.editor.headers, 1);
    expect(res.statusCode, res.body).toBe(201);
    await waitFor(() => fragmentText(client.doc).includes('alpha'));
    expect(fragmentText(client.doc)).not.toContain('beta');
  });

  test('agent_changed_at stays null: the restore is the user\'s change', async () => {
    const w = await setup();
    await twoIndexedVersions(w);
    expect(await agentChangedAt(w)).toBeNull();

    const res = await restore(w, w.editor.headers, 1);
    expect(res.statusCode, res.body).toBe(201);
    expect(await agentChangedAt(w)).toBeNull();
  });

  test('an archived space: a member gets 404, an admin 409 space_archived', async () => {
    const w = await setup();
    await twoIndexedVersions(w);
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, w.space.id)))
    );

    const member = await restore(w, w.editor.headers, 1);
    expect(member.statusCode).toBe(404);
    expect(member.json().error).toBe('page_not_found');
    const admin = await restore(w, w.headers, 1);
    expect(admin.statusCode).toBe(409);
    expect(admin.json().error).toBe('space_archived');
    expect((await history(w)).map((v) => v.number)).toEqual([2, 1]);
  });

  test('a failing collab call fails the restore (500) and adds no version; the retry succeeds', async () => {
    let fail = true;
    const real = new InProcessCollabClient(server);
    const flaky: CollabClient = {
      flush: (n) => real.flush(n),
      async replaceBlocks(a) {
        if (fail) throw new AppError('internal_error');
        return real.replaceBlocks(a);
      },
      setTitle: (a) => real.setTitle(a),
      revoke: (t) => real.revoke(t),
    };
    const flakyApp = buildTestApp({ collab: flaky });
    const w = await setup();
    await twoIndexedVersions(w);
    const attempt = () =>
      flakyApp.inject({
        method: 'POST',
        url: `/api/v1/pages/${w.page.id}/versions/1/restore`,
        headers: w.editor.headers,
      });

    const res = await attempt();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
    expect((await history(w)).map((v) => v.number)).toEqual([2, 1]);

    fail = false;
    const ok = await attempt();
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().number).toBe(3);
  });
});
