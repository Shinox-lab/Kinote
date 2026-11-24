import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agents, documents, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor, type Actor } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { replaceFile } from '../src/routes/files.js';
import { bytesFile } from '../src/uploadedFile.js';
import { buildTestApp, signUpMember, useTestDb } from './support/testkit.js';
import { agentWorld, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const PNG_HEAD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_NO_TEXT = Buffer.concat([PNG_HEAD, Buffer.from('\nFAKE-EXTRACT-EMPTY\n')]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const enc = (s: string) => new TextEncoder().encode(s);

/** Every file version, from any writer, is held for review by the same rule as the writer's page edits. */
describe('file review decision', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });

  async function setup() {
    const w = await agentWorld(app, 'review-decision');
    const reviewer = await signUpMember(app, w.tenant.id, 'member');
    const viewer = await signUpMember(app, w.tenant.id, 'member');
    for (const [space, user, role] of [[w.strict, reviewer, 'reviewer'], [w.strict, viewer, 'viewer'], [w.open, viewer, 'viewer']] as const) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/spaces/${space.id}/grants`, headers: w.ownerHeaders,
        payload: { principal_type: 'user', principal_id: user.userId, role },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    const agentActor: Actor = { tenantId: w.tenant.id, principalType: 'agent', principalId: w.agentId, owner: { userId: w.owner.userId, tenantRole: 'owner' } };
    return { ...w, reviewer, viewer, agentActor };
  }
  type Ctx = AgentWorld & Awaited<ReturnType<typeof setup>>;

  async function upload(c: Ctx, spaceId: string, name: string, data: string | Uint8Array) {
    const res = await app.inject(uploadRequest('/api/v1/files', c.ownerHeaders, { name, data }, { space_id: spaceId }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  const ver = async (c: Ctx, id: string) => (await withTenantTx(c.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, id))))[0]!;
  const doc = async (c: Ctx, id: string) => (await withTenantTx(c.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
  const setAlwaysReview = (c: Ctx, on: boolean) =>
    withTenantTx(c.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: on }).where(eq(agents.id, c.agentId)));
  async function agentReplace(c: Ctx, fileId: string, name: string, bytes: Uint8Array) {
    const out = await replaceFile(c.agentActor, fileId, bytesFile(name, bytes), { storage });
    assert.equal(out.status, 'created');
    return out.response.version.id;
  }
  const approve = (c: Ctx, versionId: string) =>
    app.inject({ method: 'POST', url: `/api/v1/versions/${versionId}/approve`, headers: c.reviewer.headers, payload: {} });

  test('an always-review agent version waits for review in a normal space', async () => {
    const c = await setup();
    const up = await upload(c, c.open.id, 'notes.txt', 'First words.');
    await settle(c.tenant.id);
    const v2 = await agentReplace(c, up.document.id, 'notes.txt', enc('Agent words.'));
    await settle(c.tenant.id);
    assert.equal((await ver(c, v2)).status, 'pending_review');
  });

  test('an agent without always-review in a normal space is indexed', async () => {
    const c = await setup();
    await setAlwaysReview(c, false);
    const up = await upload(c, c.open.id, 'notes.txt', 'First words.');
    await settle(c.tenant.id);
    const v2 = await agentReplace(c, up.document.id, 'notes.txt', enc('Agent words.'));
    await settle(c.tenant.id);
    assert.equal((await ver(c, v2)).status, 'indexed');
  });

  test('a no-text version in a review space waits, and approval publishes it as stored', async () => {
    const c = await setup();
    const up = await upload(c, c.strict.id, 'photo.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    const v = await ver(c, up.version.id);
    assert.equal(v.status, 'pending_review');
    assert.equal(v.noText, true);
    assert.equal((await doc(c, up.document.id)).publishedVersionId, null);
    const res = await approve(c, up.version.id);
    assert.equal(res.statusCode, 200, res.body);
    await settle(c.tenant.id);
    assert.equal((await ver(c, up.version.id)).status, 'stored');
    assert.equal((await doc(c, up.document.id)).publishedVersionId, up.version.id);
  });

  test("a person's audio upload in a review space waits for review", async () => {
    const c = await setup();
    const up = await upload(c, c.strict.id, 'song.mp3', MP3);
    assert.equal((await ver(c, up.version.id)).status, 'pending_review');
    const before = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/media-url`, headers: c.viewer.headers });
    assert.equal(before.statusCode, 404);
    assert.equal((await approve(c, up.version.id)).statusCode, 200);
    assert.equal((await ver(c, up.version.id)).status, 'stored');
    const after = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/media-url`, headers: c.viewer.headers });
    assert.equal(after.statusCode, 200, after.body);
  });

  test('a person in a normal space is unchanged', async () => {
    const c = await setup();
    const pdf = await upload(c, c.open.id, 'r.pdf', '%PDF-1.7\nFAKE-EXTRACT\nSome text.\n');
    const png = await upload(c, c.open.id, 'p.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    assert.equal((await ver(c, pdf.version.id)).status, 'indexed');
    assert.equal((await ver(c, png.version.id)).status, 'stored');
    assert.equal((await doc(c, png.document.id)).publishedVersionId, png.version.id);
  });
});
