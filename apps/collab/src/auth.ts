import { and, eq, isNull } from 'drizzle-orm';
import { withTenantTx, documents, pages, memberships, tenants } from '@living-wiki/db';
import { requireSpaceRole, type Actor } from '@living-wiki/core';
import { AppError } from '@living-wiki/contracts';
import { getCollabTokenSecret, parseDocumentName, verifyCollabToken } from '@living-wiki/shared';

export interface CollabContext {
  tenantId: string;
  pageId: string;
  spaceId: string;
  actorType: 'user' | 'agent';
  actorId: string;
  quietSeconds: number;
  /** True when the connection may read the page but must not change it. */
  readOnly: boolean;
}

/**
 * Authenticates a websocket connection to a page document.
 *
 * The token only proves who the holder is and what the API granted at issue
 * time (it lives five minutes). The role is always re-read from the database
 * here, so a holder demoted since issuance gets a read-only connection and a
 * removed holder is refused. Any failure throws; callers treat that as a
 * refused connection.
 *
 * Agents have no membership row and no agent authentication yet: for
 * `principalType: 'agent'` the membership lookup is skipped and permissions
 * come from the agent's space grants, capped by `requireSpaceRole`.
 *
 * `secret` is the collab token signing secret; the collab server passes the
 * one it was built with, other callers default to `COLLAB_TOKEN_SECRET`.
 */
export async function authenticateCollabConnection(
  token: string,
  documentNameRaw: string,
  secret: string = getCollabTokenSecret()
): Promise<CollabContext> {
  const doc = parseDocumentName(documentNameRaw);
  if (!doc) throw new AppError('page_not_found', 'Page not found.');

  const claims = verifyCollabToken(token, secret);
  if (
    !claims ||
    claims.tenantId !== doc.tenantId ||
    claims.pageId !== doc.pageId
  ) {
    throw new AppError('unauthenticated', 'Invalid collab token.');
  }
  const { tenantId, pageId } = doc;

  return withTenantTx(tenantId, async (tx) => {
    let tenantRole: Actor['tenantRole'] = 'member';
    if (claims.principalType === 'user') {
      const [membership] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, claims.principalId),
            eq(tenants.id, tenantId),
            isNull(tenants.deletedAt)
          )
        );
      if (!membership) throw new AppError('page_not_found', 'Page not found.');
      tenantRole = membership.role;
    }

    const actor: Actor = {
      tenantId,
      principalType: claims.principalType,
      principalId: claims.principalId,
      tenantRole,
    };

    const [row] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));

    if (!row || row.kind !== 'page') {
      throw new AppError('page_not_found', 'Page not found.');
    }

    const { space, effectiveRole } = await requireSpaceRole(tx, actor, row.spaceId, 'viewer');

    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    if (!page) {
      throw new AppError('page_not_found', 'Page not found.');
    }

    const canWrite = effectiveRole !== 'viewer';
    return {
      tenantId,
      pageId,
      spaceId: space.id,
      actorType: actor.principalType,
      actorId: actor.principalId,
      quietSeconds: space.quietSeconds,
      // Archived pages stay readable but are never live-edited.
      readOnly: claims.access === 'read' || !canWrite || row.archivedAt !== null,
    };
  });
}
