import {
  withTenantTx,
  claimJobs,
  completeJob,
  failJob,
  releaseJobs,
  tenantsWithDueJobs,
  NonRetryableError,
  type Job,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import {
  defaultEmbeddingProvider,
  UnavailableExtractor,
  type EmbeddingProvider,
  type Extractor,
} from '@living-wiki/core';
import { InMemoryObjectStorage, type ObjectStorage } from '@living-wiki/shared';
import { handlers as defaultHandlers, type JobContext, type JobHandler } from './registry.js';

/** Seconds a claimed job stays leased before another worker may reclaim it. */
export const LEASE_SECONDS = 300;
const DEFAULT_LIMIT = 10;
/** Passes per tenant run: jobs enqueue jobs (page.snapshot -> version.index). */
const MAX_PASSES = 5;
const DEFAULT_MAX_EXTRACTED_CHARS = 2_000_000;

/** What every handler gets besides the time. */
type RunDeps = Omit<JobContext, 'now'>;

export interface RunnerOptions {
  /** Fixed time for every step (tests). Ignored when `clock` is given. */
  now?: Date;
  /** Time source read at each claim, handler start and failure (tests). Default: wall clock. */
  clock?: () => Date;
  limit?: number;
  embeddingProvider?: EmbeddingProvider;
  /** File bytes and extracted text. Default: an empty in-memory store (tests only). */
  storage?: ObjectStorage;
  /** Default: an extractor that is always unavailable. */
  extractor?: Extractor;
  /** Default 2 000 000 characters. */
  maxExtractedChars?: number;
  /** Overrides the queue registry (tests). */
  handlers?: Record<string, JobHandler>;
  /** Stops between jobs and passes; claimed jobs not yet started are released. */
  signal?: AbortSignal;
}

type Processed = { id: string; queue: string; status: string };

/** The error's message, followed by its `cause`'s message when it has one. */
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause === undefined || cause === null) return err.message;
  const causeText = cause instanceof Error ? cause.message : String(cause);
  return `${err.message} (cause: ${causeText})`;
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
 * new transaction guarded by the claim's lease. A job that lands in the
 * dead-letter list gets its handler's `onDeadLetter` called once. Result
 * statuses: `completed`, `queued` (retry or rerun), `dead_letter`, `lost` (the
 * lease expired and another worker reclaimed the job, nothing recorded),
 * `running` (recording the outcome failed; the lease expiry recovers it), or
 * `skipped_expired` (the job's lease ran out while earlier jobs of the batch
 * ran, so it was not started; it stays `running` for the expired-lease
 * reclaim). Jobs released on abort are not listed; dead-lettered rows of an
 * aborted batch are still notified and listed as `dead_letter`.
 */
export async function runPendingJobsForTenant(
  tenantId: string,
  o: RunnerOptions = {}
): Promise<Processed[]> {
  const registry = o.handlers ?? defaultHandlers;
  const deps: RunDeps = {
    embeddingProvider: o.embeddingProvider ?? defaultEmbeddingProvider,
    storage: o.storage ?? new InMemoryObjectStorage(),
    extractor: o.extractor ?? new UnavailableExtractor(),
    maxExtractedChars: o.maxExtractedChars ?? DEFAULT_MAX_EXTRACTED_CHARS,
  };
  const limit = o.limit ?? DEFAULT_LIMIT;
  const fixedNow = o.now;
  const clock = o.clock ?? (fixedNow ? () => fixedNow : () => new Date());
  const processed: Processed[] = [];

  for (let pass = 0; pass < MAX_PASSES && !o.signal?.aborted; pass++) {
    const claimed = await withTenantTx(tenantId, (tx) =>
      claimJobs(tx, tenantId, { now: clock(), limit, leaseSeconds: LEASE_SECONDS })
    );
    if (claimed.length === 0) break;

    for (let i = 0; i < claimed.length; i++) {
      const job = claimed[i]!;
      if (o.signal?.aborted) {
        const rest = claimed.slice(i);
        await releaseUnstarted(tenantId, rest);
        // claimJobs already dead-lettered these rows; nothing else will notify them.
        for (const dead of rest.filter((j) => j.status === 'dead_letter')) {
          const status = await notifyClaimDeadLetter(dead, registry);
          processed.push({ id: dead.id, queue: dead.queue, status });
        }
        return processed;
      }
      let status: string;
      if (job.status === 'dead_letter') {
        status = await notifyClaimDeadLetter(job, registry);
      } else if (leaseExpired(job, clock())) {
        // Earlier jobs in this batch outlived this job's lease: another worker
        // may already have reclaimed it. Leave it for the expired-lease reclaim.
        console.warn(
          `[worker] job ${job.id} (${job.queue}): lease expired before it started; left for reclaim`
        );
        status = 'skipped_expired';
      } else {
        status = await runOne(tenantId, job, registry, clock, deps);
      }
      processed.push({ id: job.id, queue: job.queue, status });
    }
  }

  return processed;
}

/** True when the claim's lease (`locked_at + LEASE_SECONDS`) is at or before `now`. */
function leaseExpired(job: Job, now: Date): boolean {
  return job.lockedAt !== null && now.getTime() >= job.lockedAt.getTime() + LEASE_SECONDS * 1000;
}

function notifyClaimDeadLetter(job: Job, registry: Record<string, JobHandler>): Promise<'dead_letter'> {
  return notifyDeadLetter(job, registry[job.queue], job.lastError ?? 'dead-lettered');
}

async function releaseUnstarted(tenantId: string, claimed: Job[]): Promise<void> {
  const running = claimed.filter((j) => j.status === 'running');
  try {
    await withTenantTx(tenantId, (tx) => releaseJobs(tx, tenantId, running));
  } catch (err) {
    console.error(`[worker] releasing ${running.length} claimed job(s) failed:`, errorMessage(err));
  }
}

async function notifyDeadLetter(
  job: Job,
  handler: JobHandler | undefined,
  message: string,
  thrown?: unknown
): Promise<'dead_letter'> {
  console.error(`[worker] job ${job.id} (${job.queue}) dead-lettered: ${message}`);
  if (handler?.onDeadLetter) {
    try {
      await handler.onDeadLetter(job, message, thrown);
    } catch (hookErr) {
      console.error(`[worker] onDeadLetter for job ${job.id} failed:`, errorMessage(hookErr));
    }
  }
  return 'dead_letter';
}

async function runOne(
  tenantId: string,
  job: Job,
  registry: Record<string, JobHandler>,
  clock: () => Date,
  deps: RunDeps
): Promise<string> {
  const handler = registry[job.queue];
  const lease = job.lockedAt ?? undefined;
  let failure: { err: unknown } | undefined;
  try {
    if (!handler) throw new NonRetryableError(`No handler registered for queue "${job.queue}"`);
    await handler.run(job, { now: clock(), ...deps });
  } catch (err) {
    failure = { err };
  }

  const message = failure ? errorMessage(failure.err) : '';
  let status: string;
  try {
    status = failure
      ? (
          await withTenantTx(tenantId, (tx) =>
            failJob(tx, tenantId, job.id, {
              message,
              retryable: isRetryable(failure.err),
              now: clock(),
              lease,
            })
          )
        ).status
      : (await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, job.id, { lease }))).status;
  } catch (err) {
    console.error(
      `[worker] recording the outcome of job ${job.id} (${job.queue}) failed; ` +
        `it stays running until its lease expires:`,
      errorMessage(err)
    );
    return 'running';
  }

  if (status === 'lost') {
    console.warn(
      `[worker] job ${job.id} (${job.queue}): lease lost to another worker; outcome not recorded`
    );
  } else if (status === 'dead_letter') {
    // The hook sees the row as failJob left it: the failing run counted.
    const deadJob: Job = {
      ...job,
      status: 'dead_letter',
      attempts: job.attempts + 1,
      lockedAt: null,
      lastError: message,
    };
    await notifyDeadLetter(deadJob, handler, message, failure?.err);
  }
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
  storage?: ObjectStorage;
  extractor?: Extractor;
  maxExtractedChars?: number;
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
          storage: o.storage,
          extractor: o.extractor,
          maxExtractedChars: o.maxExtractedChars,
          handlers: o.handlers,
          signal: o.signal,
        });
      } catch (err) {
        console.error(`[worker] running jobs for tenant ${tenantId} failed:`, errorMessage(err));
      }
    }
    await sleep(o.intervalMs, o.signal);
  }
}
