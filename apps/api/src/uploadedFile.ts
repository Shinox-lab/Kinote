// An uploaded file, as the upload routes see it: its size, SHA-256, first
// bytes and (for zip-based formats) zip directory are known up front, and its
// bytes are read through once into storage. A multipart upload is written to a
// private temporary file as it arrives, hashed and counted on the way, so a
// large upload costs disk, not memory.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, readSync, closeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DETECT_HEAD_BYTES, listZipEntries, listZipEntriesFrom } from '@kinote/core';

export interface UploadedFile {
  name: string;
  sizeBytes: number;
  /** SHA-256 of the bytes, hex. */
  contentHash: string;
  /** The first DETECT_HEAD_BYTES bytes (all of them for a smaller file). */
  head: Uint8Array;
  /** The entry names of the file's zip directory, read on demand; null when it isn't a zip. */
  zipEntries(): string[] | null;
  /** The bytes, from the start. */
  open(): Readable | Uint8Array;
  /** Removes what the file left on disk. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** An UploadedFile from bytes already in memory (tests, small internal callers). */
export function bytesFile(name: string, bytes: Uint8Array): UploadedFile {
  return {
    name,
    sizeBytes: bytes.byteLength,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    head: bytes.subarray(0, DETECT_HEAD_BYTES),
    zipEntries: () => listZipEntries(bytes),
    open: () => bytes,
    dispose: async () => undefined,
  };
}

/**
 * Writes `stream` to a new file in a private (0700) temporary directory,
 * hashing and counting it on the way. The directory is removed again if
 * writing fails; otherwise the caller disposes of it.
 */
export async function spoolUpload(name: string, stream: Readable, dir: string = tmpdir()): Promise<UploadedFile> {
  const folder = await mkdtemp(join(dir, 'kinote-upload-'));
  const path = join(folder, 'file');
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
      if (headBytes < DETECT_HEAD_BYTES) {
        const take = chunk.subarray(0, DETECT_HEAD_BYTES - headBytes);
        headChunks.push(Buffer.from(take));
        headBytes += take.byteLength;
      }
      done(null, chunk);
    },
  });
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    await pipeline(stream, tap, createWriteStream(path, { mode: 0o600 }));
  } catch (err) {
    await dispose();
    throw err;
  }

  return {
    name,
    sizeBytes,
    contentHash: hash.digest('hex'),
    head: new Uint8Array(Buffer.concat(headChunks)),
    zipEntries: () => {
      const fd = openSync(path, 'r');
      try {
        return listZipEntriesFrom((offset, length) => {
          const buf = Buffer.alloc(length);
          const read = readSync(fd, buf, 0, length, offset);
          return new Uint8Array(buf.buffer, buf.byteOffset, read);
        }, sizeBytes);
      } finally {
        closeSync(fd);
      }
    },
    open: () => createReadStream(path),
    dispose,
  };
}
