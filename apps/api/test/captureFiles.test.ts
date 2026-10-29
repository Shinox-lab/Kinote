import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { documents, spaces, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel, FakeExtractor, blockText } from '@kinote/core';
import { InMemoryObjectStorage, type BlockLike } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { uploadRequest } from './support/multipart.js';
import { pdf } from './support/sourcekit.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

const MEETING = [
  'Oct 14 meeting with George',
  '- George hero video swap.',
  '- Shop the look.',
  '- George launch moved to December.',
].join('\n');

describe('file captures', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;
  const storage = new InMemoryObjectStorage();
  const model = new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: embedder, storage });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, {
      collab,
      placementModel: model,
      embeddingProvider: embedder,
      storage,
      extractor: new FakeExtractor(),
    });

  async function world() {
    const { tenant, headers, inboxSpace } = await bootstrapTenant(app, { name: 'Files Co', slug: 'files-co' });
    const clients = (await post(headers, '/api/v1/spaces', { name: 'Clients', slug: 'clients' })).json().id as string;
    const page = async (title: string, slug: string, markdown: string, parentId: string | null = null) => {
      const res = await post(headers, '/api/v1/pages', { space_id: clients, parent_id: parentId, title, slug, markdown });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().id as string;
      expect((await post(headers, `/api/v1/pages/${id}/snapshot`)).statusCode).toBeLessThan(300);
      await run(tenant.id);
      return id;
    };
    const george = await page('Client - George', 'george', 'George is a client. Launch is in November.');
    await page('29Sep', 'sep-29', 'Hero video notes.', george);
    return { tenant, headers, inbox: inboxSpace.id as string, clients, george };
  }

  /** Uploads to the sender's Inbox, as the Capture page's Attach does. */
  async function upload(headers: Headers, inbox: string, name: string, data: string, type?: string) {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data, type }, { space_id: inbox }));
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json().document.id as string;
  }

  const fileRow = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
  const spaceKind = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select({ kind: spaces.kind }).from(spaces).where(eq(spaces.id, id))))[0]!.kind;

  test('a file alone becomes its own page, its text routed; the file moves under the page', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'Oct 14 meeting with George.md', MEETING, 'text/markdown');
    const res = await post(w.headers, '/api/v1/captures', { file_id: file });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ text: '', file: { id: file, name: 'Oct 14 meeting with George.md' } });
    await run(w.tenant.id);

    const detail = (await get(w.headers, `/api/v1/captures/${res.json().id}`)).json();
    expect(detail.capture).toMatchObject({ status: 'done', shape: 'document' });
    expect(detail.receipt.document).toMatchObject({ outcome: 'created', title: 'Oct 14 meeting with George', parentTitle: 'Client - George' });
    const pageId = detail.receipt.document.pageId as string;
    const text = (readBlocks(await storedDoc(w.tenant.id, pageId)) as BlockLike[]).map(blockText).join('\n');
    expect(text).toContain('Shop the look.');

    const moved = await fileRow(w.tenant.id, file);
    expect(moved).toMatchObject({ parentId: pageId, spaceId: w.clients });
  });

  test('typed text comes first and names the page', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'notes.pdf', pdf('George launch moved to December.'));
    const res = await post(w.headers, '/api/v1/captures', { text: 'George December update', file_id: file });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    const detail = (await get(w.headers, `/api/v1/captures/${res.json().id}`)).json();
    expect(detail.receipt.document).toMatchObject({ outcome: 'created', title: 'George December update' });
  });

  test('Updates only routes the text and leaves the file in the Inbox', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'meeting.md', MEETING, 'text/markdown');
    const res = await post(w.headers, '/api/v1/captures', { file_id: file, shape: 'updates' });
    await run(w.tenant.id);
    const detail = (await get(w.headers, `/api/v1/captures/${res.json().id}`)).json();
    expect(detail.capture).toMatchObject({ status: 'done', shape: 'updates' });
    expect(detail.receipt.document).toBeNull();
    expect(await spaceKind(w.tenant.id, (await fileRow(w.tenant.id, file)).spaceId)).toBe('inbox');
  });

  test('undoing the page puts the file back in the Inbox', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'Oct 14 meeting with George.md', MEETING, 'text/markdown');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    await run(w.tenant.id);
    const undo = await post(w.headers, `/api/v1/captures/${id}/undo`);
    expect(undo.statusCode, undo.body).toBe(200);
    const back = await fileRow(w.tenant.id, file);
    expect(back).toMatchObject({ spaceId: w.inbox, parentId: null, archivedAt: null });
  });

  test('undo leaves the file where a person moved it since', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'Oct 14 meeting with George.md', MEETING, 'text/markdown');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    await run(w.tenant.id);
    const moved = await post(w.headers, `/api/v1/files/${file}/move`, { target_space_id: w.clients, target_parent_id: w.george });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await post(w.headers, `/api/v1/captures/${id}/undo`)).statusCode).toBe(200);
    expect(await fileRow(w.tenant.id, file)).toMatchObject({ spaceId: w.clients, parentId: w.george });
  });

  test('a file moved out of the Inbox before routing stays where it was put', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'Oct 14 meeting with George.md', MEETING, 'text/markdown');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    const moved = await post(w.headers, `/api/v1/files/${file}/move`, { target_space_id: w.clients, target_parent_id: w.george });
    expect(moved.statusCode, moved.body).toBe(200);
    await run(w.tenant.id);
    expect((await get(w.headers, `/api/v1/captures/${id}`)).json().receipt.document).toMatchObject({ outcome: 'created' });
    expect(await fileRow(w.tenant.id, file)).toMatchObject({ spaceId: w.clients, parentId: w.george });
  });

  test('a file already sent with another capture is refused', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'notes.md', MEETING, 'text/markdown');
    expect((await post(w.headers, '/api/v1/captures', { file_id: file })).statusCode).toBe(201);
    const again = await post(w.headers, '/api/v1/captures', { file_id: file });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('capture_file_in_use');
  });

  test('a file with no readable text fails the capture and stays in the Inbox', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'scan.pdf', '%PDF-1.7\nFAKE-EXTRACT-EMPTY');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    await run(w.tenant.id);
    const { capture } = (await get(w.headers, `/api/v1/captures/${id}`)).json();
    expect(capture).toMatchObject({ status: 'failed', error: 'No text could be read from this file. It was kept in your Inbox.' });
    expect((await fileRow(w.tenant.id, file)).spaceId).toBe(w.inbox);
  });

  test('a file over 50,000 characters of text is not routed', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'big.md', `# Big\n\n${'word '.repeat(10_500)}`, 'text/markdown');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    await run(w.tenant.id);
    const { capture } = (await get(w.headers, `/api/v1/captures/${id}`)).json();
    expect(capture).toMatchObject({ status: 'failed', error: 'Too long to route. The file was kept in your Inbox.' });
  });

  test('only your own Inbox file, and not audio or video', async () => {
    const w = await world();
    const member = await signUpMember(app, w.tenant.id, 'member');
    await post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const mine = await upload(w.headers, w.inbox, 'mine.md', MEETING, 'text/markdown');
    expect((await post(member.headers, '/api/v1/captures', { file_id: mine })).statusCode).toBe(404);

    const song = await upload(w.headers, w.inbox, 'song.mp3', 'ID3audio-bytes');
    const refused = await post(w.headers, '/api/v1/captures', { file_id: song });
    expect(refused.statusCode).toBe(415);
    expect(refused.json().message).toBe("Audio and video can't be read yet.");

    expect((await post(w.headers, '/api/v1/captures', {})).statusCode).toBe(400);
  });

  test('the capture waits while the file is being read', async () => {
    const w = await world();
    const file = await upload(w.headers, w.inbox, 'Oct 14 meeting with George.md', MEETING, 'text/markdown');
    const id = (await post(w.headers, '/api/v1/captures', { file_id: file })).json().id as string;
    const before = (await get(w.headers, `/api/v1/captures/${id}`)).json();
    expect(before.capture).toMatchObject({ status: 'queued', file: { id: file } });
    await run(w.tenant.id);
    expect((await get(w.headers, `/api/v1/captures/${id}`)).json().capture.status).toBe('done');
  });
});
