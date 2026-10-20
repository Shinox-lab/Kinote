import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { withTenantTx } from '@living-wiki/db';
import { DEFAULT_AUTH_RATE_LIMIT_MAX, type ObjectStorage } from '@living-wiki/shared';
import {
  SearchRequestSchema,
  AskRequestSchema,
  AppError,
  CreateTenantResponseSchema,
  InviteMemberResponseSchema,
  AcceptInvitationResponseSchema,
  SpaceSchema,
  SpaceResponseSchema,
  SpaceListSchema,
  TreeResponseSchema,
  UpsertGrantResponseSchema,
  GrantListSchema,
  MemberSchema,
  MemberListSchema,
  GroupSchema,
  GroupListSchema,
  SourceListSchema,
  SourceSchema,
  SourceTokenSchema,
  CreateSourceTokenResponseSchema,
  GroupMemberResponseSchema,
  PageSummarySchema,
  PageDetailsSchema,
  DocumentSummarySchema,
  VersionSummarySchema,
  VersionListSchema,
  VersionDetailSchema,
  BlockDiffSchema,
  CollabTokenResponseSchema,
  ReviewListSchema,
  UpdatesResponseSchema,
  RetryVersionResponseSchema,
  UploadFileResponseSchema,
  FileDetailsSchema,
  FileVersionListSchema,
  ChunkInspectorSchema,
  SearchResponseSchema,
  AskResponseSchema,
} from '@living-wiki/contracts';
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
import { createSource, issueSourceToken, listSources, revokeSourceToken, updateSource } from './routes/sources.js';
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
import {
  archiveFile,
  downloadVersionFile,
  getFileDetails,
  getVersionChunks,
  listFileVersions,
  moveFile,
  readMultipartUpload,
  replaceFile,
  restoreFile,
  uploadFile,
  withdrawFile,
} from './routes/files.js';
import { listUpdates } from './routes/updates.js';
import { authRoutes, type AuthRateLimit } from './routes/auth.js';
import { requireSession, resolveActor, type AuthSession } from './auth/actor.js';
import { registerErrorHandler } from './errors.js';
import { parseReply } from './reply.js';
import { searchWiki } from './search/hybridSearch.js';
import { askWiki } from './search/ask.js';
import type { CollabClient } from './collab/client.js';
import { fastifyLogger, type ApiLoggerOptions } from './logger.js';

export interface ApiServerOptions {
  /** Per-IP limit for sign-up and sign-in (each route counted separately). */
  authRateLimit?: AuthRateLimit;
  /**
   * Trust X-Forwarded-For from a reverse proxy, so `req.ip` (and the per-IP
   * auth rate limit) is the real client address. Default false: without a
   * proxy in front the header is client-controlled and must be ignored. A
   * hop count trusts exactly that many proxies (the recommended form); `true`
   * trusts every hop, including a forged leftmost entry. TRUST_PROXY in config.
   */
  trustProxy?: boolean | number;
  /**
   * The collab server's internal endpoints. A manual snapshot flushes the
   * live document through it first. Production always passes one (main.ts);
   * without it (tests that do not run collab) the flush is skipped.
   */
  collab?: CollabClient;
  /**
   * Logging (pino, with secrets redacted: see logger.ts). Without it the
   * server is silent, as tests want it; main.ts always passes one.
   */
  logger?: ApiLoggerOptions;
  /** Where file bytes live. Without it the file routes answer internal_error (tests that never upload). */
  storage?: ObjectStorage;
  /** Largest upload in bytes (default 50 MB; MAX_UPLOAD_BYTES in config). */
  maxUploadBytes?: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800;

/**
 * Fastify's `trustProxy` for our setting. A hop count N becomes a trust
 * function over hop indexes (0 is the TCP peer): the peer and the next N-1
 * addresses from the right of X-Forwarded-For are proxies, the one after them
 * is the client. (Fastify 5 itself treats a bare number as "trust nothing".)
 * The api must then be reachable only through those proxies.
 */
function trustProxyOption(setting: boolean | number | undefined): boolean | ((addr: string, hop: number) => boolean) {
  if (typeof setting !== 'number') return setting ?? false;
  return (_addr, hop) => hop < setting;
}

const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = { max: DEFAULT_AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' };

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
  const app = Fastify({ logger: fastifyLogger(opts.logger), trustProxy: trustProxyOption(opts.trustProxy) });
  registerErrorHandler(app);

  // Fastify refuses an EMPTY body sent as application/json (400), which
  // browsers and fetch wrappers send on body-less POSTs (snapshot, archive,
  // sign-out, ...). An empty body is no body (`undefined`); anything else goes
  // through Fastify's own strict parser (prototype poisoning refused, server
  // body limit), so malformed JSON, even whitespace, is still 400.
  const strictJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '') {
      done(null, undefined);
      return;
    }
    strictJson(req, text, done);
  });

  /**
   * Closes the live editing sessions an access change can affect (only
   * `userId`'s when the change names one user), so they reconnect under the
   * new role. Called by the admin routes AFTER their transaction committed;
   * best effort: a failure is logged, the admin change stands, and the
   * sockets keep their old access until they reconnect.
   */
  async function revokeLiveSessions(req: FastifyRequest, target: { tenantId: string; userId?: string }) {
    if (!opts.collab) return;
    try {
      await opts.collab.revoke(target);
    } catch (err) {
      req.log.error({ err }, 'collab revoke failed');
    }
  }
  /** Revocation target of a grant or group change: one user, or the whole tenant. */
  const revokeTarget = (actor: Actor, principalType: string, principalId: string) =>
    principalType === 'user'
      ? { tenantId: actor.tenantId, userId: principalId.toLowerCase() }
      : { tenantId: actor.tenantId };

  // Identity comes only from the session token and, for tenant routes, the
  // membership row of the session user in x-tenant-id. Routes declare
  // config.auth ('public' | 'session' | 'tenant'); undeclared means 'tenant'.
  // Checked in onRequest, before the body is read or parsed: an
  // unauthenticated request never gets as far as the JSON parser.
  app.decorateRequest('authSession', null);
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (req) => {
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
  // One file part per request, never buffered past the limit (the parser stops at it).
  app.register(multipart, {
    limits: { fileSize: opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6 },
  });

  const fileDeps = () => {
    if (!opts.storage) throw new AppError('internal_error');
    return { storage: opts.storage };
  };

  app.post('/api/v1/tenants', { config: { auth: 'session' } }, async (req, reply) => {
    const res = await createTenantWithInbox(sessionOf(req).userId, req.body);
    return reply.status(201).send(parseReply(CreateTenantResponseSchema, res));
  });

  app.post('/api/v1/invitations', async (req, reply) => {
    const res = await inviteMember(actorOf(req), req.body);
    return reply.status(201).send(parseReply(InviteMemberResponseSchema, res));
  });

  app.post('/api/v1/invitations/accept', { config: { auth: 'session' } }, async (req, reply) => {
    const res = await acceptInvitation(sessionOf(req).userId, req.body);
    return reply.status(200).send(parseReply(AcceptInvitationResponseSchema, res));
  });

  app.get('/api/v1/spaces', async (req, reply) => {
    const actor = actorOf(req);
    const res = await listSpacesForActor(actor);
    return reply.send(parseReply(SpaceListSchema, res));
  });

  app.post('/api/v1/spaces', async (req, reply) => {
    const actor = actorOf(req);
    const res = await createSpace(actor, req.body);
    return reply.status(201).send(parseReply(SpaceResponseSchema, res));
  });

  app.get('/api/v1/spaces/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await getSpaceForActor(actor, (req.params as any).id);
    return reply.send(parseReply(SpaceResponseSchema, res));
  });

  app.patch('/api/v1/spaces/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await updateSpaceSettings(actor, (req.params as any).id, req.body);
    return reply.send(parseReply(SpaceSchema, res));
  });

  app.get('/api/v1/spaces/:id/tree', async (req, reply) => {
    const res = await getSpaceTree(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(TreeResponseSchema, res));
  });

  app.get('/api/v1/spaces/:id/archived', async (req, reply) => {
    const res = await getSpaceArchived(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(TreeResponseSchema, res));
  });

  app.post('/api/v1/spaces/:id/archive', async (req, reply) => {
    const res = await archiveSpace(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(SpaceResponseSchema, res));
  });

  app.post('/api/v1/spaces/:id/grants', async (req, reply) => {
    const actor = actorOf(req);
    const res = await upsertSpaceGrant(actor, (req.params as any).id, req.body);
    await revokeLiveSessions(req, revokeTarget(actor, res.principalType, res.principalId));
    return reply.status(201).send(parseReply(UpsertGrantResponseSchema, res));
  });

  app.get('/api/v1/spaces/:id/grants', async (req, reply) => {
    const res = await listSpaceGrants(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(GrantListSchema, res));
  });

  app.delete('/api/v1/spaces/:id/grants/:principalType/:principalId', async (req, reply) => {
    const p = req.params as any;
    const actor = actorOf(req);
    await deleteSpaceGrant(actor, p.id, p.principalType, p.principalId);
    await revokeLiveSessions(req, revokeTarget(actor, p.principalType, p.principalId));
    return reply.status(204).send();
  });

  app.get('/api/v1/members', async (req, reply) => {
    return reply.send(parseReply(MemberListSchema, await listMembers(actorOf(req))));
  });

  app.patch('/api/v1/members/:userId', async (req, reply) => {
    const actor = actorOf(req);
    const res = await changeMemberRole(actor, (req.params as any).userId, req.body);
    await revokeLiveSessions(req, { tenantId: actor.tenantId, userId: res.userId });
    return reply.send(parseReply(MemberSchema, res));
  });

  app.delete('/api/v1/members/:userId', async (req, reply) => {
    const actor = actorOf(req);
    const userId = String((req.params as any).userId).toLowerCase();
    await removeMember(actor, userId);
    await revokeLiveSessions(req, { tenantId: actor.tenantId, userId });
    return reply.status(204).send();
  });

  app.get('/api/v1/groups', async (req, reply) => {
    return reply.send(parseReply(GroupListSchema, await listGroups(actorOf(req))));
  });

  app.post('/api/v1/groups', async (req, reply) => {
    const res = await createGroup(actorOf(req), req.body);
    return reply.status(201).send(parseReply(GroupSchema, res));
  });

  app.post('/api/v1/groups/:id/members', async (req, reply) => {
    const actor = actorOf(req);
    const res = await addGroupMember(actor, (req.params as any).id, req.body);
    await revokeLiveSessions(req, revokeTarget(actor, res.principalType, res.principalId));
    return reply.send(parseReply(GroupMemberResponseSchema, res));
  });

  app.delete('/api/v1/groups/:id/members/:principalType/:principalId', async (req, reply) => {
    const p = req.params as any;
    const actor = actorOf(req);
    await removeGroupMember(actor, p.id, p.principalType, p.principalId);
    await revokeLiveSessions(req, revokeTarget(actor, p.principalType, p.principalId));
    return reply.status(204).send();
  });

  app.get('/api/v1/sources', async (req, reply) => {
    return reply.send(parseReply(SourceListSchema, await listSources(actorOf(req))));
  });

  app.post('/api/v1/sources', async (req, reply) => {
    const res = await createSource(actorOf(req), req.body);
    return reply.status(201).send(parseReply(SourceSchema, res));
  });

  app.patch('/api/v1/sources/:id', async (req, reply) => {
    const res = await updateSource(actorOf(req), (req.params as any).id, req.body);
    return reply.send(parseReply(SourceSchema, res));
  });

  app.post('/api/v1/sources/:id/tokens', async (req, reply) => {
    const res = await issueSourceToken(actorOf(req), (req.params as any).id, req.body);
    return reply.status(201).send(parseReply(CreateSourceTokenResponseSchema, res));
  });

  app.delete('/api/v1/sources/:id/tokens/:tokenId', async (req, reply) => {
    const p = req.params as any;
    const res = await revokeSourceToken(actorOf(req), p.id, p.tokenId);
    return reply.send(parseReply(SourceTokenSchema, res));
  });

  app.post('/api/v1/pages', async (req, reply) => {
    const actor = actorOf(req);
    const res = await createPage(actor, req.body);
    return reply.status(201).send(parseReply(PageSummarySchema, res));
  });

  app.get('/api/v1/pages/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await getPageDetails(actor, (req.params as any).id);
    return reply.send(parseReply(PageDetailsSchema, res));
  });

  app.get('/api/v1/pages/:id/versions', async (req, reply) => {
    return reply.send(
      parseReply(VersionListSchema, await listPageVersions(actorOf(req), (req.params as any).id))
    );
  });

  app.get('/api/v1/pages/:id/changes', async (req, reply) => {
    return reply.send(
      parseReply(BlockDiffSchema, await getPageChanges(actorOf(req), (req.params as any).id))
    );
  });

  app.get('/api/v1/pages/:id/compare', async (req, reply) => {
    return reply.send(
      parseReply(
        BlockDiffSchema,
        await comparePageVersions(actorOf(req), (req.params as any).id, req.query)
      )
    );
  });

  app.get('/api/v1/versions/:id', async (req, reply) => {
    return reply.send(
      parseReply(VersionDetailSchema, await getVersionDetail(actorOf(req), (req.params as any).id))
    );
  });

  app.get('/api/v1/versions/:id/diff', async (req, reply) => {
    return reply.send(
      parseReply(BlockDiffSchema, await getVersionDiff(actorOf(req), (req.params as any).id))
    );
  });

  app.post('/api/v1/pages/:id/collab-token', async (req, reply) => {
    const res = await issueCollabToken(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(CollabTokenResponseSchema, res));
  });

  app.post('/api/v1/pages/:id/snapshot', async (req, reply) => {
    const res = await submitPageSnapshot(actorOf(req), (req.params as any).id, opts.collab);
    return reply.status(201).send(parseReply(VersionSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/versions/:n/restore', async (req, reply) => {
    const { id, ...params } = req.params as any;
    const res = await restorePageVersion(actorOf(req), id, params, opts.collab);
    return reply.status(201).send(parseReply(VersionSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/move', async (req, reply) => {
    const actor = actorOf(req);
    const res = await movePage(actor, (req.params as any).id, req.body);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/archive', async (req, reply) => {
    const actor = actorOf(req);
    const res = await archivePage(actor, (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/restore', async (req, reply) => {
    const res = await restorePage(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/withdraw', async (req, reply) => {
    const actor = actorOf(req);
    const res = await withdrawPage(actor, (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files', async (req, reply) => {
    const actor = actorOf(req);
    const deps = fileDeps();
    const upload = await readMultipartUpload(req);
    const out = await uploadFile(actor, upload, deps);
    return reply
      .status(out.status === 'created' ? 201 : 200)
      .send(parseReply(UploadFileResponseSchema, out.response));
  });

  app.post('/api/v1/files/:id/versions', async (req, reply) => {
    const actor = actorOf(req);
    const deps = fileDeps();
    const upload = await readMultipartUpload(req);
    const out = await replaceFile(actor, (req.params as any).id, upload.file, deps);
    return reply
      .status(out.status === 'created' ? 201 : 200)
      .send(parseReply(UploadFileResponseSchema, out.response));
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const res = await getFileDetails(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(FileDetailsSchema, res));
  });

  app.get('/api/v1/files/:id/versions', async (req, reply) => {
    const res = await listFileVersions(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(FileVersionListSchema, res));
  });

  app.get('/api/v1/versions/:id/file', async (req, reply) => {
    const out = await downloadVersionFile(
      actorOf(req),
      (req.params as any).id,
      { inline: (req.query as any)?.inline === '1' },
      fileDeps()
    );
    return reply.headers(out.headers).send(Buffer.from(out.bytes));
  });

  app.get('/api/v1/versions/:id/chunks', async (req, reply) => {
    const res = await getVersionChunks(actorOf(req), (req.params as any).id, fileDeps());
    return reply.send(parseReply(ChunkInspectorSchema, res));
  });

  app.post('/api/v1/files/:id/move', async (req, reply) => {
    const res = await moveFile(actorOf(req), (req.params as any).id, req.body);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/archive', async (req, reply) => {
    const res = await archiveFile(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/restore', async (req, reply) => {
    const res = await restoreFile(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/withdraw', async (req, reply) => {
    const res = await withdrawFile(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.get('/api/v1/updates', async (req, reply) => {
    return reply.send(parseReply(UpdatesResponseSchema, await listUpdates(actorOf(req), req.query)));
  });

  app.get('/api/v1/reviews', async (req, reply) => {
    return reply.send(parseReply(ReviewListSchema, await listReviewQueue(actorOf(req), req.query)));
  });

  app.post('/api/v1/versions/:id/approve', async (req, reply) => {
    const actor = actorOf(req);
    const res = await approveVersion(actor, (req.params as any).id, req.body ?? {});
    return reply.send(parseReply(VersionSummarySchema, res));
  });

  app.post('/api/v1/versions/:id/reject', async (req, reply) => {
    const actor = actorOf(req);
    const res = await rejectVersion(actor, (req.params as any).id, req.body);
    return reply.send(parseReply(VersionSummarySchema, res));
  });

  app.post('/api/v1/versions/:id/retry', async (req, reply) => {
    const res = await retryVersion(actorOf(req), (req.params as any).id);
    return reply.send(parseReply(RetryVersionResponseSchema, res));
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
    return reply.send(parseReply(SearchResponseSchema, { passages: res }));
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
    return reply.send(parseReply(AskResponseSchema, res));
  });

  return app;
}
