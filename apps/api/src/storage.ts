import { AppError } from '@living-wiki/contracts';
export class TenantObjectStorage {
  private buckets = new Map<string, { bytes: Buffer; mimeType: string }>();

  private assertTenantKey(tenantId: string, objectKey: string) {
    if (!objectKey.startsWith(`${tenantId}/`) || objectKey.includes('..')) {
      throw new AppError('document_not_found', 'Object key does not belong to tenant prefix.');
    }
  }

  async putObject(tenantId: string, relativePath: string, bytes: Buffer, mimeType: string) {
    const cleanRelative = relativePath.replace(/^\/+/, '');
    const objectKey = `${tenantId}/${cleanRelative}`;
    this.assertTenantKey(tenantId, objectKey);
    this.buckets.set(objectKey, { bytes: Buffer.from(bytes), mimeType });
    return { objectKey, sizeBytes: bytes.byteLength };
  }

  async getObject(tenantId: string, objectKey: string) {
    this.assertTenantKey(tenantId, objectKey);
    const entry = this.buckets.get(objectKey);
    if (!entry) {
      throw new AppError('document_not_found', 'Object not found.');
    }
    return entry;
  }

  async deleteObject(tenantId: string, objectKey: string) {
    this.assertTenantKey(tenantId, objectKey);
    this.buckets.delete(objectKey);
  }
}

export const objectStorage = new TenantObjectStorage();
