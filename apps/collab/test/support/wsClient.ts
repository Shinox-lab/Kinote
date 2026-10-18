import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { getCollabTokenSecret } from '@living-wiki/shared';
import { createCollabServer, type CollabServer } from '../../src/server.js';

/** Internal secret the test servers are built with (Task 4.2 endpoints). */
export const TEST_INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef!!';

/**
 * Builds a collab server through the factory with the test secrets and
 * listens on a free port. Callers tear it down with `server.server.destroy()`.
 */
export async function startCollabServer(
  extraHooks?: Parameters<typeof createCollabServer>[1]
): Promise<{ server: CollabServer; port: number }> {
  const server = createCollabServer(
    { collabTokenSecret: getCollabTokenSecret(), internalSecret: TEST_INTERNAL_SECRET },
    extraHooks
  );
  await server.server.listen(0);
  return { server, port: server.server.address.port };
}

export interface ConnectedClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  destroy(): void;
}

/**
 * Connects a real websocket Hocuspocus client. Resolves once the provider has
 * synced, rejects when the server refuses authentication, and rejects after a
 * timeout so a broken handshake fails the test instead of hanging it.
 */
export function connectClient(args: {
  port: number;
  documentName: string;
  token: string;
  timeoutMs?: number;
}): Promise<ConnectedClient> {
  const doc = new Y.Doc();
  return new Promise<ConnectedClient>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${args.port}`,
      WebSocketPolyfill: WebSocket,
      // Never retry: a refused client must fail once, not reconnect forever.
      maxAttempts: 1,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: args.documentName,
      document: doc,
      token: args.token,
      onSynced: () => finish(() => resolve({ doc, provider, destroy })),
      onAuthenticationFailed: ({ reason }: { reason: string }) =>
        finish(() => {
          destroy();
          reject(new Error(`authentication failed: ${reason}`));
        }),
    });
    // Hocuspocus 4: a provider given its own websocket must be attached to it.
    provider.attach();
    function destroy() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    }
    const timer = setTimeout(
      () =>
        finish(() => {
          destroy();
          reject(new Error('timed out waiting for the collab client to sync'));
        }),
      args.timeoutMs ?? 5000
    );
  });
}
