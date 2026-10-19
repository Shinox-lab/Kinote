import { randomUUID } from 'node:crypto';
import { documents, spaces, tenants, withTenantTx, type DocumentRow } from '@living-wiki/db';

export interface FileSeed {
  tenantId: string;
  spaceId: string;
  documentId: string;
  userId: string;
}

/** A tenant with one space and one (version-less) file document, written directly. */
export async function seedFileDocument(
  opts: { reviewRequired?: boolean; spaceKind?: 'normal' | 'inbox'; title?: string } = {}
): Promise<FileSeed> {
  const tenantId = randomUUID();
  const spaceId = randomUUID();
  const documentId = randomUUID();
  const userId = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
    await tx.insert(spaces).values({
      id: spaceId,
      tenantId,
      name: 's',
      slug: 's',
      kind: opts.spaceKind ?? 'normal',
      reviewRequired: opts.reviewRequired ?? false,
      createdBy: userId,
    });
    await tx.insert(documents).values({
      id: documentId,
      tenantId,
      spaceId,
      kind: 'file',
      title: opts.title ?? 'a.pdf',
      createdByType: 'user',
      createdBy: userId,
    });
  });
  return { tenantId, spaceId, documentId, userId };
}

export type { DocumentRow };
