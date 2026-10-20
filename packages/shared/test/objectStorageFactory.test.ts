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

describe('S3ObjectStorage.ensureBucket with a client that races another creator', () => {
  const storageWith = (send: (cmd: { constructor: { name: string } }) => Promise<unknown>) => {
    const storage = createObjectStorage({
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_BUCKET: 'lw-race',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
      S3_REGION: 'us-east-1',
    }) as unknown as { ensureBucket(): Promise<void>; client: { send: typeof send } };
    storage.client = { send };
    return storage;
  };
  const missing = () => Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

  it.each(['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'])('is fine when the bucket appears meanwhile (%s)', async (name) => {
    const calls: string[] = [];
    const storage = storageWith(async (cmd) => {
      calls.push(cmd.constructor.name);
      if (cmd.constructor.name === 'HeadBucketCommand') throw missing();
      throw Object.assign(new Error('exists'), { name });
    });
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    expect(calls).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
  });

  it('still fails for any other error', async () => {
    const storage = storageWith(async (cmd) => {
      if (cmd.constructor.name === 'HeadBucketCommand') throw missing();
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    await expect(storage.ensureBucket()).rejects.toThrow('denied');
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
