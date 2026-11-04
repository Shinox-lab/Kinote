import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { getDb, readStanding, rowsOf, tenants, withTenantTx } from '@kinote/db';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_AUTH_RATE_LIMIT_MAX, DEFAULT_USAGE_LIMITS, type CreditRates, type ObjectStorage, type UsageLimits } from '@kinote/shared';
import {
  SearchRequestSchema,
  AskRequestSchema,
  AppError,
  CreateTenantResponseSchema,
  CaptureSummarySchema,
  CaptureListSchema,
  CaptureDetailSchema,
  SuggestionSummarySchema,
  SuggestionListSchema,
  UndoChangesResponseSchema,
  MoveChangeResponseSchema,
  NeedsHomeListSchema,
  NeedsHomeDocumentListSchema,
  FactStatusSchema,
  CaptureChangeListSchema,
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
  PendingInvitationListSchema,
  DemoSeedStatusSchema,
  GroupSchema,
  GroupListSchema,
  GroupMemberListSchema,
  SourceListSchema,
  SourceSchema,
  SourceTokenSchema,
  RevokeSourceTokensResponseSchema,
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
  RecentResponseSchema,
  LinkTargetListSchema,
  DocumentTitleListSchema,
  PageConnectionsSchema,
  CollectionSchema,
  CollectionPickListSchema,
  CollectionRowsSchema,
  FieldDefSchema,
  FieldUsageSchema,
  PageFieldsSchema,
  CommentThreadSchema,
  CommentThreadListSchema,
  MentionableListSchema,
  AttentionListSchema,
  MentionableGroupListSchema,
  NotificationListSchema,
  RetryVersionResponseSchema,
  UploadFileResponseSchema,
  SourcePutResponseSchema,
  SourceDeleteResponseSchema,
  VersionTextSchema,
  ExternalIdSchema,
  FileDetailsSchema,
  FileVersionListSchema,
  ChunkInspectorSchema,
  SearchResponseSchema,
  AskResponseSchema,
  UsageSummarySchema,
  DrawingSceneSchema,
} from '@kinote/contracts';
import {
  getReadableSpaceIds,
  defaultAnswerProvider,
  defaultEmbeddingProvider,
  withUsageScope,
  countSeats,
  creditVerdict,
  indexHeld,
  type Actor,
  type AnswerProvider,
  type EmbeddingProvider,
} from '@kinote/core';
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
  listInvitations,
  revokeInvitation,
  changeMemberRole,
  removeMember,
  leaveWorkspace,
  deleteWorkspace,
  listGroups,
  listGroupMembers,
  createGroup,
  addGroupMember,
  removeGroupMember,
  listSpaceGrants,
  deleteSpaceGrant,
} from './routes/admin.js';
import { deleteSourceFile, putSourceFile } from './routes/sourceFiles.js';
import { registerInternalRoutes } from './routes/internal.js';
import { createSource, issueSourceToken, listSources, revokeSourceToken, revokeTokensMadeBy, updateSource } from './routes/sources.js';
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
  renamePage,
  archivePage,
  restorePage,
  withdrawPage,
  listPageVersions,
  getVersionDetail,
  getPageChanges,
  comparePageVersions,
  getPageDrawing,
  getVersionDiff,
} from './routes/pages.js';
import { listReviewQueue } from './routes/reviews.js';
import { answerCapture, createCapture, getCapture, listCaptures } from './routes/captures.js';
import { acceptSuggestion, declineSuggestion, listPageSuggestions } from './routes/suggestions.js';
import {
  dismissCaptureFact,
  listNeedsHome,
  listNeedsHomeDocuments,
  placeCaptureDocument,
  routeCaptureAsUpdates,
  moveCaptureDocument,
  listPageCaptureChanges,
  moveCaptureChange,
  placeCaptureFact,
  undoCapture,
  undoCaptureChange,
} from './routes/captureChanges.js';
import {
  archiveFile,
  dismissRemoval,
  getVersionText,
  downloadVersionFile,
  createMediaUrl,
  streamMedia,
  getFileDetails,
  getVersionChunks,
  listFileVersions,
  moveFile,
  renameFile,
  withMultipartUpload,
  replaceFile,
  restoreFile,
  uploadFile,
  withdrawFile,
} from './routes/files.js';
import { listUpdates } from './routes/updates.js';
import { listAttention } from './routes/attention.js';
import { listRecent } from './routes/recent.js';
import { getPageConnections, listDocumentTitles, listLinkTargets } from './routes/connections.js';
import {
  addComment,
  createThread,
  deleteComment,
  deleteThread,
  listMentionable,
  listMentionableGroups,
  listThreads,
  setThreadResolved,
  updateComment,
} from './routes/talk.js';
import { listNotifications, markNotificationsRead } from './routes/notifications.js';
import { emailInvitation } from './invitationMail.js';
import {
  addField,
  collectionRows,
  createCollection,
  listCollections,
  fieldUsage,
  getCollection,
  removeCollection,
  removeField,
  setPageFields,
  updateField,
} from './routes/collections.js';
import { authRoutes, type AuthRateLimit, type SignUpModeSetting } from './routes/auth.js';
import { PgRateLimitStore } from './rateLimitStore.js';
import type { Mailer } from './mail.js';
import { aiActionsLeftOrUnknown, chargeAi, requestLimit, requireCredits, uploadSlots } from './usageLimits.js';
import { demoSeedRunning, demoSeedStatus, startDemoSeed } from './routes/demoSeed.js';
import {
  invalidateActor,
  invalidateTenantActors,
  requireSession,
  resolveActor,
  resolveSourceActor,
  type AuthSession,
  type SourceActor,
} from './auth/actor.js';
import { registerErrorHandler } from './errors.js';
import { parseReply } from './reply.js';
import { invalidateTreeCache } from './treeCache.js';

import { answerPassages } from './search/ask.js';
import { getCollabTokenSecret, type CollabClient } from '@kinote/shared';
import { collectionTables, searchWiki } from '@kinote/core';
import { fastifyLogger, type ApiLoggerOptions } from './logger.js';

export interface ApiServerOptions {
  /** Per-IP limit for sign-up and sign-in (each route counted separately). */
  authRateLimit?: AuthRateLimit;
  /**
   * Where rate-limit counters live: 'postgres' (default) shares them between
   * every api process; 'memory' keeps them in this process (tests without a database).
   */
  rateLimitStore?: 'postgres' | 'memory';
  /**
   * Who may create an account (SIGNUP_MODE). Default 'open', as tests want it;
   * main.ts passes the configured mode, whose own default is 'auto'.
   */
  signUpMode?: SignUpModeSetting;
  /**
   * Outgoing email (SMTP_URL). With it, sign-ups are verified by email and
   * passwords can be reset by email; without it, neither.
   */
  mailer?: Mailer;
  /** Per-person request limits and the daily AI allowance (DEFAULT_USAGE_LIMITS; usageLimitsOf(config) in main.ts). */
  limits?: UsageLimits;
  /** Uploads read at once in this process (MAX_CONCURRENT_UPLOADS; default 4). */
  maxConcurrentUploads?: number;
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
  /** Where uploads wait on disk while they are checked and stored (UPLOAD_TMP_DIR; default the OS temp dir). */
  uploadTmpDir?: string;
  /** Embeddings for search and Ask queries. Default: the deterministic test provider. */
  embeddingProvider?: EmbeddingProvider;
  /** Answers for Ask. Default: the deterministic quoted-passage provider. */
  answerProvider?: AnswerProvider;
  /** MODEL_CREDIT_RATES, parsed. Null or unset: model calls are recorded at 0 credits. */
  creditRates?: CreditRates | null;
  /** BILLING_URL: where Upgrade links point. */
  billingUrl?: string;
  /** CONTROL_PLANE_TOKENS: bearer tokens for /internal/v1/. None: that API does not exist (404). */
  controlPlaneTokens?: string[];
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

/**
 * Logs the two TRUST_PROXY settings that weaken the per-IP sign-in limit:
 * `true` (a client picks its own bucket by sending X-Forwarded-For) at start,
 * and `false` behind a proxy (every user shares the proxy's bucket) the first
 * time a request arrives carrying X-Forwarded-For.
 */
function warnOnTrustProxyMismatch(app: FastifyInstance, setting: boolean | number | undefined): void {
  if (setting === true) {
    app.log.warn(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop, so a client can dodge the sign-in rate limit; set the number of proxies instead'
    );
    return;
  }
  if (setting) return;
  let warned = false;
  app.addHook('onRequest', async (req) => {
    if (warned || req.headers['x-forwarded-for'] === undefined) return;
    warned = true;
    req.log.warn(
      'request has X-Forwarded-For but TRUST_PROXY=false: every user behind the proxy shares one sign-in rate-limit bucket; set TRUST_PROXY to the number of proxies'
    );
  });
}

/** Uploads read at once per process when MAX_CONCURRENT_UPLOADS is unset. */
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimit = { max: DEFAULT_AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' };

/** The tenant actor attached by the auth hook (routes default to `auth: 'tenant'`). */
function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new AppError('unauthenticated');
  return req.actor;
}

/** The source attached by the auth hook on `auth: 'source'` routes. */
function sourceOf(req: FastifyRequest): SourceActor {
  if (!req.sourceActor) throw new AppError('unauthenticated');
  return req.sourceActor;
}

function sessionOf(req: FastifyRequest): AuthSession {
  if (!req.authSession) throw new AppError('unauthenticated');
  return req.authSession;
}

export function buildApiServer(opts: ApiServerOptions = {}) {
  const embeddingProvider = opts.embeddingProvider ?? defaultEmbeddingProvider;
  const answerProvider = opts.answerProvider ?? defaultAnswerProvider;
  const limits = opts.limits ?? DEFAULT_USAGE_LIMITS;
  const creditRates = opts.creditRates ?? null;
  const credits = requireCredits(opts.billingUrl);
  /** Runs a route's work in a usage scope: its model calls are charged to the caller's workspace as `kind`. */
  const metered = <T>(kind: 'capture' | 'ask' | 'index', req: FastifyRequest, fn: () => Promise<T>): Promise<T> => {
    const actor = actorOf(req);
    return withUsageScope({ tenantId: actor.tenantId, kind, principalId: actor.principalId }, creditRates, fn);
  };
  const HOUR_MS = 60 * 60 * 1000;
  const uploadLimit = requestLimit('upload', limits.uploadPerMinute);
  const uploads = uploadSlots(opts.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS);
  const app = Fastify({
    logger: fastifyLogger(opts.logger),
    trustProxy: trustProxyOption(opts.trustProxy),
    // An external id is up to 256 characters, each up to four bytes, each byte `%XX`: the default (100) would refuse legal ids.
    routerOptions: { maxParamLength: 4096 },
  });
  registerErrorHandler(app);
  warnOnTrustProxyMismatch(app, opts.trustProxy);
  // Every api response is data, never a page: nothing in it may run, be framed
  // or be sniffed into another type. File and media routes replace the CSP
  // with their own `sandbox` (headers set later win).
  app.addHook('onRequest', async (_req, reply) => {
    reply.headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });

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
  app.decorateRequest('sourceActor', null);
  app.addHook('onRequest', async (req) => {
    const mode = req.routeOptions.config?.auth ?? 'tenant';
    if (mode === 'public') return;
    if (mode === 'source') {
      req.sourceActor = await resolveSourceActor(req);
      return;
    }
    req.authSession = await requireSession(req);
    if (mode === 'tenant') req.actor = await resolveActor(req);
  });

  // Rate limiting is opt-in per route (sign-up, sign-in). The plugin's onRoute
  // hook must be installed before those routes are declared, so the auth
  // routes are registered as a plugin after it.
  app.register(rateLimit, {
    global: false,
    // Shared by every api process; 'memory' only for tests that run without a database.
    ...(opts.rateLimitStore === 'memory' ? {} : { store: PgRateLimitStore }),
    errorResponseBuilder: () => new AppError('rate_limited'),
  });
  app.register(authRoutes, {
    authRateLimit: opts.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT,
    signUpMode: opts.signUpMode ?? 'open',
    ...(opts.mailer ? { mailer: opts.mailer } : {}),
  });
  // One file part per request, never buffered past the limit (the parser stops at it).
  app.register(multipart, {
    limits: { fileSize: opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6 },
  });

  const fileDeps = () => {
    if (!opts.storage) throw new AppError('internal_error');
    return { storage: opts.storage };
  };

  app.post(
    '/api/v1/tenants',
    { config: { auth: 'session' }, onRequest: requestLimit('tenant-create', 5, { windowMs: HOUR_MS }) },
    async (req, reply) => {
      const userId = sessionOf(req).userId;
      // my_tenants reads across tenants (SECURITY DEFINER); only workspaces this person owns count.
      const owned = rowsOf<{ role: string }>(await getDb().execute(sql`SELECT role FROM my_tenants(${userId}::uuid)`));
      if (owned.filter((t) => t.role === 'owner').length >= limits.maxTenantsPerUser) {
        throw new AppError('tenant_limit_reached');
      }
      const res = await createTenantWithInbox(userId, req.body);
      return reply.status(201).send(parseReply(CreateTenantResponseSchema, res));
    }
  );

  app.post('/api/v1/invitations', async (req, reply) => {
    const actor = actorOf(req);
    const res = await inviteMember(actor, req.body);
    // inviteMember checked the role and the body; the link goes out by email only when asked and possible.
    const wantsEmail = (req.body as { send_email?: unknown }).send_email === true;
    const emailed = wantsEmail && opts.mailer ? await emailInvitation(opts.mailer, actor, res, req.log) : false;
    return reply.status(201).send(parseReply(InviteMemberResponseSchema, { ...res, emailed }));
  });

  app.get('/api/v1/invitations', async (req, reply) => {
    return reply.send(parseReply(PendingInvitationListSchema, await listInvitations(actorOf(req))));
  });

  app.delete('/api/v1/invitations/:id', async (req, reply) => {
    await revokeInvitation(actorOf(req), (req.params as { id: string }).id);
    return reply.status(204).send();
  });

  app.post('/api/v1/invitations/accept', { config: { auth: 'session' } }, async (req, reply) => {
    // With email on, only a confirmed address can take an invitation sent to it.
    const res = await acceptInvitation(sessionOf(req).userId, req.body, { requireVerifiedEmail: opts.mailer !== undefined });
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
    // Review/quiet settings feed the tree's attention dots.
    invalidateTreeCache(actor.tenantId, res.id);
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
    const actor = actorOf(req);
    const res = await archiveSpace(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.id);
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
    invalidateActor(actor.tenantId, res.userId);
    await revokeLiveSessions(req, { tenantId: actor.tenantId, userId: res.userId });
    return reply.send(parseReply(MemberSchema, res));
  });

  // The signed-in user leaves this workspace. Registered before `/members/:userId`; "me" is never a user id.
  app.delete('/api/v1/members/me', async (req, reply) => {
    const actor = actorOf(req);
    await leaveWorkspace(actor);
    invalidateActor(actor.tenantId, actor.principalId);
    await revokeLiveSessions(req, { tenantId: actor.tenantId, userId: actor.principalId.toLowerCase() });
    return reply.status(204).send();
  });

  app.delete('/api/v1/members/:userId', async (req, reply) => {
    const actor = actorOf(req);
    const userId = String((req.params as any).userId).toLowerCase();
    await removeMember(actor, userId);
    invalidateActor(actor.tenantId, userId);
    await revokeLiveSessions(req, { tenantId: actor.tenantId, userId });
    return reply.status(204).send();
  });

  // Deletes the workspace in x-tenant-id (Settings -> Workspace, owners only); a demo workspace is purged.
  app.delete('/api/v1/tenant', async (req, reply) => {
    const actor = actorOf(req);
    if (demoSeedRunning(actor.tenantId)) throw new AppError('demo_seed_running');
    await deleteWorkspace(actor);
    invalidateTenantActors(actor.tenantId);
    invalidateTreeCache(actor.tenantId);
    await revokeLiveSessions(req, { tenantId: actor.tenantId });
    return reply.status(204).send();
  });

  // The demo content (Settings -> Spaces): add it to an empty workspace, or reset a demo workspace back to it.
  // Both answer at once and carry on in the background; poll the GET.
  app.get('/api/v1/demo-seed', async (req, reply) => reply.send(parseReply(DemoSeedStatusSchema, await demoSeedStatus(actorOf(req)))));
  // Each seed or reset re-indexes and re-routes a whole demo: a few an hour per workspace.
  const demoSeedLimit = requestLimit('demo-seed', 3, { windowMs: HOUR_MS, per: 'tenant' });
  app.post('/api/v1/demo-seed', { onRequest: demoSeedLimit }, async (req, reply) => {
    await startDemoSeed(app, req, actorOf(req));
    return reply.status(202).send(parseReply(DemoSeedStatusSchema, await demoSeedStatus(actorOf(req))));
  });
  app.post('/api/v1/demo-seed/reset', { onRequest: demoSeedLimit }, async (req, reply) => {
    const actor = actorOf(req);
    await startDemoSeed(app, req, actor, {
      reset: true,
      afterWipe: () => {
        invalidateTenantActors(actor.tenantId);
        invalidateTreeCache(actor.tenantId);
        return revokeLiveSessions(req, { tenantId: actor.tenantId });
      },
    });
    return reply.status(202).send(parseReply(DemoSeedStatusSchema, await demoSeedStatus(actorOf(req))));
  });

  app.get('/api/v1/groups', async (req, reply) => {
    return reply.send(parseReply(GroupListSchema, await listGroups(actorOf(req))));
  });

  app.post('/api/v1/groups', async (req, reply) => {
    const res = await createGroup(actorOf(req), req.body);
    return reply.status(201).send(parseReply(GroupSchema, res));
  });

  app.get('/api/v1/groups/:id/members', async (req, reply) => {
    return reply.send(parseReply(GroupMemberListSchema, await listGroupMembers(actorOf(req), (req.params as any).id)));
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

  app.post('/api/v1/source-tokens/revoke', async (req, reply) => {
    const res = await revokeTokensMadeBy(actorOf(req), req.body);
    return reply.send(parseReply(RevokeSourceTokensResponseSchema, res));
  });

  app.delete('/api/v1/sources/:id/tokens/:tokenId', async (req, reply) => {
    const p = req.params as any;
    const res = await revokeSourceToken(actorOf(req), p.id, p.tokenId);
    return reply.send(parseReply(SourceTokenSchema, res));
  });

  app.post('/api/v1/pages', async (req, reply) => {
    const actor = actorOf(req);
    const res = await createPage(actor, req.body);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.status(201).send(parseReply(PageSummarySchema, res));
  });

  app.get('/api/v1/pages/:id', async (req, reply) => {
    const actor = actorOf(req);
    // `?meta=1`: the console's page chrome, without the live blocks and Markdown
    // its editor receives over the collab socket anyway.
    const res = await getPageDetails(actor, (req.params as any).id, {
      meta: (req.query as { meta?: string } | undefined)?.meta === '1',
    });
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

  app.get('/api/v1/pages/:id/drawings/:drawingId', async (req, reply) => {
    const { id, drawingId } = req.params as { id: string; drawingId: string };
    return reply.send(parseReply(DrawingSceneSchema, await getPageDrawing(actorOf(req), id, drawingId, req.query)));
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
    invalidateTreeCache(actor.tenantId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.patch('/api/v1/pages/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await renamePage(actor, (req.params as any).id, req.body, opts.collab);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/archive', async (req, reply) => {
    const actor = actorOf(req);
    const res = await archivePage(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/restore', async (req, reply) => {
    const actor = actorOf(req);
    const res = await restorePage(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/pages/:id/withdraw', async (req, reply) => {
    const actor = actorOf(req);
    const res = await withdrawPage(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files', { onRequest: uploadLimit }, async (req, reply) => {
    const actor = actorOf(req);
    const deps = fileDeps();
    const release = uploads.take(reply);
    let out: Awaited<ReturnType<typeof uploadFile>>;
    try {
      out = await withMultipartUpload(req, opts.uploadTmpDir, (upload) => uploadFile(actor, upload, deps));
    } finally {
      release();
    }
    invalidateTreeCache(actor.tenantId, out.response.document.spaceId);
    return reply
      .status(out.status === 'created' ? 201 : 200)
      .send(parseReply(UploadFileResponseSchema, out.response));
  });

  // The upload API: a script acts as its source, with a source token and no session.
  // A wildcard, not a parameter: an id such as `reports/2026-q3` works with or without URL-encoding the
  // slash, instead of an unmatched path that answers a valid token with 401.
  app.put('/api/v1/source/files/*', { config: { auth: 'source' }, onRequest: uploadLimit }, async (req, reply) => {
    const source = sourceOf(req);
    const deps = fileDeps();
    const externalId = ExternalIdSchema.parse((req.params as any)['*']);
    const release = uploads.take(reply);
    let out: Awaited<ReturnType<typeof putSourceFile>>;
    try {
      out = await withMultipartUpload(req, opts.uploadTmpDir, ({ file }) => putSourceFile(source, externalId, file, deps));
    } finally {
      release();
    }
    return reply.status(out.status).send(parseReply(SourcePutResponseSchema, out.response));
  });

  app.delete('/api/v1/source/files/*', { config: { auth: 'source' } }, async (req, reply) => {
    const res = await deleteSourceFile(sourceOf(req), (req.params as any)['*']);
    return reply.send(parseReply(SourceDeleteResponseSchema, res));
  });

  app.post('/api/v1/files/:id/dismiss-removal', async (req, reply) => {
    const actor = actorOf(req);
    const res = await dismissRemoval(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/versions', { onRequest: uploadLimit }, async (req, reply) => {
    const actor = actorOf(req);
    const deps = fileDeps();
    const release = uploads.take(reply);
    let out: Awaited<ReturnType<typeof replaceFile>>;
    try {
      out = await withMultipartUpload(req, opts.uploadTmpDir, ({ file }) => replaceFile(actor, (req.params as any).id, file, deps));
    } finally {
      release();
    }
    invalidateTreeCache(actor.tenantId, out.response.document.spaceId);
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
    return reply.headers(out.headers).send(out.stream);
  });

  app.post('/api/v1/versions/:id/media-url', async (req, reply) => {
    const res = await createMediaUrl(actorOf(req), (req.params as any).id, getCollabTokenSecret());
    return reply.send(res);
  });

  // The signed link is the credential: a media element cannot send the bearer header.
  app.get('/api/v1/media/:token', { config: { auth: 'public' } }, async (req, reply) => {
    const out = await streamMedia(
      (req.params as any).token,
      getCollabTokenSecret(),
      req.headers.range,
      fileDeps()
    );
    return reply.status(out.status).headers(out.headers).send(Buffer.from(out.bytes));
  });

  app.get('/api/v1/versions/:id/text', async (req, reply) => {
    const res = await getVersionText(actorOf(req), (req.params as any).id, fileDeps());
    return reply.send(parseReply(VersionTextSchema, res));
  });

  app.get('/api/v1/versions/:id/chunks', async (req, reply) => {
    const res = await getVersionChunks(actorOf(req), (req.params as any).id, fileDeps());
    return reply.send(parseReply(ChunkInspectorSchema, res));
  });

  app.post('/api/v1/files/:id/move', async (req, reply) => {
    const actor = actorOf(req);
    const res = await moveFile(actor, (req.params as any).id, req.body);
    invalidateTreeCache(actor.tenantId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.patch('/api/v1/files/:id', async (req, reply) => {
    const actor = actorOf(req);
    const res = await renameFile(actor, (req.params as any).id, req.body);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/archive', async (req, reply) => {
    const actor = actorOf(req);
    const res = await archiveFile(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/restore', async (req, reply) => {
    const actor = actorOf(req);
    const res = await restoreFile(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.post('/api/v1/files/:id/withdraw', async (req, reply) => {
    const actor = actorOf(req);
    const res = await withdrawFile(actor, (req.params as any).id);
    invalidateTreeCache(actor.tenantId, res.spaceId);
    return reply.send(parseReply(DocumentSummarySchema, res));
  });

  app.get('/api/v1/attention', async (req, reply) => {
    return reply.send(parseReply(AttentionListSchema, await listAttention(actorOf(req))));
  });

  app.get('/api/v1/updates', async (req, reply) => {
    return reply.send(parseReply(UpdatesResponseSchema, await listUpdates(actorOf(req), req.query)));
  });

  app.get('/api/v1/link-targets', async (req, reply) => {
    return reply.send(parseReply(LinkTargetListSchema, await listLinkTargets(actorOf(req), req.query)));
  });

  app.get('/api/v1/documents/titles', async (req, reply) => {
    return reply.send(parseReply(DocumentTitleListSchema, await listDocumentTitles(actorOf(req), req.query)));
  });

  app.get('/api/v1/pages/:id/connections', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(PageConnectionsSchema, await getPageConnections(actorOf(req), id)));
  });

  app.post('/api/v1/pages/:id/collection', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(parseReply(CollectionSchema, await createCollection(actorOf(req), id)));
  });

  app.delete('/api/v1/pages/:id/collection', async (req, reply) => {
    const { id } = req.params as { id: string };
    await removeCollection(actorOf(req), id);
    return reply.status(204).send();
  });

  app.get('/api/v1/collections', async (req, reply) => {
    return reply.send(parseReply(CollectionPickListSchema, await listCollections(actorOf(req), req.query)));
  });

  app.post('/api/v1/collections/:id/rows', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CollectionRowsSchema, await collectionRows(actorOf(req), id, req.body)));
  });

  app.get('/api/v1/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CollectionSchema, await getCollection(actorOf(req), id)));
  });

  app.post('/api/v1/collections/:id/fields', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(parseReply(FieldDefSchema, await addField(actorOf(req), id, req.body)));
  });

  app.patch('/api/v1/collections/:id/fields/:fieldId', async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    return reply.send(parseReply(FieldDefSchema, await updateField(actorOf(req), id, fieldId, req.body)));
  });

  app.delete('/api/v1/collections/:id/fields/:fieldId', async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    await removeField(actorOf(req), id, fieldId);
    return reply.status(204).send();
  });

  app.get('/api/v1/collections/:id/fields/:fieldId/usage', async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    return reply.send(parseReply(FieldUsageSchema, await fieldUsage(actorOf(req), id, fieldId, req.query)));
  });

  app.patch('/api/v1/pages/:id/fields', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(PageFieldsSchema, await setPageFields(actorOf(req), id, req.body, opts.collab)));
  });

  app.get('/api/v1/pages/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CommentThreadListSchema, await listThreads(actorOf(req), id)));
  });

  app.post('/api/v1/pages/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(parseReply(CommentThreadSchema, await createThread(actorOf(req), id, req.body)));
  });

  app.post('/api/v1/threads/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(201).send(parseReply(CommentThreadSchema, await addComment(actorOf(req), id, req.body)));
  });

  app.post('/api/v1/threads/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CommentThreadSchema, await setThreadResolved(actorOf(req), id, true)));
  });

  app.post('/api/v1/threads/:id/unresolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CommentThreadSchema, await setThreadResolved(actorOf(req), id, false)));
  });

  app.delete('/api/v1/threads/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteThread(actorOf(req), id);
    return reply.status(204).send();
  });

  app.patch('/api/v1/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CommentThreadSchema, await updateComment(actorOf(req), id, req.body)));
  });

  app.delete('/api/v1/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteComment(actorOf(req), id);
    return reply.status(204).send();
  });

  app.get('/api/v1/mentionable/groups', async (req, reply) => {
    return reply.send(parseReply(MentionableGroupListSchema, await listMentionableGroups(actorOf(req), req.query)));
  });

  app.get('/api/v1/mentionable', async (req, reply) => {
    return reply.send(parseReply(MentionableListSchema, await listMentionable(actorOf(req), req.query)));
  });

  app.get('/api/v1/notifications', async (req, reply) => {
    return reply.send(parseReply(NotificationListSchema, await listNotifications(actorOf(req))));
  });

  app.post('/api/v1/notifications/read', async (req, reply) => {
    return reply.send(await markNotificationsRead(actorOf(req), req.body ?? {}));
  });

  app.get('/api/v1/recent', async (req, reply) => {
    return reply.send(parseReply(RecentResponseSchema, await listRecent(actorOf(req), req.query)));
  });

  app.post('/api/v1/captures', { onRequest: [requestLimit('capture', limits.capturePerMinute), credits] }, async (req, reply) => {
    // Routing runs in the worker and is charged there; refuse up front once today's allowance is gone.
    const actor = actorOf(req);
    if (!(await aiActionsLeftOrUnknown(req, actor.tenantId, limits.tenantDailyAiActions))) {
      throw new AppError('ai_budget_exhausted');
    }
    return reply.status(201).send(parseReply(CaptureSummarySchema, await createCapture(actorOf(req), req.body)));
  });

  app.get('/api/v1/captures', async (req, reply) => {
    return reply.send(parseReply(CaptureListSchema, await listCaptures(actorOf(req), req.query)));
  });

  app.get('/api/v1/captures/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CaptureDetailSchema, await getCapture(actorOf(req), id)));
  });

  app.post('/api/v1/captures/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CaptureDetailSchema, await answerCapture(actorOf(req), id, req.body)));
  });

  app.post('/api/v1/captures/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(UndoChangesResponseSchema, await undoCapture(actorOf(req), id, opts.collab)));
  });

  app.post('/api/v1/capture-changes/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(UndoChangesResponseSchema, await undoCaptureChange(actorOf(req), id, opts.collab)));
  });

  app.post('/api/v1/capture-changes/:id/move', { onRequest: credits }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await metered('capture', req, () =>
      moveCaptureChange(actorOf(req), id, req.body, { collab: opts.collab, embedder: embeddingProvider })
    );
    return reply.send(parseReply(MoveChangeResponseSchema, res));
  });

  app.get('/api/v1/pages/:id/capture-changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CaptureChangeListSchema, await listPageCaptureChanges(actorOf(req), id, req.query)));
  });

  app.get('/api/v1/needs-home', async (req, reply) => {
    return reply.send(parseReply(NeedsHomeListSchema, await listNeedsHome(actorOf(req))));
  });

  app.post('/api/v1/capture-facts/:id/place', { onRequest: credits }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await metered('capture', req, () => placeCaptureFact(actorOf(req), id, req.body, { embedder: embeddingProvider }));
    return reply.send(parseReply(FactStatusSchema, res));
  });

  app.get('/api/v1/needs-home/documents', async (req, reply) => {
    return reply.send(parseReply(NeedsHomeDocumentListSchema, await listNeedsHomeDocuments(actorOf(req))));
  });

  app.post('/api/v1/captures/:id/document/place', { onRequest: credits }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await metered('capture', req, () => placeCaptureDocument(actorOf(req), id, req.body, { embedder: embeddingProvider }));
    return reply.send(parseReply(CaptureSummarySchema, res));
  });

  app.post('/api/v1/captures/:id/document/as-updates', { onRequest: credits }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(CaptureSummarySchema, await routeCaptureAsUpdates(actorOf(req), id)));
  });

  app.post('/api/v1/captures/:id/document/move', { onRequest: credits }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await metered('capture', req, () => moveCaptureDocument(actorOf(req), id, req.body, { embedder: embeddingProvider }));
    return reply.send(parseReply(CaptureSummarySchema, res));
  });

  app.post('/api/v1/capture-facts/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(FactStatusSchema, await dismissCaptureFact(actorOf(req), id)));
  });

  app.get('/api/v1/pages/:id/suggestions', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(SuggestionListSchema, await listPageSuggestions(actorOf(req), id)));
  });

  app.post('/api/v1/suggestions/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(SuggestionSummarySchema, await acceptSuggestion(actorOf(req), id, opts.collab)));
  });

  app.post('/api/v1/suggestions/:id/decline', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(parseReply(SuggestionSummarySchema, await declineSuggestion(actorOf(req), id)));
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

  registerInternalRoutes(app, opts.controlPlaneTokens ?? []);

  app.get('/api/v1/usage', async (req, reply) => {
    const actor = actorOf(req);
    const now = new Date();
    const summary = await withTenantTx(actor.tenantId, async (tx) => {
      const standing = await readStanding(tx, actor.tenantId, now);
      const verdict = creditVerdict(standing);
      const [tenant] = await tx.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, actor.tenantId));
      const admin = actor.tenantRole === 'owner' || actor.tenantRole === 'admin';
      return {
        state: verdict.state,
        plan: tenant?.plan ?? 'standard',
        usedCredits: verdict.usedCredits,
        limitCredits: verdict.limitCredits,
        creditsTopup: standing.creditsTopup,
        graceLeftCredits: verdict.graceLeftCredits,
        indexUsedCredits: standing.indexCreditsUsedMilli / 1000,
        indexLimitCredits: standing.limits?.indexCreditsPerMonth ?? null,
        indexHeld: indexHeld(standing),
        storageBytes: standing.storageBytes,
        storageLimitBytes: standing.limits?.storageBytes ?? null,
        seats: await countSeats(tx, actor.tenantId, now),
        seatLimit: standing.limits?.seats ?? null,
        resetsAt: verdict.resetsAt.toISOString(),
        billingUrl: admin && opts.billingUrl ? opts.billingUrl : null,
      };
    });
    return reply.send(parseReply(UsageSummarySchema, summary));
  });

  app.post('/api/v1/search', { onRequest: requestLimit('search', limits.searchPerMinute) }, async (req, reply) =>
    metered('index', req, async () => {
    const actor = actorOf(req);
    const parsed = SearchRequestSchema.parse(req.body);
    let queryEmbedding: number[];
    try {
      [queryEmbedding] = await embeddingProvider.embed([parsed.query], 'query');
    } catch {
      throw new AppError('search_unavailable');
    }

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
  }));

  app.post('/api/v1/ask', { onRequest: [requestLimit('ask', limits.askPerMinute), credits] }, async (req, reply) =>
    metered('ask', req, async () => {
    const actor = actorOf(req);
    const parsed = AskRequestSchema.parse(req.body);
    await chargeAi(req, reply, actor.tenantId, limits.tenantDailyAiActions);
    let queryEmbedding: number[];
    try {
      [queryEmbedding] = await embeddingProvider.embed([parsed.question], 'query');
    } catch {
      throw new AppError('search_unavailable');
    }

    const { passages, tables } = await withTenantTx(actor.tenantId, async (tx) => {
      const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
      const effectiveSpaces = parsed.space_ids
        ? readableSpaceIds.filter((id) => parsed.space_ids!.includes(id))
        : readableSpaceIds;
      const passages = await searchWiki(
        tx,
        actor,
        effectiveSpaces,
        inboxSpaceId,
        parsed.question,
        queryEmbedding,
        5
      );
      // Questions across a collection ("which clients launch in December?") read its rows as a table.
      return { passages, tables: passages.length > 0 ? await collectionTables(tx, actor, effectiveSpaces, passages) : [] };
    });
    const res = await answerPassages(parsed.question, passages, answerProvider, tables);
    return reply.send(parseReply(AskResponseSchema, res));
  }));

  return app;
}
