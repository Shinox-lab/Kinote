import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, blockActivity, memberships } from '@living-wiki/db';
import type { BlockDiffEntry } from '@living-wiki/contracts';
import { resolveActorNames } from '../src/people.js';
import {
  bootstrapTenant,
  createAgent,
  signUp,
  signUpMember,
  buildTestApp,
  useTestDb,
} from './support/testkit.js';

const app = buildTestApp();
useTestDb();

type Role = 'owner' | 'admin' | 'member' | 'viewer';

async function post(headers: Record<string, string>, url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers, payload: payload as any });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const get = (url: string, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url, headers });

/** A tenant with one page of three paragraphs and readers of each role (all with a grant on the space). */
async function world() {
  const { owner, tenant, headers } = await bootstrapTenant(app, { name: 'Names Co', slug: 'names-co' });
  const space = await post(headers, '/api/v1/spaces', { name: 'Docs', slug: 'docs' });
  const page = await post(headers, '/api/v1/pages', {
    space_id: space.id,
    title: 'Page',
    slug: 'page',
    markdown: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
  });
  async function reader(tenantRole: Role, spaceRole: 'viewer' | 'editor', name: string) {
    const s = await signUp(app, undefined, name);
    await withTenantTx(tenant.id, (tx) =>
      tx.insert(memberships).values({ tenantId: tenant.id, userId: s.userId, role: tenantRole }).then(() => undefined)
    );
    if (tenantRole !== 'owner' && tenantRole !== 'admin') {
      await post(headers, `/api/v1/spaces/${space.id}/grants`, {
        principal_type: 'user',
        principal_id: s.userId,
        role: spaceRole,
      });
    }
    return { ...s, headers: { authorization: `Bearer ${s.token}`, 'x-tenant-id': tenant.id } };
  }
  const editor = await reader('member', 'editor', 'Eddie Editor');
  const viewer = await reader('viewer', 'viewer', 'Vera Viewer');
  const plain = await reader('member', 'viewer', 'Pat Plain');
  const admin = await reader('admin', 'viewer', 'Ada Admin');
  const author = await reader('member', 'editor', 'Ann Author');
  return { owner, tenant, headers, space, page, editor, viewer, plain, admin, author };
}
type World = Awaited<ReturnType<typeof world>>;

/** Records `actor` as the last actor of every block of the page (nothing is indexed, so all blocks are `added`). */
async function attributeAll(w: World, actor: { type: 'user' | 'agent'; id: string }) {
  const blocks = (await get(`/api/v1/pages/${w.page.id}/changes`, w.headers)).json() as BlockDiffEntry[];
  expect(blocks.length).toBe(3);
  await withTenantTx(w.tenant.id, async (tx) => {
    for (const b of blocks) {
      await tx
        .insert(blockActivity)
        .values({ tenantId: w.tenant.id, pageId: w.page.id, blockId: b.blockId, actorType: actor.type, actorId: actor.id })
        .onConflictDoUpdate({
          target: [blockActivity.tenantId, blockActivity.pageId, blockActivity.blockId],
          set: { actorType: actor.type, actorId: actor.id },
        });
    }
  });
}

async function authors(w: World, headers: Record<string, string>) {
  const res = await get(`/api/v1/pages/${w.page.id}/changes`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as BlockDiffEntry[]).map((e) => e.author);
}

describe('GET /pages/:id/changes author names', () => {
  test('a member change is named for an editor, a viewer, a plain member and an admin', async () => {
    const w = await world();
    await attributeAll(w, { type: 'user', id: w.author.userId });
    for (const who of [w.editor, w.viewer, w.plain, w.admin, { headers: w.headers }]) {
      const list = await authors(w, (who as any).headers);
      expect(list).toEqual(Array(3).fill({ type: 'user', id: w.author.userId, name: 'Ann Author' }));
    }
  });

  test("an agent's change is named with the agent's name", async () => {
    const w = await world();
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Scribe' });
    await attributeAll(w, { type: 'agent', id: agentId });
    const list = await authors(w, w.viewer.headers);
    expect(list[0]).toEqual({ type: 'agent', id: agentId, name: 'Scribe' });
  });

  test('a user removed from the tenant shows as Former member', async () => {
    const w = await world();
    await attributeAll(w, { type: 'user', id: w.author.userId });
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .delete(memberships)
        .where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.author.userId)))
        .then(() => undefined)
    );
    const list = await authors(w, w.plain.headers);
    expect(list[0]).toEqual({ type: 'user', id: w.author.userId, name: 'Former member' });
  });

  test('a user of another tenant only is never named', async () => {
    const w = await world();
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co', email: 'secret.person@example.test' });
    await attributeAll(w, { type: 'user', id: other.owner.userId });
    const res = await get(`/api/v1/pages/${w.page.id}/changes`, w.viewer.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as BlockDiffEntry[])[0]!.author).toEqual({
      type: 'user',
      id: other.owner.userId,
      name: 'Former member',
    });
    // Neither the other user's name nor their email local part leaks.
    expect(res.body).not.toContain('secret.person');
  });

  test('an agent of another tenant is shown as Agent', async () => {
    const w = await world();
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const foreign = await createAgent(other.tenant.id, other.owner.userId, { name: 'Foreign Bot' });
    await attributeAll(w, { type: 'agent', id: foreign });
    const list = await authors(w, w.headers);
    expect(list[0]).toEqual({ type: 'agent', id: foreign, name: 'Agent' });
  });

  test('/compare entries carry no name', async () => {
    const w = await world();
    await attributeAll(w, { type: 'user', id: w.author.userId });
    // Two versions of the page: the creation snapshot and a manual one.
    const snap = await app.inject({ method: 'POST', url: `/api/v1/pages/${w.page.id}/snapshot`, headers: w.headers });
    expect(snap.statusCode, snap.body).toBe(201);
    const res = await get(`/api/v1/pages/${w.page.id}/compare?from=1&to=1`, w.headers);
    expect(res.statusCode, res.body).toBe(200);
    for (const e of res.json() as BlockDiffEntry[]) {
      expect(e.author).toBeUndefined();
      expect(JSON.stringify(e)).not.toContain('"name"');
    }
  });
});

describe('resolveActorNames', () => {
  test('empty input is an empty map and runs no query', async () => {
    const tx = new Proxy({}, { get: () => { throw new Error('queried'); } }) as any;
    expect(await resolveActorNames(tx, 'tenant', [])).toEqual(new Map());
  });

  test('keys are "<type>:<id>"; duplicates collapse; unknowns get the fallbacks', async () => {
    const w = await world();
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Scribe' });
    const ghostAgent = '00000000-0000-4000-8000-000000000001';
    const ghostUser = '00000000-0000-4000-8000-000000000002';
    const names = await withTenantTx(w.tenant.id, (tx) =>
      resolveActorNames(tx, w.tenant.id, [
        { type: 'user', id: w.author.userId },
        { type: 'user', id: w.author.userId },
        { type: 'agent', id: agentId },
        { type: 'agent', id: ghostAgent },
        { type: 'user', id: ghostUser },
      ])
    );
    expect(Object.fromEntries(names)).toEqual({
      [`user:${w.author.userId}`]: 'Ann Author',
      [`agent:${agentId}`]: 'Scribe',
      [`agent:${ghostAgent}`]: 'Agent',
      [`user:${ghostUser}`]: 'Former member',
    });
  });
});
