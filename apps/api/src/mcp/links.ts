import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { documents, versions, withTenantTx, writeAuditEvent, type DocumentRow } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { blockMarkdown, readLiveBlocks, requireDocumentRole, type Actor } from '@kinote/core';
import {
  documentName,
  getCollabTokenSecret,
  signAgentLink,
  verifyAgentLink,
  type BlockLike,
  type CollabClient,
  type ObjectStorage,
} from '@kinote/shared';
import { agentActorByTokenId } from '../auth/actor.js';
import { encodeHeaderName, readableFileVersion } from '../routes/files.js';
import type { ToolContext } from './tool.js';

/** `<PUBLIC_URL>/api/v1/<path>/<token>`, whatever slashes PUBLIC_URL ends with (it may carry a sub-path). */
export function linkUrl(publicUrl: string, path: 'agent-files' | 'agent-uploads', token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/v1/${path}/${token}`;
}

export type DownloadTarget = { kind: 'file'; versionId: string } | { kind: 'page'; documentId: string; versionId: string | null };

/** A 15-minute link to one file version or page, for this agent and token only; null without PUBLIC_URL. */
export function downloadLink(ctx: Pick<ToolContext, 'actor' | 'agent' | 'deps'>, target: DownloadTarget): { url: string; expiresAt: Date } | null {
  if (!ctx.deps.publicUrl) return null;
  const { token, expiresAt } = signAgentLink(
    'agent-file',
    { tenantId: ctx.actor.tenantId, agentId: ctx.agent.agentId, tokenId: ctx.agent.tokenId, ...target },
    getCollabTokenSecret()
  );
  return { url: linkUrl(ctx.deps.publicUrl, 'agent-files', token), expiresAt };
}

/**
 * A page as one Markdown file: `# <title>` and every block's Markdown, no block ids. The live page, or a saved
 * version (below editor only the indexed one). The caller checked the actor may read the page.
 */
export async function pageMarkdown(
  actor: Actor,
  doc: DocumentRow,
  versionId: string | null,
  role: 'viewer' | 'editor' | 'reviewer' | 'admin'
): Promise<{ title: string; markdown: string }> {
  const { title, blocks } = await withTenantTx(actor.tenantId, async (tx) => {
    if (versionId === null) {
      const live = await readLiveBlocks(tx, actor.tenantId, doc.id);
      if (live) return { title: live.title || doc.title, blocks: live.blocks };
    }
    const id = versionId ?? doc.latestVersionId;
    if (id === null) return { title: doc.title, blocks: [] as BlockLike[] };
    if (versionId !== null && role === 'viewer' && doc.indexedVersionId !== versionId) throw new AppError('version_not_found');
    const [v] = await tx
      .select({ title: versions.title, blocks: versions.blocks })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, id), eq(versions.documentId, doc.id)));
    if (!v) throw new AppError('version_not_found');
    return { title: v.title, blocks: Array.isArray(v.blocks) ? (v.blocks as BlockLike[]) : [] };
  });
  const parts = await Promise.all(blocks.map((b) => blockMarkdown(b)));
  return { title, markdown: `# ${title}\n\n${parts.join('\n\n')}\n` };
}

/** Thrown for every refusal of a link route: the answer is the same 404 whatever the reason. */
export class LinkNotFound extends Error {}

/**
 * GET /api/v1/agent-files/:token: the bytes behind an agent's download link. Every request re-checks the token
 * row, the agent, its owner and its access as a reader; any failure is `LinkNotFound`. Each fetch is audited.
 */
export async function serveAgentFile(
  token: string,
  deps: { storage: ObjectStorage; collab?: CollabClient }
): Promise<{ stream: Readable; headers: Record<string, string> }> {
  const claims = verifyAgentLink('agent-file', token, getCollabTokenSecret());
  if (!claims || claims.kind === 'upload') throw new LinkNotFound();
  const who = await agentActorByTokenId(claims.tenantId, claims.tokenId);
  if (!who || who.agent.agentId !== claims.agentId) throw new LinkNotFound();
  const { actor } = who;
  try {
    if (claims.kind === 'file') {
      const { ver } = await withTenantTx(actor.tenantId, (tx) => readableFileVersion(tx, actor, claims.versionId, 'viewer'));
      const { stream, sizeBytes } = await deps.storage.getStream(actor.tenantId, ver.objectKey!);
      const mime = ver.mimeType ?? 'application/octet-stream';
      await audit(actor, claims.tokenId, { versionId: ver.id });
      return {
        stream,
        headers: {
          ...(sizeBytes > 0 ? { 'content-length': String(sizeBytes) } : {}),
          'content-type': mime.startsWith('text/') ? 'text/plain; charset=utf-8' : mime,
          ...downloadHeaders(ver.fileName ?? ver.title),
          etag: `"${ver.contentHash}"`,
        },
      };
    }
    const { doc, role } = await withTenantTx(actor.tenantId, async (tx) => {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, claims.documentId)));
      if (!doc || doc.kind !== 'page' || doc.archivedAt) throw new AppError('page_not_found');
      const access = await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'page_not_found' });
      return { doc, role: access.effectiveRole };
    });
    if (claims.versionId === null && deps.collab) {
      await deps.collab.flush(documentName(actor.tenantId, doc.id)).catch(() => undefined);
    }
    const { title, markdown } = await pageMarkdown(actor, doc, claims.versionId, role);
    const bytes = Buffer.from(markdown, 'utf8');
    await audit(actor, claims.tokenId, { documentId: doc.id, versionId: claims.versionId });
    return {
      stream: Readable.from([bytes]),
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'text/markdown; charset=utf-8',
        ...downloadHeaders(`${title}.md`),
      },
    };
  } catch (err) {
    if (err instanceof AppError) throw new LinkNotFound();
    throw err;
  }
}

const downloadHeaders = (name: string) => ({
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox',
  'cache-control': 'no-store',
  'content-disposition': `attachment; filename*=UTF-8''${encodeHeaderName(name)}`,
});

export async function audit(actor: Actor, tokenId: string, payload: Record<string, unknown>, type: 'mcp.link_fetch' | 'mcp.link_upload' = 'mcp.link_fetch') {
  await withTenantTx(actor.tenantId, (tx) =>
    writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type,
      actorType: 'agent',
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: actor.principalId,
      payload: { tokenId, ...payload },
    })
  );
}
