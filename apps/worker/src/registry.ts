import type { Job } from '@living-wiki/db';
import { takePageSnapshot, indexVersion, type EmbeddingProvider } from '@living-wiki/core';

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
      await indexVersion({ tenantId: job.tenantId, versionId: payload.versionId }, ctx.embeddingProvider);
    },
    // Marking the version failed on dead letter is added in Task 3.4.
    async onDeadLetter() {},
  },
};
