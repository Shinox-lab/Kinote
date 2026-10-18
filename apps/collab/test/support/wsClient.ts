import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';

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
