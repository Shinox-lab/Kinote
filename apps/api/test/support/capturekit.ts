import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { captures, withTenantTx } from '@kinote/db';
import { enqueueCaptureRoute } from '../../src/routes/captures.js';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel, FakeExtractor, blockText } from '@kinote/core';
import { InMemoryObjectStorage, type BlockLike } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../../collab/src/server.js';
import { startCollabServer } from '../../../collab/test/support/wsClient.js';
import { readBlocks } from '../../../collab/test/support/blocks.js';
import { storedDoc } from '../../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../../worker/src/runner.js';
import { InProcessCollabClient } from './inProcessCollab.js';
import { uploadRequest } from './multipart.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './testkit.js';

type Headers = Record<string, string>;

/**
 * Everything a routing test needs, set up once per describe block: an in-process collab server, the app wired to
 * it, the deterministic model and embedder, and `world(slug)`, a workspace with space Clients, page
 * `Client - George` ("George is a client. Launch is in November.") and its child `29Sep`. Call at describe level.
 */
export function useCaptureKit(opts: { model?: DeterministicPlacementModel } = {}) {
  const storage = new InMemoryObjectStorage();
  const model = opts.model ?? new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();
  const kit = {
    storage,
    model,
    embedder,
    server: undefined as unknown as CollabServer,
    collab: undefined as unknown as InProcessCollabClient,
    app: undefined as unknown as FastifyInstance,
  };

  beforeAll(async () => {
    ({ server: kit.server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    kit.collab = new InProcessCollabClient(kit.server);
    kit.app = buildTestApp({ collab: kit.collab, embeddingProvider: embedder, storage });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(kit.server);
  });
  afterAll(async () => {
    await kit.server.server.destroy();
  });

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    kit.app.inject({ method: 'POST', url, headers, payload: payload as never });
  const patch = (headers: Headers, url: string, payload: unknown = {}) =>
    kit.app.inject({ method: 'PATCH', url, headers, payload: payload as never });
  const get = (headers: Headers, url: string) => kit.app.inject({ method: 'GET', url, headers });
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, {
      collab: kit.collab,
      placementModel: model,
      embeddingProvider: embedder,
      storage,
      extractor: new FakeExtractor(),
    });

  /** The page's live text, one line per top-level block. */
  const pageText = async (tenantId: string, pageId: string) =>
    (readBlocks(await storedDoc(tenantId, pageId)) as BlockLike[]).map(blockText).join('\n');

  async function world(slug = 'capture-co') {
    const { tenant, owner, headers, inboxSpace } = await bootstrapTenant(kit.app, { name: `${slug} Co`, slug });
    const res = await post(headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' });
    assert.equal(res.statusCode, 201, res.body);
    const clients = res.json().id as string;
    const page = async (title: string, pageSlug: string, markdown: string, parentId: string | null = null) => {
      const made = await post(headers, '/api/v1/pages', { space_id: clients, parent_id: parentId, title, slug: pageSlug, markdown });
      assert.equal(made.statusCode, 201, made.body);
      const id = made.json().id as string;
      assert.ok((await post(headers, `/api/v1/pages/${id}/snapshot`)).statusCode < 300);
      await run(tenant.id);
      return id;
    };
    const george = await page('Client - George', 'george', 'George is a client. Launch is in November.');
    const sep29 = await page('29Sep', 'sep-29', 'Hero video notes.', george);
    return { tenant, owner, headers, inbox: inboxSpace.id as string, clients, george, sep29, run: () => run(tenant.id) };
  }

  /** Uploads a file to the sender's Inbox, as the Capture page's Attach does; returns its document id. */
  async function upload(headers: Headers, inbox: string, name: string, data: string | Buffer, type?: string) {
    const res = await kit.app.inject(uploadRequest('/api/v1/files', headers, { name, data, type }, { space_id: inbox }));
    assert.ok(res.statusCode < 300, res.body);
    return res.json().document.id as string;
  }

  return Object.assign(kit, { post, patch, get, run, pageText, world, upload });
}
export type CaptureKit = ReturnType<typeof useCaptureKit>;
export type CaptureWorld = Awaited<ReturnType<CaptureKit['world']>>;

/** Files a capture as the agent would over MCP (the tool comes later): a row on channel mcp, and its routing job. */
export async function agentCapture(tenantId: string, agentId: string, text: string, extra: Partial<typeof captures.$inferInsert> = {}) {
  return withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .insert(captures)
      .values({ tenantId, senderType: 'agent', senderId: agentId, channel: 'mcp', text, ...extra })
      .returning();
    await enqueueCaptureRoute(tx, tenantId, row!.id);
    return row!.id;
  });
}

