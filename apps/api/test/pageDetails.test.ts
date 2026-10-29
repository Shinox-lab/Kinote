import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@kinote/db';
import { VersionSummarySchema } from '@kinote/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import { buildTestApp, bootstrapTenant, useTestDb } from './support/testkit.js';

const VERSION_SUMMARY_KEYS = [
  'createdAt',
  'createdBy',
  'createdByType',
  'error',
  'id',
  'indexedAt',
  'number',
  'reason',
  'reviewNote',
  'reviewedAt',
  'reviewedBy',
  'status',
].sort();

/**
 * GET /api/v1/pages/:id returns versions as light summaries: no markdown,
 * blocks or Yjs snapshot per version.
 */
describe('GET /api/v1/pages/:id version payload', () => {
  const app = buildTestApp();
  useTestDb();

  test('versions, latestVersion and indexedVersion carry exactly the VersionSummary keys', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Details Co', slug: 'details-co' });
    const spaceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers,
      payload: { name: 'open', slug: 'open', review_required: false },
    });
    assert.equal(spaceRes.statusCode, 201, spaceRes.body);
    const spaceId = spaceRes.json().id as string;

    const pageRes = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers,
      payload: { space_id: spaceId, title: 'Details', slug: 'details', markdown: 'Version one body.' },
    });
    assert.equal(pageRes.statusCode, 201, pageRes.body);
    const pageId = pageRes.json().id as string;

    const s1 = await app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers });
    assert.equal(s1.statusCode, 201, s1.body);
    await runPendingJobsForTenant(tenant.id);

    const state = await encodePageYDoc('Details', 'Version two body.');
    await withTenantTx(tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: state, liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, tenant.id), eq(pages.documentId, pageId)))
    );
    const s2 = await app.inject({ method: 'POST', url: `/api/v1/pages/${pageId}/snapshot`, headers });
    assert.equal(s2.statusCode, 201, s2.body);

    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    assert.equal(body.versions.length, 2);
    assert.equal(body.versions[0].number, 2);
    assert.equal(body.latestVersion.number, 2);
    assert.equal(body.indexedVersion.number, 1);

    assert.deepEqual(Object.keys(body.versions[0]).sort(), VERSION_SUMMARY_KEYS);
    assert.deepEqual(Object.keys(body.versions[1]).sort(), VERSION_SUMMARY_KEYS);
    assert.deepEqual(Object.keys(body.latestVersion).sort(), VERSION_SUMMARY_KEYS);
    assert.deepEqual(Object.keys(body.indexedVersion).sort(), VERSION_SUMMARY_KEYS);

    // The payload parses as the published contract.
    VersionSummarySchema.parse(body.versions[0]);
    VersionSummarySchema.parse(body.indexedVersion);
    assert.equal(body.indexedVersion.status, 'indexed');
    assert.equal(typeof body.indexedVersion.indexedAt, 'string');
  });
});
