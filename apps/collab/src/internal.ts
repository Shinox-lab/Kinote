import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import type { Hocuspocus } from '@hocuspocus/server';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, documents, pages, spaces } from '@living-wiki/db';
import {
  AppError,
  CollabFlushRequestSchema,
  CollabReplaceBlocksRequestSchema,
  CollabRevokeRequestSchema,
  ERROR_SENTENCES,
  type ErrorCode,
} from '@living-wiki/contracts';
import { parseDocumentName } from '@living-wiki/shared';
import type { CollabContext } from './auth.js';
import { openTrustedDirectSession } from './directSession.js';
import { BLOCK_FRAGMENT } from './fragment.js';
import { collabServerDeps, storeDocumentNow } from './serverState.js';

/**
 * The privileged API-to-collab endpoints. Every request must carry the shared
 * `x-internal-secret`; nothing here checks a collab token, so these paths must
 * never be reachable without it.
 */
export const INTERNAL_PATHS = {
  flush: '/internal/flush',
  replaceBlocks: '/internal/replace-blocks',
  revoke: '/internal/revoke',
} as const;

/**
 * Close code of a revoked websocket: Hocuspocus' "Reset Connection". The
 * provider treats it like any dropped socket: it reconnects and sends a
 * token again (the console fetches a fresh one).
 */
export const REVOKED_CLOSE = { code: 4205, reason: 'Reset Connection' } as const;

/** Largest JSON body the internal endpoints read. */
export const MAX_INTERNAL_BODY_BYTES = 2 * 1024 * 1024;

const blockNote = ServerBlockNoteEditor.create();

function requireDocument(name: string): { tenantId: string; pageId: string } {
  const parsed = parseDocumentName(name);
  if (!parsed) throw new AppError('validation_failed', 'Malformed collab document name.');
  return parsed;
}

/**
 * POST /internal/flush: stores the document now when it is loaded (what
 * clients typed is in `pages.ydoc_state` when this resolves). A document that
 * is not loaded has nothing unsaved, so that is a no-op.
 */
export async function flushDocument(server: Hocuspocus, input: unknown): Promise<void> {
  const parsed = CollabFlushRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed');
  const { documentName } = parsed.data;
  requireDocument(documentName);

  const document = server.documents.get(documentName);
  if (!document || document.isLoading) return;
  await storeDocumentNow(server, document, {});
}

/**
 * The context a trusted (secret-authenticated) direct session edits under:
 * the page must exist for that tenant; the actor is the one the caller names.
 */
async function trustedContext(
  tenantId: string,
  pageId: string,
  actor: { type: 'user' | 'agent'; id: string }
): Promise<CollabContext> {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ spaceId: documents.spaceId, kind: documents.kind, quietSeconds: spaces.quietSeconds })
      .from(documents)
      .innerJoin(
        pages,
        and(eq(pages.tenantId, documents.tenantId), eq(pages.documentId, documents.id))
      )
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documents.id, pageId),
          eq(pages.tenantId, tenantId),
          eq(spaces.tenantId, tenantId)
        )
      )
  );
  if (!row || row.kind !== 'page') throw new AppError('page_not_found');
  return {
    tenantId,
    pageId,
    spaceId: row.spaceId,
    actorType: actor.type,
    actorId: actor.id,
    quietSeconds: row.quietSeconds,
    readOnly: false,
  };
}

/**
 * POST /internal/replace-blocks: replaces the live page content with `blocks`
 * and its title, as one transaction attributed to `actor` with `source`
 * (`restore` never marks the page agent-changed, `agent` does). Connected
 * clients see the change live; it is stored before this resolves.
 */
export async function replaceDocumentBlocks(server: Hocuspocus, input: unknown): Promise<void> {
  const parsed = CollabReplaceBlocksRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed');
  const { documentName, title, blocks, actor, source } = parsed.data;
  const { tenantId, pageId } = requireDocument(documentName);

  // Convert once off-document first: invalid blocks are refused before the
  // live fragment is touched (a throw mid-transaction would leave it cleared).
  try {
    blockNote.blocksToYXmlFragment(blocks as any, new Y.Doc().getXmlFragment(BLOCK_FRAGMENT));
  } catch {
    throw new AppError('validation_failed', 'The blocks are not valid page content.');
  }

  const context = await trustedContext(tenantId, pageId, actor);
  const session = await openTrustedDirectSession(server, documentName, context);
  try {
    await session.transact({ source, actorId: actor.id }, (doc) => {
      const fragment = doc.getXmlFragment(BLOCK_FRAGMENT);
      fragment.delete(0, fragment.length);
      blockNote.blocksToYXmlFragment(blocks as any, fragment);
      doc.getMap('meta').set('title', title);
    });
  } finally {
    await session.close();
  }
}

/**
 * POST /internal/revoke: closes the websocket under every live connection of
 * `tenant_id` (only `user_id`'s when given). The API calls it after an admin
 * change that can alter access (member removed or re-roled, grants, groups).
 * The clients reconnect and authenticate again, and `authenticateCollabConnection`
 * re-reads the role: a removed member is refused, a demoted one read-only.
 *
 * The whole socket is closed, not only the document connection: a closed
 * document connection alone leaves the provider's socket open and
 * unauthenticated, with nothing that makes it authenticate again. Other
 * documents multiplexed on the same socket reconnect with it.
 */
export async function revokeConnections(server: Hocuspocus, input: unknown): Promise<void> {
  const parsed = CollabRevokeRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed');
  const tenantId = parsed.data.tenant_id.toLowerCase();
  const userId = parsed.data.user_id?.toLowerCase();

  const sockets = new Set<{ close(code?: number, reason?: string): void }>();
  for (const document of server.documents.values()) {
    for (const connection of document.getConnections()) {
      const context = connection.context as CollabContext | undefined;
      if (!context || context.tenantId.toLowerCase() !== tenantId) continue;
      if (
        userId !== undefined &&
        !(context.actorType === 'user' && context.actorId.toLowerCase() === userId)
      ) {
        continue;
      }
      sockets.add(connection.webSocket);
    }
  }
  for (const socket of sockets) {
    try {
      socket.close(REVOKED_CLOSE.code, REVOKED_CLOSE.reason);
    } catch {
      // Already closing or gone: nothing left to revoke.
    }
  }
}

const HANDLERS: Record<string, (server: Hocuspocus, input: unknown) => Promise<void>> = {
  [INTERNAL_PATHS.flush]: flushDocument,
  [INTERNAL_PATHS.replaceBlocks]: replaceDocumentBlocks,
  [INTERNAL_PATHS.revoke]: revokeConnections,
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time secret check; hashing first makes the lengths always equal. */
function secretMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (typeof presented !== 'string' || presented === '' || expected === '') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, code: ErrorCode, status: number, headers = {}): void {
  sendJson(response, status, { error: code, message: ERROR_SENTENCES[code] }, headers);
}

class BodyTooLarge extends Error {}

/**
 * Replies and closes the connection without reading the rest of the body
 * (401, 413), so a caller cannot tie the connection up by streaming more.
 * `Connection: close` makes Node end and destroy the socket once the reply is
 * flushed. A client still pushing a large body at that moment may see a reset
 * instead of the reply; either way the call has failed and nothing is held.
 */
function sendAndClose(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  response.end(JSON.stringify(body), () => request.destroy());
}

/**
 * Reads the whole JSON body, up to `limit` bytes. A declared or streamed size
 * over the limit rejects with BodyTooLarge as soon as it is known, without
 * reading further.
 */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        request.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function handleInternal(
  server: Hocuspocus,
  handler: (server: Hocuspocus, input: unknown) => Promise<void>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const { internalSecret } = collabServerDeps(server);
  if (!secretMatches(request.headers['x-internal-secret'], internalSecret)) {
    return sendAndClose(request, response, 401, {
      error: 'unauthenticated',
      message: ERROR_SENTENCES.unauthenticated,
    });
  }
  if (request.method !== 'POST') {
    request.resume();
    return sendJson(
      response,
      405,
      { error: 'validation_failed', message: 'Only POST is allowed here.' },
      { Allow: 'POST' }
    );
  }

  let input: unknown;
  try {
    const raw = await readBody(request, MAX_INTERNAL_BODY_BYTES);
    input = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return sendAndClose(request, response, 413, {
        error: 'validation_failed',
        message: 'The request body is too large.',
      });
    }
    return sendError(response, 'validation_failed', 400);
  }

  try {
    await handler(server, input);
    response.writeHead(204);
    response.end();
  } catch (err) {
    if (err instanceof AppError) {
      return sendJson(response, err.statusCode, { error: err.code, message: err.message });
    }
    console.error(
      `[collab] internal ${request.url} failed:`,
      err instanceof Error ? err.message : err
    );
    return sendError(response, 'internal_error', 500);
  }
}

/**
 * The internal handler for a request target, or undefined. Matches the raw
 * origin-form path exactly (query string ignored) without URL parsing: Node
 * accepts request targets that `new URL` rejects (`http://[x`, `//[`), and
 * this must never throw. Anything else (absolute-form, unknown) is not internal.
 */
function internalHandlerFor(url: unknown) {
  if (typeof url !== 'string') return undefined;
  const path = url.split('?', 1)[0];
  return Object.hasOwn(HANDLERS, path) ? HANDLERS[path] : undefined;
}

/**
 * The Hocuspocus 4 `onRequest` hook for the internal endpoints. Any other
 * request target resolves untouched, so later hooks and Hocuspocus' default
 * response (`GET /`, a health check) still run. For an internal path the reply
 * is sent here and the hook rejects with `null`: Hocuspocus then skips the
 * remaining hooks and its default response without logging an error.
 *
 * It never rejects with anything else: Hocuspocus re-throws a truthy hook
 * error out of its async request listener, an unhandled rejection that would
 * take the whole collab process (and every unsaved edit) down.
 */
export async function handleInternalRequest(
  server: Hocuspocus,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  let handler: ReturnType<typeof internalHandlerFor>;
  try {
    handler = internalHandlerFor(request.url);
  } catch {
    return;
  }
  if (!handler) return;
  try {
    await handleInternal(server, handler, request, response);
  } catch (err) {
    try {
      console.error('[collab] internal request failed:', err instanceof Error ? err.message : err);
      if (!response.headersSent) sendError(response, 'internal_error', 500);
      else response.end();
    } catch {
      // The connection is already gone; nothing more to report.
    }
  }
  throw null;
}
