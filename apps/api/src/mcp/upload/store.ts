import { PassThrough, Readable } from 'node:stream';
import { and, count, eq, gt, lte, sql } from 'drizzle-orm';
import { mcpUploads, withTenantTx, type McpUploadRow } from '@kinote/db';
import type { Actor } from '@kinote/core';
import type { ObjectStorage } from '@kinote/shared';
import { spoolUpload, type UploadedFile } from '../../uploadedFile.js';
import { ToolError } from '../refs.js';

/** Bytes per chunk the panel sends (the last may be shorter); base64 of one is 1 398 104 characters. */
export const UPLOAD_CHUNK_BYTES = 1_048_576;
/** An unfinished upload is forgotten after an hour. */
export const UPLOAD_TTL_MS = 3_600_000;
/** A replace upload lives as long as its link. */
const LINK_TTL_MS = 15 * 60_000;
/** Uploads one agent may have open at once. */
export const MAX_OPEN_UPLOADS = 3;
const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800;
const AUDIO_VIDEO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']);

const NOT_FOUND = 'Upload not found';
const NOTHING_SENT = 'Nothing has been sent to the upload link yet. Send the file with the curl line, then call again.';
const NO_STORAGE = 'File uploads are not set up on this Kinote server.';

export interface UploadDeps {
  storage?: ObjectStorage;
  maxUploadBytes?: number;
  uploadTmpDir?: string;
}

/** The storage key of chunk `index` (storage keys are `<tenantId>/<relative path>`). */
export function partKey(tenantId: string, uploadId: string, index: number): string {
  return `${tenantId}/${partPath(uploadId, index)}`;
}
const partPath = (uploadId: string, index: number) => `uploads/${uploadId}/${index}`;

function storageOf(deps: UploadDeps): ObjectStorage {
  if (!deps.storage) throw new ToolError(NO_STORAGE);
  return deps.storage;
}

async function deleteParts(storage: ObjectStorage, tenantId: string, row: Pick<McpUploadRow, 'id' | 'nextIndex'>): Promise<void> {
  for (let i = 0; i < row.nextIndex; i++) await storage.delete(tenantId, partKey(tenantId, row.id, i)).catch(() => undefined);
}

/** The agent's live upload, or "Upload not found" (another agent's, unknown, or expired). */
async function liveUpload(
  actor: Actor,
  agentId: string,
  uploadId: string,
  now: Date,
  purpose: McpUploadRow['purpose'] | null = 'panel'
): Promise<McpUploadRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) throw new ToolError(NOT_FOUND);
  const [row] = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select()
      .from(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), eq(mcpUploads.id, uploadId), eq(mcpUploads.agentId, agentId), gt(mcpUploads.expiresAt, now)))
  );
  if (!row || (purpose !== null && row.purpose !== purpose)) throw new ToolError(NOT_FOUND);
  return row;
}

async function removeUpload(storage: ObjectStorage, tenantId: string, row: Pick<McpUploadRow, 'id' | 'nextIndex'>): Promise<void> {
  await withTenantTx(tenantId, (tx) => tx.delete(mcpUploads).where(and(eq(mcpUploads.tenantId, tenantId), eq(mcpUploads.id, row.id))));
  await deleteParts(storage, tenantId, row);
}

/**
 * Starts an upload after deleting the tenant's expired ones (there is no periodic job). Refuses a file over
 * the size cap, audio or video (by mime or extension), and a fourth open upload of the same agent.
 */
export async function beginUpload(
  deps: UploadDeps,
  actor: Actor,
  agentId: string,
  input: { name: string; size: number; mime: string },
  now: Date = new Date()
): Promise<{ uploadId: string; chunkBytes: number }> {
  const storage = storageOf(deps);
  const max = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (input.size > max) throw new ToolError(`This file is larger than ${Math.floor(max / 1_048_576)} MB.`);
  const ext = input.name.toLowerCase().split('.').pop() ?? '';
  if (/^(audio|video)\//i.test(input.mime) || (input.name.includes('.') && AUDIO_VIDEO_EXT.has(ext))) {
    throw new ToolError("Audio and video can't be read yet.");
  }

  const uploadId = await openUpload(storage, actor, agentId, { name: input.name, mime: input.mime, size: input.size, purpose: 'panel', documentId: null }, now);
  return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES };
}

/**
 * Deletes the tenant's expired uploads (there is no periodic job), then adds one for the agent unless it has
 * MAX_OPEN_UPLOADS open already (panel uploads and replace links count together).
 */
async function openUpload(
  storage: ObjectStorage,
  actor: Actor,
  agentId: string,
  input: { name: string; mime: string; size: number; purpose: McpUploadRow['purpose']; documentId: string | null },
  now: Date
): Promise<string> {
  const expired = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .delete(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), lte(mcpUploads.expiresAt, now)))
      .returning({ id: mcpUploads.id, nextIndex: mcpUploads.nextIndex })
  );
  for (const row of expired) await deleteParts(storage, actor.tenantId, row);

  return withTenantTx(actor.tenantId, async (tx) => {
    // One agent's begins are serialised so two at once cannot both pass the open-upload count.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'mcp-upload:' + agentId}))`);
    const [open] = await tx
      .select({ n: count() })
      .from(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), eq(mcpUploads.agentId, agentId), gt(mcpUploads.expiresAt, now)));
    if ((open?.n ?? 0) >= MAX_OPEN_UPLOADS) throw new ToolError('Finish or cancel another upload first.');
    const [row] = await tx
      .insert(mcpUploads)
      .values({
        tenantId: actor.tenantId,
        agentId,
        name: input.name,
        mime: input.mime,
        size: input.size,
        purpose: input.purpose,
        documentId: input.documentId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + (input.purpose === 'replace' ? LINK_TTL_MS : UPLOAD_TTL_MS)),
      })
      .returning({ id: mcpUploads.id });
    return row!.id;
  });
}

/**
 * Starts a kinote_replace upload link's staging row for one file: the size is unknown until the PUT. Same
 * expiry sweep and open-upload cap as the panel.
 */
export async function beginLinkUpload(
  deps: UploadDeps,
  actor: Actor,
  agentId: string,
  input: { documentId: string; name: string; mime: string },
  now: Date = new Date()
): Promise<{ uploadId: string }> {
  const storage = storageOf(deps);
  // Asking again for the same file (a curl that failed, say) replaces the link nothing was sent to.
  await withTenantTx(actor.tenantId, (tx) =>
    tx
      .delete(mcpUploads)
      .where(
        and(
          eq(mcpUploads.tenantId, actor.tenantId),
          eq(mcpUploads.agentId, agentId),
          eq(mcpUploads.purpose, 'replace'),
          eq(mcpUploads.documentId, input.documentId),
          eq(mcpUploads.nextIndex, 0)
        )
      )
  );
  return { uploadId: await openUpload(storage, actor, agentId, { ...input, size: 0, purpose: 'replace' }, now) };
}

/** A link upload that is live (not expired), for `putWhole`'s caller: null when unknown, expired or not a replace. */
export async function liveLinkUpload(tenantId: string, agentId: string, uploadId: string, now: Date = new Date()): Promise<McpUploadRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) return null;
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, tenantId), eq(mcpUploads.id, uploadId), eq(mcpUploads.agentId, agentId), gt(mcpUploads.expiresAt, now)))
  );
  return row && row.purpose === 'replace' ? row : null;
}

/** Thrown by `putWhole` when the upload already has its bytes (a second PUT). */
export class UploadAlreadySent extends Error {}
/** Thrown by `putWhole` when the body passes the size cap; nothing is kept and the link may be used again. */
export class UploadTooLarge extends Error {}

/**
 * Streams one PUT body into the upload's single part, counting bytes as they arrive: past `maxBytes` the
 * stream is cut off (`UploadTooLarge`), whatever the request said its length was, and nothing is staged.
 * The upload is claimed first (`next_index` 0 → -1), so a second PUT, even a concurrent one, is
 * `UploadAlreadySent` and cannot overwrite the first. Changes nothing but the staging row and part.
 */
export async function putWhole(
  deps: UploadDeps,
  tenantId: string,
  uploadId: string,
  body: Readable,
  maxBytes: number,
  tmpDir?: string
): Promise<{ bytes: number; sha256: string }> {
  const storage = storageOf(deps);
  const claim = (from: number, to: number, extra: Partial<McpUploadRow> = {}) =>
    withTenantTx(tenantId, (tx) =>
      tx
        .update(mcpUploads)
        .set({ nextIndex: to, ...extra })
        .where(and(eq(mcpUploads.tenantId, tenantId), eq(mcpUploads.id, uploadId), eq(mcpUploads.nextIndex, from)))
        .returning({ id: mcpUploads.id })
    );
  if ((await claim(0, -1)).length === 0) {
    body.resume();
    throw new UploadAlreadySent();
  }
  // Counted as it streams: past the cap the generator throws, which ends the spool and destroys the body.
  let tooLarge = false;
  async function* counted() {
    let seen = 0;
    // Leave the request open when cut off, so the 413 still reaches the client; the rest is drained unread.
    for await (const chunk of body.iterator({ destroyOnReturn: false })) {
      seen += (chunk as Buffer).byteLength;
      if (seen > maxBytes) {
        tooLarge = true;
        throw new UploadTooLarge();
      }
      yield chunk as Buffer;
    }
  }
  let file: UploadedFile | null = null;
  try {
    file = await spoolUpload('upload', Readable.from(counted()), tmpDir);
    await storage.put(tenantId, partPath(uploadId, 0), file.open(), 'application/octet-stream');
    await claim(-1, 1, { size: file.sizeBytes, receivedBytes: file.sizeBytes });
    return { bytes: file.sizeBytes, sha256: file.contentHash };
  } catch (err) {
    body.resume();
    await claim(-1, 0);
    // The pipeline may report the cut-off as an abort: the flag says what happened.
    throw tooLarge ? new UploadTooLarge() : err;
  } finally {
    await file?.dispose();
  }
}

function decodeBase64(data: string): Buffer {
  const clean = data.replace(/\s+/g, '');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== clean.replace(/=+$/, '')) {
    throw new ToolError('This chunk is not valid base64.');
  }
  return bytes;
}

/**
 * Stores chunk `index`. Chunks arrive in order; one already received is a no-op (a retry after a lost reply).
 * Every chunk but the last is exactly UPLOAD_CHUNK_BYTES. Bytes past the declared size cancel the upload.
 */
export async function putChunk(
  deps: UploadDeps,
  actor: Actor,
  agentId: string,
  uploadId: string,
  index: number,
  data: string,
  now: Date = new Date()
): Promise<{ receivedBytes: number }> {
  const storage = storageOf(deps);
  const row = await liveUpload(actor, agentId, uploadId, now);
  if (index < row.nextIndex) return { receivedBytes: row.receivedBytes };
  if (index > row.nextIndex) throw new ToolError(`Chunk ${index} arrived before chunk ${row.nextIndex}.`);
  const bytes = decodeBase64(data);
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_CHUNK_BYTES) {
    throw new ToolError(`A chunk holds 1 to ${UPLOAD_CHUNK_BYTES} bytes.`);
  }
  const received = row.receivedBytes + bytes.byteLength;
  if (received > row.size) {
    await removeUpload(storage, actor.tenantId, row);
    throw new ToolError(`The file is larger than declared (${row.size} bytes); the upload was cancelled.`);
  }
  if (received < row.size && bytes.byteLength !== UPLOAD_CHUNK_BYTES) {
    throw new ToolError(`Every chunk but the last must be exactly ${UPLOAD_CHUNK_BYTES} bytes.`);
  }

  await storage.put(actor.tenantId, partPath(row.id, index), bytes, 'application/octet-stream');
  // Only the first of two identical concurrent chunks counts.
  const [updated] = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .update(mcpUploads)
      .set({ receivedBytes: received, nextIndex: index + 1 })
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), eq(mcpUploads.id, row.id), eq(mcpUploads.nextIndex, index)))
      .returning({ receivedBytes: mcpUploads.receivedBytes })
  );
  if (updated) return { receivedBytes: updated.receivedBytes };
  return { receivedBytes: (await liveUpload(actor, agentId, uploadId, now)).receivedBytes };
}

/**
 * Takes a complete upload of this purpose (a panel upload never finishes as a replace, nor the reverse):
 * streams its chunks in order into one spooled file (hashed on the way), then deletes the chunks and the
 * row. The caller disposes of the file.
 */
export async function takeUpload(
  deps: UploadDeps,
  actor: Actor,
  agentId: string,
  uploadId: string,
  opts: { purpose: McpUploadRow['purpose']; documentId?: string },
  now: Date = new Date()
): Promise<{ file: UploadedFile; row: McpUploadRow }> {
  const storage = storageOf(deps);
  const row = await liveUpload(actor, agentId, uploadId, now, opts.purpose);
  // A replace upload finishes only the file it was made for; one still being PUT has nothing to take yet.
  if (opts.purpose === 'replace' && row.documentId !== opts.documentId) throw new ToolError(NOT_FOUND);
  // Nothing PUT yet (or the PUT is still arriving): the link stays usable.
  if (opts.purpose === 'replace' && row.nextIndex <= 0) throw new ToolError(NOTHING_SENT);
  if (row.receivedBytes !== row.size) throw new ToolError(`The upload is incomplete: ${row.receivedBytes} of ${row.size} bytes.`);

  const stream = new PassThrough();
  const pump = (async () => {
    try {
      for (let i = 0; i < row.nextIndex; i++) {
        const { stream: part } = await storage.getStream(actor.tenantId, partKey(actor.tenantId, row.id, i));
        for await (const chunk of part) {
          if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
        }
      }
      stream.end();
    } catch (err) {
      stream.destroy(err as Error);
    }
  })();
  const file = await spoolUpload(row.name, stream, deps.uploadTmpDir);
  await pump;
  await removeUpload(storage, actor.tenantId, row);
  return { file, row };
}

/** Cancels an upload: deletes its chunks and row. Unknown or another agent's id: nothing happens. */
export async function cancelUpload(deps: UploadDeps, actor: Actor, agentId: string, uploadId: string): Promise<void> {
  const storage = storageOf(deps);
  let row: McpUploadRow;
  try {
    row = await liveUpload(actor, agentId, uploadId, new Date(0), null);
  } catch {
    return;
  }
  await removeUpload(storage, actor.tenantId, row);
}
