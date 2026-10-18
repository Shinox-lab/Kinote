import { and, eq } from 'drizzle-orm';
import { withTenantTx, versions, storableMessage, type Job } from '@living-wiki/db';
import { ERROR_SENTENCES } from '@living-wiki/contracts';
import { takePageSnapshot, indexVersion, type EmbeddingProvider } from '@living-wiki/core';

/** Longest `versions.error` stored for a failed version. */
const MAX_VERSION_ERROR_LENGTH = 500;

/** Contract sentences that promise an automatic retry (wrong once a job is dead-lettered). */
const RETRY_SENTENCES = Object.values(ERROR_SENTENCES).filter((s) =>
  s.includes('retry automatically')
);

/**
 * The failure detail for a dead-lettered job's error text: a leading
 * "will retry automatically" contract sentence is dropped in favour of the
 * cause the runner appended (` (cause: ...)`), or kept without the retry
 * promise when there is no cause.
 */
function failureDetail(error: string): string {
  for (const sentence of RETRY_SENTENCES) {
    if (!error.startsWith(sentence)) continue;
    const rest = error.slice(sentence.length);
    const cause = /^ \(cause: ([\s\S]*)\)$/.exec(rest);
    if (cause) return cause[1]!;
    return sentence.split(';')[0]!.trim() + rest;
  }
  return error;
}

/** `versions.error` for a version whose index job dead-lettered after `attempts` attempts. */
export function failedVersionError(attempts: number, error: string): string {
  const text = `Indexing failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${failureDetail(error)}`;
  return storableMessage(text).slice(0, MAX_VERSION_ERROR_LENGTH);
}

export interface JobContext {
  now: Date;
  embeddingProvider: EmbeddingProvider;
}

/**
 * A queue's handler. `run` must be idempotent: a job can run again after a
 * crash (lease expiry) or a retry. Throw `NonRetryableError` (or an `AppError`
 * below 500) for failures that can never succeed. `onDeadLetter` is called once
 * when the job lands in the dead-letter list.
 */
export interface JobHandler {
  run(job: Job, ctx: JobContext): Promise<void>;
  onDeadLetter?(job: Job, error: string): Promise<void>;
}

export const handlers: Record<string, JobHandler> = {
  'page.snapshot': {
    async run(job) {
      const payload = job.payload as {
        pageId: string;
        reason?: Parameters<typeof takePageSnapshot>[0]['reason'];
        actorType?: 'user' | 'agent';
        actorId: string;
      };
      await takePageSnapshot({
        tenantId: job.tenantId,
        pageId: payload.pageId,
        reason: payload.reason ?? 'quiet',
        actorType: payload.actorType ?? 'user',
        actorId: payload.actorId,
        manual: false,
      });
    },
  },
  'version.index': {
    async run(job, ctx) {
      const payload = job.payload as { versionId: string };
      const result = await indexVersion(
        { tenantId: job.tenantId, versionId: payload.versionId },
        ctx.embeddingProvider
      );
      if (result.outcome === 'skipped') {
        console.warn(
          `[worker] version.index: version ${payload.versionId} not indexed (skipped: ${result.reason})`
        );
      }
    },
    /**
     * Marks the version `failed` with a neutral error text ("Indexing failed
     * after N attempts: <cause>", NUL-free, at most 500 characters), only while it is
     * still `indexing`: a version withdrawn, superseded or indexed meanwhile
     * keeps its status. A retry (POST /versions/:id/retry) revives it.
     */
    async onDeadLetter(job, error) {
      const payload = job.payload as { versionId?: unknown };
      if (typeof payload?.versionId !== 'string') return;
      const versionId = payload.versionId;
      await withTenantTx(job.tenantId, (tx) =>
        tx
          .update(versions)
          .set({ status: 'failed', error: failedVersionError(job.attempts, error) })
          .where(
            and(
              eq(versions.tenantId, job.tenantId),
              eq(versions.id, versionId),
              eq(versions.status, 'indexing')
            )
          )
      );
    },
  },
};
