import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { AppError } from '@kinote/contracts';
import { signCollabToken, getCollabTokenSecret, documentName } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { waitFor } from '../../collab/test/support/collabWorld.js';
import type { CollabClient } from '@kinote/shared';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, signUpMember, buildTestApp, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * Live-session revocation: an admin change that can alter someone's access
 * closes the affected live editing sockets after it committed, so the
 * collab server re-reads the role on the reconnect (a removed member is
 * refused, a demoted one read-only). Best effort: a failing revoke is logged
 * and never fails the admin request.
 */
describe('live editing sessions are revoked on access changes', () => {
  let server: CollabServer;
  let port: number;
  let app: ReturnType<typeof buildTestApp>;
  const clients: ConnectedClient[] = [];

  beforeAll(async () => {
    ({ server, port } = await startCollabServer());
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

  async function call(target: typeof app, method: string, url: string, headers: Headers, payload?: unknown) {
    return target.inject({ method: method as any, url, headers, payload: payload as any });
  }

  /** A tenant, a space, one page, and two editors (A and B) of that space. */
  async function world(target: typeof app = app) {
    const { owner, tenant, headers } = await bootstrapTenant(target, { name: 'Revoke Co', slug: 'revoke-co' });
    const space = (await call(target, 'POST', '/api/v1/spaces', headers, { name: 'Docs', slug: 'docs' })).json();
    const page = (
      await call(target, 'POST', '/api/v1/pages', headers, {
        space_id: space.id,
        title: 'Shared',
        slug: 'shared',
        markdown: 'Shared page.',
      })
    ).json();
    const a = await signUpMember(target, tenant.id, 'member');
    const b = await signUpMember(target, tenant.id, 'member');
    for (const user of [a, b]) {
      const res = await call(target, 'POST', `/api/v1/spaces/${space.id}/grants`, headers, {
        principal_type: 'user',
        principal_id: user.userId,
        role: 'editor',
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const name = documentName(tenant.id, page.id);
    const token = (userId: string) =>
      signCollabToken(
        { tenantId: tenant.id, pageId: page.id, principalType: 'user', principalId: userId, access: 'write' },
        getCollabTokenSecret()
      );
    return { owner, tenant, headers, space, page, a, b, name, token };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function connect(w: World, userId: string) {
    const client = await connectClient({ port, documentName: w.name, token: w.token(userId) });
    clients.push(client);
    const drops = { count: 0 };
    client.provider.configuration.websocketProvider.on('disconnect', () => {
      drops.count += 1;
    });
    return { client, drops };
  }

  /** The server-side connection of `userId` on the page, once it is there. */
  function liveConnection(w: World, userId: string) {
    return server.documents
      .get(w.name)
      ?.getConnections()
      .find((c) => (c.context as { actorId?: string } | undefined)?.actorId === userId);
  }

  async function staysZero(drops: { count: number }, ms = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      expect(drops.count).toBe(0);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  test("removing a member drops that member's socket, and the old token no longer connects; another member stays", async () => {
    const w = await world();
    const a = await connect(w, w.a.userId);
    const b = await connect(w, w.b.userId);

    const res = await call(app, 'DELETE', `/api/v1/members/${w.a.userId}`, w.headers);
    expect(res.statusCode, res.body).toBe(204);

    await waitFor(() => a.drops.count > 0);
    await staysZero(b.drops);
    // The token A still holds has not expired, but A is no member any more.
    await expect(
      connectClient({ port, documentName: w.name, token: w.token(w.a.userId) })
    ).rejects.toThrow(/authentication failed/);
  });

  test('demoting a member to tenant viewer drops the socket; the reconnect is read-only', async () => {
    const w = await world();
    const a = await connect(w, w.a.userId);
    expect(liveConnection(w, w.a.userId)?.readOnly).toBe(false);

    const res = await call(app, 'PATCH', `/api/v1/members/${w.a.userId}`, w.headers, { role: 'viewer' });
    expect(res.statusCode, res.body).toBe(200);

    await waitFor(() => a.drops.count > 0);
    const again = await connectClient({ port, documentName: w.name, token: w.token(w.a.userId) });
    clients.push(again);
    await waitFor(() => liveConnection(w, w.a.userId)?.readOnly === true);
  });

  test("a grant change reconnects the tenant's sockets: the demoted user read-only, another user writable again", async () => {
    const w = await world();
    const a = await connect(w, w.a.userId);
    const b = await connect(w, w.b.userId);

    const res = await call(app, 'POST', `/api/v1/spaces/${w.space.id}/grants`, w.headers, {
      principal_type: 'group',
      principal_id: (await call(app, 'POST', '/api/v1/groups', w.headers, { name: 'Readers' })).json().id,
      role: 'viewer',
    });
    expect(res.statusCode, res.body).toBe(201);
    // A grant to a group can change anyone's role: every socket of the tenant reconnects.
    await waitFor(() => a.drops.count > 0 && b.drops.count > 0);

    const demote = await call(app, 'POST', `/api/v1/spaces/${w.space.id}/grants`, w.headers, {
      principal_type: 'user',
      principal_id: w.a.userId,
      role: 'viewer',
    });
    expect(demote.statusCode, demote.body).toBe(201);
    const againA = await connectClient({ port, documentName: w.name, token: w.token(w.a.userId) });
    const againB = await connectClient({ port, documentName: w.name, token: w.token(w.b.userId) });
    clients.push(againA, againB);
    await waitFor(() => liveConnection(w, w.a.userId)?.readOnly === true);
    expect(liveConnection(w, w.b.userId)?.readOnly).toBe(false);
  });

  test('every access-changing admin route revokes after it committed, with the user when it names one', async () => {
    const calls: Array<{ tenantId: string; userId?: string }> = [];
    const recording: CollabClient = {
      async flush() {},
      async replaceBlocks() {},
      async applyBlockOps() {},
      async setTitle() {},
      async setFields() {},
      async revoke(target) {
        calls.push(target);
      },
    };
    const rec = buildTestApp({ collab: recording });
    const w = await world(rec);
    calls.length = 0;
    const tenantWide = { tenantId: w.tenant.id };
    const forA = { tenantId: w.tenant.id, userId: w.a.userId };
    const group = (await call(rec, 'POST', '/api/v1/groups', w.headers, { name: 'Team' })).json();

    const steps: Array<[string, string, unknown, { tenantId: string; userId?: string }]> = [
      ['POST', `/api/v1/spaces/${w.space.id}/grants`, { principal_type: 'user', principal_id: w.a.userId, role: 'viewer' }, forA],
      ['POST', `/api/v1/spaces/${w.space.id}/grants`, { principal_type: 'group', principal_id: group.id, role: 'viewer' }, tenantWide],
      ['DELETE', `/api/v1/spaces/${w.space.id}/grants/group/${group.id}`, undefined, tenantWide],
      ['DELETE', `/api/v1/spaces/${w.space.id}/grants/user/${w.a.userId}`, undefined, forA],
      ['POST', `/api/v1/groups/${group.id}/members`, { principal_type: 'user', principal_id: w.a.userId }, forA],
      ['DELETE', `/api/v1/groups/${group.id}/members/user/${w.a.userId}`, undefined, forA],
      ['PATCH', `/api/v1/members/${w.a.userId}`, { role: 'viewer' }, forA],
      ['DELETE', `/api/v1/members/${w.a.userId}`, undefined, forA],
    ];
    for (const [method, url, payload, expected] of steps) {
      const before = calls.length;
      const res = await call(rec, method, url, w.headers, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
      expect(calls.slice(before), `${method} ${url}`).toEqual([expected]);
    }

    // A refused change revokes nothing.
    const before = calls.length;
    const refused = await call(rec, 'DELETE', `/api/v1/members/${w.owner.userId}`, w.headers);
    expect(refused.statusCode).toBe(409);
    expect(calls.length).toBe(before);
  });

  test('a failing revoke is logged and does not fail the admin request', async () => {
    const lines: string[] = [];
    const failing: CollabClient = {
      async flush() {},
      async replaceBlocks() {},
      async applyBlockOps() {},
      async setTitle() {},
      async setFields() {},
      async revoke() {
        throw new AppError('internal_error');
      },
    };
    const logged = buildTestApp({
      collab: failing,
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
    });
    const w = await world(logged);
    const res = await call(logged, 'DELETE', `/api/v1/members/${w.a.userId}`, w.headers);
    expect(res.statusCode, res.body).toBe(204);
    const errors = lines.map((l) => JSON.parse(l)).filter((e) => e.level === 50);
    expect(errors.map((e) => e.msg)).toContain('collab revoke failed');
    await logged.close();
  });
});
