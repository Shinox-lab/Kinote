import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { withTenantTx } from '@living-wiki/db';
import { SearchRequestSchema, AskRequestSchema, AppError } from '@living-wiki/contracts';
import {
  getReadableSpaceIds,
  defaultEmbeddingProvider,
  type Actor,
} from '@living-wiki/core';
import {
  createTenantWithInbox,
  createSpace,
  getSpaceForActor,
  listSpacesForActor,
  updateSpaceSettings,
  getSpaceTree,
  getSpaceArchived,
  archiveSpace,
  upsertSpaceGrant,
  inviteMember,
  acceptInvitation,
} from './routes/foundations.js';
import {
  listMembers,
  changeMemberRole,
  removeMember,
  listGroups,
  createGroup,
  addGroupMember,
  removeGroupMember,
  listSpaceGrants,
  deleteSpaceGrant,
} from './routes/admin.js';
import {
  createPage,
  getPageDetails,
  issueCollabToken,
  submitPageSnapshot,
  restorePageVersion,
  approveVersion,
  rejectVersion,
  retryVersion,
  movePage,
  archivePage,
  restorePage,
  withdrawPage,
  listPageVersions,
  getVersionDetail,
  getPageChanges,
  comparePageVersions,
  getVersionDiff,
} from './routes/pages.js';
import { listReviewQueue } from './routes/reviews.js';
import { authRoutes, type AuthRateLimit } from './routes/auth.js';
import { requireSession, resolveActor, type AuthSession } from './auth/actor.js';
import { registerErrorHandler } from './errors.js';
import { searchWiki } from './search/hybridSearch.js';
import { askWiki } from './search/ask.js';
import type { CollabClient } from './collab/client.js';

export interface ApiServerOptions {
  /** Per-IP limit for sign-up and sign-in (each route counted separately). */
  authRateLimit?: AuthRateLimit;
  /**
   * Trust X-Forwarded-For from a reverse proxy, so `req.ip` (and the per-IP
   * auth rate limit) is the real client address. Default false: without a
   * proxy in front the header is client-controlled and must be ignored.
   */
  trustProxy?: boolean;
  /**
   * The collab server's internal endpoints. A manual snapshot flushes the
   * live document through it first. Production always passes one (main.ts);
   * without it (tests that do not run collab) the flush is skipped.
   */
  collab?: CollabClient;
}

const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = { max: 10, timeWindow: '1 minute' };

/** The tenant actor attached by the auth hook (routes default to `auth: 'tenant'`). */
function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new AppError('unauthenticated');
  return req.actor;
}

function sessionOf(req: FastifyRequest): AuthSession {
  if (!req.authSession) throw new AppError('unauthenticated');
  return req.authSession;
}

export function buildApiServer(opts: ApiServerOptions = {}) {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  registerErrorHandler(app);

  // Identity comes only from the session token and, for tenant routes, the
  // membership row of the session user in x-tenant-id. Routes declare
  // config.auth ('public' | 'session' | 'tenant'); undeclared means 'tenant'.
  app.decorateRequest('authSession', null);
  app.decorateRequest('actor', null);
  app.addHook('preHandler', async (req) => {
    const mode = req.routeOptions.config?.auth ?? 'tenant';
    if (mode === 'public') return;
    req.authSession = await requireSession(req);
    if (mode === 'tenant') req.actor = await resolveActor(req);
  });

  // Rate limiting is opt-in per route (sign-up, sign-in). The plugin's onRoute
  // hook must be installed before those routes are declared, so the auth
  // routes are registered as a plugin after it.
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AppError('rate_limited'),
  });
  app.register(authRoutes, { authRateLimit: opts.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT });

  app.post('/api/v1/tenants', { config: { auth: 'session' } }, async (req, reply) => {
    const res = await createTenantWithInbox(sessionOf(req).userId, req.body);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/invitations', async (req, reply) => {
    const res = await inviteMember(actorOf(req), req.body);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/invitations/accept', { config: { auth: 'session' } }, async (req, reply) => {
    const res = await acceptInvitation(sessionOf(req).userId, req.body);
    return reply.status(200).send(res);
  });

  app.get('/api/v1/spaces', async (req, reply) => {
    const actor = actorOf(req);
    const res = await listSpacesForActor(actor);
    return reply.send(res);
  });

  app.post('/api/v1/spaces', async (req, reply) => {
    const actor = actorOf(req);
    const res = await createSpace(actor, req.body);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/spaces/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await getSpaceForActor(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.patch('/api/v1/spaces/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await updateSpaceSettings(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.get('/api/v1/spaces/:id/tree', async (req, reply) => {
    const res = await getSpaceTree(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.get('/api/v1/spaces/:id/archived', async (req, reply) => {
    const res = await getSpaceArchived(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/spaces/:id/archive', async (req, reply) => {
    const res = await archiveSpace(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/spaces/:id/grants', async (req, reply) => {
    const actor = actorOf(req);
    const res = await upsertSpaceGrant(actor, (req.params as any).id, req.body);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/spaces/:id/grants', async (req, reply) => {
    const res = await listSpaceGrants(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.delete('/api/v1/spaces/:id/grants/:principalType/:principalId', async (req, reply) => {
    const p = req.params as any;
    await deleteSpaceGrant(actorOf(req), p.id, p.principalType, p.principalId);
    return reply.status(204).send();
  });

  app.get('/api/v1/members', async (req, reply) => {
    return reply.send(await listMembers(actorOf(req)));
  });

  app.patch('/api/v1/members/:userId', async (req, reply) => {
    const res = await changeMemberRole(actorOf(req), (req.params as any).userId, req.body);
    return reply.send(res);
  });

  app.delete('/api/v1/members/:userId', async (req, reply) => {
    await removeMember(actorOf(req), (req.params as any).userId);
    return reply.status(204).send();
  });

  app.get('/api/v1/groups', async (req, reply) => {
    return reply.send(await listGroups(actorOf(req)));
  });

  app.post('/api/v1/groups', async (req, reply) => {
    const res = await createGroup(actorOf(req), req.body);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/groups/:id/members', async (req, reply) => {
    const res = await addGroupMember(actorOf(req), (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.delete('/api/v1/groups/:id/members/:principalType/:principalId', async (req, reply) => {
    const p = req.params as any;
    await removeGroupMember(actorOf(req), p.id, p.principalType, p.principalId);
    return reply.status(204).send();
  });

  app.post('/api/v1/pages', async (req, reply) => {
    const actor = actorOf(req);
    const res = await createPage(actor, req.body);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/pages/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await getPageDetails(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.get('/api/v1/pages/:id/versions', async (req, reply) => {
    return reply.send(await listPageVersions(actorOf(req), (req.params as any).id));
  });

  app.get('/api/v1/pages/:id/changes', async (req, reply) => {
    return reply.send(await getPageChanges(actorOf(req), (req.params as any).id));
  });

  app.get('/api/v1/pages/:id/compare', async (req, reply) => {
    return reply.send(await comparePageVersions(actorOf(req), (req.params as any).id, req.query));
  });

  app.get('/api/v1/versions/:id', async (req, reply) => {
    return reply.send(await getVersionDetail(actorOf(req), (req.params as any).id));
  });

  app.get('/api/v1/versions/:id/diff', async (req, reply) => {
    return reply.send(await getVersionDiff(actorOf(req), (req.params as any).id));
  });

  app.post('/api/v1/pages/:id/collab-token', async (req, reply) => {
    const res = await issueCollabToken(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/snapshot', async (req, reply) => {
    const res = await submitPageSnapshot(actorOf(req), (req.params as any).id, opts.collab);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/pages/:id/versions/:n/restore', async (req, reply) => {
    const { id, ...params } = req.params as any;
    const res = await restorePageVersion(actorOf(req), id, params, opts.collab);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/pages/:id/move', async (req, reply) => {
    const actor = actorOf(req);
    const res = await movePage(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/archive', async (req, reply) => {
    const actor = actorOf(req);
    const res = await archivePage(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/restore', async (req, reply) => {
    const res = await restorePage(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/withdraw', async (req, reply) => {
    const actor = actorOf(req);
    const res = await withdrawPage(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.get('/api/v1/reviews', async (req, reply) => {
    return reply.send(await listReviewQueue(actorOf(req), req.query));
  });

  app.post('/api/v1/versions/:id/approve', async (req, reply) => {
    const actor = actorOf(req);
    const res = await approveVersion(actor, (req.params as any).id, req.body ?? {});
    return reply.send(res);
  });

  app.post('/api/v1/versions/:id/reject', async (req, reply) => {
    const actor = actorOf(req);
    const res = await rejectVersion(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.post('/api/v1/versions/:id/retry', async (req, reply) => {
    const res = await retryVersion(actorOf(req), (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/search', async (req, reply) => {
    const actor = actorOf(req);
    const parsed = SearchRequestSchema.parse(req.body);
    const [queryEmbedding] = await defaultEmbeddingProvider.embed([parsed.query]);

    const res = await withTenantTx(actor.tenantId, async (tx) => {
      const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
      const effectiveSpaces = parsed.space_ids
        ? readableSpaceIds.filter((id) => parsed.space_ids!.includes(id))
        : readableSpaceIds;
      return searchWiki(
        tx,
        actor,
        effectiveSpaces,
        inboxSpaceId,
        parsed.query,
        queryEmbedding,
        parsed.limit
      );
    });
    return reply.send({ passages: res });
  });

  app.post('/api/v1/ask', async (req, reply) => {
    const actor = actorOf(req);
    const parsed = AskRequestSchema.parse(req.body);
    const [queryEmbedding] = await defaultEmbeddingProvider.embed([parsed.question]);

    const res = await withTenantTx(actor.tenantId, async (tx) => {
      const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
      const effectiveSpaces = parsed.space_ids
        ? readableSpaceIds.filter((id) => parsed.space_ids!.includes(id))
        : readableSpaceIds;
      return askWiki(tx, actor, effectiveSpaces, inboxSpaceId, parsed.question, queryEmbedding);
    });
    return reply.send(res);
  });

  return app;
}
