import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { documents, getDb, memberships, spaceGrants, spaces, tenants, users, withTenantTx } from '@kinote/db';
import { AppError, type DemoSeedStatus } from '@kinote/contracts';
import {
  demoPeople,
  readDemoFiles,
  seedDemo,
  uniqueSuffix,
  uploadDemoFiles,
  type Actor,
  type DemoAccount,
  type DemoHttp,
} from '@kinote/core';
import { createSession } from '../auth/sessions.js';
import { requireTenantAdmin } from './admin.js';

const runs = new Map<string, { state: 'running' | 'done' | 'failed'; error?: string }>();

/** Marks a workspace the demo content went into; only such a workspace can be reset (reset_demo_workspace, 0036). */
const DEMO_PLAN = 'demo';

/** Whether demo content is being added to (or reset in) the workspace right now. */
export function demoSeedRunning(tenantId: string): boolean {
  return runs.get(tenantId)?.state === 'running';
}

async function isEmpty(actor: Actor): Promise<boolean> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const [own] = await tx.select({ n: sql<number>`count(*)::int` }).from(spaces).where(eq(spaces.kind, 'normal'));
    const [docs] = await tx.select({ n: sql<number>`count(*)::int` }).from(documents);
    return own.n === 0 && docs.n === 0;
  });
}

async function isDemo(tenantId: string): Promise<boolean> {
  return withTenantTx(tenantId, async (tx) => {
    const [t] = await tx.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId));
    return t?.plan === DEMO_PLAN;
  });
}

export async function demoSeedStatus(actor: Actor): Promise<DemoSeedStatus> {
  requireTenantAdmin(actor);
  const run = runs.get(actor.tenantId);
  const idle = run?.state !== 'running';
  return {
    state: run?.state ?? 'idle',
    canSeed: idle && (await isEmpty(actor)),
    canReset: idle && (await isDemo(actor.tenantId)),
    ...(run?.error ? { error: run.error } : {}),
  };
}

function multipart(fields: Record<string, string>, file: { name: string; mimeType: string; buffer: Buffer }) {
  const boundary = `----kinote${uniqueSuffix()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  const fileName = file.name.replace(/["\r\n]/g, '_');
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The demo's api access in-process: every call goes through the real routes, as that person. */
function injectHttp(app: FastifyInstance): DemoHttp {
  const headers = (account?: DemoAccount, tenantId?: string) => ({
    ...(account ? { authorization: `Bearer ${account.token}` } : {}),
    ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
  });
  return {
    async json(path, o = {}) {
      const method = o.method ?? 'GET';
      const res = await app.inject({
        method,
        url: `/api/v1${path}`,
        headers: headers(o.account, o.tenantId),
        payload: o.data as object | undefined,
      });
      if (res.statusCode >= 400) throw new Error(`${method} ${path} -> ${res.statusCode} ${res.body}`);
      return (res.body ? res.json() : null) as never;
    },
    async upload({ account, tenantId, spaceId, file }) {
      const body = multipart({ space_id: spaceId }, file);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { ...headers(account, tenantId), 'content-type': body.contentType },
        payload: body.payload,
      });
      if (res.statusCode >= 400) throw new Error(`upload ${file.name} -> ${res.statusCode} ${res.body}`);
      return res.json().document.id as string;
    },
  };
}

/** The three colleagues of the demo: real rows with no usable password (nobody can sign in as them). */
async function colleagues(suffix: string): Promise<Record<'tomas' | 'mei' | 'jonah', DemoAccount>> {
  const out = {} as Record<'tomas' | 'mei' | 'jonah', DemoAccount>;
  for (const key of ['tomas', 'mei', 'jonah'] as const) {
    const email = `${key}-${suffix}@demo.example`;
    const [user] = await getDb().insert(users).values({ email, name: demoPeople[key].name, passwordHash: '!' }).returning();
    out[key] = { token: (await createSession(user.id)).token, user: { id: user.id, name: user.name, email } };
  }
  return out;
}

/**
 * After a reset the spaces are new: the workspace's other members (not its admins, who see every space) get a grant
 * on each, as they would on joining the demo: viewers as viewer, members as reviewer where review is on, else editor.
 */
async function grantMembers(tenantId: string, skip: string[]): Promise<void> {
  await withTenantTx(tenantId, async (tx) => {
    const people = await tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(inArray(memberships.role, ['member', 'viewer']), notInArray(memberships.userId, skip)));
    const live = await tx.select().from(spaces).where(and(eq(spaces.kind, 'normal'), isNull(spaces.archivedAt)));
    const rows = people.flatMap((p) =>
      live.map((s) => ({
        tenantId,
        spaceId: s.id,
        principalType: 'user' as const,
        principalId: p.userId,
        role: p.role === 'viewer' ? ('viewer' as const) : s.reviewRequired ? ('reviewer' as const) : ('editor' as const),
      }))
    );
    if (rows.length) await tx.insert(spaceGrants).values(rows).onConflictDoNothing();
  });
}

/**
 * Starts adding the Northwind Studio demo content to the actor's workspace, which must be empty; with `reset`, first
 * empties a workspace it was added to before (everything but its members and Inbox goes) and then adds it again. The
 * actor stands in for Priya (the owner); Tomás, Mei and Jonah are added as members. Runs in the background (a minute
 * or two, while the worker indexes the pages): poll `demoSeedStatus`. `afterWipe` runs once the old content is gone
 * (the api closes the workspace's live editing sessions there).
 */
export async function startDemoSeed(
  app: FastifyInstance,
  req: FastifyRequest,
  actor: Actor,
  o: { reset?: boolean; afterWipe?: () => Promise<void> } = {}
): Promise<void> {
  requireTenantAdmin(actor);
  if (runs.get(actor.tenantId)?.state === 'running') throw new AppError('demo_seed_running');
  if (o.reset ? !(await isDemo(actor.tenantId)) : !(await isEmpty(actor))) {
    throw new AppError(o.reset ? 'not_demo_workspace' : 'workspace_not_empty');
  }
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw new AppError('unauthenticated');

  const tenantId = actor.tenantId;
  runs.set(tenantId, { state: 'running' });
  const log = req.log;
  void (async () => {
    try {
      if (o.reset) {
        await withTenantTx(tenantId, (tx) => tx.execute(sql`SELECT reset_demo_workspace(${tenantId}::uuid)`));
        await o.afterWipe?.();
      } else {
        // Marked first, so a run that stops half way can still be reset.
        await withTenantTx(tenantId, (tx) => tx.update(tenants).set({ plan: DEMO_PLAN }).where(eq(tenants.id, tenantId)));
      }
      const [me] = await getDb().select().from(users).where(eq(users.id, actor.principalId));
      const owner: DemoAccount = { token, user: { id: me.id, name: me.name, email: me.email } };
      const others = await colleagues(uniqueSuffix());
      const http = injectHttp(app);
      const demo = await seedDemo(http, {
        into: { owner, tenantId, slug: '' },
        accounts: { priya: owner, ...others },
      });
      await uploadDemoFiles(http, demo, readDemoFiles());
      if (o.reset) await grantMembers(tenantId, [me.id, ...Object.values(others).map((a) => a.user.id)]);
      runs.set(tenantId, { state: 'done' });
    } catch (err) {
      log.error({ err }, 'demo seed failed');
      runs.set(tenantId, { state: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'failed' });
    }
  })();
}
