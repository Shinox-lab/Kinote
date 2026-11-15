import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { documents, pageCards, withTenantTx } from '@kinote/db';
import { defaultEmbeddingProvider } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InMemoryObjectStorage } from '@kinote/shared';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';
import { agentWorld, callTool, publishPage, type AgentWorld } from './support/mcpkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

describe('kinote_browse', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
  });

  const browse = (w: AgentWorld, args: object = {}) => callTool(app, w.token, 'kinote_browse', args);

  test('no arguments lists the granted spaces and not the Inbox or an ungranted space', async () => {
    const w = await agentWorld(app, 'browse-spaces');
    const a = await publishPage(app, w.ownerHeaders, w.open.id, 'Handbook', 'Welcome.');
    await publishPage(app, w.ownerHeaders, w.hidden.id, 'Secret plans', 'Hidden.');
    await publishPage(app, w.ownerHeaders, w.inboxSpace.id, 'My inbox note', 'Mine.');
    const res = await browse(w);
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^# Open\n/);
    assert.ok(res.text.includes(`- Handbook (${short(a)})`));
    assert.ok(res.text.includes('\n# Strict\n(no pages yet)'));
    assert.ok(!res.text.includes('Secret plans'));
    assert.ok(!res.text.includes('Hidden'));
    assert.ok(!res.text.includes('inbox note'));
  });

  test('depth 1 shows top-level pages with how many are below', async () => {
    const w = await agentWorld(app, 'browse-depth');
    const parent = await publishPage(app, w.ownerHeaders, w.open.id, 'Parent', 'P.');
    const child = await publishPage(app, w.ownerHeaders, w.open.id, 'Child', 'C.', parent);
    await publishPage(app, w.ownerHeaders, w.open.id, 'Grandchild', 'G.', child);
    const one = await browse(w, { space: 'Open', depth: 1 });
    assert.equal(one.text, `# Open\n- Parent (${short(parent)}) (2 below)`);
    const two = await browse(w, { space: 'Open' });
    assert.equal(two.text, `# Open\n- Parent (${short(parent)})\n  - Child (${short(child)}) (1 below)`);
    const four = await browse(w, { space: 'Open', depth: 4 });
    assert.match(four.text, /\n {4}- Grandchild \([0-9a-f]{8}\)$/);
  });

  test('a parent with 25 children shows 20 and says how many more', async () => {
    const w = await agentWorld(app, 'browse-many');
    const parent = await publishPage(app, w.ownerHeaders, w.open.id, 'Index', 'I.');
    for (let i = 0; i < 25; i++) await publishPage(app, w.ownerHeaders, w.open.id, `Item ${String(i).padStart(2, '0')}`, 'x', parent);
    const res = await browse(w, { space: 'Open' });
    assert.equal((res.text.match(/^ {2}- Item/gm) ?? []).length, 20);
    assert.ok(res.text.endsWith(`  … 5 more under Index (${short(parent)})`));
  });

  test('a page with a card shows its first sentence, one without shows its title only', async () => {
    const w = await agentWorld(app, 'browse-cards');
    const carded = await publishPage(app, w.ownerHeaders, w.open.id, 'Carded', 'Laptops are issued on day one.');
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    const [card] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(pageCards).where(eq(pageCards.documentId, carded)));
    assert.ok(card, 'indexing built a card');
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(pageCards).set({ summary: `How laptops are issued. ${'More detail follows here. '.repeat(10)}` }).where(eq(pageCards.documentId, carded))
    );
    const bare = await publishPage(app, w.ownerHeaders, w.open.id, 'Bare', 'Not indexed yet.');
    const res = await browse(w, { space: 'Open' });
    assert.ok(res.text.split('\n').includes(`- Carded (${short(carded)}) — How laptops are issued.`), res.text);
    assert.ok(res.text.includes(`- Bare (${short(bare)})`) && !res.text.includes(`- Bare (${short(bare)}) —`));
    await withTenantTx(w.tenant.id, (tx) => tx.update(pageCards).set({ summary: 'x'.repeat(300) }).where(eq(pageCards.documentId, carded)));
    const long = await browse(w, { space: 'Open' });
    const line = long.text.split('\n').find((l) => l.includes('Carded'))!;
    assert.ok(line.endsWith('…'));
    assert.ok(line.split(' — ')[1]!.length <= 120);
  });

  test('under roots the tree at a page', async () => {
    const w = await agentWorld(app, 'browse-under');
    const a = await publishPage(app, w.ownerHeaders, w.open.id, 'Area', 'A.');
    const b = await publishPage(app, w.ownerHeaders, w.open.id, 'Branch', 'B.', a);
    await publishPage(app, w.ownerHeaders, w.open.id, 'Elsewhere', 'E.');
    const res = await browse(w, { under: short(a) });
    assert.equal(res.text, `# Open › Area (${short(a)})\n- Branch (${short(b)})`);
    const hidden = await publishPage(app, w.ownerHeaders, w.hidden.id, 'No', 'N.');
    const refused = await browse(w, { under: hidden });
    assert.equal(refused.isError, true);
  });

  test('archived pages do not appear', async () => {
    const w = await agentWorld(app, 'browse-archived');
    const gone = await publishPage(app, w.ownerHeaders, w.open.id, 'Gone page', 'G.');
    await withTenantTx(w.tenant.id, (tx) => tx.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, gone)));
    const res = await browse(w, { space: 'Open' });
    assert.ok(!res.text.includes('Gone page'));
  });

  test('a file is marked [file]', async () => {
    app = buildTestApp({ storage: new InMemoryObjectStorage() });
    const w = await agentWorld(app, 'browse-file');
    const up = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'memo.txt', data: 'hello' }, { space_id: w.open.id }));
    assert.equal(up.statusCode, 201, up.body);
    const res = await browse(w, { space: 'Open' });
    assert.ok(res.text.includes(`- memo.txt (${short(up.json().document.id)}) [file]`), res.text);
  });
});
