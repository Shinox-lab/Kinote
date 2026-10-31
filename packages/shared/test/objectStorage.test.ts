import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  InMemoryObjectStorage,
  S3ObjectStorage,
  type ObjectStorage,
} from '../src/index.js';

// The S3 case runs against a real endpoint (the MinIO of docker-compose.yml)
// only when S3_ENDPOINT is set; the bucket is created if missing.
const s3Configured = Boolean(process.env.S3_ENDPOINT);

function s3Options(bucket: string) {
  return {
    endpoint: process.env.S3_ENDPOINT,
    bucket,
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
  };
}

async function ensureBucket(bucket: string): Promise<void> {
  const o = s3Options(bucket);
  const client = new S3Client({
    region: o.region,
    endpoint: o.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

const implementations: Array<{
  name: string;
  skip: boolean;
  make: () => Promise<ObjectStorage>;
}> = [
  { name: 'InMemoryObjectStorage', skip: false, make: async () => new InMemoryObjectStorage() },
  {
    name: 'S3ObjectStorage',
    skip: !s3Configured,
    make: async () => {
      const bucket = process.env.S3_BUCKET ?? 'kinote';
      await ensureBucket(bucket);
      return new S3ObjectStorage(s3Options(bucket));
    },
  },
];

const bytesOf = (s: string) => new TextEncoder().encode(s);
const notFound = { code: 'document_not_found' };

describe.each(implementations)('ObjectStorage contract: $name', ({ skip, make }) => {
  describe.skipIf(skip)('contract', () => {
    // Built in beforeAll, not at collection time, so a skipped or filtered
    // run never constructs an S3 client.
    let storage: ObjectStorage;
    beforeAll(async () => {
      storage = await make();
    });
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    it('put then get returns identical bytes and mime type', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
      // A distinctive type under a key whose extension does not imply it: a
      // dropped ContentType would read back as a default (or a type guessed
      // from the extension) and fail this assertion.
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.bin`, bytes, 'application/pdf');
      expect(stored.objectKey.startsWith(`${tenantA}/`)).toBe(true);
      expect(stored.sizeBytes).toBe(6);
      const got = await storage.get(tenantA, stored.objectKey);
      expect(Array.from(got.bytes)).toEqual(Array.from(bytes));
      expect(got.mimeType).toBe('application/pdf');
    });

    it('stores a multi-part body (above one 8 MiB part) byte for byte', async () => {
      const bytes = new Uint8Array(20 * 1024 * 1024 + 7);
      for (let i = 0; i < bytes.length; i += 4099) bytes[i] = (i / 4099) % 251;
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.mp4`, bytes, 'video/mp4');
      expect(stored.sizeBytes).toBe(bytes.byteLength);
      const got = await storage.get(tenantA, stored.objectKey);
      expect(got.bytes.byteLength).toBe(bytes.byteLength);
      expect(Buffer.compare(Buffer.from(got.bytes), Buffer.from(bytes))).toBe(0);
    }, 60_000);

    it('getRange returns just the requested bytes, clamped to the object', async () => {
      const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.mp3`, bytes, 'audio/mpeg');
      expect(Array.from(await storage.getRange(tenantA, stored.objectKey, 10, 19))).toEqual(Array.from(bytes.slice(10, 20)));
      expect(Array.from(await storage.getRange(tenantA, stored.objectKey, 95, 500))).toEqual(Array.from(bytes.slice(95)));
      await expect(storage.getRange(tenantB, stored.objectKey, 0, 1)).rejects.toThrow();
    });

    it('sizeBytes is the byte length, not the character count', async () => {
      const bytes = bytesOf('héllo wörld');
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.txt`, bytes, 'text/plain');
      expect(stored.sizeBytes).toBe(bytes.byteLength);
      expect(stored.sizeBytes).toBeGreaterThan('héllo wörld'.length);
    });

    it("tenant A cannot read tenant B's key", async () => {
      const stored = await storage.put(tenantB, `uploads/${randomUUID()}.pdf`, bytesOf('B-SECRET'), 'application/pdf');
      await expect(storage.get(tenantA, stored.objectKey)).rejects.toMatchObject(notFound);
      await expect(storage.delete(tenantA, stored.objectKey)).rejects.toMatchObject(notFound);
      const still = await storage.get(tenantB, stored.objectKey);
      expect(new TextDecoder().decode(still.bytes)).toBe('B-SECRET');
    });

    it.each([
      ['dot-dot', (t: string) => `${t}/../${randomUUID()}/x`],
      ['trailing dot-dot', (t: string) => `${t}/uploads/..`],
      ['double slash', (t: string) => `${t}//x`],
      ['inner double slash', (t: string) => `${t}/a//x`],
      ['backslash', (t: string) => `${t}/a\\x`],
      ['dot segment', (t: string) => `${t}/a/./x`],
      ['leading dot segment', (t: string) => `${t}/./x`],
      ['trailing dot', (t: string) => `${t}/uploads/.`],
      ['outside prefix', () => `${randomUUID()}/x`],
      ['bare tenant id', (t: string) => t],
    ])('rejects a %s key for get and delete', async (_label, keyFor) => {
      const key = keyFor(tenantA);
      await expect(storage.get(tenantA, key)).rejects.toMatchObject(notFound);
      await expect(storage.delete(tenantA, key)).rejects.toMatchObject(notFound);
    });

    it.each([
      ['dot-dot', '../x'],
      ['inner dot-dot', 'a/../x'],
      ['double slash', 'a//x'],
      ['backslash', 'a\\x'],
      ['dot segment', 'a/./x'],
      ['leading dot segment', './x'],
      ['trailing dot', 'uploads/.'],
      ['bare dot', '.'],
      ['empty', ''],
    ])('rejects a %s relative path on put', async (_label, rel) => {
      await expect(storage.put(tenantA, rel, bytesOf('x'), 'text/plain')).rejects.toMatchObject(notFound);
    });

    it('normalizes a leading-slash relative path', async () => {
      const name = `${randomUUID()}.txt`;
      const stored = await storage.put(tenantA, `//uploads/${name}`, bytesOf('hi'), 'text/plain');
      expect(stored.objectKey).toBe(`${tenantA}/uploads/${name}`);
      const got = await storage.get(tenantA, stored.objectKey);
      expect(new TextDecoder().decode(got.bytes)).toBe('hi');
    });

    it('delete then get throws; delete of a missing key is a no-op', async () => {
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.txt`, bytesOf('gone'), 'text/plain');
      await storage.delete(tenantA, stored.objectKey);
      await expect(storage.get(tenantA, stored.objectKey)).rejects.toMatchObject(notFound);
      await expect(storage.delete(tenantA, stored.objectKey)).resolves.toBeUndefined();
    });

    it('get of a never-written key throws document_not_found', async () => {
      await expect(storage.get(tenantA, `${tenantA}/uploads/${randomUUID()}`)).rejects.toMatchObject(notFound);
    });

    it.each([
      ['non-uuid', 'tenant-a'],
      ['path-widening', 'a/../b'],
      ['upper-case uuid', randomUUID().toUpperCase()],
      ['empty', ''],
    ])('rejects a %s tenant id', async (_label, bad) => {
      await expect(storage.put(bad, 'x', bytesOf('x'), 'text/plain')).rejects.toMatchObject(notFound);
      await expect(storage.get(bad, `${bad}/x`)).rejects.toMatchObject(notFound);
      await expect(storage.delete(bad, `${bad}/x`)).rejects.toMatchObject(notFound);
    });
  });
});

describe('InMemoryObjectStorage', () => {
  it('copies bytes on put and on get', async () => {
    const storage = new InMemoryObjectStorage();
    const tenant = randomUUID();
    const bytes = bytesOf('abc');
    const { objectKey } = await storage.put(tenant, 'f.txt', bytes, 'text/plain');
    bytes[0] = 0;
    const first = await storage.get(tenant, objectKey);
    expect(new TextDecoder().decode(first.bytes)).toBe('abc');
    first.bytes[0] = 0;
    const second = await storage.get(tenant, objectKey);
    expect(new TextDecoder().decode(second.bytes)).toBe('abc');
  });
});

describe('S3ObjectStorage error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tenant = randomUUID();
  const key = `${tenant}/uploads/x.pdf`;
  const storage = () =>
    new S3ObjectStorage({ bucket: 'b', accessKey: 'k', secretKey: 's', region: 'us-east-1' });
  const s3Error = (name: string, status: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it.each([
    ['NoSuchKey', 404],
    ['NotFound', 404],
  ])('maps %s to document_not_found', async (name, status) => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(s3Error(name, status) as never);
    await expect(storage().get(tenant, key)).rejects.toMatchObject(notFound);
  });

  it.each([
    ['NoSuchBucket', 404],
    ['SomeOther404', 404],
    ['AccessDenied', 403],
  ])('surfaces %s as a normal error, not document_not_found', async (name, status) => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(s3Error(name, status) as never);
    const err = await storage().get(tenant, key).catch((e: unknown) => e);
    expect(err).toMatchObject({ name });
    expect(err).not.toMatchObject(notFound);
  });
});

describe.skipIf(!s3Configured)('S3ObjectStorage against a real endpoint', () => {
  it('a missing bucket is an error, not document_not_found', async () => {
    const storage = new S3ObjectStorage(s3Options(`missing-${randomUUID()}`));
    const tenant = randomUUID();
    const err = await storage.get(tenant, `${tenant}/uploads/x`).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'NoSuchBucket' });
    expect(err).not.toMatchObject(notFound);
  });
});
