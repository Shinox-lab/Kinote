import { and, count, desc, eq, isNull } from 'drizzle-orm';
import {
  sourceItems,
  sources,
  sourceTokens,
  spaces,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
} from '@living-wiki/db';
import {
  AppError,
  CreateSourceRequestSchema,
  CreateSourceTokenRequestSchema,
  UpdateSourceRequestSchema,
  type CreateSourceTokenResponse,
  type Source,
  type SourceToken,
} from '@living-wiki/contracts';
import { assertValidUuid, type Actor } from '@living-wiki/core';
import { mintSourceToken } from '../auth/sourceTokens.js';
import { requireTenantAdmin } from './admin.js';

type SourceRow = typeof sources.$inferSelect;
type TokenRow = typeof sourceTokens.$inferSelect;

const DAY_MS = 86_400_000;

const toToken = (r: TokenRow): SourceToken => ({
  id: r.id,
  name: r.name,
  prefix: r.tokenPrefix,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

/**
 * A space a source may deliver into: it exists in this tenant (404), is not the
 * Inbox (an Inbox item belongs to one person, a script has no owner: 400) and is
 * not archived (409).
 */
async function requireTargetSpace(tx: DbTransaction, tenantId: string, spaceId: string) {
  assertValidUuid(spaceId, 'space_not_found');
  const [space] = await tx
    .select()
    .from(spaces)
    .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, spaceId)));
  if (!space) throw new AppError('space_not_found');
  if (space.kind === 'inbox') {
    throw new AppError('validation_failed', 'A source cannot deliver into the Inbox. Choose a space.');
  }
  if (space.archivedAt) throw new AppError('space_archived');
  return space;
}

async function loadSource(tx: DbTransaction, tenantId: string, sourceId: string, lock = false): Promise<SourceRow> {
  assertValidUuid(sourceId, 'source_not_found');
  const query = tx
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('source_not_found');
  return row;
}

/** The admin-facing view of sources: target space name, live item count and tokens (newest first). */
async function viewSources(tx: DbTransaction, tenantId: string, only?: string): Promise<Source[]> {
  const rows = await tx
    .select({ source: sources, spaceName: spaces.name })
    .from(sources)
    .innerJoin(spaces, and(eq(spaces.tenantId, sources.tenantId), eq(spaces.id, sources.targetSpaceId)))
    .where(and(eq(sources.tenantId, tenantId), only ? eq(sources.id, only) : undefined))
    .orderBy(desc(sources.createdAt), desc(sources.id));
  if (rows.length === 0) return [];

  const counts = await tx
    .select({ sourceId: sourceItems.sourceId, n: count() })
    .from(sourceItems)
    .where(and(eq(sourceItems.tenantId, tenantId), isNull(sourceItems.deletedAt)))
    .groupBy(sourceItems.sourceId);
  const itemCount = new Map(counts.map((c) => [c.sourceId, Number(c.n)]));

  const tokens = await tx
    .select()
    .from(sourceTokens)
    .where(eq(sourceTokens.tenantId, tenantId))
    .orderBy(desc(sourceTokens.createdAt), desc(sourceTokens.id));
  const byId = new Map<string, SourceToken[]>();
  for (const t of tokens) byId.set(t.sourceId, [...(byId.get(t.sourceId) ?? []), toToken(t)]);

  return rows.map(({ source: s, spaceName }) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    targetSpaceId: s.targetSpaceId,
    targetSpaceName: spaceName,
    trusted: s.trusted,
    status: s.status,
    itemCount: itemCount.get(s.id) ?? 0,
    lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    tokens: byId.get(s.id) ?? [],
  }));
}

/** POST /api/v1/sources (tenant admin): a new, untrusted, active upload-API source. */
export async function createSource(actor: Actor, input: unknown): Promise<Source> {
  requireTenantAdmin(actor);
  const body = CreateSourceRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireTargetSpace(tx, actor.tenantId, body.target_space_id);
    const [row] = await tx
      .insert(sources)
      .values({
        tenantId: actor.tenantId,
        kind: 'upload_api',
        name: body.name,
        targetSpaceId: body.target_space_id,
        createdBy: actor.principalId,
      })
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'source.created',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'source',
      subjectId: row!.id,
      payload: { name: row!.name, targetSpaceId: row!.targetSpaceId },
    });
    return (await viewSources(tx, actor.tenantId, row!.id))[0]!;
  });
}

/** GET /api/v1/sources (tenant admin). */
export async function listSources(actor: Actor): Promise<Source[]> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, (tx) => viewSources(tx, actor.tenantId));
}

const snapshot = (s: SourceRow) => ({
  name: s.name,
  targetSpaceId: s.targetSpaceId,
  trusted: s.trusted,
  status: s.status,
});

/**
 * PATCH /api/v1/sources/:id (tenant admin): name, target space, trusted, status.
 * A new target moves future files only; `trusted` applies to files read from now on.
 */
export async function updateSource(actor: Actor, sourceId: string, input: unknown): Promise<Source> {
  requireTenantAdmin(actor);
  const body = UpdateSourceRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    const before = await loadSource(tx, actor.tenantId, sourceId, true);
    if (body.target_space_id !== undefined) await requireTargetSpace(tx, actor.tenantId, body.target_space_id);
    const [after] = await tx
      .update(sources)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.target_space_id !== undefined ? { targetSpaceId: body.target_space_id } : {}),
        ...(body.trusted !== undefined ? { trusted: body.trusted } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      })
      .where(and(eq(sources.tenantId, actor.tenantId), eq(sources.id, before.id)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'source.updated',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'source',
      subjectId: before.id,
      payload: { before: snapshot(before), after: snapshot(after!) },
    });
    return (await viewSources(tx, actor.tenantId, before.id))[0]!;
  });
}

/** POST /api/v1/sources/:id/tokens (tenant admin): the secret is in this reply and nowhere else, ever. */
export async function issueSourceToken(
  actor: Actor,
  sourceId: string,
  input: unknown
): Promise<CreateSourceTokenResponse> {
  requireTenantAdmin(actor);
  const body = CreateSourceTokenRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    const source = await loadSource(tx, actor.tenantId, sourceId);
    const minted = mintSourceToken(actor.tenantId);
    const [row] = await tx
      .insert(sourceTokens)
      .values({
        tenantId: actor.tenantId,
        sourceId: source.id,
        name: body.name,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
        expiresAt: body.expires_in_days ? new Date(Date.now() + body.expires_in_days * DAY_MS) : null,
        createdBy: actor.principalId,
      })
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'source.token_issued',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'source',
      subjectId: source.id,
      payload: { sourceId: source.id, tokenId: row!.id, name: row!.name },
    });
    return { token: minted.token, info: toToken(row!) };
  });
}

/** DELETE /api/v1/sources/:id/tokens/:tokenId (tenant admin): revokes; repeating it changes nothing. */
export async function revokeSourceToken(actor: Actor, sourceId: string, tokenId: string): Promise<SourceToken> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const source = await loadSource(tx, actor.tenantId, sourceId);
    assertValidUuid(tokenId, 'source_not_found');
    const [token] = await tx
      .select()
      .from(sourceTokens)
      .where(
        and(
          eq(sourceTokens.tenantId, actor.tenantId),
          eq(sourceTokens.sourceId, source.id),
          eq(sourceTokens.id, tokenId)
        )
      )
      .for('update');
    if (!token) throw new AppError('source_not_found');
    if (token.revokedAt) return toToken(token);
    const [revoked] = await tx
      .update(sourceTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(sourceTokens.tenantId, actor.tenantId), eq(sourceTokens.id, token.id)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'source.token_revoked',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'source',
      subjectId: source.id,
      payload: { sourceId: source.id, tokenId: token.id, name: token.name },
    });
    return toToken(revoked!);
  });
}
