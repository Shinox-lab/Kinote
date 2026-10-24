import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, auditEvents, documents, pages, versions } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

type Headers = Record<string, string>;

/**
 * Renaming: the title of a page lives in the live collab document (so the
 * editor shows the new name at once and the next snapshot indexes it), the
 * title of a file lives in the document row (the stored file keeps its own
 * name). Both are audited.
 */
describe('renaming a page or a file', () => {
  let server: CollabServer;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    app = buildTestApp({ collab: new InProcessCollabClient(server), storage: new InMemoryObjectStorage() });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  async function setup() {
    const { tenant, owner, headers } = await bootstrapTenant(app, {
      name: 'Rename Co',
      slug: 'rename-co',
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
    return { tenant, owner, headers, space, editor, viewer, page };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  async function post(headers: Headers, url: string, payload?: unknown) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function grant(headers: Headers, spaceId: string, userId: string, role: string) {
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, {
      principal_type: 'user',
      principal_id: userId,
      role,
    });
  }

  const renamePage = (headers: Headers, id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/pages/${id}`, headers, payload: payload as any });

  const renameFile = (headers: Headers, id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/files/${id}`, headers, payload: payload as any });

  /** The title the live document carries, as collab stored it. */
  async function liveTitle(tenantId: string, documentId: string) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select({ state: pages.ydocState })
        .from(pages)
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, documentId)))
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row!.state);
    return doc.getMap('meta').get('title');
  }

  async function treeTitle(w: World, documentId: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/spaces/${w.space.id}/tree`,
      headers: w.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const node = (res.json() as any).nodes.find((n: any) => n.id === documentId);
    return node?.title;
  }

  async function auditTypes(tenantId: string) {
    const rows = await withTenantTx(tenantId, (tx) =>
      tx.select({ type: auditEvents.type }).from(auditEvents).where(eq(auditEvents.tenantId, tenantId))
    );
    return rows.map((r) => r.type);
  }

  test('an editor renames a page: the live title, the tree and the audit trail follow', async () => {
    const w = await setup();

    const res = await renamePage(w.editor.headers, w.page.id, { title: 'Renamed page' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('Renamed page');

    // The live document carries the new title, so the page screen shows it at once.
    expect(await liveTitle(w.tenant.id, w.page.id)).toBe('Renamed page');
    const details = await app.inject({
      method: 'GET',
      url: `/api/v1/pages/${w.page.id}`,
      headers: w.editor.headers,
    });
    expect(details.statusCode, details.body).toBe(200);
    expect(details.json().title).toBe('Renamed page');
    // The tree shows the new name without waiting for a snapshot.
    expect(await treeTitle(w, w.page.id)).toBe('Renamed page');
    expect(await auditTypes(w.tenant.id)).toContain('page.renamed');
  });

  test('a viewer cannot rename a page (403) and the title stays', async () => {
    const w = await setup();
    const res = await renamePage(w.viewer.headers, w.page.id, { title: 'Not yours' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
    expect(await liveTitle(w.tenant.id, w.page.id)).toBe('Original');
    expect(await treeTitle(w, w.page.id)).toBe('Original');
  });

  test('an archived page is not renamed (409 page_archived)', async () => {
    const w = await setup();
    const archived = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/archive`,
      headers: w.headers,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const res = await renamePage(w.editor.headers, w.page.id, { title: 'Too late' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('page_archived');
    expect(await liveTitle(w.tenant.id, w.page.id)).toBe('Original');
  });

  test('an empty title is refused (400 validation_failed)', async () => {
    const w = await setup();
    const res = await renamePage(w.editor.headers, w.page.id, { title: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
    expect(await liveTitle(w.tenant.id, w.page.id)).toBe('Original');
  });

  test('an editor renames a file: the name changes, the stored file does not', async () => {
    const w = await setup();
    const upload = await app.inject(
      uploadRequest('/api/v1/files', w.editor.headers, { name: 'notes.txt', data: 'hello' }, {
        space_id: w.space.id,
      })
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json().document;

    const res = await renameFile(w.editor.headers, file.id, { title: 'Meeting notes' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().title).toBe('Meeting notes');
    expect(await treeTitle(w, file.id)).toBe('Meeting notes');

    // The version keeps the file that was uploaded.
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select({ fileName: versions.fileName })
        .from(versions)
        .where(and(eq(versions.tenantId, w.tenant.id), eq(versions.documentId, file.id)))
    );
    expect(rows.map((r) => r.fileName)).toEqual(['notes.txt']);
    expect(await auditTypes(w.tenant.id)).toContain('file.renamed');
  });

  test('a file a source keeps in sync is not renamed by hand (409 managed_by_source)', async () => {
    const w = await setup();
    const upload = await app.inject(
      uploadRequest('/api/v1/files', w.editor.headers, { name: 'notes.txt', data: 'hello' }, {
        space_id: w.space.id,
      })
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json().document;
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(documents).set({ placement: 'synced' }).where(eq(documents.id, file.id))
    );

    const res = await renameFile(w.editor.headers, file.id, { title: 'Meeting notes' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('managed_by_source');
  });

  test('a viewer cannot rename a file (403)', async () => {
    const w = await setup();
    const upload = await app.inject(
      uploadRequest('/api/v1/files', w.editor.headers, { name: 'notes.txt', data: 'hello' }, {
        space_id: w.space.id,
      })
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json().document;

    const res = await renameFile(w.viewer.headers, file.id, { title: 'Not yours' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });
});
