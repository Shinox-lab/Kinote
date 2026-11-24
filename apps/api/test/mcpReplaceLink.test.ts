import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { agentTokens, agents, auditEvents, mcpUploads, tenantBilling, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, issueAgentToken, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const PUBLIC_URL = 'https://kinote.example/sub/';

/** kinote_replace with no content: an upload link; the PUT only stages; a second call commits. */
describe('kinote_replace upload links', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;
  let storage: InMemoryObjectStorage;

  async function world(slug: string, maxUploadBytes?: number) {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage, publicUrl: PUBLIC_URL, ...(maxUploadBytes ? { maxUploadBytes } : {}) });
    const w = await agentWorld(app, slug);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, w.agentId)));
    const { token, tokenId } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'capture', 'edit'] });
    const res = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'Budget 2026.csv', data: 'a,b\n1,2\n' }, { space_id: w.open.id }));
    assert.equal(res.statusCode, 201, res.body);
    return { ...w, token, tokenId, fileId: res.json().document.id as string };
  }
  type W = AgentWorld & { fileId: string };
  const replace = (w: W, args: object) => callTool(app, w.token, 'kinote_replace', args);
  async function link(w: W) {
    const res = await replace(w, { page_id: w.fileId, base_version: 1 });
    assert.equal(res.isError, false, res.text);
    const url = /Upload link \(15 minutes, one file up to [\d.]+ [KM]B\): (\S+)/.exec(res.text)?.[1];
    const uploadId = /upload_id ([0-9a-f-]{36})/.exec(res.text)?.[1];
    assert.ok(url && uploadId, res.text);
    return { text: res.text, path: new URL(url).pathname.replace(/^\/sub/, ''), uploadId };
  }
  const put = (path: string, payload: string | Buffer | Readable, headers: Record<string, string> = {}) =>
    app.inject({ method: 'PUT', url: path, payload: payload as never, headers: { 'content-type': 'application/octet-stream', ...headers } });
  const versionsOf = (w: W) => withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, w.fileId)));

  test('no content returns an upload link, a PUT stages it, upload_id commits it', async () => {
    const w = await world('rl-flow');
    const l = await link(w);
    assert.match(l.text, /Send with: curl -fT 'Budget 2026\.csv' 'https:\/\/kinote\.example\/sub\/api\/v1\/agent-uploads\/\S+'/);
    assert.match(l.text, /Then call kinote_replace with page_id \S+, base_version 1 and upload_id [0-9a-f-]{36}\./);
    const body = 'a,b\n1,3\n';
    const res = await put(l.path, body);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { upload_id: l.uploadId, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    assert.equal((await versionsOf(w)).length, 1, 'the PUT changes nothing');
    const done = await replace(w, { page_id: w.fileId, base_version: 1, upload_id: l.uploadId });
    assert.match(done.text, /^Replaced: Budget 2026\.csv is now v2 \(was v1\)/);
    assert.equal((await versionsOf(w)).length, 2);
    const audit = await withTenantTx(w.tenant.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.type, 'mcp.link_upload')));
    assert.equal(audit.length, 1);
    assert.equal((await withTenantTx(w.tenant.id, (tx) => tx.select().from(mcpUploads))).length, 0, 'the staged upload is gone');
  });

  test('the no-content call checks the base before giving a link', async () => {
    const w = await world('rl-stale');
    const v2 = await app.inject(uploadRequest(`/api/v1/files/${w.fileId}/versions`, w.ownerHeaders, { name: 'Budget 2026.csv', data: 'x\n' }));
    assert.equal(v2.statusCode, 201);
    const res = await replace(w, { page_id: w.fileId, base_version: 1 });
    assert.equal(res.isError, true);
    assert.match(res.text, /^This file changed since v1: v2 by /);
    assert.equal((await withTenantTx(w.tenant.id, (tx) => tx.select().from(mcpUploads))).length, 0);
  });

  test('a second PUT is 409; an expired link is 404; a revoked token is 404', async () => {
    const w = await world('rl-twice');
    const l = await link(w);
    assert.equal((await put(l.path, 'one\n')).statusCode, 200);
    assert.equal((await put(l.path, 'two\n')).statusCode, 409);
    const l2 = await link(w);
    await withTenantTx(w.tenant.id, (tx) => tx.update(mcpUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mcpUploads.id, l2.uploadId)));
    assert.equal((await put(l2.path, 'x\n')).statusCode, 404);
    const l3 = await link(w);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, w.tokenId)));
    assert.equal((await put(l3.path, 'x\n')).statusCode, 404);
  });

  test('a PUT over the cap is 413 and stages nothing, even chunked', async () => {
    const w = await world('rl-cap', 1024);
    const l = await link(w);
    const big = Buffer.alloc(2048, 0x61);
    assert.equal((await put(l.path, big, { 'content-length': '2048' })).statusCode, 413);
    const chunked = await put(l.path, Readable.from([big.subarray(0, 1000), big.subarray(1000)]), { 'transfer-encoding': 'chunked' });
    assert.equal(chunked.statusCode, 413);
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(mcpUploads).where(eq(mcpUploads.id, l.uploadId)));
    assert.equal(row!.receivedBytes, 0);
    assert.equal((await put(l.path, 'ten bytes\n')).statusCode, 200);
  });

  test('asking again for the same file replaces the unsent link, which lives 15 minutes', async () => {
    const w = await world('rl-again');
    for (let i = 0; i < 5; i++) await link(w);
    const rows = await withTenantTx(w.tenant.id, (tx) => tx.select().from(mcpUploads));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime() <= 15 * 60_000);
  });

  test('a commit before the PUT keeps the link and says nothing was sent', async () => {
    const w = await world('rl-early');
    const l = await link(w);
    const early = await replace(w, { page_id: w.fileId, base_version: 1, upload_id: l.uploadId });
    assert.equal(early.isError, true);
    assert.equal(early.text, 'Nothing has been sent to the upload link yet. Send the file with the curl line, then call again.');
    assert.equal((await put(l.path, 'a,b\n9,9\n')).statusCode, 200);
    const done = await replace(w, { page_id: w.fileId, base_version: 1, upload_id: l.uploadId });
    assert.match(done.text, /^Replaced/);
  });

  test('an empty PUT is refused at commit', async () => {
    const w = await world('rl-empty');
    const l = await link(w);
    assert.equal((await put(l.path, '')).statusCode, 200);
    const res = await replace(w, { page_id: w.fileId, base_version: 1, upload_id: l.uploadId });
    assert.equal(res.isError, true);
    assert.equal(res.text, 'The file is empty.');
    assert.equal((await versionsOf(w)).length, 1);
  });

  test('a replace upload_id cannot finish a panel upload, nor another file', async () => {
    const w = await world('rl-purpose');
    const l = await link(w);
    assert.equal((await put(l.path, 'x\n')).statusCode, 200);
    const other = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'other.csv', data: 'o\n' }, { space_id: w.open.id }));
    const otherId = other.json().document.id as string;
    const wrongFile = await replace(w, { page_id: otherId, base_version: 1, upload_id: l.uploadId });
    assert.equal(wrongFile.isError, true);
    assert.match(wrongFile.text, /Upload not found/);
    const panel = await callTool(app, w.token, 'kinote_upload_finish', { upload_id: l.uploadId, about: 'A budget.' });
    assert.equal(panel.isError, true);
    assert.match(panel.text, /Upload not found/);
  });

  test('a suspended workspace refuses the PUT', async () => {
    const w = await world('rl-suspended');
    const l = await link(w);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    const res = await put(l.path, 'x\n');
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'suspended');
  });

  test('open uploads are capped at 3 across panel and links', async () => {
    const w = await world('rl-open');
    const begin = await callTool(app, w.token, 'kinote_upload_begin', { name: 'a.txt', size: 3, mime: 'text/plain' });
    assert.equal(begin.isError, false, begin.text);
    await link(w);
    const other = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'b.csv', data: 'b\n' }, { space_id: w.open.id }));
    await link({ ...w, fileId: other.json().document.id });
    const third = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'c.csv', data: 'c\n' }, { space_id: w.open.id }));
    const fourth = await replace(w, { page_id: third.json().document.id, base_version: 1 });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /Finish or cancel another upload first/);
  });
});
