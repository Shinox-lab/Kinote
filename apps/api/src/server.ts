import Fastify from 'fastify';
import { withTenantTx } from '@living-wiki/db';
import { SearchRequestSchema, AskRequestSchema } from '@living-wiki/contracts';
import {
  getReadableSpaceIds,
  takePageSnapshot,
  defaultEmbeddingProvider,
  type Actor,
} from '@living-wiki/core';
import {
  createTenantWithInbox,
  createSpace,
  getSpaceForActor,
  listSpacesForActor,
  updateSpaceSettings,
  upsertSpaceGrant,
  inviteMember,
} from './routes/foundations.js';
import {
  createPage,
  getPageDetails,
  approveVersion,
  rejectVersion,
  movePage,
  archivePage,
  withdrawPage,
} from './routes/pages.js';
import { searchWiki } from './search/hybridSearch.js';
import { askWiki } from './search/ask.js';

export function buildApiServer() {
  const app = Fastify({ logger: false });

  function extractActor(headers: Record<string, string | undefined>): Actor {
    return {
      tenantId: headers['x-tenant-id'] ?? '',
      principalType: (headers['x-principal-type'] as 'user' | 'agent') ?? 'user',
      principalId: headers['x-principal-id'] ?? '',
      tenantRole: (headers['x-tenant-role'] as Actor['tenantRole']) ?? 'member',
    };
  }

  app.post('/api/v1/tenants', async (req, reply) => {
    const res = await createTenantWithInbox(req.body);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/invitations', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await inviteMember(actor, req.body as any);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/spaces', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await listSpacesForActor(actor);
    return reply.send(res);
  });

  app.post('/api/v1/spaces', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await createSpace(actor, req.body);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/spaces/:id', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await getSpaceForActor(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.patch('/api/v1/spaces/:id', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await updateSpaceSettings(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.post('/api/v1/spaces/:id/grants', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await upsertSpaceGrant(actor, (req.params as any).id, req.body);
    return reply.status(201).send(res);
  });

  app.post('/api/v1/pages', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await createPage(actor, req.body);
    return reply.status(201).send(res);
  });

  app.get('/api/v1/pages/:id', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await getPageDetails(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/snapshot', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const pageId = (req.params as any).id;
    // Check viewer/editor permission before taking snapshot
    await getPageDetails(actor, pageId);
    const version = await takePageSnapshot({
      tenantId: actor.tenantId,
      pageId,
      reason: actor.principalType === 'agent' ? 'agent' : 'submit',
      actorType: actor.principalType,
      actorId: actor.principalId,
      manual: true,
    });
    return reply.status(201).send(version);
  });

  app.post('/api/v1/pages/:id/move', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await movePage(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/archive', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await archivePage(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/pages/:id/withdraw', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await withdrawPage(actor, (req.params as any).id);
    return reply.send(res);
  });

  app.post('/api/v1/versions/:id/approve', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await approveVersion(actor, (req.params as any).id, req.body ?? {});
    return reply.send(res);
  });

  app.post('/api/v1/versions/:id/reject', async (req, reply) => {
    const actor = extractActor(req.headers as any);
    const res = await rejectVersion(actor, (req.params as any).id, req.body);
    return reply.send(res);
  });

  app.post('/api/v1/search', async (req, reply) => {
    const actor = extractActor(req.headers as any);
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
    const actor = extractActor(req.headers as any);
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
