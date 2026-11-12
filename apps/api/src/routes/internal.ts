import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  addTopup,
  getDb,
  memberships,
  readBillingState,
  readTenantDefaults,
  tenantDefaults,
  readStanding,
  releaseHeldIndexJobs,
  tenantBilling,
  rowsOf,
  tenantLimits,
  tenants,
  users,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  AppError,
  BillingStateBodySchema,
  PageQuerySchema,
  PutDefaultsRequestSchema,
  PutLimitsRequestSchema,
  TopupInputSchema,
  UsageQuerySchema,
  type InternalTenant,
  type InternalTenantDetail,
  type TenantUsage,
} from '@kinote/contracts';
import { countSeats, creditVerdict, indexHeld } from '@kinote/core';

// The control-plane API: Kinote-SaaS sets limits, adds top-ups and reads usage
// here. Mounted only when CONTROL_PLANE_TOKENS is set; every route checks the
// bearer token itself (the routes are `public` to the session auth). Calls
// across tenants go through the SECURITY DEFINER cp_list_tenants; calls for one
// tenant run in its own transaction, so RLS still applies. Reference:
// docs/control-plane-api.md.

/** Audit rows from the control plane: a system actor with this id and `by: 'control_plane'`. */
const CONTROL_PLANE_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function kinoteVersion(): string {
  try {
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** An onRequest hook accepting `Authorization: Bearer <one of tokens>`, compared by SHA-256 in constant time. */
function bearerCheck(tokens: string[]) {
  const hashes = tokens.map(sha256);
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) throw new AppError('unauthenticated');
    const presented = sha256(match[1]!);
    let ok = false;
    for (const hash of hashes) ok = timingSafeEqual(hash, presented) || ok;
    if (!ok) throw new AppError('unauthenticated');
  };
}

const notFound = () => new AppError('tenant_not_found');

async function tenantRow(tx: DbTransaction, id: string) {
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, id));
  return row ?? null;
}

async function ownerEmail(tx: DbTransaction, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')))
    .orderBy(memberships.createdAt, memberships.userId)
    .limit(1);
  return row?.email ?? null;
}

/** One tenant's usage in the period containing `at`; the same numbers for /tenants/:id and /usage. */
async function usageOf(tx: DbTransaction, tenantId: string, at: Date): Promise<TenantUsage> {
  const standing = await readStanding(tx, tenantId, at);
  const verdict = creditVerdict(standing);
  return {
    period: standing.period.key,
    periodEnd: standing.period.end.toISOString(),
    creditsUsed: standing.creditsUsedMilli / 1000,
    indexCreditsUsed: standing.indexCreditsUsedMilli / 1000,
    creditsTopup: standing.creditsTopup,
    storageBytes: standing.storageBytes,
    seats: await countSeats(tx, tenantId, new Date()),
    state: verdict.state,
    indexHeld: indexHeld(standing),
  };
}

async function detailOf(tx: DbTransaction, id: string): Promise<InternalTenantDetail> {
  const tenant = await tenantRow(tx, id);
  if (!tenant) throw notFound();
  const standing = await readStanding(tx, id, new Date());
  const usage = await usageOf(tx, id, new Date());
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    plan: tenant.plan,
    createdAt: tenant.createdAt.toISOString(),
    deletedAt: tenant.deletedAt?.toISOString() ?? null,
    ownerEmail: await ownerEmail(tx, id),
    seats: usage.seats,
    billingState: await readBillingState(tx, id),
    limits: standing.limits,
    usage,
  };
}

/** A tenant id from the path; anything that is not a UUID is simply not found. */
function tenantIdOf(req: FastifyRequest): string {
  const id = String((req.params as { id?: unknown }).id ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw notFound();
  return id;
}

type CpTenantRow = {
  id: string;
  slug: string;
  name: string;
  plan: string;
  created_at: Date | string;
  deleted_at: Date | string | null;
  owner_email: string | null;
  seats: number;
  billing_state: 'ok' | 'past_due' | 'suspended';
  manage_url: string | null;
};

async function listTenants(after: string | undefined, limit: number): Promise<CpTenantRow[]> {
  const result = await getDb().execute(sql`SELECT * FROM public.cp_list_tenants(${after ?? null}::uuid, ${limit})`);
  return rowsOf<CpTenantRow>(result);
}

const iso = (v: Date | string) => new Date(v).toISOString();

export interface InternalRouteOptions {
  /** Closes a workspace's live editing sessions (after it is suspended, so they reconnect read-only). */
  revokeTenant?: (tenantId: string) => Promise<void>;
}

export function registerInternalRoutes(app: FastifyInstance, tokens: string[], o: InternalRouteOptions = {}): void {
  if (tokens.length === 0) {
    // Off: the paths do not exist (the session auth would otherwise answer 401).
    app.all('/internal/*', { config: { auth: 'public' } }, async (_req, reply: FastifyReply) => reply.callNotFound());
    return;
  }
  const opts = { config: { auth: 'public' as const }, onRequest: bearerCheck(tokens) };

  app.get('/internal/v1/info', opts, async () => ({
    kinoteVersion: kinoteVersion(),
    apiVersion: 1 as const,
    features: ['limits', 'usage', 'topups', 'billing_state', 'default_limits'],
  }));

  app.get('/internal/v1/defaults', opts, async () => ({ defaults: await readTenantDefaults(getDb()) }));

  app.put('/internal/v1/defaults', opts, async (req) => {
    // A missing body is a mistake, not "no defaults": that takes an explicit JSON null.
    if (req.body === undefined) throw new AppError('validation_failed', 'The body must be the defaults, or null to remove them.');
    const body = PutDefaultsRequestSchema.parse(req.body);
    const db = getDb();
    if (body === null) {
      await db.delete(tenantDefaults).where(eq(tenantDefaults.id, true));
    } else {
      const values = {
        plan: body.plan,
        seats: body.seats,
        storageBytes: body.storageBytes,
        creditsPerMonth: body.creditsPerMonth,
        indexCreditsPerMonth: body.indexCreditsPerMonth,
        gracePercent: body.gracePercent ?? 10,
        maxFreePerOwner: body.maxFreePerOwner,
        askModel: body.askModel ?? null,
        creditMultiplier: body.creditMultiplier ?? 1,
        updatedAt: new Date(),
      };
      await db.insert(tenantDefaults).values({ id: true, ...values }).onConflictDoUpdate({ target: tenantDefaults.id, set: values });
    }
    return { defaults: await readTenantDefaults(db) };
  });

  app.get('/internal/v1/tenants', opts, async (req) => {
    const { after, limit } = PageQuerySchema.parse(req.query);
    const rows = await listTenants(after, limit);
    const page: InternalTenant[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      plan: r.plan,
      createdAt: iso(r.created_at),
      deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
      ownerEmail: r.owner_email,
      seats: Number(r.seats),
      billingState: { state: r.billing_state, manageUrl: r.manage_url },
    }));
    return { tenants: page, next: rows.length === limit ? rows.at(-1)!.id : null };
  });

  app.get('/internal/v1/tenants/:id', opts, async (req) => {
    const id = tenantIdOf(req);
    return withTenantTx(id, (tx) => detailOf(tx, id));
  });

  app.put('/internal/v1/tenants/:id/limits', opts, async (req) => {
    const id = tenantIdOf(req);
    // A missing body is a mistake, not "remove every limit": that takes an explicit JSON null.
    if (req.body === undefined) throw new AppError('validation_failed', 'The body must be the limits, or null to remove them.');
    const body = PutLimitsRequestSchema.parse(req.body);
    return withTenantTx(id, async (tx) => {
      const tenant = await tenantRow(tx, id);
      if (!tenant || tenant.deletedAt) throw notFound();
      const now = new Date();
      if (body === null) {
        await tx.delete(tenantLimits).where(eq(tenantLimits.tenantId, id));
      } else {
        const values = {
          seats: body.seats,
          storageBytes: body.storageBytes,
          creditsPerMonth: body.creditsPerMonth,
          indexCreditsPerMonth: body.indexCreditsPerMonth,
          gracePercent: body.gracePercent ?? 10,
          periodAnchorDay: body.periodAnchorDay ?? 1,
          askModel: body.askModel ?? null,
          creditMultiplier: body.creditMultiplier ?? 1,
          updatedAt: now,
          updatedBy: 'control_plane',
        };
        await tx
          .insert(tenantLimits)
          .values({ tenantId: id, ...values })
          .onConflictDoUpdate({ target: tenantLimits.tenantId, set: values });
      }
      // The demo workspace keeps its 'demo' marker; limits still apply to it.
      const plan = tenant.plan === 'demo' ? 'demo' : (body?.plan ?? 'standard');
      await tx.update(tenants).set({ plan }).where(and(eq(tenants.id, id), isNull(tenants.deletedAt)));
      // Raised or removed limits let held indexing run now; jobs still over the limit are held again.
      await releaseHeldIndexJobs(tx, id, now);
      await writeAuditEvent(tx, {
        tenantId: id,
        type: 'limits.updated',
        actorType: 'system',
        actorId: CONTROL_PLANE_ACTOR_ID,
        subjectType: 'tenant',
        subjectId: id,
        payload: { by: 'control_plane', plan, limits: body === null ? null : { ...body, plan: undefined } },
      });
      return detailOf(tx, id);
    });
  });

  app.put('/internal/v1/tenants/:id/billing-state', opts, async (req) => {
    const id = tenantIdOf(req);
    if (req.body === undefined) throw new AppError('validation_failed', 'The body must be the billing state.');
    const body = BillingStateBodySchema.parse(req.body);
    const { detail, from } = await withTenantTx(id, async (tx) => {
      const tenant = await tenantRow(tx, id);
      if (!tenant || tenant.deletedAt) throw notFound();
      const before = await readBillingState(tx, id);
      const now = new Date();
      if (before.state !== body.state || before.manageUrl !== body.manageUrl) {
        const values = { state: body.state, manageUrl: body.manageUrl, updatedAt: now };
        await tx.insert(tenantBilling).values({ tenantId: id, ...values }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: values });
        // Lifting a suspension lets held indexing run now (jobs still over an index limit are held again).
        if (before.state === 'suspended' && body.state !== 'suspended') await releaseHeldIndexJobs(tx, id, now);
        await writeAuditEvent(tx, {
          tenantId: id,
          type: 'billing.state_updated',
          actorType: 'system',
          actorId: CONTROL_PLANE_ACTOR_ID,
          subjectType: 'tenant',
          subjectId: id,
          payload: { by: 'control_plane', state: body.state, manageUrl: body.manageUrl },
        });
      }
      return { detail: await detailOf(tx, id), from: before.state };
    });
    // After commit: live editors reconnect and find the workspace read-only. Best effort.
    if (body.state === 'suspended' && from !== 'suspended' && o.revokeTenant) {
      try {
        await o.revokeTenant(id);
      } catch (err) {
        req.log.error({ err }, 'collab revoke after suspension failed');
      }
    }
    return detail;
  });

  app.post('/internal/v1/tenants/:id/topups', opts, async (req, reply) => {
    const id = tenantIdOf(req);
    const { credits, idempotencyKey } = TopupInputSchema.parse(req.body);
    return withTenantTx(id, async (tx) => {
      const tenant = await tenantRow(tx, id);
      if (!tenant || tenant.deletedAt) throw notFound();
      const result = await addTopup(tx, id, credits, idempotencyKey, new Date());
      if (result.created) {
        await writeAuditEvent(tx, {
          tenantId: id,
          type: 'credits.topup',
          actorType: 'system',
          actorId: CONTROL_PLANE_ACTOR_ID,
          subjectType: 'tenant',
          subjectId: id,
          payload: { by: 'control_plane', credits, idempotencyKey, period: result.periodKey },
        });
      }
      return reply.status(result.created ? 201 : 200).send(await detailOf(tx, id));
    });
  });

  app.get('/internal/v1/usage', opts, async (req) => {
    const { after, limit, period } = UsageQuerySchema.parse(req.query);
    const at = period ? new Date(`${period}T00:00:00Z`) : new Date();
    const rows = await listTenants(after, limit);
    const usage = [];
    for (const r of rows) {
      usage.push({ tenantId: r.id, ...(await withTenantTx(r.id, (tx) => usageOf(tx, r.id, at))) });
    }
    return { usage, next: rows.length === limit ? rows.at(-1)!.id : null };
  });
}
