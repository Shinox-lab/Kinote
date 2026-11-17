import { PassThrough } from 'node:stream';
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
/** Uploads one agent may have open at once. */
export const MAX_OPEN_UPLOADS = 3;
const DEFAULT_MAX_UPLOAD_BYTES = 52_428_800;
const AUDIO_VIDEO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']);

const NOT_FOUND = 'Upload not found';
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
async function liveUpload(actor: Actor, agentId: string, uploadId: string, now: Date): Promise<McpUploadRow> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) throw new ToolError(NOT_FOUND);
  const [row] = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select()
      .from(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), eq(mcpUploads.id, uploadId), eq(mcpUploads.agentId, agentId), gt(mcpUploads.expiresAt, now)))
  );
  if (!row) throw new ToolError(NOT_FOUND);
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

  const expired = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .delete(mcpUploads)
      .where(and(eq(mcpUploads.tenantId, actor.tenantId), lte(mcpUploads.expiresAt, now)))
      .returning({ id: mcpUploads.id, nextIndex: mcpUploads.nextIndex })
  );
  for (const row of expired) await deleteParts(storage, actor.tenantId, row);

  const uploadId = await withTenantTx(actor.tenantId, async (tx) => {
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
        createdAt: now,
        expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS),
      })
      .returning({ id: mcpUploads.id });
    return row!.id;
  });
  return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES };
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
 * Takes a complete upload: streams its chunks in order into one spooled file (hashed on the way), then
 * deletes the chunks and the row. The caller disposes of the file.
 */
export async function takeUpload(
  deps: UploadDeps,
  actor: Actor,
  agentId: string,
  uploadId: string,
  now: Date = new Date()
): Promise<{ file: UploadedFile; row: McpUploadRow }> {
  const storage = storageOf(deps);
  const row = await liveUpload(actor, agentId, uploadId, now);
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
    row = await liveUpload(actor, agentId, uploadId, new Date(0));
  } catch {
    return;
  }
  await removeUpload(storage, actor.tenantId, row);
}
