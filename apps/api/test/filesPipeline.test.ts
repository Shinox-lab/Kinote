import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, rowsOf, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor, type Extractor } from '@kinote/core';
import { AppError } from '@kinote/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

/** The files slice, from upload to answer, through the real routes, the real worker and the real index. */
describe('files pipeline', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  let extractor: Extractor;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
    extractor = new FakeExtractor();
  });
  const settle = (tenantId: string, clock?: () => Date) => runPendingJobsForTenant(tenantId, { storage, extractor, clock });

  /** A "PDF" whose extracted pages are the given sentences. */
  const pdf = (...pages: string[]) =>
    `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({
      pageCount: pages.length,
      ocrUsed: false,
      sections: pages.map((text, i) => ({ headingPath: [], pageFrom: i + 1, pageTo: i + 1, kind: 'text', text })),
    })}`;

  async function setup() {
    const { tenant, headers: ownerHeaders, inboxSpace } = await bootstrapTenant(app, { name: 'Pipe Co', slug: 'pipe-co' });
    const mk = async (name: string, review: boolean) =>
      (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name, slug: name.toLowerCase(), review_required: review } })).json();
    const open = await mk('Open', false);
    const strict = await mk('Strict', true);
    const author = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    const grant = async (spaceId: string, userId: string, role: string) => {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/spaces/${spaceId}/grants`, headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: userId, role },
      });
      assert.equal(res.statusCode, 201, res.body);
    };
    await grant(open.id, author.userId, 'editor');
    await grant(strict.id, author.userId, 'reviewer'); // the author may review, but not their own work
    await grant(strict.id, reviewer.userId, 'reviewer');
    return { tenant, ownerHeaders, inboxSpace, open, strict, author, reviewer };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const upload = async (c: Ctx, spaceId: string | undefined, name: string, data: string | Uint8Array, headers = c.author.headers) => {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data }, spaceId ? { space_id: spaceId } : {}));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  };
  const replace = async (c: Ctx, fileId: string, name: string, data: string) => {
    const res = await app.inject(uploadRequest(`/api/v1/files/${fileId}/versions`, c.author.headers, { name, data }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { version: { id: string } };
  };
  const badge = async (c: Ctx, id: string) => (await app.inject({ method: 'GET', url: `/api/v1/files/${id}`, headers: c.author.headers })).json().badge as string;
  const search = async (c: Ctx, query: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: c.author.headers, payload: { query } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().passages as Array<{ documentId: string; versionId: string; text: string; pageFrom: number | null; documentKind: string }>;
  };
  const answering = async (c: Ctx, query: string, documentId: string) =>
    (await search(c, query)).filter((p) => p.documentId === documentId);

  test('upload → read → index → search → Ask, with the page of the hit', async () => {
    const c = await setup();
    const up = await upload(c, c.open.id, 'handbook.pdf', pdf('Staff accrue pomegranate leave.', 'Receipts are due within thirty days.'));
    assert.equal(await badge(c, up.document.id), 'Reading text…');
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1');
    const [hit] = await answering(c, 'receipts due thirty days', up.document.id);
    assert.deepEqual([hit!.documentKind, hit!.pageFrom], ['file', 2]);
    const ask = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: c.author.headers, payload: { question: 'pomegranate leave' } });
    assert.equal(ask.json().citations[0].pageFrom, 1);
  });

  test('a review space holds the file until a different person approves it', async () => {
    const c = await setup();
    const up = await upload(c, c.strict.id, 'contract.pdf', pdf('The contract renews every year on the first of March.'), c.reviewer.headers);
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Not indexed (awaiting approval)');
    assert.deepEqual(await answering(c, 'contract renews every year', up.document.id), []);

    const own = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/approve`, headers: c.reviewer.headers, payload: {} });
    assert.equal(own.statusCode, 409);
    assert.equal(own.json().error, 'self_approval');

    const approved = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/approve`, headers: c.author.headers, payload: {} });
    assert.equal(approved.statusCode, 200, approved.body);
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1');
    assert.equal((await answering(c, 'contract renews every year', up.document.id)).length, 1);
  });

  test('a replaced file keeps answering until its successor is indexed; reject and withdraw behave', async () => {
    const c = await setup();
    const up = await upload(c, c.open.id, 'rules.pdf', pdf('The old rule: zebra crossings are optional.'));
    await settle(c.tenant.id);
    assert.equal((await answering(c, 'old rule zebra crossings', up.document.id)).length, 1);

    const v2 = await replace(c, up.document.id, 'rules.pdf', pdf('The new rule: zebra crossings are mandatory.'));
    // v2 is uploaded but not yet read: v1 still answers, v2 does not.
    assert.match((await answering(c, 'zebra crossings optional', up.document.id))[0]!.text, /old rule/);
    assert.equal((await answering(c, 'new rule mandatory', up.document.id)).filter((p) => p.versionId === v2.version.id).length, 0);
    await settle(c.tenant.id);
    const after = await answering(c, 'zebra crossings', up.document.id);
    assert.deepEqual(new Set(after.map((p) => p.versionId)), new Set([v2.version.id]));
    assert.equal(await badge(c, up.document.id), 'Indexed · v2');
  });

  test('in a review space the old version answers while the new one waits, and after a reject', async () => {
    const c = await setup();
    const up = await upload(c, c.strict.id, 'rules.pdf', pdf('The old rule: lanterns are optional.'));
    await settle(c.tenant.id);
    await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/approve`, headers: c.reviewer.headers, payload: {} });
    await settle(c.tenant.id);
    assert.equal((await answering(c, 'old rule lanterns', up.document.id)).length, 1);

    const v2 = await replace(c, up.document.id, 'rules.pdf', pdf('The new rule: lanterns are mandatory.'));
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1, v2 awaiting approval');
    assert.match((await answering(c, 'rule lanterns', up.document.id))[0]!.text, /old rule/);

    const rejected = await app.inject({ method: 'POST', url: `/api/v1/versions/${v2.version.id}/reject`, headers: c.reviewer.headers, payload: { review_note: 'not yet' } });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1, v2 rejected');
    assert.match((await answering(c, 'rule lanterns', up.document.id))[0]!.text, /old rule/);

    const withdrawn = await app.inject({ method: 'POST', url: `/api/v1/files/${up.document.id}/withdraw`, headers: c.reviewer.headers });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.deepEqual(await answering(c, 'rule lanterns', up.document.id), []);
    // The rejected v2 is still the latest version; nothing is indexed.
    assert.equal(await badge(c, up.document.id), 'Not indexed · v2 rejected');
  });

  test('extraction down for the whole retry window fails the file; a retry recovers it with no re-upload', async () => {
    const c = await setup();
    let down = true;
    extractor = { extract: async (input) => { if (down) throw new AppError('extractor_unavailable'); return new FakeExtractor().extract(input); } };
    const up = await upload(c, c.open.id, 'scan.pdf', pdf('A scanned page about tangerines.'));
    let t = Date.now();
    for (let i = 0; i < 20; i++) {
      await settle(c.tenant.id, () => new Date(t));
      t += 40_000;
      if ((await badge(c, up.document.id)) === 'Extraction failed') break;
    }
    assert.equal(await badge(c, up.document.id), 'Extraction failed');
    down = false;
    const retry = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/retry`, headers: c.author.headers });
    assert.equal(retry.statusCode, 200, retry.body);
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1');
    assert.equal((await answering(c, 'scanned page tangerines', up.document.id)).length, 1);
  });

  test('another tenant sees nothing, storage refuses a foreign prefix, and SQL without a tenant sees no rows', async () => {
    const c = await setup();
    const up = await upload(c, c.open.id, 'secret.pdf', pdf('Only the first tenant may read about quinces.'));
    await settle(c.tenant.id);
    const other = await bootstrapTenant(app, { name: 'Rival Co', slug: 'rival-co', email: 'rival@example.test' });
    for (const url of [`/api/v1/files/${up.document.id}`, `/api/v1/files/${up.document.id}/versions`, `/api/v1/versions/${up.version.id}/file`, `/api/v1/versions/${up.version.id}/chunks`]) {
      assert.equal((await app.inject({ method: 'GET', url, headers: other.headers })).statusCode, 404, url);
    }
    const found = await app.inject({ method: 'POST', url: '/api/v1/search', headers: other.headers, payload: { query: 'quinces' } });
    assert.deepEqual(found.json().passages, []);
    const [row] = await withTenantTx(c.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, up.version.id)));
    await assert.rejects(storage.get(other.tenant.id, row!.objectKey!));
    const visible = rowsOf<{ n: string }>(await getDb().execute(sql`select count(*)::text as n from versions`));
    assert.equal(visible[0]!.n, '0');
  });

  test('audio is stored for download: no reading, no review, no search', async () => {
    const c = await setup();
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
    const up = await upload(c, c.strict.id, 'song.mp3', mp3);
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Stored · no searchable text');
    const queue = await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: c.reviewer.headers });
    assert.deepEqual(queue.json(), []);
    const download = await app.inject({ method: 'GET', url: `/api/v1/versions/${up.version.id}/file`, headers: c.author.headers });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(new Uint8Array(download.rawPayload), mp3);
    const inspector = await app.inject({ method: 'GET', url: `/api/v1/versions/${up.version.id}/chunks`, headers: c.author.headers });
    assert.equal(inspector.json().ready, false);
  });

  test('a replacement with no text leaves the old version answering and the badge says so', async () => {
    const c = await setup();
    const up = await upload(c, c.open.id, 'rules.pdf', pdf('The old rule about quinces stays in force.'));
    await settle(c.tenant.id);
    const v2 = await replace(c, up.document.id, 'rules.pdf', '%PDF-1.7\nFAKE-EXTRACT-EMPTY\n');
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Indexed · v1, v2 has no searchable text');
    assert.equal((await answering(c, 'old rule quinces', up.document.id)).length, 1);
    assert.equal((await withTenantTx(c.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, v2.version.id))))[0]!.status, 'stored');
  });

  test('withdrawing a stored file says Withdrawn', async () => {
    const c = await setup();
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
    const up = await upload(c, c.open.id, 'song.mp3', mp3);
    assert.equal(await badge(c, up.document.id), 'Stored · no searchable text');
    const res = await app.inject({ method: 'POST', url: `/api/v1/files/${up.document.id}/withdraw`, headers: c.ownerHeaders });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await badge(c, up.document.id), 'Withdrawn');
  });

  test('a file whose text cannot be read is stored with its reason, never indexed or queued', async () => {
    const c = await setup();
    const up = await upload(c, c.strict.id, 'blank.pdf', '%PDF-1.7\nFAKE-EXTRACT-EMPTY\n');
    await settle(c.tenant.id);
    assert.equal(await badge(c, up.document.id), 'Stored · no searchable text');
    const [row] = await withTenantTx(c.tenant.id, (tx) => tx.select().from(versions).where(and(eq(versions.id, up.version.id))));
    assert.equal(row!.error, 'No text could be read from this file.');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: c.reviewer.headers })).json(), []);
  });
});
