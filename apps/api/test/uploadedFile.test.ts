import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { InMemoryObjectStorage } from '@kinote/shared';
import { listZipEntries } from '@kinote/core';
import { bytesFile, spoolUpload } from '../src/uploadedFile.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

async function readAll(body: Readable | Uint8Array): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** A stream of `bytes` in uneven chunks, as a network would deliver them. */
function chunked(bytes: Uint8Array): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0, n = 1; at < bytes.length; at += n, n = (n * 7 + 3) % 5000 || 1) yield Buffer.from(bytes.subarray(at, at + n));
    })()
  );
}

/** A minimal zip (empty stored entries) with the given names. */
function zipOf(names: string[], padding = 0): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = enc.encode(name);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    local.set(n, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const pad = Buffer.alloc(padding);
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset + padding, 16);
  return new Uint8Array(Buffer.concat([...locals, pad, cd, end]));
}

describe('spooling an upload to disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kinote-spool-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('knows the size, hash and head up front, reads back the same bytes, and cleans up', async () => {
    const bytes = new Uint8Array(randomBytes(300_000));
    const file = await spoolUpload('data.bin', chunked(bytes), dir);
    const inMemory = bytesFile('data.bin', bytes);

    expect(file.sizeBytes).toBe(bytes.length);
    expect(file.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(file.contentHash).toBe(inMemory.contentHash);
    expect(Buffer.compare(Buffer.from(file.head), Buffer.from(inMemory.head))).toBe(0);
    // Each open reads from the start (a source upload may store it twice).
    expect(Buffer.compare(await readAll(file.open()), Buffer.from(bytes))).toBe(0);
    expect(Buffer.compare(await readAll(file.open()), Buffer.from(bytes))).toBe(0);

    const [folder] = await readdir(dir);
    expect((await stat(join(dir, folder!))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, folder!, 'file'))).mode & 0o777).toBe(0o600);

    await file.dispose();
    await file.dispose();
    expect(await readdir(dir)).toEqual([]);
  });

  test('reads a zip directory from disk, however far into the file it is', async () => {
    const zip = zipOf(['[Content_Types].xml', 'xl/workbook.xml'], 1_000_000);
    const file = await spoolUpload('book.xlsx', chunked(zip), dir);
    expect(file.zipEntries()).toEqual(['[Content_Types].xml', 'xl/workbook.xml']);
    expect(file.zipEntries()).toEqual(listZipEntries(zip));
    await file.dispose();
  });

  test('a stream that fails leaves nothing behind', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(10_000, 7));
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(spoolUpload('x.bin', failing, dir)).rejects.toThrow('connection reset');
    expect(await readdir(dir)).toEqual([]);
  });

  test('an empty upload is size 0 with an empty head', async () => {
    const file = await spoolUpload('empty.txt', Readable.from([]), dir);
    expect(file.sizeBytes).toBe(0);
    expect(file.head.length).toBe(0);
    await file.dispose();
  });
});

describe('upload routes leave no temporary files', () => {
  useTestDb();
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kinote-upload-route-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('after a stored upload, a duplicate, a refused type, a file too large and an Office file', async () => {
    const storage = new InMemoryObjectStorage();
    const app = buildTestApp({ storage, maxUploadBytes: 100_000, uploadTmpDir: dir });
    const { headers } = await bootstrapTenant(app, { name: 'Spool Co', slug: 'spool-co' });

    const ok = await app.inject(uploadRequest('/api/v1/files', headers, { name: 'notes.txt', data: 'hello' }));
    expect(ok.statusCode).toBe(201);
    expect(await readdir(dir)).toEqual([]);

    const again = await app.inject(uploadRequest('/api/v1/files', headers, { name: 'notes.txt', data: 'hello' }));
    expect(again.statusCode).toBe(200);
    expect(again.json().unchanged).toBe(true);
    expect(await readdir(dir)).toEqual([]);

    const svg = await app.inject(uploadRequest('/api/v1/files', headers, { name: 'x.svg', data: '<svg></svg>' }));
    expect(svg.statusCode).toBe(415);
    expect(await readdir(dir)).toEqual([]);

    const big = await app.inject(uploadRequest('/api/v1/files', headers, { name: 'big.txt', data: 'a'.repeat(200_000) }));
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('file_too_large');
    expect(await readdir(dir)).toEqual([]);

    // A large Office file is recognised from its zip directory, read from disk.
    const xlsx = zipOf(['[Content_Types].xml', 'xl/workbook.xml'], 60_000);
    const sheet = await app.inject(uploadRequest('/api/v1/files', headers, { name: 'book.xlsx', data: xlsx }));
    expect(sheet.statusCode).toBe(201);
    expect(sheet.json().version.sizeBytes).toBe(xlsx.length);
    expect(await readdir(dir)).toEqual([]);
  });
});
