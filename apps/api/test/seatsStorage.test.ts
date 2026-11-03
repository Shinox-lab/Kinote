import { describe, test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { memberships, tenantLimits, tenantStorage, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { countSeats } from '@kinote/core';
import { asUser, bootstrapTenant, buildTestApp, createAgent, signUp, signUpMember, useTestDb, type TestSession } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';
import { makeSource, putFile } from './support/sourcekit.js';

type Headers = Record<string, string>;

describe('seat and storage limits', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });

  const invite = (headers: Headers, email: string, role = 'member') =>
    app.inject({ method: 'POST', url: '/api/v1/invitations', headers, payload: { email, role } });
  const accept = (session: TestSession, token: string) =>
    app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: asUser(session), payload: { token } });
  const setRole = (headers: Headers, userId: string, role: string) =>
    app.inject({ method: 'PATCH', url: `/api/v1/members/${userId}`, headers, payload: { role } });

  async function limit(tenantId: string, v: { seats?: number | null; storageBytes?: number | null }) {
    await withTenantTx(tenantId, (tx) =>
      tx.insert(tenantLimits).values({ tenantId, ...v }).onConflictDoUpdate({ target: tenantLimits.tenantId, set: v })
    );
  }
  const seats = (tenantId: string) => withTenantTx(tenantId, (tx) => countSeats(tx, tenantId, new Date()));
  const memberCount = async (tenantId: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(memberships).where(eq(memberships.tenantId, tenantId)))).length;

  test('seats count members and pending invitations but not viewers or agents', async () => {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Count Co', slug: 'count-co' });
    await signUpMember(app, tenant.id, 'member');
    await signUpMember(app, tenant.id, 'viewer');
    await createAgent(tenant.id, owner.userId);
    expect((await invite(headers, 'pending@x.test')).statusCode).toBe(201);
    expect((await invite(headers, 'looker@x.test', 'viewer')).statusCode).toBe(201);
    expect(await seats(tenant.id)).toBe(3);
    // Re-inviting the same person replaces their invitation: still one seat.
    expect((await invite(headers, 'pending@x.test', 'admin')).statusCode).toBe(201);
    expect(await seats(tenant.id)).toBe(3);
  });

  test('inviting past the seat limit is refused; inviting a viewer is not', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Full Co', slug: 'full-co' });
    await limit(tenant.id, { seats: 2 });
    expect((await invite(headers, 'one@x.test')).statusCode).toBe(201);
    const refused = await invite(headers, 'two@x.test');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'seat_limit_reached', message: ERROR_SENTENCES.seat_limit_reached });
    expect(refused.json().message).toBe('This workspace has no free seats on its plan. Remove someone or upgrade to add more.');
    expect((await invite(headers, 'viewer@x.test', 'viewer')).statusCode).toBe(201);
    // Re-inviting someone already counted is not a new seat.
    expect((await invite(headers, 'one@x.test', 'admin')).statusCode).toBe(201);
  });

  test('accepting your own pending invitation at a full workspace succeeds', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Join Co', slug: 'join-co' });
    await limit(tenant.id, { seats: 2 });
    const invitee = await signUp(app, 'joiner@x.test');
    const { acceptToken } = (await invite(headers, 'joiner@x.test')).json();
    expect(await seats(tenant.id)).toBe(2);
    const res = await accept(invitee, acceptToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(await seats(tenant.id)).toBe(2);
  });

  test('promoting a viewer at a full workspace is refused; member→admin is not', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Promo Co', slug: 'promo-co' });
    const member = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'viewer');
    await limit(tenant.id, { seats: 2 });
    const refused = await setRole(headers, viewer.userId, 'member');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('seat_limit_reached');
    expect((await setRole(headers, member.userId, 'admin')).statusCode).toBe(200);
    expect((await setRole(headers, member.userId, 'viewer')).statusCode).toBe(200);
    expect((await setRole(headers, viewer.userId, 'member')).statusCode).toBe(200);
  });

  test('after a downgrade nobody is removed and nobody can be added', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Down Co', slug: 'down-co' });
    await signUpMember(app, tenant.id, 'member');
    await signUpMember(app, tenant.id, 'admin');
    await limit(tenant.id, { seats: 1 });
    expect(await memberCount(tenant.id)).toBe(3);
    expect((await invite(headers, 'late@x.test')).json().error).toBe('seat_limit_reached');
  });

  const upload = (headers: Headers, data: string, name = 'a.txt') =>
    app.inject(uploadRequest('/api/v1/files', headers, { name, data }));

  test('an upload past the storage limit is refused with 413 and nothing is stored', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Disk Co', slug: 'disk-co' });
    await limit(tenant.id, { storageBytes: 100 });
    expect((await upload(headers, 'x'.repeat(60))).statusCode).toBe(201);
    const refused = await upload(headers, 'y'.repeat(60), 'b.txt');
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toEqual({ error: 'storage_limit_reached', message: 'This file would take the workspace over its storage limit.' });
    const stored = await withTenantTx(tenant.id, (tx) => tx.select().from(versions).where(eq(versions.tenantId, tenant.id)));
    expect(stored).toHaveLength(1);
    const [bytes] = await withTenantTx(tenant.id, (tx) => tx.select().from(tenantStorage));
    expect(bytes!.bytes).toBe(60);
    expect((storage as unknown as { objects: Map<string, unknown> }).objects.size).toBe(1);
  });

  test('a new file version past the limit is refused, and so is a source PUT', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Ver Co', slug: 'ver-co' });
    const first = await upload(headers, 'x'.repeat(60));
    expect(first.statusCode).toBe(201);
    await limit(tenant.id, { storageBytes: 100 });
    const id = first.json().document.id as string;
    const replaced = await app.inject(uploadRequest(`/api/v1/files/${id}/versions`, headers, { name: 'a.txt', data: 'z'.repeat(60) }));
    expect(replaced.statusCode).toBe(413);
    expect(replaced.json().error).toBe('storage_limit_reached');

    const space = (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers, payload: { name: 'Docs', slug: 'docs' } })).json().id;
    const src = await makeSource(app, headers, { name: 'Feed', spaceId: space });
    const put = await putFile(app, src.token, 'reports/q3.txt', { name: 'q3.txt', data: 'q'.repeat(60) });
    expect(put.statusCode).toBe(413);
    expect(put.json().error).toBe('storage_limit_reached');
  });

  test('with no limits, nothing is refused', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Free Co', slug: 'free-co' });
    for (let i = 0; i < 4; i++) expect((await invite(headers, `p${i}@x.test`)).statusCode).toBe(201);
    expect((await upload(headers, 'x'.repeat(5000))).statusCode).toBe(201);
    await limit(tenant.id, { seats: null, storageBytes: null });
    expect((await invite(headers, 'more@x.test')).statusCode).toBe(201);
    expect((await upload(headers, 'y'.repeat(5000), 'b.txt')).statusCode).toBe(201);
  });
});
