import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { spaces, withTenantTx, type DocumentRow } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { currentFileVersion, fileReviewDecision, requireDocumentRole, type VersionRow } from '@kinote/core';
import { baseConflictMessage, detect, replaceFile } from '../../routes/files.js';
import { bytesFile, type UploadedFile } from '../../uploadedFile.js';
import { pageLink, shortId } from '../format.js';
import { uploadLink } from '../links.js';
import { beginLinkUpload, cancelUpload, takeUpload } from '../upload/store.js';
import { shellQuote } from './download.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext, type ToolOutput } from '../tool.js';
import { INLINE_BYTES } from './download.js';
import { formatSize } from './read.js';

const EMPTY = 'The file is empty.';
const TOO_BIG =
  'This is over 256 KiB, too big to send inline. Call kinote_replace with page_id and base_version only to get an upload link.';
const NO_AV = "Kinote can't take audio or video from an agent; a person can replace it in Kinote.";
const NO_STORAGE = 'This server has no file storage configured.';

/** A file's type word (`csv`, `png`) from its name, as detection keys it. */
const typeOfName = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'file');

/** The file the agent may replace, its current version and its space's name; a refusal the agent can read otherwise. */
export async function replaceTarget(ctx: ToolContext, pageId: string): Promise<{ doc: DocumentRow; current: VersionRow | null; spaceName: string }> {
  const { actor } = ctx;
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await resolvePageRef(tx, actor, pageId);
    ctx.touch([doc.id]);
    if (doc.kind === 'page') throw new ToolError('Pages change with kinote_edit.');
    const access = await requireDocumentRole(tx, actor, doc, 'viewer');
    if (access.effectiveRole === 'viewer') throw new ToolError('No edit access: a person can change it.');
    if (doc.placement === 'synced') throw new AppError('managed_by_source');
    return { doc, current: await currentFileVersion(tx, actor.tenantId, doc.id), spaceName: access.space.name };
  });
}

/**
 * Adds the bytes as the file's next version, after the checks an agent's replace needs: not audio or video,
 * the same type as the current version, then `replaceFile` with the base (same bytes → unchanged, a moved base →
 * the conflict naming the current version). The result names the new version and what happens to it next.
 */
export async function commitReplace(
  ctx: ToolContext,
  target: { doc: DocumentRow; current: VersionRow | null; spaceName: string },
  file: UploadedFile,
  baseVersion: number
): Promise<ToolOutput> {
  const { actor, deps } = ctx;
  if (file.sizeBytes === 0) throw new ToolError(EMPTY);
  if (!deps.storage) throw new ToolError(NO_STORAGE);
  const detected = detect(file);
  if (detected.handling === 'stored') throw new ToolError(NO_AV);
  const { doc, current } = target;
  // The type the server detected at upload is the file's type: other bytes are a different file.
  if (current?.mimeType && current.mimeType !== detected.mimeType) {
    throw new ToolError(`This is a ${detected.extension} but the file is a ${typeOfName(current.fileName ?? doc.title)}. Add it as a new file with kinote_upload.`);
  }
  const out = await replaceFile(actor, doc.id, file, { storage: deps.storage }, { baseVersion });
  const ver = out.response.version;
  if (out.status === 'unchanged') return { text: `Unchanged: this is already v${ver.number}.`, structured: { page_id: doc.id, version: ver.number, status: ver.status } };
  const held = await withTenantTx(actor.tenantId, (tx) =>
    fileReviewDecision(tx, { tenantId: actor.tenantId, spaceId: doc.spaceId, createdByType: 'agent', createdBy: actor.principalId })
  );
  const next = held ? `waiting for review in ${target.spaceName}` : ver.status === 'stored' ? 'stored (no text)' : 'being read';
  const link = pageLink(ctx.agent, deps.publicUrl, doc.id, 'file');
  return {
    text: [`Replaced: ${ver.fileName} is now v${ver.number} (was v${baseVersion}) · ${next}`, ...(link ? [link] : [])].join('\n'),
    structured: { page_id: doc.id, version: ver.number, status: ver.status },
  };
}

/**
 * The no-content call: checks the base now (so a stale agent learns before uploading), then stages an upload
 * row for this file and answers a 15-minute PUT link. Nothing is written until the call with upload_id.
 */
async function uploadLinkFor(
  ctx: ToolContext,
  target: { doc: DocumentRow; current: VersionRow | null },
  fileName: string,
  baseVersion: number
): Promise<ToolOutput> {
  const { actor, deps } = ctx;
  if ((target.current?.number ?? 0) !== baseVersion) {
    throw new ToolError(await withTenantTx(actor.tenantId, (tx) => baseConflictMessage(tx, actor.tenantId, target.current, baseVersion)));
  }
  if (!deps.publicUrl) throw new ToolError('This server has no PUBLIC_URL, so it cannot give upload links. Send content_text or content_base64 (up to 256 KiB).');
  if (!deps.storage) throw new ToolError(NO_STORAGE);
  const { uploadId } = await beginLinkUpload(deps, actor, ctx.agent.agentId, {
    documentId: target.doc.id,
    name: fileName,
    mime: target.current?.mimeType ?? 'application/octet-stream',
  });
  const link = uploadLink(ctx, uploadId);
  if (!link) {
    await cancelUpload(deps, actor, ctx.agent.agentId, uploadId);
    throw new ToolError(NO_STORAGE);
  }
  const max = deps.maxUploadBytes ?? 52_428_800;
  return {
    text: [
      `Upload link (15 minutes, one file up to ${formatSize(max)}): ${link.url}`,
      `Send with: curl -fT ${shellQuote(fileName)} ${shellQuote(link.url)}`,
      `Then call kinote_replace with page_id ${shortId(target.doc.id)}, base_version ${baseVersion} and upload_id ${uploadId}.`,
    ].join('\n'),
    structured: { page_id: target.doc.id, upload_id: uploadId, url: link.url, expires_at: link.expiresAt.toISOString() },
  };
}

export const replaceTool = defineTool({
  name: 'kinote_replace',
  annotations: { title: 'Replace a file', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Add a new version of a file from your own copy. base_version: the version your copy came from (kinote_read level "info" or kinote_download says it); if someone changed the file since, it is refused. Send content_text (a text file) or content_base64, each up to 256 KiB; for a bigger file call with page_id and base_version only to get an upload link.',
  input: {
    page_id: z.string().min(1).max(64),
    base_version: z.number().int().min(1),
    content_text: z.string().max(4 * INLINE_BYTES).optional(),
    content_base64: z.string().max(2 * INLINE_BYTES).optional(),
    upload_id: z.string().min(1).max(64).optional(),
    file_name: z.string().min(1).max(255).optional(),
  },
  async run(args, ctx) {
    const given = [args.content_text, args.content_base64, args.upload_id].filter((v) => v !== undefined).length;
    if (given > 1) throw new ToolError('Send only one of content_text, content_base64 and upload_id.');
    const target = await replaceTarget(ctx, args.page_id);
    const fileName = args.file_name ?? target.current?.fileName ?? target.doc.title;
    if (args.content_text !== undefined) {
      const bytes = new TextEncoder().encode(args.content_text);
      if (bytes.byteLength > INLINE_BYTES) throw new ToolError(TOO_BIG);
      return commitReplace(ctx, target, bytesFile(fileName, bytes), args.base_version);
    }
    if (args.content_base64 !== undefined) {
      const bytes = Buffer.from(args.content_base64, 'base64');
      if (bytes.byteLength > INLINE_BYTES) throw new ToolError(TOO_BIG);
      return commitReplace(ctx, target, bytesFile(fileName, new Uint8Array(bytes)), args.base_version);
    }
    if (args.upload_id !== undefined) {
      const { file } = await takeUpload(ctx.deps, ctx.actor, ctx.agent.agentId, args.upload_id, { purpose: 'replace', documentId: target.doc.id });
      try {
        return await commitReplace(ctx, { ...target }, { ...file, name: fileName }, args.base_version);
      } finally {
        await file.dispose();
      }
    }
    return uploadLinkFor(ctx, target, fileName, args.base_version);
  },
});
