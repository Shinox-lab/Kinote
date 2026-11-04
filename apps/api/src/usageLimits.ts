import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@kinote/contracts';
import { chargeAiAction, hasAiActionsLeft, hitLimit } from '@kinote/db';

const MINUTE_MS = 60_000;

/** Who a per-person limit counts: the member in this workspace, the source token, or the session user. */
function whoOf(req: FastifyRequest, per: 'person' | 'tenant'): string {
  if (per === 'tenant') {
    const tenantId = req.actor?.tenantId ?? req.sourceActor?.tenantId;
    if (tenantId) return `tenant:${tenantId}`;
  }
  if (req.actor) return `${req.actor.tenantId}:${req.actor.principalId}`;
  if (req.sourceActor) return `source:${req.sourceActor.sourceId}`;
  if (req.authSession) return `user:${req.authSession.userId}`;
  return `ip:${req.ip}`;
}

/**
 * An `onRequest` hook (it runs after the auth hook) allowing `max` requests per
 * window (a minute by default) per person, or per workspace, counted in the
 * shared Postgres counters. Routes that share a `name` share the count. If the
 * counters can't be read the request goes through: these limits protect cost
 * and load, not accounts (sign-in fails closed instead).
 */
export function requestLimit(name: string, max: number, o: { windowMs?: number; per?: 'person' | 'tenant' } = {}) {
  const windowMs = o.windowMs ?? MINUTE_MS;
  const per = o.per ?? 'person';
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let verdict: Awaited<ReturnType<typeof hitLimit>>;
    try {
      verdict = await hitLimit(`limit:${name}:${whoOf(req, per)}`, max, windowMs);
    } catch (err) {
      req.log.error({ err }, `rate limit ${name} unavailable; request allowed`);
      return;
    }
    if (!verdict.allowed) {
      reply.header('retry-after', Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)));
      throw new AppError('rate_limited');
    }
  };
}

/**
 * Counts one AI action against the workspace's daily allowance, or refuses
 * with `ai_budget_exhausted` (Retry-After: until midnight UTC). As with the
 * per-minute limits, an unreadable counter lets the action through.
 */
export async function chargeAi(req: FastifyRequest, reply: FastifyReply, tenantId: string, dailyLimit: number): Promise<void> {
  let verdict: Awaited<ReturnType<typeof chargeAiAction>>;
  try {
    verdict = await chargeAiAction(tenantId, dailyLimit);
  } catch (err) {
    req.log.error({ err }, 'AI allowance unavailable; action allowed');
    return;
  }
  if (!verdict.allowed) {
    reply.header('retry-after', Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)));
    throw new AppError('ai_budget_exhausted');
  }
}

/** Whether the workspace has AI actions left today; true when the counter can't be read. */
export async function aiActionsLeftOrUnknown(req: FastifyRequest, tenantId: string, dailyLimit: number): Promise<boolean> {
  try {
    return await hasAiActionsLeft(tenantId, dailyLimit);
  } catch (err) {
    req.log.error({ err }, 'AI allowance unavailable; action allowed');
    return true;
  }
}

/**
 * At most `max` uploads taken at once in this process. An upload waits on disk
 * while it is checked and stored (up to MAX_UPLOAD_BYTES), so this bounds the
 * temporary disk uploads can take to about `max` × MAX_UPLOAD_BYTES. A busy
 * process answers rate_limited with a short Retry-After instead of queuing.
 */
export function uploadSlots(max: number) {
  let inUse = 0;
  return {
    /** Takes a slot; call the returned function once to give it back. */
    take(reply: FastifyReply): () => void {
      if (inUse >= max) {
        reply.header('retry-after', 5);
        throw new AppError('rate_limited', 'Too many uploads are in progress; please try again in a few seconds.');
      }
      inUse++;
      let given = false;
      return () => {
        if (given) return;
        given = true;
        inUse--;
      };
    },
    get inUse() {
      return inUse;
    },
  };
}
