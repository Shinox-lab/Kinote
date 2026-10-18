import {
  withTenantTx,
  claimJobs,
  completeJob,
  failJob,
  tenantsWithDueJobs,
  NonRetryableError,
  type Job,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '@living-wiki/core';
import { handlers as defaultHandlers, type JobHandler } from './registry.js';

/** Seconds a claimed job stays leased before another worker may reclaim it. */
export const LEASE_SECONDS = 300;
const DEFAULT_LIMIT = 10;
/** Passes per tenant run: jobs enqueue jobs (page.snapshot -> version.index). */
const MAX_PASSES = 5;

export interface RunnerOptions {
  now?: Date;
  limit?: number;
  embeddingProvider?: EmbeddingProvider;
  /** Overrides the queue registry (tests). */
  handlers?: Record<string, JobHandler>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** NonRetryableError and client-side AppErrors (status < 500) can never succeed on retry. */
function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof AppError && err.statusCode < 500) return false;
  return true;
}

/**
 * Runs one tenant's due jobs. Each pass claims a batch in its own committed
 * transaction, runs every handler outside it, then records the outcome in a
 * new transaction. A job that lands in the dead-letter list gets its handler's
 * `onDeadLetter` called once.
 */
export async function runPendingJobsForTenant(
  tenantId: string,
  o: RunnerOptions = {}
): Promise<Array<{ id: string; queue: string; status: string }>> {
  const registry = o.handlers ?? defaultHandlers;
  const embeddingProvider = o.embeddingProvider ?? defaultEmbeddingProvider;
  const limit = o.limit ?? DEFAULT_LIMIT;
  const processed: Array<{ id: string; queue: string; status: string }> = [];

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const now = o.now ?? new Date();
    const claimed = await withTenantTx(tenantId, (tx) =>
      claimJobs(tx, tenantId, { now, limit, leaseSeconds: LEASE_SECONDS })
    );
    if (claimed.length === 0) break;

    for (const job of claimed) {
      const status = await runOne(tenantId, job, registry, { now, embeddingProvider });
      processed.push({ id: job.id, queue: job.queue, status });
    }
  }

  return processed;
}

async function runOne(
  tenantId: string,
  job: Job,
  registry: Record<string, JobHandler>,
  ctx: { now: Date; embeddingProvider: EmbeddingProvider }
): Promise<string> {
  const handler = registry[job.queue];
  try {
    if (!handler) throw new NonRetryableError(`No handler registered for queue "${job.queue}"`);
    await handler.run(job, ctx);
  } catch (err) {
    const message = errorMessage(err);
    const { status } = await withTenantTx(tenantId, (tx) =>
      failJob(tx, tenantId, job.id, { message, retryable: isRetryable(err), now: ctx.now })
    );
    if (status === 'dead_letter') {
      console.error(`[worker] job ${job.id} (${job.queue}) dead-lettered: ${message}`);
      if (handler?.onDeadLetter) {
        try {
          await handler.onDeadLetter(job, message);
        } catch (hookErr) {
          console.error(`[worker] onDeadLetter for job ${job.id} failed:`, errorMessage(hookErr));
        }
      }
    }
    return status;
  }
  const { status } = await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, job.id));
  return status;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls for tenants with due jobs every `intervalMs` and runs each tenant's
 * jobs until `signal` aborts. A failing tenant run is logged and does not stop
 * the loop; the run in progress finishes before the loop returns.
 */
export async function runWorkerLoop(o: {
  intervalMs: number;
  signal: AbortSignal;
  embeddingProvider?: EmbeddingProvider;
  handlers?: Record<string, JobHandler>;
}): Promise<void> {
  while (!o.signal.aborted) {
    let tenantIds: string[] = [];
    try {
      tenantIds = await tenantsWithDueJobs(new Date(), LEASE_SECONDS);
    } catch (err) {
      console.error('[worker] polling for due jobs failed:', errorMessage(err));
    }
    for (const tenantId of tenantIds) {
      if (o.signal.aborted) break;
      try {
        await runPendingJobsForTenant(tenantId, {
          embeddingProvider: o.embeddingProvider,
          handlers: o.handlers,
        });
      } catch (err) {
        console.error(`[worker] running jobs for tenant ${tenantId} failed:`, errorMessage(err));
      }
    }
    await sleep(o.intervalMs, o.signal);
  }
}
