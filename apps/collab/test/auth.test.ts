import { describe, test, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import assert from 'node:assert/strict';
import type * as Y from 'yjs';
import { db } from '@living-wiki/db';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  type CollabClaims,
} from '@living-wiki/shared';
import { collabServer } from '../src/server.js';
import { authenticateCollabConnection } from '../src/auth.js';
import { connectClient } from './support/wsClient.js';
import {
  asUser,
  bootstrapTenant,
  buildTestApp,
  signUpMember,
} from '../../api/test/support/testkit.js';

type Access = CollabClaims['access'];

describe('collab connection authentication', () => {
  const app = buildTestApp();
  let port: number;
  const clients: Array<{ destroy(): void }> = [];

  beforeAll(async () => {
    await (collabServer as any).listen(0);
    port = (collabServer as any).address.port;
  });

  beforeEach(async () => {
    await (db as any).__resetForTests();
    collabServer.activeDocs.clear();
  });

  afterAll(async () => {
    for (const c of clients) c.destroy();
    collabServer.activeDocs.clear();
    await (collabServer as any).destroy();
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
    const pageA = (
      await post(headers, '/api/v1/pages', {
        space_id: space.id,
        title: 'Page A',
        slug: 'page-a',
        markdown: '# A',
      })
    ).document;
    const pageB = (
      await post(headers, '/api/v1/pages', {
        space_id: space.id,
        title: 'Page B',
        slug: 'page-b',
        markdown: '# B',
      })
    ).document;
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
    const d = (collabServer as any).documents.get(name);
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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(300);
    expect(serverDoc(name).getMap('probe').get('viewer')).toBeUndefined();
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
    await sleep(400);
    expect(serverDoc(name).getMap('probe').get('demoted')).toBeUndefined();
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
});
