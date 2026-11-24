import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { agentTokens, agents, auditEvents, spaceGrants, tenantBilling, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage, getCollabTokenSecret, signAgentLink } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { linkUrl } from '../src/mcp/links.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, publishPage, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const NAME = 'Q3 \'final\' (v2) 报告.csv';
const CSV = 'a,b\n1,2\n';

/** GET /api/v1/agent-files/:token: an agent's signed download link, re-checked on every fetch. */
describe('agent download links', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });

  async function setup(w?: AgentWorld) {
    const world = w ?? (await agentWorld(app, 'links'));
    const res = await app.inject(uploadRequest('/api/v1/files', world.ownerHeaders, { name: NAME, data: CSV }, { space_id: world.open.id }));
    assert.equal(res.statusCode, 201, res.body);
    await runPendingJobsForTenant(world.tenant.id, { storage, extractor: new FakeExtractor() });
    const up = res.json() as { document: { id: string }; version: { id: string } };
    const sign = (claims: object = { kind: 'file', versionId: up.version.id }, now?: Date) =>
      signAgentLink('agent-file', { tenantId: world.tenant.id, agentId: world.agentId, tokenId: world.tokenId, ...claims } as never, getCollabTokenSecret(), now).token;
    return { w: world, up, sign };
  }
  const fetch = (token: string) => app.inject({ method: 'GET', url: `/api/v1/agent-files/${token}` });

  test('a file link streams the version with download headers', async () => {
    const { w, up, sign } = await setup();
    const res = await fetch(sign());
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, CSV);
    const enc = encodeURIComponent(NAME).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${enc}`);
    assert.equal(res.headers['content-security-policy'], 'sandbox');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['etag'], `"${createHash('sha256').update(CSV).digest('hex')}"`);
    const rows = await withTenantTx(w.tenant.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.type, 'mcp.link_fetch')));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actorId, w.agentId);
    assert.deepEqual(rows[0]!.payload, { tokenId: w.tokenId, versionId: up.version.id });
  });

  test('a page link returns Markdown named <title>.md', async () => {
    const { w, sign } = await setup();
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Tool guide', 'Install it first.');
    const res = await fetch(sign({ kind: 'page', documentId: id, versionId: null }));
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['content-type']), /^text\/markdown/);
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''Tool%20guide.md`);
    assert.ok(res.body.startsWith('# Tool guide\n\n'), res.body);
    assert.ok(res.body.includes('Install it first.'));
  });

  test('expired, tampered, revoked token, disabled agent and removed grant all answer 404', async () => {
    const { w, sign } = await setup();
    const expect404 = async (token: string, why: string) => {
      const res = await fetch(token);
      assert.equal(res.statusCode, 404, why);
      return res.body;
    };
    const bodies = new Set<string>();
    bodies.add(await expect404(sign(undefined, new Date(Date.now() - 16 * 60_000)), 'expired'));
    bodies.add(await expect404(`${sign().slice(0, -3)}abc`, 'tampered'));
    bodies.add(await expect404(sign({ kind: 'file', versionId: '11111111-1111-4111-8111-111111111111' }), 'unknown version'));

    const good = sign();
    await withTenantTx(w.tenant.id, (tx) => tx.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, w.tokenId)));
    bodies.add(await expect404(good, 'revoked'));
    await withTenantTx(w.tenant.id, (tx) => tx.update(agentTokens).set({ revokedAt: null }).where(eq(agentTokens.id, w.tokenId)));
    assert.equal((await fetch(good)).statusCode, 200, 'restored');

    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ disabledAt: new Date() }).where(eq(agents.id, w.agentId)));
    bodies.add(await expect404(good, 'disabled'));
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ disabledAt: null }).where(eq(agents.id, w.agentId)));

    await withTenantTx(w.tenant.id, (tx) =>
      tx.delete(spaceGrants).where(and(eq(spaceGrants.spaceId, w.open.id), eq(spaceGrants.principalId, w.agentId)))
    );
    bodies.add(await expect404(good, 'grant removed'));
    assert.equal(bodies.size, 1, 'every refusal looks the same');
  });

  test('a suspended workspace still downloads', async () => {
    const { w, sign } = await setup();
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    assert.equal((await fetch(sign())).statusCode, 200);
  });

  test('linkUrl joins PUBLIC_URL with a trailing slash or sub-path', () => {
    assert.equal(linkUrl('https://x.example/kinote/', 'agent-files', 't'), 'https://x.example/kinote/api/v1/agent-files/t');
    assert.equal(linkUrl('https://x.example', 'agent-uploads', 't'), 'https://x.example/api/v1/agent-uploads/t');
    assert.equal(linkUrl('https://x.example//', 'agent-files', 't'), 'https://x.example/api/v1/agent-files/t');
  });
});
