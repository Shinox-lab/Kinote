import type { Document, Hocuspocus, onStoreDocumentPayload } from '@hocuspocus/server';
import { AppError } from '@living-wiki/contracts';

export interface CollabServerDeps {
  /** Verifies the signed collab tokens clients and direct sessions present. */
  collabTokenSecret: string;
  /** Shared secret for the API-to-collab internal endpoints (`x-internal-secret`). */
  internalSecret: string;
  /** Store debounce; defaults to 1000 ms. */
  debounceMs?: number;
  /** Longest a busy document waits for a store; defaults to 5000 ms. */
  maxDebounceMs?: number;
}

export interface ServerState {
  deps: CollabServerDeps;
  /** Every in-flight onChange bookkeeping job, for the shutdown settle. */
  inflight: Set<Promise<void>>;
  /**
   * The same jobs grouped by the change's context object. A direct-session
   * transaction stamps a fresh context per call, so its key names exactly the
   * work that call triggered.
   */
  inflightByKey: WeakMap<object, Set<Promise<void>>>;
  /** Store payloads whose onStoreDocument hooks all succeeded. */
  storedPayloads: WeakSet<object>;
}

const serverState = new WeakMap<Hocuspocus, ServerState>();

function stateOf(server: Hocuspocus): ServerState {
  const state = serverState.get(server);
  if (!state) throw new Error('Not a collab server built by createCollabServer.');
  return state;
}

/** Fresh bookkeeping for a server the factory is about to build. */
export function newServerState(deps: CollabServerDeps): ServerState {
  return {
    deps,
    inflight: new Set(),
    inflightByKey: new WeakMap(),
    storedPayloads: new WeakSet(),
  };
}

/** The dependencies a collab server was built with. */
export function collabServerDeps(server: Hocuspocus): CollabServerDeps {
  return stateOf(server).deps;
}

/** Records in-flight work (under `key` too, when given) until it settles. */
export function trackWork(state: ServerState, work: Promise<void>, key?: object): void {
  state.inflight.add(work);
  let forKey: Set<Promise<void>> | undefined;
  if (key) {
    forKey = state.inflightByKey.get(key);
    if (!forKey) {
      forKey = new Set();
      state.inflightByKey.set(key, forKey);
    }
    forKey.add(work);
  }
  const done = () => {
    state.inflight.delete(work);
    forKey?.delete(work);
  };
  work.then(done, done);
}

/** `trackWork` for a server built by the factory (also a test seam). */
export function trackCollabWork(server: Hocuspocus, work: Promise<void>, key?: object): void {
  trackWork(stateOf(server), work, key);
}

async function drain(set: Set<Promise<void>> | undefined): Promise<void> {
  while (set && set.size > 0) {
    await Promise.allSettled([...set]);
  }
}

/**
 * Resolves once the onChange bookkeeping started on `server` has finished:
 * only the work recorded under `key` when one is given (a direct-session
 * call's own changes), otherwise every job on the server (shutdown).
 */
export async function collabSettle(server: Hocuspocus, key?: object): Promise<void> {
  const state = stateOf(server);
  await drain(key ? state.inflightByKey.get(key) : state.inflight);
}

/** Records the dependencies and bookkeeping of a server built by the factory. */
export function registerCollabServer(server: Hocuspocus, state: ServerState): void {
  serverState.set(server, state);
}

/** Marks a store payload as stored (called from the core afterStoreDocument hook). */
export function markStored(state: ServerState, payload: object): void {
  state.storedPayloads.add(payload);
}

/**
 * Stores `document` to Postgres now, through the same hook chain as the
 * debounced store (any pending debounced store is replaced by this one).
 * Hocuspocus 4 catches and only logs a failing store; this rejects with
 * `internal_error` instead, so a caller never takes a failed save for a
 * successful one.
 */
export async function storeDocumentNow(
  server: Hocuspocus,
  document: Document,
  context: unknown
): Promise<void> {
  const state = stateOf(server);
  const payload: onStoreDocumentPayload = {
    clientsCount: document.getConnectionsCount(),
    lastContext: context,
    lastTransactionOrigin: { source: 'local', context },
    document,
    documentName: document.name,
    instance: server,
  };
  await server.storeDocumentHooks(document, payload, true);
  if (!state.storedPayloads.has(payload)) {
    throw new AppError('internal_error', 'The collab document could not be stored.');
  }
}
