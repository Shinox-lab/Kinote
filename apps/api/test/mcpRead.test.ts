import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { pages, withTenantTx } from '@kinote/db';
import { encodeBlocksYDoc, FakeExtractor, markdownBlocks, readLiveBlocks } from '@kinote/core';
import { InMemoryObjectStorage, type CollabClient } from '@kinote/shared';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, publishPage, type AgentWorld } from './support/mcpkit.js';
import { uploadRequest } from './support/multipart.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

const PAGE = [
  'Intro line one has five words.',
  '## Setup',
  'Install the tool first.',
  '### Keys',
  'Create an API key.',
  '## Usage',
  'Run it daily.',
].join('\n\n');

describe('kinote_read', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;
  let storage: InMemoryObjectStorage;

  async function world(slug: string, collab?: CollabClient) {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage, ...(collab ? { collab } : {}) });
    return agentWorld(app, slug);
  }
  const index = (w: AgentWorld) => runPendingJobsForTenant(w.tenant.id, { storage, extractor: new FakeExtractor() });
  const read = (w: AgentWorld, args: object) => callTool(app, w.token, 'kinote_read', args);
  const live = (w: AgentWorld, id: string) => withTenantTx(w.tenant.id, (tx) => readLiveBlocks(tx, w.tenant.id, id));

  test('outline lists headings with ids and word counts, after a header with the status', async () => {
    const w = await world('read-outline');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Tool guide', PAGE);
    await index(w);
    const blocks = (await live(w, id))!.blocks;
    const headingId = (text: string) => short(blocks.find((b) => JSON.stringify(b.content).includes(text))!.id);
    const res = await read(w, { page_id: short(id) });
    assert.equal(res.isError, false, res.text);
    assert.equal(
      res.text,
      [
        `# Tool guide (${short(id)}) · Open · indexed v1`,
        'Intro: 6 words',
        `## Setup  [${headingId('Setup')}] 9 words`,
        `### Keys  [${headingId('Keys')}] 4 words`,
        `## Usage  [${headingId('Usage')}] 3 words`,
      ].join('\n')
    );
  });

  test('section returns only that section, nested headings included', async () => {
    const w = await world('read-section');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Tool guide', PAGE);
    await index(w);
    const setup = (await live(w, id))!.blocks.find((b) => JSON.stringify(b.content).includes('Setup'))!;
    const res = await read(w, { page_id: id, level: 'section', section_id: short(setup.id) });
    assert.equal(res.isError, false, res.text);
    assert.ok(res.text.includes(`<kinote:content page="${short(id)}">`));
    assert.ok(res.text.includes(`[${short(setup.id)}] ## Setup`));
    assert.ok(res.text.includes('Install the tool first.'));
    assert.ok(res.text.includes('Create an API key.'));
    assert.ok(!res.text.includes('Run it daily.'));
    assert.ok(!res.text.includes('Intro line'));
  });

  test('a section id that is not a heading says so', async () => {
    const w = await world('read-notheading');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Tool guide', PAGE);
    const para = (await live(w, id))!.blocks.find((b) => JSON.stringify(b.content).includes('Install'))!;
    const res = await read(w, { page_id: id, level: 'section', section_id: short(para.id) });
    assert.equal(res.isError, true);
    assert.equal(res.text, `"${short(para.id)}" is not a heading. Read level "outline" to find section IDs.`);
  });

  test('a 300-block page read in full through its cursors returns every block once, in order', async () => {
    const w = await world('read-cursor');
    const md = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}`).join('\n\n');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Long page', md);
    const expected = (await live(w, id))!.blocks.map((b) => short(b.id));
    assert.equal(expected.length, 300);
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const res = await read(w, { page_id: id, level: 'full', ...(cursor ? { cursor } : {}) });
      assert.equal(res.isError, false, res.text);
      assert.ok(res.text.length <= 6000 * 4, 'under the cap');
      for (const m of res.text.matchAll(/^\[([0-9a-f]{8})\] /gm)) seen.push(m[1]!);
      cursor = /More: call kinote_read with cursor "([A-Za-z0-9_-]+)"\.$/.exec(res.text)?.[1];
      calls++;
    } while (cursor && calls < 20);
    assert.ok(calls >= 2, 'the page needed more than one call');
    assert.deepEqual(seen, expected);
  });

  test('a cursor for another page or level is refused', async () => {
    const w = await world('read-badcursor');
    const md = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}`).join('\n\n');
    const a = await publishPage(app, w.ownerHeaders, w.open.id, 'Long page', md);
    const b = await publishPage(app, w.ownerHeaders, w.open.id, 'Other page', 'Short.');
    const first = await read(w, { page_id: a, level: 'full' });
    const cursor = /cursor "([A-Za-z0-9_-]+)"/.exec(first.text)![1]!;
    for (const args of [{ page_id: b, cursor }, { page_id: a, level: 'outline', cursor }, { page_id: a, level: 'full', cursor: 'garbage' }]) {
      const res = await read(w, args);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.equal(res.text, 'This cursor belongs to another read. Start again without a cursor.');
    }
  });

  test('a page with a change not yet indexed reports the live page ahead of the index', async () => {
    const w = await world('read-ahead');
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Policy', 'First text.');
    assert.match((await read(w, { page_id: id })).text, /· not indexed yet$/m);
    await index(w);
    const state = encodeBlocksYDoc('Policy', await markdownBlocks('Second text, changed.'));
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(pages).set({ ydocState: state }).where(and(eq(pages.tenantId, w.tenant.id), eq(pages.documentId, id)))
    );
    const snap = await app.inject({ method: 'POST', url: `/api/v1/pages/${id}/snapshot`, headers: w.ownerHeaders });
    assert.ok(snap.statusCode < 300, snap.body);
    const res = await read(w, { page_id: id, level: 'full' });
    assert.match(res.text, /· live page ahead of the index \(indexed v1, latest v2\)$/m);
    assert.ok(res.text.includes('Second text, changed.'), 'read shows the live page');
  });

  test('a file returns its extracted text', async () => {
    const w = await world('read-file');
    const pdf = `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({
      pageCount: 2,
      ocrUsed: false,
      sections: [
        { headingPath: [], pageFrom: 1, pageTo: 1, kind: 'text', text: 'Page one says hello.' },
        { headingPath: [], pageFrom: 2, pageTo: 2, kind: 'text', text: 'Page two says goodbye.' },
      ],
    })}`;
    const up = await app.inject(uploadRequest('/api/v1/files', w.ownerHeaders, { name: 'memo.pdf', data: pdf }, { space_id: w.open.id }));
    assert.equal(up.statusCode, 201, up.body);
    const fileId = up.json().document.id as string;
    await index(w);
    const res = await read(w, { page_id: fileId, level: 'outline' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, new RegExp(`^# memo\\.pdf \\(${short(fileId)}\\) · Open · indexed v1`));
    assert.ok(res.text.indexOf('Page one says hello.') < res.text.indexOf('Page two says goodbye.'));
    assert.ok(res.text.includes(`<kinote:content page="${short(fileId)}">`));
  });

  test('a page in an ungranted space gives the not-found text', async () => {
    const w = await world('read-hidden');
    const id = await publishPage(app, w.ownerHeaders, w.hidden.id, 'Secret', 'Nope.');
    const res = await read(w, { page_id: id });
    assert.equal(res.isError, true);
    assert.equal(res.text, `No page "${id}" that this agent can read. Use kinote_search or kinote_browse to find it.`);
  });

  test('flush is called once for full, and not for outline', async () => {
    const flushed: string[] = [];
    const stub: CollabClient = {
      async flush(name) {
        flushed.push(name);
      },
      async replaceBlocks() {},
      async applyBlockOps() {},
      async setTitle() {},
      async setFields() {},
      async revoke() {},
    };
    const w = await world('read-flush', stub);
    const id = await publishPage(app, w.ownerHeaders, w.open.id, 'Flushy', 'Body.');
    flushed.length = 0;
    await read(w, { page_id: id });
    assert.equal(flushed.length, 0);
    await read(w, { page_id: id, level: 'full' });
    assert.equal(flushed.length, 1);
    assert.ok(flushed[0]!.includes(id));
  });
});
