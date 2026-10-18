import { and, eq } from 'drizzle-orm';
import { withTenantTx, documents, pages } from '@living-wiki/db';
import { requireSpaceRole, type Actor } from '@living-wiki/core';

export interface CollabContext {
  tenantId: string;
  pageId: string;
  spaceId: string;
  actorType: 'user' | 'agent';
  actorId: string;
  quietSeconds: number;
}

export async function verifyCollabToken(
  token: string,
  tenantId: string,
  pageId: string
): Promise<CollabContext> {
  // Token format in v1/tests: "{principalType}:{principalId}:{tenantRole}"
  const [principalTypeRaw, principalId, tenantRoleRaw] = token.split(':');
  const actor: Actor = {
    tenantId,
    principalType: principalTypeRaw === 'agent' ? 'agent' : 'user',
    principalId: principalId ?? '',
    tenantRole: (tenantRoleRaw as Actor['tenantRole']) ?? 'member',
  };

  return withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page' || doc.archivedAt) {
      throw { statusCode: 404, error: 'page_not_found', message: 'Page not found.' };
    }

    const { space } = await requireSpaceRole(tx, actor, doc.spaceId, 'editor');

    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    if (!page) {
      throw { statusCode: 404, error: 'page_not_found', message: 'Page not found.' };
    }

    return {
      tenantId,
      pageId,
      spaceId: space.id,
      actorType: actor.principalType,
      actorId: actor.principalId,
      quietSeconds: space.quietSeconds,
    };
  });
}
