import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agents, documents, versions, withTenantTx } from '@kinote/db';
import { FakeExtractor } from '@kinote/core';
import { InMemoryObjectStorage } from '@kinote/shared';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, createAgent, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, issueAgentToken, publishPage, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);

/** kinote_replace: a new version of a file from the agent's own bytes, guarded by base_version. */
describe('kinote_replace', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;
  let storage: InMemoryObjectStorage;

  async function world(slug: string) {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
    const w = await agentWorld(app, slug);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, w.agentId)));
    const { token } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'edit'] });
    return { ...w, token };
  }
  const index = (w: AgentWorld) => runPendingJobsForTenant(w.tenant.id, { storage, extractor: new FakeExtractor() });
  const replace = (w: AgentWorld, args: object, token = w.token) => callTool(app, token, 'kinote_replace', args);
  async function upload(w: AgentWorld, name: string, data: string | Uint8Array, spaceId = w.open.id) {
    const res = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name, data }, { space_id: spaceId }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  const versionsOf = (w: AgentWorld, id: string) =>
    withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, id)).orderBy(versions.number));

  test('content_text replaces a CSV and names the new version and status', async () => {
    const w = await world('rp-text');
    const up = await upload(w, 'data.csv', 'a,b\n1,2\n');
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'a,b\n1,3\n' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^Replaced: data\.csv is now v2 \(was v1\) · being read/);
    const vs = await versionsOf(w, up.document.id);
    assert.equal(vs.length, 2);
    assert.equal(vs[1]!.createdByType, 'agent');
    assert.equal(new TextDecoder().decode((await storage.get(w.tenant.id, vs[1]!.objectKey!)).bytes), 'a,b\n1,3\n');

    const strict = await upload(w, 'other.csv', 'x\n', w.strict.id);
    const held = await replace(w, { page_id: strict.document.id, base_version: 1, content_text: 'y\n' });
    assert.match(held.text, /waiting for review in Strict/);
  });

  test('content_base64 replaces a PNG', async () => {
    const w = await world('rp-png');
    const up = await upload(w, 'dot.png', PNG);
    const next = Buffer.concat([PNG, Buffer.from('more')]);
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_base64: next.toString('base64') });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^Replaced: dot\.png is now v2 \(was v1\)/);
  });

  test('the same bytes again answer Unchanged, even after a base move', async () => {
    const w = await world('rp-same');
    const up = await upload(w, 'data.csv', 'a\n');
    assert.match((await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'b\n' })).text, /^Replaced/);
    const again = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'b\n' });
    assert.equal(again.isError, false, again.text);
    assert.equal(again.text, 'Unchanged: this is already v2.');
    assert.equal((await versionsOf(w, up.document.id)).length, 2);
  });

  test('a stale base is refused naming the current version and author', async () => {
    const w = await world('rp-stale');
    const up = await upload(w, 'data.csv', 'a\n');
    const v2 = await app.inject(uploadRequest(`/api/v1/files/${up.document.id}/versions`, w.ownerHeaders, { name: 'data.csv', data: 'b\n' }));
    assert.equal(v2.statusCode, 201);
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'c\n' });
    assert.equal(res.isError, true);
    assert.match(res.text, /^This file changed since v1: v2 by .+ at \d{4}-\d\d-\d\d \d\d:\d\d\. Download it again, redo your change on v2, and send base_version 2\.$/);
  });

  test('two concurrent replaces on the same base: one wins', async () => {
    const w = await world('rp-race');
    const up = await upload(w, 'data.csv', 'a\n');
    const [x, y] = await Promise.all([
      replace(w, { page_id: up.document.id, base_version: 1, content_text: 'x\n' }),
      replace(w, { page_id: up.document.id, base_version: 1, content_text: 'y\n' }),
    ]);
    const texts = [x.text, y.text];
    assert.equal(texts.filter((t) => t.startsWith('Replaced')).length, 1, texts.join(' | '));
    assert.equal(texts.filter((t) => t.startsWith('This file changed since v1')).length, 1, texts.join(' | '));
    assert.equal((await versionsOf(w, up.document.id)).length, 2);
  });

  test('a type change is refused', async () => {
    const w = await world('rp-type');
    const up = await upload(w, 'data.csv', 'a\n');
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_base64: PNG.toString('base64'), file_name: 'data.png' });
    assert.equal(res.isError, true);
    assert.equal(res.text, 'This is a png but the file is a csv. Add it as a new file with kinote_upload.');
  });

  test('a page is refused with kinote_edit', async () => {
    const w = await world('rp-page');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Guide', 'Words.');
    const res = await replace(w, { page_id: id, base_version: 1, content_text: 'x' });
    assert.equal(res.isError, true);
    assert.equal(res.text, 'Pages change with kinote_edit.');
  });

  test('a view-only agent is refused', async () => {
    const w = await world('rp-viewer');
    const up = await upload(w, 'data.csv', 'a\n');
    const viewer = await createAgent(w.tenant.id, w.owner.userId, { name: 'Viewer bot' });
    const g = await app.inject({
      method: 'POST', url: `/api/v1/spaces/${w.open.id}/grants`, headers: w.ownerHeaders,
      payload: { principal_type: 'agent', principal_id: viewer, role: 'viewer' },
    });
    assert.equal(g.statusCode, 201);
    const { token } = await issueAgentToken(w.tenant.id, viewer, { scopes: ['read', 'edit'] });
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'b\n' }, token);
    assert.equal(res.isError, true);
    assert.equal(res.text, 'No edit access: a person can change it.');
  });

  test('audio is refused', async () => {
    const w = await world('rp-audio');
    const up = await upload(w, 'song.mp3', MP3);
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_base64: Buffer.from([...MP3, 9]).toString('base64') });
    assert.equal(res.isError, true);
    assert.equal(res.text, "Kinote can't take audio or video from an agent; a person can replace it in Kinote.");
  });

  test('a synced file is refused', async () => {
    const w = await world('rp-synced');
    const up = await upload(w, 'data.csv', 'a\n');
    await withTenantTx(w.tenant.id, (tx) => tx.update(documents).set({ placement: 'synced' }).where(eq(documents.id, up.document.id)));
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'b\n' });
    assert.equal(res.isError, true);
    assert.match(res.text, /managed by an external source/);
  });

  test('an empty file is refused', async () => {
    const w = await world('rp-empty');
    const up = await upload(w, 'data.csv', 'a\n');
    for (const args of [{ content_text: '' }, { content_base64: '' }]) {
      const res = await replace(w, { page_id: up.document.id, base_version: 1, ...args });
      assert.equal(res.isError, true);
      assert.equal(res.text, 'The file is empty.');
    }
    assert.equal((await versionsOf(w, up.document.id)).length, 1);
  });

  test('over 256 KiB inline is refused and points to the upload link', async () => {
    const w = await world('rp-big');
    const up = await upload(w, 'data.csv', 'a\n');
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'x'.repeat(256 * 1024 + 1) });
    assert.equal(res.isError, true);
    assert.match(res.text, /over 256 KiB.*kinote_replace with page_id and base_version only/);
  });

  test('a rejected latest version does not move the base', async () => {
    const w = await world('rp-rejected');
    const up = await upload(w, 'data.csv', 'a\n');
    await index(w);
    assert.match((await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'b\n' })).text, /^Replaced/);
    const vs = await versionsOf(w, up.document.id);
    await withTenantTx(w.tenant.id, (tx) => tx.update(versions).set({ status: 'rejected' }).where(eq(versions.id, vs[1]!.id)));
    const res = await replace(w, { page_id: up.document.id, base_version: 1, content_text: 'c\n' });
    assert.match(res.text, /^Replaced: data\.csv is now v3 \(was v1\)/);
  });
});
