import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import { documents, spaces, tenants, versions, withTenantTx } from '../src/index.js';

describe('file columns on versions', () => {
  it('stores and returns the file columns; page versions leave them null', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const docId = randomUUID();
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` });
      await tx.insert(spaces).values({ id: spaceId, tenantId, name: 'S', slug: 's', createdBy: userId });
      await tx.insert(documents).values({
        id: docId, tenantId, spaceId, kind: 'file', title: 'a.pdf', createdByType: 'user', createdBy: userId,
      });
      await tx.insert(versions).values([
        {
          tenantId, documentId: docId, number: 1, title: 'a.pdf', status: 'extracting', contentHash: 'h1',
          reason: 'upload', createdByType: 'user', createdBy: userId,
          objectKey: `${tenantId}/files/${docId}/v/original`, fileName: 'a.pdf', mimeType: 'application/pdf',
          sizeBytes: 3_000_000_000, sourceRevision: 'rev-1', extractedKey: null,
        },
        {
          tenantId, documentId: docId, number: 2, title: 'a.pdf', status: 'indexing', contentHash: 'h2',
          reason: 'quiet', createdByType: 'user', createdBy: userId,
        },
      ]);
    });
    const rows = await withTenantTx(tenantId, (tx) =>
      tx.select().from(versions).where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, docId))).orderBy(versions.number)
    );
    expect(rows[0]).toMatchObject({
      fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3_000_000_000, sourceRevision: 'rev-1', extractedKey: null,
    });
    expect(rows[0]!.objectKey).toContain('/files/');
    expect(rows[1]).toMatchObject({ objectKey: null, fileName: null, mimeType: null, sizeBytes: null, sourceRevision: null, extractedKey: null });
  });
});
