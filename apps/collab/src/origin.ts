import { isTransactionOrigin } from '@hocuspocus/server';
import type { CollabContext } from './auth.js';

/** What a direct (server-side) session says about the edit it makes. */
export interface DirectOrigin {
  source: 'agent' | 'restore';
  actorId: string;
  /**
   * Block ids the caller reports as changed; feeds `block_activity` until
   * Task 4.3 derives them from the update itself.
   */
  changedBlockIds?: string[];
}

/**
 * The context of a direct connection's transaction: the verified collab
 * context of the session's token plus the actor the call supplied. Hocuspocus
 * 4 delivers it on the transaction origin as `{ source: 'local', context }`.
 */
export interface DirectSessionContext extends CollabContext {
  directOrigin?: DirectOrigin;
}

export interface OriginActor {
  actorType: 'user' | 'agent';
  actorId: string;
  source: 'human' | 'agent' | 'restore';
}

function isActorType(value: unknown): value is 'user' | 'agent' {
  return value === 'user' || value === 'agent';
}

/** The caller-supplied origin of a direct-session transaction, if `origin` is one. */
export function directOriginOf(origin: unknown): DirectOrigin | null {
  if (!isTransactionOrigin(origin) || origin.source !== 'local') return null;
  const direct = (origin.context as Partial<DirectSessionContext> | undefined)?.directOrigin;
  if (
    !direct ||
    typeof direct.actorId !== 'string' ||
    (direct.source !== 'agent' && direct.source !== 'restore')
  ) {
    return null;
  }
  return direct;
}

/**
 * Who made the change a Yjs transaction origin stands for.
 *
 * - A websocket client edit (`{ source: 'connection', connection }`): the
 *   connection's authenticated principal, as a human edit (or an agent edit
 *   when the token principal is an agent).
 * - A direct-session edit (`{ source: 'local', context }` from
 *   `openDirectSession(...).transact`): the actor and source the call
 *   supplied. An agent edit is always typed `agent`; otherwise the session
 *   token's principal decides the actor type.
 * - Anything else (the initial document load, a Redis replay, a local
 *   transaction without a session actor, a foreign origin): `null`.
 */
export function resolveOriginActor(origin: unknown): OriginActor | null {
  if (!isTransactionOrigin(origin)) return null;

  if (origin.source === 'connection') {
    const ctx = origin.connection?.context as Partial<CollabContext> | undefined;
    if (!ctx || typeof ctx.actorId !== 'string' || !isActorType(ctx.actorType)) return null;
    return {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      source: ctx.actorType === 'agent' ? 'agent' : 'human',
    };
  }

  const direct = directOriginOf(origin);
  if (!direct) return null;
  const principalType = (origin as { context?: Partial<CollabContext> }).context?.actorType;
  return {
    actorType: direct.source === 'agent' || principalType === 'agent' ? 'agent' : 'user',
    actorId: direct.actorId,
    source: direct.source,
  };
}
