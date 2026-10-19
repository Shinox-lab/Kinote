import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { versions, withTenantTx } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { computeFileBadge, fileAttention, type FileBadgeInput } from '../src/pages/badge.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

const input = (over: Partial<FileBadgeInput> = {}): FileBadgeInput => ({
  latestVersion: { number: 1, status: 'indexed', hasText: true },
  indexedVersion: { number: 1 },
  sourceDeleted: false,
  placement: 'pinned',
  ...over,
});
const latest = (status: string, number = 2, hasText = true) => ({ latestVersion: { number, status, hasText } });

describe('computeFileBadge and fileAttention', () => {
  const cases: Array<[string, FileBadgeInput, string, 'failed' | 'review' | null]> = [
    ['indexed', input(), 'Indexed · v1', null],
    ['reading its text', input({ ...latest('extracting', 1), indexedVersion: null }), 'Reading text…', null],
    ['indexing', input({ ...latest('indexing', 1), indexedVersion: null }), 'Indexing…', null],
    ['new file awaiting approval', input({ ...latest('pending_review', 1), indexedVersion: null }), 'Not indexed (awaiting approval)', 'review'],
    ['replacement awaiting approval', input(latest('pending_review')), 'Indexed · v1, v2 awaiting approval', 'review'],
    ['new file rejected', input({ ...latest('rejected', 1), indexedVersion: null }), 'Not indexed · v1 rejected', null],
    ['replacement rejected', input(latest('rejected')), 'Indexed · v1, v2 rejected', null],
    ['extraction failed', input({ ...latest('failed', 1, false), indexedVersion: null }), 'Extraction failed', 'failed'],
    ['indexing failed', input({ ...latest('failed', 1, true), indexedVersion: null }), 'Index failed', 'failed'],
    ['replacement failed', input(latest('failed', 2, true)), 'Index failed', 'failed'],
    ['withdrawn', input({ ...latest('withdrawn', 1), indexedVersion: null }), 'Withdrawn', null],
    ['stored without text', input({ ...latest('stored', 1, false), indexedVersion: null }), 'Stored · no searchable text', null],
    ['superseded latest with an indexed version', input(latest('superseded')), 'Indexed · v1', null],
    ['removed at source (synced)', input({ sourceDeleted: true, placement: 'synced' }), 'Removed at source', null],
    ['source deleted but pinned stays withdrawn', input({ ...latest('withdrawn', 1), indexedVersion: null, sourceDeleted: true, placement: 'pinned' }), 'Withdrawn', null],
    ['no versions at all', input({ latestVersion: null, indexedVersion: null }), 'Not indexed', null],
  ];
  test.each(cases)('%s', (_name, given, badge, dot) => {
    assert.equal(computeFileBadge(given), badge);
    assert.equal(fileAttention(given), dot);
  });
});

describe('file status in the tree, the review queue and updates', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });

  async function setup() {
    const { tenant, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Status Co', slug: 'status-co' });
    const mk = async (name: string, review: boolean) =>
      (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name, slug: name.toLowerCase(), review_required: review } })).json();
    const open = await mk('Open', false);
    const strict = await mk('Strict', true);
    const author = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    const bystander = await signUpMember(app, tenant.id, 'member');
    for (const [space, user, role] of [
      [open, author, 'editor'], [strict, author, 'editor'], [strict, reviewer, 'reviewer'], [open, reviewer, 'viewer'],
    ] as const) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/spaces/${space.id}/grants`, headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: user.userId, role },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    return { tenant, inboxSpace, ownerHeaders, open, strict, author, reviewer, bystander };
  }
  async function upload(headers: Record<string, string>, spaceId: string | undefined, name: string, data: string) {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data }, spaceId ? { space_id: spaceId } : {}));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  const nodeFor = async (headers: Record<string, string>, spaceId: string, id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/spaces/${spaceId}/tree`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().nodes.find((n: { id: string }) => n.id === id);
  };

  test('tree dots: review while it waits, failed when it fails, none when indexed or archived', async () => {
    const c = await setup();
    const waiting = await upload(c.author.headers, c.strict.id, 'waiting.txt', 'wait for approval');
    const indexed = await upload(c.author.headers, c.open.id, 'indexed.txt', 'indexed text here');
    await settle(c.tenant.id);
    assert.deepEqual(
      { kind: (await nodeFor(c.author.headers, c.strict.id, waiting.document.id)).kind, attention: (await nodeFor(c.author.headers, c.strict.id, waiting.document.id)).attention },
      { kind: 'file', attention: 'review' }
    );
    assert.equal((await nodeFor(c.author.headers, c.open.id, indexed.document.id)).attention, null);

    await withTenantTx(c.tenant.id, (tx) => tx.update(versions).set({ status: 'failed' }).where(eq(versions.id, indexed.version.id)));
    assert.equal((await nodeFor(c.author.headers, c.open.id, indexed.document.id)).attention, 'failed');

    const archived = await app.inject({ method: 'POST', url: `/api/v1/files/${indexed.document.id}/archive`, headers: c.ownerHeaders });
    assert.equal(archived.statusCode, 200, archived.body);
    const archivedTree = await app.inject({ method: 'GET', url: `/api/v1/spaces/${c.open.id}/archived`, headers: c.ownerHeaders });
    assert.equal(archivedTree.json().nodes[0].attention, null);
  });

  test('the review queue lists a file with its kind and file facts, and approving it indexes it', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.strict.id, 'contract.txt', 'The contract renews each year.');
    await settle(c.tenant.id);
    const queue = await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: c.reviewer.headers });
    assert.equal(queue.statusCode, 200, queue.body);
    const [item] = queue.json();
    assert.equal(item.document.kind, 'file');
    assert.equal(item.document.id, up.document.id);
    assert.deepEqual(item.file, { fileName: 'contract.txt', mimeType: 'text/plain', sizeBytes: 30 });
    assert.equal(item.version.status, 'pending_review');
    assert.equal(item.canApprove, true);

    const approved = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/approve`, headers: c.reviewer.headers, payload: {} });
    assert.equal(approved.statusCode, 200, approved.body);
    await settle(c.tenant.id);
    assert.equal((await nodeFor(c.author.headers, c.strict.id, up.document.id)).attention, null);
  });

  test('a page in the queue says kind page and has no file block', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.author.headers,
      payload: { space_id: c.strict.id, title: 'A page', slug: 'a-page', markdown: 'page text here' },
    });
    await app.inject({ method: 'POST', url: `/api/v1/pages/${page.json().id}/snapshot`, headers: c.author.headers });
    const [item] = (await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: c.reviewer.headers })).json();
    assert.equal(item.document.kind, 'page');
    assert.equal(item.file, null);
  });

  test('another member\'s Inbox file never reaches a reviewer\'s queue or an update feed', async () => {
    const c = await setup();
    await upload(c.author.headers, undefined, 'private.txt', 'only for the author');
    await settle(c.tenant.id);
    const feed = await app.inject({ method: 'GET', url: '/api/v1/updates', headers: c.bystander.headers });
    assert.deepEqual(feed.json(), []);
    const own = await app.inject({ method: 'GET', url: '/api/v1/updates', headers: c.author.headers });
    assert.equal(own.json().length, 1);
    assert.equal(own.json()[0].document.kind, 'file');
    const admin = await app.inject({ method: 'GET', url: '/api/v1/updates', headers: c.ownerHeaders });
    assert.equal(admin.json().length, 1);
  });

  test('updates list an indexed upload as a file', async () => {
    const c = await setup();
    await upload(c.author.headers, c.open.id, 'notes.txt', 'some notes to index');
    await settle(c.tenant.id);
    const feed = (await app.inject({ method: 'GET', url: '/api/v1/updates', headers: c.author.headers })).json();
    assert.deepEqual(feed.map((u: { document: { kind: string }; status: string }) => [u.document.kind, u.status]), [['file', 'indexed']]);
  });
});
