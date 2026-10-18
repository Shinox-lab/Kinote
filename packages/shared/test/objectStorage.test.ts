import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryObjectStorage,
  S3ObjectStorage,
  type ObjectStorage,
} from '../src/index.js';

const s3Configured = Boolean(process.env.S3_ENDPOINT);

const implementations: Array<{
  name: string;
  skip: boolean;
  make: () => ObjectStorage;
}> = [
  { name: 'InMemoryObjectStorage', skip: false, make: () => new InMemoryObjectStorage() },
  {
    name: 'S3ObjectStorage',
    skip: !s3Configured,
    make: () =>
      new S3ObjectStorage({
        endpoint: process.env.S3_ENDPOINT,
        bucket: process.env.S3_BUCKET ?? 'living-wiki',
        accessKey: process.env.S3_ACCESS_KEY ?? '',
        secretKey: process.env.S3_SECRET_KEY ?? '',
        region: process.env.S3_REGION ?? 'us-east-1',
      }),
  },
];

const bytesOf = (s: string) => new TextEncoder().encode(s);
const notFound = { code: 'document_not_found' };

describe.each(implementations)('ObjectStorage contract: $name', ({ skip, make }) => {
  describe.skipIf(skip)('contract', () => {
    const storage = make();
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    it('put then get returns identical bytes and mime type', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
      const stored = await storage.put(tenantA, `uploads/${randomUUID()}.bin`, bytes, 'application/octet-stream');
      expect(stored.objectKey.startsWith(`${tenantA}/`)).toBe(true);
      expect(stored.sizeBytes).toBe(6);
      const got = await storage.get(tenantA, stored.objectKey);
      expect(Array.from(got.bytes)).toEqual(Array.from(bytes));
      expect(got.mimeType).toBe('application/octet-stream');
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

describe('S3 contract gating', () => {
  it('is skipped (not failed) when S3_ENDPOINT is unset', () => {
    expect(implementations.find((i) => i.name === 'S3ObjectStorage')?.skip).toBe(!s3Configured);
  });
});
