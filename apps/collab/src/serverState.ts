import type { Hocuspocus } from '@hocuspocus/server';

export interface CollabServerDeps {
  /** Verifies the signed collab tokens clients and direct sessions present. */
  collabTokenSecret: string;
  /** Shared secret for the API-to-collab internal endpoints (Task 4.2). */
  internalSecret: string;
  /** Store debounce; defaults to 1000 ms. */
  debounceMs?: number;
  /** Longest a busy document waits for a store; defaults to 5000 ms. */
  maxDebounceMs?: number;
}

export interface ServerState {
  deps: CollabServerDeps;
  /** In-flight onChange bookkeeping, so direct sessions can await it. */
  inflight: Set<Promise<void>>;
}

const serverState = new WeakMap<Hocuspocus, ServerState>();

function stateOf(server: Hocuspocus): ServerState {
  const state = serverState.get(server);
  if (!state) throw new Error('Not a collab server built by createCollabServer.');
  return state;
}

/** The dependencies a collab server was built with. */
export function collabServerDeps(server: Hocuspocus): CollabServerDeps {
  return stateOf(server).deps;
}

/** Resolves once every onChange handler started on `server` has finished. */
export async function collabSettle(server: Hocuspocus): Promise<void> {
  const { inflight } = stateOf(server);
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

/** Records the dependencies and bookkeeping of a server built by the factory. */
export function registerCollabServer(server: Hocuspocus, state: ServerState): void {
  serverState.set(server, state);
}
