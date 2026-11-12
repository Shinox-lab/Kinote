import {
  withTenantTx,
  claimJobs,
  completeJob,
  failJob,
  releaseJobs,
  tenantsWithDueJobs,
  deleteExpiredCounters,
  chargeAiAction,
  enqueueJob,
  nextAiDay,
  readStanding,
  INDEX_QUEUES,
  NonRetryableError,
  type Job,
} from '@kinote/db';
import { AppError } from '@kinote/contracts';
import {
  defaultEmbeddingProvider,
  defaultPlacementModel,
  UnavailableExtractor,
  withUsageScope,
  indexHeld,
  type EmbeddingProvider,
  type Extractor,
  type ModelProviders,
  type RoutingModel,
} from '@kinote/core';
import { InMemoryObjectStorage, type CollabClient, type CreditRates, type ObjectStorage } from '@kinote/shared';
import { handlers as defaultHandlers, type JobContext, type JobHandler } from './registry.js';

/** The collab client when none is configured: every call fails, so a routing job retries. */
export const unavailableCollab: CollabClient = {
  async flush() {
    throw new AppError('internal_error');
  },
  async replaceBlocks() {
    throw new AppError('internal_error');
  },
  async applyBlockOps() {
    throw new AppError('internal_error');
  },
  async setTitle() {
    throw new AppError('internal_error');
  },
  async setFields() {
    throw new AppError('internal_error');
  },
  async revoke() {
    throw new AppError('internal_error');
  },
};

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
  /** Default: the deterministic placement model. */
  placementModel?: RoutingModel;
  /** Default: a client that refuses every call (routing captures needs a real one). */
  collab?: CollabClient;
  /** Overrides the queue registry (tests). */
  handlers?: Record<string, JobHandler>;
  /** Stops between jobs and passes; claimed jobs not yet started are released. */
  signal?: AbortSignal;
  /**
   * AI actions per workspace per UTC day (TENANT_DAILY_AI_ACTIONS). A job whose
   * handler `usesAi` beyond it waits for the next UTC day. Default 0: no allowance.
   */
  aiDailyLimit?: number;
  /** MODEL_CREDIT_RATES, parsed. Each job's model calls are metered; null charges 0 credits. */
  /** The rate table, or a getter read as each job runs (the live model settings). */
  creditRates?: CreditRates | null | (() => CreditRates | null);
  /**
   * The deployment's model settings. Each job first reloads them (one small read) and runs with the providers for
   * the models then in effect, fixed for the whole job: a job never embeds with a model the settings already left,
   * and never switches model halfway. Overrides embeddingProvider and placementModel.
   */
  models?: ModelProviders;
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
    placementModel: o.placementModel ?? defaultPlacementModel,
    collab: o.collab ?? unavailableCollab,
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
        const jobDeps = o.models ? await currentModels(o.models, deps) : deps;
        status = await runOne(tenantId, job, registry, clock, jobDeps, o.aiDailyLimit ?? 0, o.creditRates ?? null);
      }
      processed.push({ id: job.id, queue: job.queue, status });
    }
  }

  return processed;
}

/**
 * Charges one AI action for `job`'s workspace. Past today's allowance the job
 * is put back for the next UTC day (a rerun of the same job, as a busy capture
 * is) and true is returned: the run is over without calling the handler. An
 * unreadable counter lets the job run.
 */
async function deferredPastAllowance(job: Job, aiDailyLimit: number, now: Date): Promise<boolean> {
  let allowed = true;
  try {
    ({ allowed } = await chargeAiAction(job.tenantId, aiDailyLimit, now));
  } catch (err) {
    console.error(`[worker] AI allowance unavailable for job ${job.id}; running it:`, errorMessage(err));
    return false;
  }
  if (allowed) return false;
  const runAt = nextAiDay(now);
  await withTenantTx(job.tenantId, (tx) =>
    enqueueJob(tx, {
      tenantId: job.tenantId,
      queue: job.queue,
      idempotencyKey: job.idempotencyKey,
      payload: job.payload as Record<string, unknown>,
      runAt,
    })
  );
  console.warn(
    `[worker] job ${job.id} (${job.queue}): workspace ${job.tenantId} used today's AI allowance; waits until ${runAt.toISOString()}`
  );
  return true;
}

const HELD_QUEUES = new Set<string>(INDEX_QUEUES);

/** The deps with providers for the models in effect now (reloaded from the database). */
async function currentModels(models: ModelProviders, deps: RunDeps): Promise<RunDeps> {
  const settings = await models.cache.refresh();
  return {
    ...deps,
    embeddingProvider: models.embeddingFor(settings.embeddingModel),
    placementModel: models.routingFor(settings.routerModel),
  };
}

/** Work the operator caused (`operator: true` in the payload, e.g. a model change re-index): free, never held. */
function isOperatorJob(job: Job): boolean {
  return (job.payload as Record<string, unknown> | null)?.operator === true;
}

/**
 * Indexing work past the workspace's index credit limit (plus grace) is held,
 * not failed: the job is put back for the period's end and true is returned
 * without running it. Raising the limit (the control-plane API) releases it
 * sooner. An unreadable standing lets the job run.
 */
async function heldAtIndexLimit(job: Job, now: Date): Promise<boolean> {
  if (!HELD_QUEUES.has(job.queue) || isOperatorJob(job)) return false;
  let standing: Awaited<ReturnType<typeof readStanding>>;
  try {
    standing = await withTenantTx(job.tenantId, (tx) => readStanding(tx, job.tenantId, now));
  } catch (err) {
    console.error(`[worker] usage standing unavailable for job ${job.id}; running it:`, errorMessage(err));
    return false;
  }
  if (!indexHeld(standing)) return false;
  const runAt = standing.period.end;
  await withTenantTx(job.tenantId, (tx) =>
    enqueueJob(tx, {
      tenantId: job.tenantId,
      queue: job.queue,
      idempotencyKey: job.idempotencyKey,
      payload: job.payload as Record<string, unknown>,
      runAt,
    })
  );
  console.warn(
    `[worker] job ${job.id} (${job.queue}): workspace ${job.tenantId} reached its indexing limit; waits until ${runAt.toISOString()}`
  );
  return true;
}

/** Capture routing and placement spend the Capture and Ask pool; every other job is indexing work. */
const CAPTURE_QUEUES = new Set(['capture.route', 'capture.place']);

function usageScopeOf(job: Job, clock: () => Date) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    tenantId: job.tenantId,
    kind: CAPTURE_QUEUES.has(job.queue) ? ('capture' as const) : ('index' as const),
    principalId: id(payload.principalId),
    documentId: id(payload.documentId),
    clock,
    operator: isOperatorJob(job),
  };
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
  deps: RunDeps,
  aiDailyLimit: number,
  creditRates: CreditRates | null | (() => CreditRates | null)
): Promise<string> {
  const handler = registry[job.queue];
  const lease = job.lockedAt ?? undefined;
  let failure: { err: unknown } | undefined;
  try {
    if (!handler) throw new NonRetryableError(`No handler registered for queue "${job.queue}"`);
    if (
      !(await heldAtIndexLimit(job, clock())) &&
      !(handler.usesAi && !isOperatorJob(job) && (await deferredPastAllowance(job, aiDailyLimit, clock())))
    ) {
      const rates = typeof creditRates === 'function' ? creditRates() : creditRates;
      await withUsageScope(usageScopeOf(job, clock), rates, () => handler.run(job, { now: clock(), ...deps }));
    }
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

/** How often the loop deletes finished rate-limit windows. */
const COUNTER_SWEEP_MS = 10 * 60 * 1000;

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
  placementModel?: RoutingModel;
  collab?: CollabClient;
  handlers?: Record<string, JobHandler>;
  aiDailyLimit?: number;
  /** The rate table, or a getter read as each job runs (the live model settings). */
  creditRates?: CreditRates | null | (() => CreditRates | null);
  /** See RunnerOptions.models. */
  models?: ModelProviders;
}): Promise<void> {
  let lastSweep = 0;
  while (!o.signal.aborted) {
    // Finished rate-limit windows are only clutter; one worker pass every few minutes clears them.
    if (Date.now() - lastSweep >= COUNTER_SWEEP_MS) {
      lastSweep = Date.now();
      try {
        await deleteExpiredCounters();
      } catch (err) {
        console.error('[worker] clearing finished rate-limit windows failed:', errorMessage(err));
      }
    }
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
          placementModel: o.placementModel,
          collab: o.collab,
          handlers: o.handlers,
          signal: o.signal,
          aiDailyLimit: o.aiDailyLimit,
          creditRates: o.creditRates,
          models: o.models,
        });
      } catch (err) {
        console.error(`[worker] running jobs for tenant ${tenantId} failed:`, errorMessage(err));
      }
    }
    await sleep(o.intervalMs, o.signal);
  }
}
