import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AppError } from '@kinote/contracts';

export interface ObjectStorage {
  put(
    tenantId: string,
    relativePath: string,
    bytes: Uint8Array,
    mimeType: string
  ): Promise<{ objectKey: string; sizeBytes: number }>;
  get(tenantId: string, objectKey: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  delete(tenantId: string, objectKey: string): Promise<void>;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function reject(message: string): never {
  throw new AppError('document_not_found', message);
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !CANONICAL_UUID.test(tenantId)) {
    reject('Invalid tenant id for object storage.');
  }
}

// A `.` path segment: `/./`, a leading `./`, a trailing `/.`, or a bare `.`.
const DOT_SEGMENT = /(^|\/)\.(\/|$)/;

function assertSafePath(path: string): void {
  if (
    path.includes('..') ||
    path.includes('//') ||
    path.includes('\\') ||
    DOT_SEGMENT.test(path)
  ) {
    reject('Object key is not a valid tenant-relative path.');
  }
}

/**
 * Shared guard for every ObjectStorage implementation: the tenant id must be a
 * canonical lower-case UUID and the key must sit under `{tenantId}/` with no
 * traversal (`..`), `.` segment, doubled slash or backslash.
 */
export function assertTenantKey(tenantId: string, objectKey: string): void {
  assertTenantId(tenantId);
  const prefix = `${tenantId}/`;
  if (typeof objectKey !== 'string' || !objectKey.startsWith(prefix) || objectKey.length === prefix.length) {
    reject('Object key does not belong to tenant prefix.');
  }
  assertSafePath(objectKey);
}

/** Builds `{tenantId}/{relativePath}` (leading slashes stripped) and validates it. */
function buildKey(tenantId: string, relativePath: string): string {
  assertTenantId(tenantId);
  if (typeof relativePath !== 'string') reject('Invalid object path.');
  const clean = relativePath.replace(/^\/+/, '');
  assertSafePath(clean);
  const objectKey = `${tenantId}/${clean}`;
  assertTenantKey(tenantId, objectKey);
  return objectKey;
}

export class InMemoryObjectStorage implements ObjectStorage {
  private objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async put(tenantId: string, relativePath: string, bytes: Uint8Array, mimeType: string) {
    const objectKey = buildKey(tenantId, relativePath);
    this.objects.set(objectKey, { bytes: new Uint8Array(bytes), mimeType });
    return { objectKey, sizeBytes: bytes.byteLength };
  }

  async get(tenantId: string, objectKey: string) {
    assertTenantKey(tenantId, objectKey);
    const entry = this.objects.get(objectKey);
    if (!entry) reject('Object not found.');
    return { bytes: new Uint8Array(entry.bytes), mimeType: entry.mimeType };
  }

  async delete(tenantId: string, objectKey: string) {
    assertTenantKey(tenantId, objectKey);
    this.objects.delete(objectKey);
  }
}

export interface S3ObjectStorageOptions {
  endpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(o: S3ObjectStorageOptions) {
    this.bucket = o.bucket;
    this.client = new S3Client({
      region: o.region,
      credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
      ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    });
  }

  /** Creates the bucket when it does not exist yet (a fresh MinIO has none). Safe to call on every start. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (err as { name?: unknown }).name;
      if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') throw err;
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (created) {
        // Another process (the api and the worker start together) created it between the check and now.
        const createdName = (created as { name?: unknown }).name;
        if (createdName !== 'BucketAlreadyOwnedByYou' && createdName !== 'BucketAlreadyExists') throw created;
      }
    }
  }

  async put(tenantId: string, relativePath: string, bytes: Uint8Array, mimeType: string) {
    const objectKey = buildKey(tenantId, relativePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: mimeType,
        ContentLength: bytes.byteLength,
      })
    );
    return { objectKey, sizeBytes: bytes.byteLength };
  }

  async get(tenantId: string, objectKey: string) {
    assertTenantKey(tenantId, objectKey);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })
      );
      if (!res.Body) reject('Object not found.');
      const bytes = await res.Body.transformToByteArray();
      return { bytes, mimeType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Only a missing object is "not found". Any other 404 (NoSuchBucket: a
      // misconfigured deployment) or error surfaces as itself.
      const name = (err as { name?: unknown }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') reject('Object not found.');
      throw err;
    }
  }

  async delete(tenantId: string, objectKey: string) {
    assertTenantKey(tenantId, objectKey);
    // S3 DeleteObject succeeds for a missing key, matching the no-op contract.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}

/**
 * S3 storage from the service environment. Names every missing variable (never
 * a value). The endpoint is optional: without it the AWS default is used.
 */
export function createObjectStorage(config: {
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_REGION?: string;
}): S3ObjectStorage {
  const missing = (['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const).filter(
    (name) => !config[name]
  );
  if (missing.length > 0) {
    throw new Error(`Object storage is not configured: ${missing.join(', ')} (missing)`);
  }
  return new S3ObjectStorage({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET!,
    accessKey: config.S3_ACCESS_KEY!,
    secretKey: config.S3_SECRET_KEY!,
    region: config.S3_REGION ?? 'us-east-1',
  });
}
