import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3ObjectStorage, createObjectStorage } from '../src/index.js';

const complete = {
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_BUCKET: 'living-wiki',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_REGION: 'us-east-1',
};

describe('createObjectStorage', () => {
  it('builds S3 storage from a complete configuration', () => {
    expect(createObjectStorage(complete)).toBeInstanceOf(S3ObjectStorage);
  });

  it('names every missing variable and never a value', () => {
    expect(() => createObjectStorage({ ...complete, S3_BUCKET: undefined })).toThrow(/S3_BUCKET/);
    try {
      createObjectStorage({ ...complete, S3_BUCKET: undefined, S3_SECRET_KEY: undefined });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/S3_BUCKET/);
      expect(message).toMatch(/S3_SECRET_KEY/);
      expect(message).not.toMatch(/secret'|key'/);
    }
  });
});

// Runs against the MinIO of docker-compose.yml only when S3_ENDPOINT is set.
describe.skipIf(!process.env.S3_ENDPOINT)('S3ObjectStorage.ensureBucket', () => {
  it('creates a missing bucket, is repeatable and then stores objects', async () => {
    const storage = createObjectStorage({
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_BUCKET: `lw-ensure-${randomUUID().slice(0, 8)}`,
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
      S3_SECRET_KEY: process.env.S3_SECRET_KEY,
      S3_REGION: process.env.S3_REGION ?? 'us-east-1',
    });
    await storage.ensureBucket();
    await storage.ensureBucket();
    const tenantId = randomUUID();
    const { objectKey } = await storage.put(tenantId, 'files/x', new Uint8Array([1, 2, 3]), 'text/plain');
    expect((await storage.get(tenantId, objectKey)).bytes).toEqual(new Uint8Array([1, 2, 3]));
    await storage.delete(tenantId, objectKey);
  });
});
