import { describe, test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versions, jobs, auditEvents, type Job } from '@living-wiki/db';
import {
  OpenAIEmbeddingProvider,
  UnavailableExtractor,
  type EmbeddingProvider,
} from '@living-wiki/core';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { handlers } from '../../worker/src/registry.js';
import { ERROR_SENTENCES } from '@living-wiki/contracts';
import {
  buildTestApp,
  bootstrapTenant,
  signUpMember,
  asUser,
  useTestDb,
} from './support/testkit.js';

/** An embedding provider whose service is always down, failing with `message`. */
function failingProvider(message: string): EmbeddingProvider {
  return {
    model: 'living-wiki-deterministic-2560-v1',
    dimensions: 2560,
    async embed() {
      throw new Error(message);
    },
  };
}
const brokenProvider = failingProvider('embedding service down');

async function loadVersion(tenantId: string, versionId: string) {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)))
  );
  return row!;
}

async function loadIndexJob(tenantId: string, versionId: string): Promise<Job> {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, 'version.index'),
          eq(jobs.idempotencyKey, `index:${versionId}`)
        )
      )
  );
  return row!;
}

/**
 * Runs the worker with the broken provider, advancing the clock by
 * 2**attempts + 1 seconds after each failure, until the index job dead-letters.
 */
async function runUntilDeadLetter(
  tenantId: string,
  versionId: string,
  provider: EmbeddingProvider = brokenProvider
): Promise<Job> {
  let t = Date.now();
  for (let i = 0; i < 20; i++) {
    await runPendingJobsForTenant(tenantId, {
      clock: () => new Date(t),
      embeddingProvider: provider,
    });
    const job = await loadIndexJob(tenantId, versionId);
    if (job.status === 'dead_letter') return job;
    t += (2 ** job.attempts + 1) * 1000;
  }
  throw new Error('index job never dead-lettered');
}

describe('failed versions and retry', () => {
  const app = buildTestApp();
  useTestDb();

  let ctx: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const { tenant, owner, headers: ownerHeaders } = await bootstrapTenant(app, {
      name: 'Retry Co',
      slug: 'retry-co',
    });
    const spaceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: ownerHeaders,
      payload: { name: 'Docs', slug: 'docs', review_required: false },
    });
    assert.equal(spaceRes.statusCode, 201, spaceRes.body);
    const space = spaceRes.json();

    const editor = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    const outsider = await signUpMember(app, tenant.id, 'member');
    for (const [uid, role] of [
      [editor.userId, 'editor'],
      [viewer.userId, 'viewer'],
    ] as const) {
      const granted = await app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${space.id}/grants`,
        headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: uid, role },
      });
      assert.equal(granted.statusCode, 201, granted.body);
    }

    const pageRes = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: editor.headers,
      payload: {
        space_id: space.id,
        title: 'Onboarding',
        slug: 'onboarding',
        markdown: '## Laptops\n\nEvery new hire receives a laptop on day one.',
      },
    });
    assert.equal(pageRes.statusCode, 201, pageRes.body);
    const pageId: string = pageRes.json().id;

    const snapRes = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${pageId}/snapshot`,
      headers: editor.headers,
    });
    assert.equal(snapRes.statusCode, 201, snapRes.body);
    const v1 = snapRes.json();
    assert.equal(v1.status, 'indexing');

    return { tenant, owner, ownerHeaders, space, editor, viewer, outsider, pageId, v1 };
  }

  async function badge(headers: Record<string, string>, pageId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${pageId}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().badge;
  }

  function retry(headers: Record<string, string>, versionId: string) {
    return app.inject({ method: 'POST', url: `/api/v1/versions/${versionId}/retry`, headers });
  }

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a dead-lettered index job fails the version; an editor retries it and it indexes once the provider recovers', async () => {
    const { tenant, editor, viewer, pageId, v1 } = ctx;

    const job = await runUntilDeadLetter(tenant.id, v1.id);
    assert.equal(job.attempts, 5);

    const failed = await loadVersion(tenant.id, v1.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error, 'failed version carries the error text');
    assert.ok(
      failed.error.startsWith('Indexing failed after 5 attempts:'),
      `neutral failure sentence, got ${JSON.stringify(failed.error)}`
    );
    assert.ok(failed.error.includes('embedding service down'), 'keeps the provider cause');
    assert.equal(failed.error.includes('retry automatically'), false, 'no retry promise');
    assert.equal(await badge(editor.headers, pageId), 'Index failed');

    // A space viewer may not retry.
    const viewerRes = await retry(viewer.headers, v1.id);
    assert.equal(viewerRes.statusCode, 403, viewerRes.body);
    assert.equal(viewerRes.json().error, 'forbidden');
    assert.equal((await loadVersion(tenant.id, v1.id)).status, 'failed');

    // An editor retries: the version is indexing again and the job is revived.
    const editorRes = await retry(editor.headers, v1.id);
    assert.equal(editorRes.statusCode, 200, editorRes.body);
    const body = editorRes.json();
    assert.equal(body.id, v1.id);
    assert.equal(body.documentId, pageId);
    assert.equal(body.number, 1);
    assert.equal(body.status, 'indexing');
    assert.equal(body.error, null);
    assert.equal('blocks' in body, false, 'no heavy columns in the reply');
    assert.equal('markdown' in body, false, 'no heavy columns in the reply');
    assert.equal('ydocSnapshot' in body, false, 'no heavy columns in the reply');

    const afterRetry = await loadVersion(tenant.id, v1.id);
    assert.equal(afterRetry.status, 'indexing');
    assert.equal(afterRetry.error, null);
    const revived = await loadIndexJob(tenant.id, v1.id);
    assert.equal(revived.id, job.id, 'the same keyed job is revived');
    assert.equal(revived.status, 'queued');
    assert.equal(revived.attempts, 0);

    const audit = await withTenantTx(tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.type, 'version.retried')))
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.subjectId, v1.id);
    assert.equal(audit[0]!.actorId, editor.userId);

    // The provider recovers and the worker runs.
    await runPendingJobsForTenant(tenant.id);
    assert.equal((await loadVersion(tenant.id, v1.id)).status, 'indexed');
    assert.equal(await badge(editor.headers, pageId), 'Indexed · v1');

    // Retrying an indexed version is refused.
    const again = await retry(editor.headers, v1.id);
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error, 'version_not_failed');
  });

  test('retry of a version in another tenant, an unknown or malformed id, or an unreadable space answers 404', async () => {
    const { tenant, outsider, v1 } = ctx;
    await runUntilDeadLetter(tenant.id, v1.id);

    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const crossTenant = await retry(other.headers, v1.id);
    assert.equal(crossTenant.statusCode, 404, crossTenant.body);
    assert.equal(crossTenant.json().error, 'version_not_found');

    const unknown = await retry(ctx.ownerHeaders, '00000000-0000-0000-0000-000000000042');
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error, 'version_not_found');

    const malformed = await retry(ctx.ownerHeaders, 'not-a-uuid');
    assert.equal(malformed.statusCode, 404);
    assert.equal(malformed.json().error, 'version_not_found');

    const unreadable = await retry(outsider.headers, v1.id);
    assert.equal(unreadable.statusCode, 404, unreadable.body);
    // Same code as an unknown version: the version's existence never leaks.
    assert.equal(unreadable.json().error, 'version_not_found');

    assert.equal((await loadVersion(tenant.id, v1.id)).status, 'failed');
  });

  test('an HTTP 401 keeps its neutral cause and does not promise a retry', async () => {
    const { tenant, v1 } = ctx;
    const provider = new OpenAIEmbeddingProvider({
      baseUrl: 'https://models.example/v1',
      model: 'test-model',
      batchSize: 64,
      timeoutMs: 1000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'bad key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const job = await runUntilDeadLetter(tenant.id, v1.id, provider);
    assert.equal(job.attempts, 5);

    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error ?? '', /401/);
    assert.equal(row.error!.includes('retry automatically'), false);
    assert.equal(row.error!.includes('bad key'), false);
  });

  test('a provider error containing NUL still ends with the version failed', async () => {
    const { tenant, v1 } = ctx;
    await runUntilDeadLetter(tenant.id, v1.id, failingProvider('bad\u0000byte from provider'));

    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.status, 'failed');
    assert.ok(row.error!.startsWith('Indexing failed after 5 attempts:'));
    assert.ok(row.error!.includes('badbyte from provider'), JSON.stringify(row.error));
    assert.equal(row.error!.includes('\u0000'), false);
  });

  test('onDeadLetter truncates the stored error to 500 characters', async () => {
    const { tenant, v1 } = ctx;
    const job = await loadIndexJob(tenant.id, v1.id);

    await handlers['version.index']!.onDeadLetter!(
      { ...job, attempts: 5 },
      `${ERROR_SENTENCES.embedding_unavailable} (cause: ${'x'.repeat(2000)})`
    );

    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error!.length, 500);
    assert.ok(row.error!.startsWith('Indexing failed after 5 attempts: xxx'));
  });

  test('an unexpected failure stores a generic sentence on the version; the detail stays in jobs.last_error', async () => {
    const { tenant, v1 } = ctx;
    // Not an AppError: the provider answers with the wrong number of vectors.
    const wrongCount: EmbeddingProvider = {
      model: 'living-wiki-deterministic-2560-v1',
      dimensions: 2560,
      async embed() {
        return [];
      },
    };
    const job = await runUntilDeadLetter(tenant.id, v1.id, wrongCount);
    assert.match(job.lastError ?? '', /embedding provider returned 0 vectors/);

    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.status, 'failed');
    assert.equal(
      row.error,
      `Indexing failed after 1 attempt: ${ERROR_SENTENCES.internal_error}`
    );
  });

  test('a raw database error text never reaches versions.error', async () => {
    const { tenant, v1 } = ctx;
    const job = await loadIndexJob(tenant.id, v1.id);
    await handlers['version.index']!.onDeadLetter!(
      { ...job, attempts: 5 },
      'Failed query: select * from chunks where tenant_id = $1\nparams: secret-value'
    );
    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.error, `Indexing failed after 5 attempts: ${ERROR_SENTENCES.internal_error}`);
  });

  test('onDeadLetter leaves a version that is no longer indexing alone', async () => {
    const { tenant, v1 } = ctx;
    await withTenantTx(tenant.id, (tx) =>
      tx
        .update(versions)
        .set({ status: 'withdrawn' })
        .where(and(eq(versions.tenantId, tenant.id), eq(versions.id, v1.id)))
    );
    const job = await loadIndexJob(tenant.id, v1.id);

    await handlers['version.index']!.onDeadLetter!(job, 'embedding service down');

    const row = await loadVersion(tenant.id, v1.id);
    assert.equal(row.status, 'withdrawn');
    assert.equal(row.error, null);
  });

  test('onDeadLetter only touches the version in the job tenant', async () => {
    const { tenant, v1 } = ctx;
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const job = await loadIndexJob(tenant.id, v1.id);

    await handlers['version.index']!.onDeadLetter!(
      { ...job, tenantId: other.tenant.id },
      'embedding service down'
    );

    assert.equal((await loadVersion(tenant.id, v1.id)).status, 'indexing');
  });

  test('the version.index handler logs a skipped indexVersion outcome', async () => {
    const { tenant, v1 } = ctx;
    await runPendingJobsForTenant(tenant.id);
    assert.equal((await loadVersion(tenant.id, v1.id)).status, 'indexed');
    const job = await loadIndexJob(tenant.id, v1.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handlers['version.index']!.run(job, {
      now: new Date(),
      embeddingProvider: brokenProvider,
      storage: new InMemoryObjectStorage(),
      extractor: new UnavailableExtractor(),
      maxExtractedChars: 1000,
    });

    const logged = warn.mock.calls.map((args) => args.join(' '));
    assert.ok(
      logged.some((line) => line.includes(v1.id) && line.includes('not_indexing')),
      `expected a skip log naming the version and reason, got ${JSON.stringify(logged)}`
    );
  });
});
