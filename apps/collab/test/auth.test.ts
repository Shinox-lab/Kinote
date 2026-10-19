import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import assert from 'node:assert/strict';
import type * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, memberships, spaces } from '@living-wiki/db';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  type CollabClaims,
} from '@living-wiki/shared';
import { openDirectSession, type CollabServer } from '../src/server.js';
import { authenticateCollabConnection } from '../src/auth.js';
import { connectClient, startCollabServer } from './support/wsClient.js';
import {
  asUser,
  bootstrapTenant,
  buildTestApp,
  signUpMember,
  useTestDb,
} from '../../api/test/support/testkit.js';

type Access = CollabClaims['access'];

describe('collab connection authentication', () => {
  const app = buildTestApp();
  let server: CollabServer;
  let port: number;
  const clients: Array<{ destroy(): void }> = [];

  beforeAll(async () => {
    ({ server, port } = await startCollabServer());
  });

  useTestDb();

  afterEach(() => {
    // Closing a test's clients unloads its documents before the next test.
    for (const c of clients.splice(0)) c.destroy();
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function connect(args: { documentName: string; token: string }) {
    const client = await connectClient({ port, ...args });
    clients.push(client);
    return client;
  }

  async function post(headers: Record<string, string>, url: string, payload: unknown) {
    const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  async function world() {
    const { owner, tenant, headers } = await bootstrapTenant(app, {
      name: 'Collab Co',
      slug: 'collab-co',
    });
    const space = await post(headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs' });
    const pageA = await post(headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Page A',
      slug: 'page-a',
      markdown: '# A',
    });
    const pageB = await post(headers, '/api/v1/pages', {
      space_id: space.id,
      title: 'Page B',
      slug: 'page-b',
      markdown: '# B',
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
    return { owner, tenant, headers, space, pageA, pageB, editor, viewer };
  }

  function tokenFor(
    w: { tenant: { id: string } },
    pageId: string,
    userId: string,
    access: Access,
    opts: { secret?: string; now?: Date } = {}
  ) {
    return signCollabToken(
      {
        tenantId: w.tenant.id,
        pageId,
        principalType: 'user',
        principalId: userId,
        access,
      },
      opts.secret ?? getCollabTokenSecret(),
      opts.now
    );
  }

  function serverDoc(name: string): Y.Doc {
    const d = server.documents.get(name);
    assert.ok(d, 'server document is loaded');
    return d;
  }

  async function waitFor(fn: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('condition not met in time');
  }

  /**
   * Asserts `fn` stays true for a bounded window. A read-only client gets a
   * negative sync-status ack but no event the tests can hook, so the check
   * polls for a short window instead of a single long sleep.
   */
  async function stays(fn: () => boolean, ms = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      expect(fn()).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test('rejects the old forgeable string token', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    await expect(
      connect({ documentName: name, token: `user:${w.owner.userId}:owner` })
    ).rejects.toThrow(/authentication failed/);
  });

  test('rejects a token signed with a different secret', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write', {
      secret: 'a-completely-different-secret-of-32-chars!!',
    });
    await expect(connect({ documentName: name, token })).rejects.toThrow(/authentication failed/);
  });

  test('rejects an expired token', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write', {
      now: new Date(Date.now() - 10 * 60 * 1000),
    });
    await expect(connect({ documentName: name, token })).rejects.toThrow(/authentication failed/);
  });

  test('rejects a token for page A used on page B', async () => {
    const w = await world();
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write');
    await expect(
      connect({ documentName: documentName(w.tenant.id, w.pageB.id), token })
    ).rejects.toThrow(/authentication failed/);
  });

  test('rejects a token whose principal has no access to the space', async () => {
    const w = await world();
    const outsider = await signUpMember(app, w.tenant.id, 'member');
    const token = tokenFor(w, w.pageA.id, outsider.userId, 'write');
    await expect(
      connect({ documentName: documentName(w.tenant.id, w.pageA.id), token })
    ).rejects.toThrow(/authentication failed/);
  });

  test('a viewer connects read-only: their edit never reaches the server, an editor edit does', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);

    const viewerClient = await connect({
      documentName: name,
      token: tokenFor(w, w.pageA.id, w.viewer.userId, 'read'),
    });
    viewerClient.doc.getMap('probe').set('viewer', 'edit');

    const editorClient = await connect({
      documentName: name,
      token: tokenFor(w, w.pageA.id, w.editor.userId, 'write'),
    });
    editorClient.doc.getMap('probe').set('editor', 'edit');

    await waitFor(() => serverDoc(name).getMap('probe').get('editor') === 'edit');
    await stays(() => serverDoc(name).getMap('probe').get('viewer') === undefined);
    // The viewer still receives the editor's edit live.
    await waitFor(() => viewerClient.doc.getMap('probe').get('editor') === 'edit');
  });

  test('a write token whose holder was demoted to viewer is read-only', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write');
    await post(w.headers, `/api/v1/spaces/${w.space.id}/grants`, {
      principal_type: 'user',
      principal_id: w.editor.userId,
      role: 'viewer',
    });

    const ctx = await authenticateCollabConnection(token, name);
    expect(ctx.readOnly).toBe(true);

    const client = await connect({ documentName: name, token });
    client.doc.getMap('probe').set('demoted', 'edit');
    await stays(() => serverDoc(name).getMap('probe').get('demoted') === undefined, 400);
  });

  test('a read token is read-only even for an editor; a write token for an editor is writable', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const read = await authenticateCollabConnection(
      tokenFor(w, w.pageA.id, w.editor.userId, 'read'),
      name
    );
    expect(read.readOnly).toBe(true);
    const write = await authenticateCollabConnection(
      tokenFor(w, w.pageA.id, w.editor.userId, 'write'),
      name
    );
    expect(write.readOnly).toBe(false);
    expect(write).toMatchObject({
      tenantId: w.tenant.id,
      pageId: w.pageA.id,
      actorType: 'user',
      actorId: w.editor.userId,
    });
  });

  test('rejects malformed document names', async () => {
    const w = await world();
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write');
    for (const bad of ['', 'nope', `${w.tenant.id}:${w.pageA.id}:x`, `${w.tenant.id}:zzz`]) {
      await expect(authenticateCollabConnection(token, bad)).rejects.toBeTruthy();
    }
  });

  test('rejects an upper-case (non-canonical) document name with an otherwise valid token', async () => {
    const w = await world();
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write');
    const upper = `${w.tenant.id.toUpperCase()}:${w.pageA.id.toUpperCase()}`;
    await expect(connect({ documentName: upper, token })).rejects.toThrow(/authentication failed/);
    await expect(authenticateCollabConnection(token, upper)).rejects.toBeTruthy();
    // No second in-memory document was created for the page.
    expect(server.documents.has(upper)).toBe(false);
  });

  test('rejects a token whose tenant does not match the document tenant', async () => {
    const w = await world();
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const token = signCollabToken(
      {
        tenantId: other.tenant.id,
        pageId: w.pageA.id,
        principalType: 'user',
        principalId: w.editor.userId,
        access: 'write',
      },
      getCollabTokenSecret()
    );
    await expect(
      connect({ documentName: documentName(w.tenant.id, w.pageA.id), token })
    ).rejects.toThrow(/authentication failed/);
  });

  test('a user whose membership was removed after the token was issued is refused', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const token = tokenFor(w, w.pageA.id, w.editor.userId, 'write');
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.editor.userId)))
        .then(() => undefined)
    );
    await expect(connect({ documentName: name, token })).rejects.toThrow(/authentication failed/);
    await expect(authenticateCollabConnection(token, name)).rejects.toBeTruthy();
  });

  test('a tenant viewer holding an editor grant and a write token connects read-only', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);
    const tenantViewer = await signUpMember(app, w.tenant.id, 'viewer');
    await post(w.headers, `/api/v1/spaces/${w.space.id}/grants`, {
      principal_type: 'user',
      principal_id: tenantViewer.userId,
      role: 'editor',
    });
    const token = tokenFor(w, w.pageA.id, tenantViewer.userId, 'write');

    const ctx = await authenticateCollabConnection(token, name);
    expect(ctx.readOnly).toBe(true);

    const client = await connect({ documentName: name, token });
    client.doc.getMap('probe').set('tenant-viewer', 'edit');
    await stays(() => serverDoc(name).getMap('probe').get('tenant-viewer') === undefined, 400);
  });

  test("another member's Inbox page: a member is refused, the creator and a tenant admin connect", async () => {
    const w = await world();
    const creator = await signUpMember(app, w.tenant.id, 'member');
    const other = await signUpMember(app, w.tenant.id, 'member');
    const admin = await signUpMember(app, w.tenant.id, 'admin');
    const spaceList = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: creator.headers });
    const inbox = (spaceList.json() as Array<{ id: string; kind: string }>).find((s) => s.kind === 'inbox');
    assert.ok(inbox);
    const item = await post(creator.headers, '/api/v1/pages', {
      space_id: inbox.id,
      title: 'Private note',
      slug: 'private-note',
      markdown: '# mine',
    });
    const name = documentName(w.tenant.id, item.id);

    const refused = tokenFor(w, item.id, other.userId, 'write');
    await expect(authenticateCollabConnection(refused, name)).rejects.toMatchObject({
      code: 'page_not_found',
    });
    await expect(connect({ documentName: name, token: refused })).rejects.toThrow(/authentication failed/);

    for (const userId of [creator.userId, admin.userId]) {
      const ctx = await authenticateCollabConnection(tokenFor(w, item.id, userId, 'write'), name);
      expect(ctx.readOnly).toBe(false);
    }
  });

  test('a page in an archived space is read-only even for a tenant admin', async () => {
    const w = await world();
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(spaces)
        .set({ archivedAt: new Date() })
        .where(and(eq(spaces.tenantId, w.tenant.id), eq(spaces.id, w.space.id)))
        .then(() => undefined)
    );
    const name = documentName(w.tenant.id, w.pageA.id);
    const ctx = await authenticateCollabConnection(tokenFor(w, w.pageA.id, w.owner.userId, 'write'), name);
    expect(ctx.readOnly).toBe(true);
    // A member of the space cannot see an archived space at all.
    await expect(
      authenticateCollabConnection(tokenFor(w, w.pageA.id, w.editor.userId, 'write'), name)
    ).rejects.toMatchObject({ code: 'page_not_found' });
  });

  test('openDirectSession refuses read-only contexts: a read token cannot transact', async () => {
    const w = await world();
    const name = documentName(w.tenant.id, w.pageA.id);

    // A viewer (database role) holding a write token.
    await expect(
      openDirectSession(server, { documentName: name, token: tokenFor(w, w.pageA.id, w.viewer.userId, 'write') })
    ).rejects.toMatchObject({ code: 'forbidden' });
    // An editor holding a read token.
    await expect(
      openDirectSession(server, { documentName: name, token: tokenFor(w, w.pageA.id, w.editor.userId, 'read') })
    ).rejects.toMatchObject({ code: 'forbidden' });

    // An editor with write access still works, and the page is unchanged by the refusals.
    const session = await openDirectSession(server, {
      documentName: name,
      token: tokenFor(w, w.pageA.id, w.editor.userId, 'write'),
    });
    await session.transact({ source: 'restore', actorId: w.editor.userId }, (ydoc) => {
      ydoc.getMap('probe').set('direct', 'ok');
    });
    expect(serverDoc(name).getMap('probe').get('direct')).toBe('ok');
    await session.close();
  });
});
