// Where the browser opens its live-editing websocket.

export const COLLAB_PATH = '/collab';

/**
 * The collab websocket URL: `VITE_COLLAB_URL` when set, otherwise the page's own
 * host (ws on http, wss on https) under `/collab`, which the dev server and the
 * production proxy forward to the collab server.
 */
export function collabUrl(location: { protocol: string; host: string }, override?: string): string {
  const custom = override?.trim().replace(/\/+$/, '');
  if (custom) return custom;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${COLLAB_PATH}`;
}

/**
 * Hocuspocus document name of a page: `{tenantId}:{pageId}`, lower-case. The same
 * form as `documentName` in @kinote/shared (not imported: it pulls in node:crypto).
 */
export function collabDocumentName(tenantId: string, pageId: string): string {
  return `${tenantId}:${pageId}`.toLowerCase();
}

export type ConnectionState = 'connecting' | 'connected' | 'offline';

/** One word for the connection, from the socket's status, the first sync and whether authentication gave up. */
export function connectionState(input: {
  socket: 'connecting' | 'connected' | 'disconnected';
  synced: boolean;
  authFailed: boolean;
}): ConnectionState {
  if (input.authFailed || input.socket === 'disconnected') return 'offline';
  return input.socket === 'connected' && input.synced ? 'connected' : 'connecting';
}
