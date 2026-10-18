import { and, eq } from 'drizzle-orm';
import { withTenantTx, jobs, markJobOutcome } from '@living-wiki/db';
import {
  takePageSnapshot,
  indexVersion,
  defaultEmbeddingProvider,
  type EmbeddingProvider,
} from '@living-wiki/core';

export async function runPendingJobsForTenant(
  tenantId: string,
  options: { now?: Date; embeddingProvider?: EmbeddingProvider } = {}
) {
  const now = options.now ?? new Date();
  const provider = options.embeddingProvider ?? defaultEmbeddingProvider;
  const processed: Array<{ id: string; queue: string; status: string }> = [];

  // Process jobs iteratively because page.snapshot can enqueue version.index
  for (let pass = 0; pass < 5; pass++) {
    const queuedJobs = await withTenantTx(tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, 'queued')));
      return rows.filter((j) => j.runAt <= now);
    });

    if (queuedJobs.length === 0) break;

    for (const job of queuedJobs) {
      try {
        if (job.queue === 'page.snapshot') {
          const payload = job.payload as any;
          await takePageSnapshot({
            tenantId,
            pageId: payload.pageId,
            reason: payload.reason ?? 'quiet',
            actorType: payload.actorType ?? 'user',
            actorId: payload.actorId,
            manual: false,
          });
        } else if (job.queue === 'version.index') {
          const payload = job.payload as any;
          await indexVersion({ tenantId, versionId: payload.versionId }, provider);
        }

        const updated = await withTenantTx(tenantId, (tx) =>
          markJobOutcome(tx, tenantId, job.id, { ok: true })
        );
        if (updated) {
          processed.push({ id: updated.id, queue: updated.queue, status: updated.status });
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        const updated = await withTenantTx(tenantId, (tx) =>
          markJobOutcome(tx, tenantId, job.id, { ok: false, error: message })
        );
        if (updated) {
          processed.push({ id: updated.id, queue: updated.queue, status: updated.status });
        }
      }
    }
  }

  return processed;
}
