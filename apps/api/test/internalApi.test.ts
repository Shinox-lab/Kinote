import { describe, test, expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  enqueueJob,
  getDb,
  jobs,
  memberships,
  periodOf,
  rowsOf,
  tenantLimits,
  tenantUsage,
  tenants,
  users,
  withTenantTx,
} from '@kinote/db';
import {
  BootstrapResponseSchema,
  DefaultsReplySchema,
  InfoSchema,
  InternalTenantDetailSchema,
  TenantPageSchema,
  UsagePageSchema,
} from '@kinote/contracts';
import type { CollabClient } from '@kinote/shared';
import { createEmailToken, peekEmailToken } from '../src/auth/emailTokens.js';
import { bootstrapTenant, buildTestApp, signUp, useTestDb } from './support/testkit.js';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);
const cp = (token = TOKEN_A) => ({ authorization: `Bearer ${token}` });
const limitsBody = {
  plan: 'team',
  seats: 5,
  storageBytes: 1_000_000,
  creditsPerMonth: 100,
  indexCreditsPerMonth: 50,
};

const revoked: { tenantId: string }[] = [];
const recordingCollab = {
  revoke: async (target: { tenantId: string }) => {
    revoked.push(target);
  },
} as unknown as CollabClient;

describe('control-plane API', () => {
  const app = buildTestApp({ controlPlaneTokens: [TOKEN_A, TOKEN_B], collab: recordingCollab });
  const off = buildTestApp();
  useTestDb();

  const get = (url: string, headers = cp()) => app.inject({ method: 'GET', url, headers });
  const putLimits = (id: string, body: unknown, headers = cp()) =>
    app.inject({ method: 'PUT', url: `/internal/v1/tenants/${id}/limits`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const topup = (id: string, credits: number, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: `/internal/v1/tenants/${id}/topups`, headers: cp(), payload: { credits, idempotencyKey } });
  const capture = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/v1/captures', headers, payload: { text: 'Invoices go out weekly.' } });

  async function world(slug: string) {
    const w = await bootstrapTenant(app, { name: slug, slug });
    await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.headers, payload: { name: 'Eng', slug: 'eng' } });
    return w;
  }

  async function spend(tenantId: string, credits: number) {
    const period = periodOf(1, new Date()).key;
    await withTenantTx(tenantId, (tx) =>
      tx
        .insert(tenantUsage)
        .values({ tenantId, period, creditsUsedMilli: credits * 1000 })
        .onConflictDoUpdate({ target: [tenantUsage.tenantId, tenantUsage.period], set: { creditsUsedMilli: credits * 1000 } })
    );
  }

  test('without CONTROL_PLANE_TOKENS the internal API does not exist', async () => {
    expect((await off.inject({ method: 'GET', url: '/internal/v1/info', headers: cp() })).statusCode).toBe(404);
  });

  test('no token or a wrong token is 401; either of two rotated tokens works', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/v1/info' })).statusCode).toBe(401);
    expect((await get('/internal/v1/info', cp('c'.repeat(40)))).statusCode).toBe(401);
    expect((await get('/internal/v1/info', { authorization: TOKEN_A })).statusCode).toBe(401);
    expect((await get('/internal/v1/info', cp(TOKEN_A))).statusCode).toBe(200);
    expect((await get('/internal/v1/info', cp(TOKEN_B))).statusCode).toBe(200);
    // A session is not a control-plane token.
    const w = await world('session-co');
    expect((await app.inject({ method: 'GET', url: '/internal/v1/info', headers: w.headers })).statusCode).toBe(401);
  });

  test('info answers apiVersion 1', async () => {
    const info = InfoSchema.parse((await get('/internal/v1/info')).json());
    expect(info.apiVersion).toBe(1);
    expect(info.features).toEqual(['limits', 'usage', 'topups', 'billing_state', 'default_limits']);
  });

  test('tenants page in creation order and continue after the last id', async () => {
    const a = await world('first-co');
    const b = await world('second-co');
    const c = await world('third-co');
    await withTenantTx(a.tenant.id, (tx) => tx.update(tenants).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(tenants.id, a.tenant.id)));
    await withTenantTx(b.tenant.id, (tx) => tx.update(tenants).set({ createdAt: new Date('2026-01-02T00:00:00Z') }).where(eq(tenants.id, b.tenant.id)));
    await withTenantTx(c.tenant.id, (tx) => tx.update(tenants).set({ createdAt: new Date('2026-01-03T00:00:00Z') }).where(eq(tenants.id, c.tenant.id)));
    const first = TenantPageSchema.parse((await get('/internal/v1/tenants?limit=2')).json());
    expect(first.tenants.map((t) => t.slug)).toEqual(['first-co', 'second-co']);
    expect(first.tenants[0]).toMatchObject({ plan: 'standard', seats: 1, deletedAt: null });
    expect(first.tenants[0]!.ownerEmail).toMatch(/@example\.test$/);
    expect(first.next).toBe(b.tenant.id);
    const second = TenantPageSchema.parse((await get(`/internal/v1/tenants?limit=2&after=${first.next}`)).json());
    expect(second.tenants.map((t) => t.slug)).toEqual(['third-co']);
    expect(second.next).toBeNull();
  });

  test('PUT limits stores them, sets the plan label, audits, and the next capture is refused when usage is past them', async () => {
    const w = await world('limit-co');
    expect((await capture(w.headers)).statusCode).toBe(201);
    await spend(w.tenant.id, 200);
    const res = await putLimits(w.tenant.id, limitsBody);
    expect(res.statusCode, res.body).toBe(200);
    const detail = InternalTenantDetailSchema.parse(res.json());
    expect(detail.plan).toBe('team');
    expect(detail.limits).toEqual({ ...limitsBody, plan: undefined, gracePercent: 10, periodAnchorDay: 1 });
    expect(detail.usage).toMatchObject({ creditsUsed: 200, state: 'exhausted', seats: 1 });
    const audits = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.type, 'limits.updated')))
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorType).toBe('system');
    expect(audits[0]!.payload).toMatchObject({ by: 'control_plane', plan: 'team' });
    expect((await capture(w.headers)).json().error).toBe('credits_exhausted');
    // The same PUT again changes nothing (idempotent).
    expect(InternalTenantDetailSchema.parse((await putLimits(w.tenant.id, limitsBody)).json()).limits).toEqual(detail.limits);
  });

  test('PUT null removes limits: the workspace is unlimited again and held index jobs are released', async () => {
    const w = await world('free-again-co');
    await putLimits(w.tenant.id, { ...limitsBody, creditsPerMonth: 1 });
    await spend(w.tenant.id, 5);
    const later = new Date(Date.now() + 86_400_000);
    const held = await withTenantTx(w.tenant.id, (tx) =>
      enqueueJob(tx, { tenantId: w.tenant.id, queue: 'version.index', idempotencyKey: 'held', payload: {}, runAt: later })
    );
    const res = await putLimits(w.tenant.id, null);
    expect(res.statusCode, res.body).toBe(200);
    const detail = InternalTenantDetailSchema.parse(res.json());
    expect(detail.limits).toBeNull();
    expect(detail.plan).toBe('standard');
    expect(detail.usage.state).toBe('unlimited');
    const [job] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(jobs).where(eq(jobs.id, held.id)));
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await withTenantTx(w.tenant.id, (tx) => tx.select().from(tenantLimits))).toHaveLength(0);
    expect((await capture(w.headers)).statusCode).toBe(201);
  });

  test('topup is idempotent by key and lifts a refused workspace back to accepted', async () => {
    const w = await world('topup-co');
    await putLimits(w.tenant.id, { ...limitsBody, creditsPerMonth: 10 });
    await spend(w.tenant.id, 11);
    expect((await capture(w.headers)).statusCode).toBe(429);
    const first = await topup(w.tenant.id, 20, 'order-1');
    expect(first.statusCode, first.body).toBe(201);
    const again = await topup(w.tenant.id, 20, 'order-1');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const detail = InternalTenantDetailSchema.parse(first.json());
    expect(detail.usage.creditsTopup).toBe(20);
    expect((await capture(w.headers)).statusCode).toBe(201);
    const audits = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.type, 'credits.topup')))
    );
    expect(audits).toHaveLength(1);
  });

  test('PUT limits on an unknown tenant is 404 tenant_not_found; GET of a deleted tenant shows it', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await putLimits(missing, limitsBody);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('tenant_not_found');
    expect((await get(`/internal/v1/tenants/${missing}`)).statusCode).toBe(404);
    expect((await topup(missing, 1, 'k')).statusCode).toBe(404);

    const w = await world('gone-co');
    await withTenantTx(w.tenant.id, (tx) => tx.update(tenants).set({ deletedAt: new Date() }).where(eq(tenants.id, w.tenant.id)));
    const gone = InternalTenantDetailSchema.parse((await get(`/internal/v1/tenants/${w.tenant.id}`)).json());
    expect(gone.deletedAt).not.toBeNull();
    expect((await putLimits(w.tenant.id, limitsBody)).statusCode).toBe(404);
  });

  test('a PUT with no body is refused and leaves the limits alone', async () => {
    const w = await world('nobody-co');
    await putLimits(w.tenant.id, limitsBody);
    const res = await app.inject({ method: 'PUT', url: `/internal/v1/tenants/${w.tenant.id}/limits`, headers: cp() });
    expect(res.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PUT',
      url: `/internal/v1/tenants/${w.tenant.id}/limits`,
      headers: { ...cp(), 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
    const detail = InternalTenantDetailSchema.parse((await get(`/internal/v1/tenants/${w.tenant.id}`)).json());
    expect(detail.plan).toBe('team');
    expect(detail.limits?.creditsPerMonth).toBe(100);
  });

  test('the control plane cannot make a workspace a demo one, nor relabel a demo workspace', async () => {
    const w = await world('label-co');
    expect((await putLimits(w.tenant.id, { ...limitsBody, plan: 'demo' })).statusCode).toBe(400);
    expect((await putLimits(w.tenant.id, { ...limitsBody, plan: 'Demo' })).statusCode).toBe(400);
    await withTenantTx(w.tenant.id, (tx) => tx.update(tenants).set({ plan: 'demo' }).where(eq(tenants.id, w.tenant.id)));
    const res = await putLimits(w.tenant.id, limitsBody);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().plan).toBe('demo');
    expect(res.json().limits.creditsPerMonth).toBe(100);
    expect((await putLimits(w.tenant.id, null)).json().plan).toBe('demo');
  });

  const putDefaults = (body: unknown, headers: Record<string, string> = cp()) =>
    app.inject({ method: 'PUT', url: '/internal/v1/defaults', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const freeDefaults = { plan: 'free', seats: 3, storageBytes: 1000, creditsPerMonth: 50, indexCreditsPerMonth: 20, maxFreePerOwner: 2 };

  test('GET defaults is null until PUT; PUT stores and answers them; PUT null clears', async () => {
    expect(DefaultsReplySchema.parse((await get('/internal/v1/defaults')).json())).toEqual({ defaults: null });
    const put = await putDefaults(freeDefaults);
    expect(put.statusCode, put.body).toBe(200);
    expect(DefaultsReplySchema.parse(put.json())).toEqual({ defaults: { ...freeDefaults, gracePercent: 10 } });
    expect((await get('/internal/v1/defaults')).json()).toEqual({ defaults: { ...freeDefaults, gracePercent: 10 } });
    const again = await putDefaults({ ...freeDefaults, seats: null, gracePercent: 0, maxFreePerOwner: null });
    expect(again.json().defaults).toEqual({ ...freeDefaults, seats: null, gracePercent: 0, maxFreePerOwner: null });
    const cleared = await putDefaults(null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ defaults: null });
    expect((await get('/internal/v1/defaults')).json()).toEqual({ defaults: null });
  });

  test('PUT defaults refuses demo, extra keys, a missing body and negative numbers', async () => {
    expect((await putDefaults({ ...freeDefaults, plan: 'Demo' })).statusCode).toBe(400);
    expect((await putDefaults({ ...freeDefaults, periodAnchorDay: 3 })).statusCode).toBe(400);
    expect((await putDefaults({ ...freeDefaults, seats: -1 })).statusCode).toBe(400);
    expect((await putDefaults({ ...freeDefaults, maxFreePerOwner: -1 })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'PUT', url: '/internal/v1/defaults', headers: cp() });
    expect(missing.statusCode).toBe(400);
    expect((await get('/internal/v1/defaults')).json()).toEqual({ defaults: null });
  });

  test('defaults need the control-plane token', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/v1/defaults' })).statusCode).toBe(401);
    expect((await putDefaults(freeDefaults, {})).statusCode).toBe(401);
  });

  test('bad bodies are 400', async () => {
    const w = await world('bad-co');
    expect((await putLimits(w.tenant.id, { ...limitsBody, seats: -1 })).statusCode).toBe(400);
    expect((await putLimits(w.tenant.id, { ...limitsBody, periodAnchorDay: 29 })).statusCode).toBe(400);
    expect((await topup(w.tenant.id, 0, 'k')).statusCode).toBe(400);
  });

  test('every response parses with its schema; usage pages like tenants and matches the detail', async () => {
    const a = await world('use-a');
    const b = await world('use-b');
    await putLimits(a.tenant.id, limitsBody);
    await spend(a.tenant.id, 42);
    const page = UsagePageSchema.parse((await get('/internal/v1/usage?limit=1')).json());
    expect(page.usage).toHaveLength(1);
    expect(page.next).not.toBeNull();
    const rest = UsagePageSchema.parse((await get(`/internal/v1/usage?after=${page.next}`)).json());
    const all = [...page.usage, ...rest.usage];
    expect(all.map((u) => u.tenantId).sort()).toEqual([a.tenant.id, b.tenant.id].sort());
    const detail = InternalTenantDetailSchema.parse((await get(`/internal/v1/tenants/${a.tenant.id}`)).json());
    const { tenantId: _id, ...fromList } = all.find((u) => u.tenantId === a.tenant.id)!;
    expect(fromList).toEqual(detail.usage);
    expect(detail.usage).toMatchObject({ creditsUsed: 42, state: 'ok' });

    const period = periodOf(1, new Date());
    const lastMonth = new Date(period.start.getTime() - 86_400_000).toISOString().slice(0, 10);
    const old = UsagePageSchema.parse((await get(`/internal/v1/usage?period=${lastMonth}`)).json());
    expect(old.usage.find((u) => u.tenantId === a.tenant.id)!.creditsUsed).toBe(0);
  });
  const putBilling = (id: string, body: unknown) =>
    app.inject({ method: 'PUT', url: `/internal/v1/tenants/${id}/billing-state`, headers: { ...cp(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const billingAudits = (tenantId: string) =>
    withTenantTx(tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.type, 'billing.state_updated')))
    );

  test('PUT billing-state stores it, shows it in the detail and the listing, and audits a change once', async () => {
    const w = await world('billing-co');
    const body = { state: 'past_due', manageUrl: 'https://cp.test/portal' };
    const res = await putBilling(w.tenant.id, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(InternalTenantDetailSchema.parse(res.json()).billingState).toEqual(body);
    expect(InternalTenantDetailSchema.parse((await get(`/internal/v1/tenants/${w.tenant.id}`)).json()).billingState).toEqual(body);
    const page = TenantPageSchema.parse((await get('/internal/v1/tenants?limit=500')).json());
    expect(page.tenants.find((t) => t.id === w.tenant.id)!.billingState).toEqual(body);
    expect((await putBilling(w.tenant.id, body)).statusCode).toBe(200);
    const audits = await billingAudits(w.tenant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ by: 'control_plane', state: 'past_due', manageUrl: 'https://cp.test/portal' });
  });

  test('a workspace never set shows billing state ok', async () => {
    const w = await world('billing-default-co');
    const detail = InternalTenantDetailSchema.parse((await get(`/internal/v1/tenants/${w.tenant.id}`)).json());
    expect(detail.billingState).toEqual({ state: 'ok', manageUrl: null });
  });

  test('PUT billing-state refuses bad bodies, unknown and deleted tenants', async () => {
    const w = await world('billing-bad-co');
    expect((await putBilling(w.tenant.id, { state: 'paused', manageUrl: null })).json().error).toBe('validation_failed');
    expect((await putBilling(w.tenant.id, { state: 'ok' })).statusCode).toBe(400);
    expect((await putBilling(w.tenant.id, { state: 'ok', manageUrl: 'not a url' })).statusCode).toBe(400);
    const empty = await app.inject({ method: 'PUT', url: `/internal/v1/tenants/${w.tenant.id}/billing-state`, headers: cp() });
    expect(empty.statusCode).toBe(400);
    const missing = await putBilling('00000000-0000-4000-8000-000000000000', { state: 'ok', manageUrl: null });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('tenant_not_found');
    await withTenantTx(w.tenant.id, (tx) => tx.update(tenants).set({ deletedAt: new Date() }).where(eq(tenants.id, w.tenant.id)));
    expect((await putBilling(w.tenant.id, { state: 'ok', manageUrl: null })).statusCode).toBe(404);
  });

  test('suspending closes live editing; lifting it releases held index jobs', async () => {
    const w = await world('billing-suspend-co');
    revoked.length = 0;
    expect((await putBilling(w.tenant.id, { state: 'suspended', manageUrl: 'https://cp.test/portal' })).statusCode).toBe(200);
    expect(revoked).toEqual([{ tenantId: w.tenant.id }]);
    await putBilling(w.tenant.id, { state: 'suspended', manageUrl: 'https://cp.test/portal' });
    expect(revoked).toHaveLength(1);
    const later = new Date(Date.now() + 86_400_000);
    const held = await withTenantTx(w.tenant.id, (tx) =>
      enqueueJob(tx, { tenantId: w.tenant.id, queue: 'version.index', idempotencyKey: 'held-billing', payload: {}, runAt: later })
    );
    expect((await putBilling(w.tenant.id, { state: 'ok', manageUrl: null })).statusCode).toBe(200);
    const [job] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(jobs).where(eq(jobs.id, held.id)));
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('control-plane API: baked version and IP allowlist', () => {
  useTestDb();
  const info = (app: ReturnType<typeof buildTestApp>, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/internal/v1/info', headers });

  test('info reports the baked version', async () => {
    const app = buildTestApp({ controlPlaneTokens: [TOKEN_A], kinoteVersion: '0.2.0' });
    expect(InfoSchema.parse((await info(app, cp())).json()).kinoteVersion).toBe('0.2.0');
  });

  test('the allowlist refuses other addresses before the token', async () => {
    const app = buildTestApp({ controlPlaneTokens: [TOKEN_A], controlPlaneAllowedIps: ['10.1.0.0/16', '172.16.0.9'], trustProxy: 1 });
    expect((await info(app, { ...cp(), 'x-forwarded-for': '10.1.2.3' })).statusCode).toBe(200);
    expect((await info(app, { ...cp(), 'x-forwarded-for': '172.16.0.9' })).statusCode).toBe(200);
    const refused = await info(app, { ...cp(), 'x-forwarded-for': '10.2.0.1' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('forbidden');
    expect((await info(app, { 'x-forwarded-for': '10.2.0.1' })).statusCode).toBe(403);
    // Allowed address, no token: the token check still applies.
    expect((await info(app, { 'x-forwarded-for': '10.1.2.3' })).statusCode).toBe(401);
  });

  test('an empty allowlist lets any address through', async () => {
    const app = buildTestApp({ controlPlaneTokens: [TOKEN_A], controlPlaneAllowedIps: [], trustProxy: 1 });
    expect((await info(app, { ...cp(), 'x-forwarded-for': '203.0.113.7' })).statusCode).toBe(200);
  });
});

describe('control-plane API: bootstrap', () => {
  useTestDb();
  const PUBLIC = 'https://acme.kinote.example';
  const app = buildTestApp({ controlPlaneTokens: [TOKEN_A], publicUrl: PUBLIC });
  const bootstrap = (body: unknown) =>
    app.inject({ method: 'POST', url: '/internal/v1/bootstrap', headers: cp(), payload: body as Record<string, unknown> });
  const confirm = (token: string, password = 'a-fresh-long-password-1') =>
    app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token, password } });
  const tokenOf = (setupUrl: string) => setupUrl.slice(`${PUBLIC}/reset-password/`.length);

  test('creates the owner, the workspace and a setup link', async () => {
    const res = await bootstrap({ email: 'Owner@Acme.test', workspaceName: 'Acme HQ' });
    expect(res.statusCode, res.body).toBe(201);
    const body = BootstrapResponseSchema.parse(res.json());
    expect(body.setupUrl.startsWith(`${PUBLIC}/reset-password/`)).toBe(true);
    const [user] = await getDb().select().from(users).where(eq(users.id, body.userId));
    expect(user?.email).toBe('owner@acme.test');
    expect(user?.passwordHash).toBe('!');
    const [tenant] = await withTenantTx(body.tenantId, (tx) => tx.select().from(tenants).where(eq(tenants.id, body.tenantId)));
    expect(tenant?.name).toBe('Acme HQ');
    const owners = await withTenantTx(body.tenantId, (tx) =>
      tx.select().from(memberships).where(and(eq(memberships.tenantId, body.tenantId), eq(memberships.userId, body.userId)))
    );
    expect(owners.map((m) => m.role)).toEqual(['owner']);
  });

  test('the link sets the password once and signs in', async () => {
    const body = BootstrapResponseSchema.parse((await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' })).json());
    const first = await confirm(tokenOf(body.setupUrl));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().user.email).toBe('owner@acme.test');
    expect((await confirm(tokenOf(body.setupUrl))).json().error).toBe('link_invalid');
  });

  test('the link works for 72 hours', async () => {
    const body = BootstrapResponseSchema.parse((await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' })).json());
    const token = tokenOf(body.setupUrl);
    const now = Date.now();
    expect(await peekEmailToken(token, 'setup', new Date(now + 71 * 3_600_000))).toBe(body.userId);
    expect(await peekEmailToken(token, 'setup', new Date(now + 73 * 3_600_000))).toBeNull();
  });

  test('again while pending: same user and workspace, a new link, the old one stops', async () => {
    const a = BootstrapResponseSchema.parse((await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' })).json());
    const again = await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' });
    expect(again.statusCode).toBe(201);
    const b = BootstrapResponseSchema.parse(again.json());
    expect(b.userId).toBe(a.userId);
    expect(b.tenantId).toBe(a.tenantId);
    expect(b.setupUrl).not.toBe(a.setupUrl);
    expect((await confirm(tokenOf(a.setupUrl))).json().error).toBe('link_invalid');
    expect((await confirm(tokenOf(b.setupUrl))).statusCode).toBe(200);
    const owned = await getDb().execute(sql`SELECT tenant_id FROM my_tenants(${a.userId}::uuid)`);
    expect(rowsOf(owned)).toHaveLength(1);
  });

  test('refused once anyone has a password, and for another email', async () => {
    await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' });
    const other = await bootstrap({ email: 'someone@acme.test', workspaceName: 'Other' });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('already_set_up');

    const fresh = BootstrapResponseSchema.parse((await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' })).json());
    await confirm(tokenOf(fresh.setupUrl));
    const done = await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' });
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe('already_set_up');
  });

  test('refused when someone signed up first', async () => {
    await signUp(app, 'early@acme.test');
    expect((await bootstrap({ email: 'owner@acme.test', workspaceName: 'Acme HQ' })).statusCode).toBe(409);
  });

  test('a bad body is validation_failed; no token is 401', async () => {
    expect((await bootstrap({ email: 'not-an-email', workspaceName: 'x' })).json().error).toBe('validation_failed');
    expect((await bootstrap({ email: 'owner@acme.test', workspaceName: '' })).json().error).toBe('validation_failed');
    expect((await app.inject({ method: 'POST', url: '/internal/v1/bootstrap', payload: { email: 'a@b.test', workspaceName: 'x' } })).statusCode).toBe(401);
  });

  test('a workspace name that slugs to a taken or empty slug still works', async () => {
    const res = await bootstrap({ email: 'owner@acme.test', workspaceName: '!!!' });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('password-reset confirm: which links it takes', () => {
  useTestDb();
  const app = buildTestApp();
  const confirm = (token: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token, password: 'a-fresh-long-password-1' } });

  test('a reset link and a setup link work; a verify link does not', async () => {
    const s = await signUp(app, 'person@acme.test');
    expect((await confirm(await createEmailToken(s.userId, 'verify'))).json().error).toBe('link_invalid');
    expect((await confirm(await createEmailToken(s.userId, 'setup'))).statusCode).toBe(200);
    expect((await confirm(await createEmailToken(s.userId, 'reset'))).statusCode).toBe(200);
  });
});
