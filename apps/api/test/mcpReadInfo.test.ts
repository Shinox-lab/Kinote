import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agents, versions, withTenantTx } from '@kinote/db';
import { FakeExtractor, type Actor } from '@kinote/core';
import { InMemoryObjectStorage } from '@kinote/shared';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { replaceFile } from '../src/routes/files.js';
import { bytesFile } from '../src/uploadedFile.js';
import { buildTestApp, createAgent, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, issueAgentToken, publishPage, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
const pdf = (text: string) => `%PDF-1.7\nFAKE-EXTRACT\n${text}\n`;

/** kinote_read on files: info, versions, the Edit with line and honest messages when there is no text. */
describe('kinote_read info and versions', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;
  let storage: InMemoryObjectStorage;

  async function world(slug: string) {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
    const w = await agentWorld(app, slug);
    const { token } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'edit'] });
    return { ...w, token };
  }
  const index = (w: AgentWorld) => runPendingJobsForTenant(w.tenant.id, { storage, extractor: new FakeExtractor() });
  const read = (w: AgentWorld, args: object) => callTool(app, w.token, 'kinote_read', args);
  async function upload(w: AgentWorld, name: string, data: string | Uint8Array, spaceId = w.open.id) {
    const res = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name, data }, { space_id: spaceId }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  async function replace(w: AgentWorld, fileId: string, name: string, data: string) {
    const res = await app.inject(uploadRequest(`/api/v1/files/${fileId}/versions`, w.ownerHeaders, { name, data }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json().version.id as string;
  }
  const setStatus = (w: AgentWorld, id: string, status: typeof versions.$inferSelect.status, error: string | null = null) =>
    withTenantTx(w.tenant.id, (tx) => tx.update(versions).set({ status, error }).where(eq(versions.id, id)));

  test('info on a file shows type, size, current version and Edit with', async () => {
    const w = await world('info-file');
    const up = await upload(w, 'memo.pdf', pdf('The memo says hello.'));
    await index(w);
    const res = await read(w, { page_id: short(up.document.id), level: 'info' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Type: pdf · \d+ B · memo\.pdf/);
    assert.match(res.text, /Version: v1 \(latest\) · indexed · by /);
    assert.match(res.text, /Readable text: v1/);
    assert.match(res.text, /Location: Open/);
    assert.ok(res.text.trimEnd().includes('Edit with: kinote_download, then kinote_replace (base_version 1)'), res.text);
    assert.ok(!res.text.includes('The memo says hello.'));
  });

  test('info on a page shows Edit with: kinote_edit', async () => {
    const w = await world('info-page');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Guide', 'Some words here.');
    const res = await read(w, { page_id: id, level: 'info' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^Edit with: kinote_edit$/m);
    assert.match(res.text, /Words: 3/);
    assert.ok(!res.text.includes('Some words here.'));
  });

  test('a view-only agent sees View only', async () => {
    const w = await world('info-viewer');
    const up = await upload(w, 'memo.pdf', pdf('Hello.'));
    await index(w);
    const viewerAgent = await createAgent(w.tenant.id, w.owner.userId, { name: 'Viewer bot' });
    const g = await app.inject({
      method: 'POST', url: `/api/v1/spaces/${w.open.id}/grants`, headers: w.ownerHeaders,
      payload: { principal_type: 'agent', principal_id: viewerAgent, role: 'viewer' },
    });
    assert.equal(g.statusCode, 201, g.body);
    const { token } = await issueAgentToken(w.tenant.id, viewerAgent, { scopes: ['read', 'edit'] });
    const res = await callTool(app, token, 'kinote_read', { page_id: up.document.id, level: 'info' });
    assert.match(res.text, /^View only: a person with edit access can change it\.$/m);
  });

  test('a file read with no level still returns its text', async () => {
    const w = await world('info-default');
    const up = await upload(w, 'memo.pdf', pdf('The memo says hello.'));
    await index(w);
    const res = await read(w, { page_id: up.document.id });
    assert.ok(res.text.includes('The memo says hello.'), res.text);
  });

  test('outline on a file is info; section is refused', async () => {
    const w = await world('info-outline');
    const up = await upload(w, 'memo.pdf', pdf('The memo says hello.'));
    await index(w);
    const outline = await read(w, { page_id: up.document.id, level: 'outline' });
    assert.match(outline.text, /Type: pdf/);
    assert.ok(!outline.text.includes('The memo says hello.'));
    const section = await read(w, { page_id: up.document.id, level: 'section', section_id: 'abcdefgh' });
    assert.equal(section.isError, true);
    assert.equal(section.text, 'A file has no sections. Read level "full" for its text.');
  });

  test('versions lists newest first with who and size, and pages with a cursor', async () => {
    const w = await world('info-versions');
    const up = await upload(w, 'notes.txt', 'v1 text');
    for (let n = 2; n <= 21; n++) await replace(w, up.document.id, 'notes.txt', `v${n} text`);
    const agentActor: Actor = { tenantId: w.tenant.id, principalType: 'agent', principalId: w.agentId, owner: { userId: w.owner.userId, tenantRole: 'owner' } };
    await replaceFile(agentActor, up.document.id, bytesFile('notes.txt', new TextEncoder().encode('v22 text')), { storage });
    const first = await read(w, { page_id: up.document.id, level: 'versions' });
    assert.equal(first.isError, false, first.text);
    const lines = (t: string) => t.split('\n').filter((l) => /^v\d+ · /.test(l));
    assert.equal(lines(first.text).length, 20);
    assert.match(lines(first.text)[0]!, /^v22 · being read · Agent "Test agent" · \d{4}-\d\d-\d\d \d\d:\d\d · 8 B$/);
    assert.match(lines(first.text)[1]!, /^v21 · /);
    const cursor = /More: call kinote_read with cursor "([A-Za-z0-9_-]+)"/.exec(first.text)?.[1];
    assert.ok(cursor, first.text);
    const second = await read(w, { page_id: up.document.id, level: 'versions', cursor });
    assert.deepEqual(lines(second.text).map((l) => l.split(' ')[0]), ['v2', 'v1']);
    assert.ok(!second.text.includes('More:'));
    const wrong = await read(w, { page_id: up.document.id, level: 'full', cursor });
    assert.equal(wrong.isError, true);
  });

  test('no-text messages follow the latest status', async () => {
    const w = await world('info-notext');
    const up = await upload(w, 'scan.pdf', pdf('Words.'));
    const v = up.version.id;
    const full = async () => (await read(w, { page_id: up.document.id, level: 'full' })).text;
    await setStatus(w, v, 'extracting');
    assert.match(await full(), /Kinote is still reading this file\. Try again in a minute\./);
    await setStatus(w, v, 'pending_review');
    assert.match(await full(), /This version is waiting for review; its text is readable once a person approves it\./);
    await setStatus(w, v, 'stored');
    assert.match(await full(), /This file has no text Kinote can read \(an image without words, audio or video\)\. kinote_download gets the file itself\./);
    await setStatus(w, v, 'failed', 'The file is damaged.');
    assert.match(await full(), /Kinote could not read this file: The file is damaged\. kinote_download gets the file itself\./);
    await setStatus(w, v, 'rejected');
    assert.match(await full(), /The latest version was rejected; no other version has readable text\./);
  });

  test('base_version skips a rejected latest version', async () => {
    const w = await world('info-rejected');
    const up = await upload(w, 'notes.txt', 'one');
    await index(w);
    const v2 = await replace(w, up.document.id, 'notes.txt', 'two');
    await setStatus(w, v2, 'rejected');
    const res = await read(w, { page_id: up.document.id, level: 'info' });
    assert.ok(res.text.includes('(base_version 1)'), res.text);
  });

  test('an older indexed version is read while the latest waits', async () => {
    const w = await world('info-older');
    const up = await upload(w, 'notes.txt', 'The first words.');
    await index(w);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: true }).where(eq(agents.id, w.agentId)));
    const agentActor: Actor = { tenantId: w.tenant.id, principalType: 'agent', principalId: w.agentId, owner: { userId: w.owner.userId, tenantRole: 'owner' } };
    await replaceFile(agentActor, up.document.id, bytesFile('notes.txt', new TextEncoder().encode('The second words.')), { storage });
    await index(w);
    const res = await read(w, { page_id: up.document.id, level: 'full' });
    assert.ok(res.text.includes('The first words.'), res.text);
    assert.match(res.text, /indexed v1, latest v2 waiting for review/);
  });
});
