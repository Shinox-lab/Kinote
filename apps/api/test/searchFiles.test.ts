import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { AskResponseSchema, SearchResponseSchema } from '@living-wiki/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

describe('search and Ask over files', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });

  const TWO_PAGE_PDF = (() => {
    const sections = [
      { headingPath: ['Leave'], pageFrom: 1, pageTo: 1, kind: 'text', text: 'Staff accrue pomegranate days of annual leave each month.' },
      { headingPath: ['Expenses'], pageFrom: 2, pageTo: 2, kind: 'text', text: 'Receipts must be submitted within thirty days of travel.' },
    ];
    return `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({ pageCount: 2, ocrUsed: false, sections })}`;
  })();

  async function setup() {
    const { tenant, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Search Co', slug: 'search-co' });
    const space = (
      await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name: 'Docs', slug: 'docs', review_required: false } })
    ).json();
    const author = await signUpMember(app, tenant.id, 'member');
    const other = await signUpMember(app, tenant.id, 'member');
    const grant = await app.inject({
      method: 'POST', url: `/api/v1/spaces/${space.id}/grants`, headers: ownerHeaders,
      payload: { principal_type: 'user', principal_id: author.userId, role: 'editor' },
    });
    assert.equal(grant.statusCode, 201, grant.body);
    return { tenant, space, ownerHeaders, author, other };
  }
  const upload = async (headers: Record<string, string>, spaceId: string | undefined, name: string, data: string) => {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data }, spaceId ? { space_id: spaceId } : {}));
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  const search = async (headers: Record<string, string>, query: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers, payload: { query } });
    assert.equal(res.statusCode, 200, res.body);
    return SearchResponseSchema.parse(res.json()).passages;
  };

  test('a passage from a file names its page and says it is a file', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.space.id, 'handbook.pdf', TWO_PAGE_PDF);
    await settle(c.tenant.id);
    const [hit] = await search(c.author.headers, 'receipts submitted thirty days travel');
    assert.ok(hit, 'the second page is found');
    assert.equal(hit.documentId, up.document.id);
    assert.equal(hit.documentKind, 'file');
    assert.equal(hit.pageFrom, 2);
    assert.equal(hit.pageTo, 2);
    assert.deepEqual(hit.blockIds, []);
    assert.match(hit.citeAs, /^handbook\.pdf \(v1, updated \d{4}-\d{2}-\d{2}\)$/);
    assert.deepEqual(hit.headingPath, ['Expenses']);
  });

  test('a page passage says kind page and has no page numbers', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.author.headers,
      payload: { space_id: c.space.id, title: 'Policy', slug: 'policy', markdown: 'Laptops are replaced every four years.' },
    });
    await app.inject({ method: 'POST', url: `/api/v1/pages/${page.json().id}/snapshot`, headers: c.author.headers });
    await settle(c.tenant.id);
    const [hit] = await search(c.author.headers, 'laptops replaced every four years');
    assert.equal(hit.documentKind, 'page');
    assert.equal(hit.pageFrom, null);
    assert.equal(hit.pageTo, null);
    assert.ok(hit.blockIds.length > 0);
  });

  test('Ask cites the file with its page', async () => {
    const c = await setup();
    await upload(c.author.headers, c.space.id, 'handbook.pdf', TWO_PAGE_PDF);
    await settle(c.tenant.id);
    const res = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: c.author.headers, payload: { question: 'pomegranate days annual leave' } });
    assert.equal(res.statusCode, 200, res.body);
    const answer = AskResponseSchema.parse(res.json());
    assert.equal(answer.foundRelevant, true);
    const first = answer.citations[0]!;
    assert.deepEqual([first.documentKind, first.pageFrom, first.pageTo], ['file', 1, 1]);
  });

  test('a file in another member\'s Inbox and a withdrawn file never answer', async () => {
    const c = await setup();
    await upload(c.author.headers, undefined, 'private.pdf', TWO_PAGE_PDF);
    const shared = await upload(c.author.headers, c.space.id, 'shared.pdf', TWO_PAGE_PDF.replace('pomegranate', 'tangerine'));
    await settle(c.tenant.id);
    assert.deepEqual(await search(c.other.headers, 'pomegranate days'), []);
    assert.ok((await search(c.author.headers, 'pomegranate days')).length > 0);
    assert.ok((await search(c.ownerHeaders, 'pomegranate days')).length > 0);

    assert.ok((await search(c.author.headers, 'tangerine days')).length > 0);
    const withdrawn = await app.inject({ method: 'POST', url: `/api/v1/files/${shared.document.id}/withdraw`, headers: c.ownerHeaders });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.deepEqual(
      (await search(c.author.headers, 'tangerine days')).filter((p) => p.documentId === shared.document.id),
      []
    );
  });
});
