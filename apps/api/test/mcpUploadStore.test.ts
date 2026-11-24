import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { mcpUploads, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import type { Actor } from '@kinote/core';
import {
  beginUpload,
  cancelUpload,
  partKey,
  putChunk,
  takeUpload,
  UPLOAD_CHUNK_BYTES,
  type UploadDeps,
} from '../src/mcp/upload/store.js';
import { ToolError } from '../src/mcp/refs.js';
import { bootstrapTenant, buildTestApp, createAgent, useTestDb } from './support/testkit.js';

const MiB = UPLOAD_CHUNK_BYTES;
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function readAll(file: { open(): Readable | Uint8Array }): Promise<Buffer> {
  const src = file.open();
  if (src instanceof Uint8Array) return Buffer.from(src);
  const parts: Buffer[] = [];
  for await (const c of src) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ToolError, String(err));
    return err.message;
  }
  assert.fail('expected a refusal');
}

describe('the MCP upload store', () => {
  useTestDb();
  let deps: UploadDeps & { storage: InMemoryObjectStorage };
  let actor: Actor;
  let agentId: string;
  let otherAgent: string;

  beforeEach(async () => {
    const app = buildTestApp();
    const { tenant, owner } = await bootstrapTenant(app, { name: 'Upload Co', slug: `upload-${randomBytes(3).toString('hex')}` });
    agentId = await createAgent(tenant.id, owner.userId, { name: 'Uploader' });
    otherAgent = await createAgent(tenant.id, owner.userId, { name: 'Other' });
    actor = { tenantId: tenant.id, principalType: 'agent', principalId: agentId, owner: { userId: owner.userId, tenantRole: 'owner' } };
    deps = { storage: new InMemoryObjectStorage(), maxUploadBytes: 52_428_800 };
  });

  async function partExists(uploadId: string, i: number): Promise<boolean> {
    try {
      await deps.storage.get(actor.tenantId, partKey(actor.tenantId, uploadId, i));
      return true;
    } catch {
      return false;
    }
  }

  async function uploadAll(bytes: Uint8Array) {
    const { uploadId, chunkBytes } = await beginUpload(deps, actor, agentId, { name: 'notes.bin', size: bytes.byteLength, mime: 'application/octet-stream' });
    assert.equal(chunkBytes, MiB);
    for (let i = 0; i * MiB < bytes.byteLength; i++) {
      await putChunk(deps, actor, agentId, uploadId, i, b64(bytes.subarray(i * MiB, (i + 1) * MiB)));
    }
    return uploadId;
  }

  test('three chunks with a short last one assemble into the file, and the parts and row are removed', async () => {
    const bytes = randomBytes(2 * MiB + 10);
    const id = await uploadAll(bytes);
    const { file, row } = await takeUpload(deps, actor, agentId, id, { purpose: 'panel' });
    try {
      assert.equal(row.name, 'notes.bin');
      assert.equal(file.sizeBytes, 2 * MiB + 10);
      assert.equal(file.contentHash, sha(bytes));
      assert.ok((await readAll(file)).equals(bytes));
    } finally {
      await file.dispose();
    }
    for (const i of [0, 1, 2]) assert.equal(await partExists(id, i), false);
    const rows = await withTenantTx(actor.tenantId, (tx) => tx.select().from(mcpUploads).where(eq(mcpUploads.id, id)));
    assert.equal(rows.length, 0);
  });

  test('a file of exactly two chunks finishes', async () => {
    const bytes = randomBytes(2 * MiB);
    const { file } = await takeUpload(deps, actor, agentId, await uploadAll(bytes), { purpose: 'panel' });
    assert.equal(file.contentHash, sha(bytes));
    await file.dispose();
  });

  test('a repeated chunk index is a no-op, so a retry after a lost reply does not corrupt the file', async () => {
    const bytes = randomBytes(MiB + 5);
    const { uploadId } = await beginUpload(deps, actor, agentId, { name: 'a.bin', size: bytes.byteLength, mime: 'application/octet-stream' });
    assert.deepEqual(await putChunk(deps, actor, agentId, uploadId, 0, b64(bytes.subarray(0, MiB))), { receivedBytes: MiB });
    assert.deepEqual(await putChunk(deps, actor, agentId, uploadId, 0, b64(bytes.subarray(0, MiB))), { receivedBytes: MiB });
    assert.deepEqual(await putChunk(deps, actor, agentId, uploadId, 1, b64(bytes.subarray(MiB))), { receivedBytes: MiB + 5 });
    assert.deepEqual(await putChunk(deps, actor, agentId, uploadId, 1, b64(bytes.subarray(MiB))), { receivedBytes: MiB + 5 });
    const { file } = await takeUpload(deps, actor, agentId, uploadId, { purpose: 'panel' });
    assert.equal(file.contentHash, sha(bytes));
    await file.dispose();
  });

  test('a gap, a short middle chunk, bad base64 and overflow are refused; overflow cancels the upload', async () => {
    const { uploadId } = await beginUpload(deps, actor, agentId, { name: 'a.bin', size: 2 * MiB + 10, mime: 'application/octet-stream' });
    await putChunk(deps, actor, agentId, uploadId, 0, b64(randomBytes(MiB)));
    assert.equal(await refusal(putChunk(deps, actor, agentId, uploadId, 2, b64(randomBytes(10)))), 'Chunk 2 arrived before chunk 1.');
    assert.match(await refusal(putChunk(deps, actor, agentId, uploadId, 1, b64(randomBytes(100)))), /exactly 1048576 bytes/);
    assert.match(await refusal(putChunk(deps, actor, agentId, uploadId, 1, '!!not base64!!')), /base64/);
    await putChunk(deps, actor, agentId, uploadId, 1, b64(randomBytes(MiB)));
    assert.match(await refusal(putChunk(deps, actor, agentId, uploadId, 2, b64(randomBytes(11)))), /larger than declared/);
    assert.equal(await refusal(putChunk(deps, actor, agentId, uploadId, 2, b64(randomBytes(10)))), 'Upload not found');
    assert.equal(await partExists(uploadId, 0), false);
  });

  test('finishing an incomplete upload is refused with the byte counts', async () => {
    const { uploadId } = await beginUpload(deps, actor, agentId, { name: 'a.bin', size: 2 * MiB + 10, mime: 'application/octet-stream' });
    await putChunk(deps, actor, agentId, uploadId, 0, b64(randomBytes(MiB)));
    assert.equal(await refusal(takeUpload(deps, actor, agentId, uploadId, { purpose: 'panel' })), 'The upload is incomplete: 1048576 of 2097162 bytes.');
  });

  test("another agent's upload, an unknown id and an expired upload are not found", async () => {
    const { uploadId } = await beginUpload(deps, actor, agentId, { name: 'a.bin', size: 10, mime: 'text/plain' });
    assert.equal(await refusal(putChunk(deps, actor, otherAgent, uploadId, 0, b64(randomBytes(10)))), 'Upload not found');
    assert.equal(await refusal(takeUpload(deps, actor, agentId, '11111111-1111-4111-8111-111111111111', { purpose: 'panel' })), 'Upload not found');
    const later = new Date(Date.now() + 61 * 60_000);
    assert.equal(await refusal(putChunk(deps, actor, agentId, uploadId, 0, b64(randomBytes(10)), later)), 'Upload not found');
  });

  test('begin refuses a file over the cap, audio and video, and a fourth open upload', async () => {
    const meta = (o: Partial<{ name: string; size: number; mime: string }>) => ({ name: 'a.pdf', size: 10, mime: 'application/pdf', ...o });
    assert.equal(await refusal(beginUpload(deps, actor, agentId, meta({ size: 52_428_801 }))), 'This file is larger than 50 MB.');
    assert.equal(await refusal(beginUpload(deps, actor, agentId, meta({ mime: 'audio/mpeg' }))), "Audio and video can't be read yet.");
    assert.equal(await refusal(beginUpload(deps, actor, agentId, meta({ name: 'talk.mp4', mime: 'application/octet-stream' }))), "Audio and video can't be read yet.");
    for (let i = 0; i < 3; i++) await beginUpload(deps, actor, agentId, meta({}));
    assert.equal(await refusal(beginUpload(deps, actor, agentId, meta({}))), 'Finish or cancel another upload first.');
    // Another agent has its own three.
    await beginUpload(deps, actor, otherAgent, meta({}));
  });

  test('begin first deletes the expired uploads of the tenant and their parts', async () => {
    const { uploadId } = await beginUpload(deps, actor, otherAgent, { name: 'a.bin', size: MiB + 1, mime: 'application/octet-stream' });
    await putChunk(deps, actor, otherAgent, uploadId, 0, b64(randomBytes(MiB)));
    const later = new Date(Date.now() + 61 * 60_000);
    await beginUpload(deps, actor, agentId, { name: 'b.bin', size: 10, mime: 'text/plain' }, later);
    assert.equal(await partExists(uploadId, 0), false);
    const rows = await withTenantTx(actor.tenantId, (tx) => tx.select().from(mcpUploads).where(eq(mcpUploads.id, uploadId)));
    assert.equal(rows.length, 0);
  });

  test('cancel removes the parts and is idempotent', async () => {
    const { uploadId } = await beginUpload(deps, actor, agentId, { name: 'a.bin', size: MiB + 1, mime: 'application/octet-stream' });
    await putChunk(deps, actor, agentId, uploadId, 0, b64(randomBytes(MiB)));
    await cancelUpload(deps, actor, agentId, uploadId);
    await cancelUpload(deps, actor, agentId, uploadId);
    assert.equal(await partExists(uploadId, 0), false);
    assert.equal(await refusal(putChunk(deps, actor, agentId, uploadId, 1, b64(randomBytes(1)))), 'Upload not found');
  });
});
