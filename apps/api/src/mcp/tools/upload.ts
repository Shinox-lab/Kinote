import { z } from 'zod';
import { withTenantTx } from '@kinote/db';
import { MAX_CAPTURE_CHARS } from '@kinote/contracts';
import { ownerActorOf, senderAccess } from '@kinote/core';
import { createCapture } from '../../routes/captures.js';
import { uploadFile } from '../../routes/files.js';
import { assertCredits } from '../../usageLimits.js';
import { shortId } from '../format.js';
import { ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';
import { beginUpload, cancelUpload, putChunk, takeUpload } from '../upload/store.js';
import { renderCapture, scopeOf, waitForCapture } from './capture.js';

/** The panel `kinote_upload` shows. */
export const UPLOAD_RESOURCE = 'ui://kinote/upload';
const APP_ONLY = { ui: { visibility: ['app' as const] } };
const PANEL = 'Used by the Kinote file panel.';
/** base64 of one 1 MiB chunk is 1 398 104 characters. */
const MAX_CHUNK_CHARS = 1_500_000;

const about = z.string().trim().min(1).max(MAX_CAPTURE_CHARS);
const placeUnder = z.string().max(200).optional();
const uploadId = z.string().min(1).max(64);

/** Refuses a capture the workspace or the agent could not make, before the panel or an upload starts. */
async function assertCanCapture(ctx: ToolContext): Promise<void> {
  const { actor, deps, log } = ctx;
  await assertCredits(actor.tenantId, { ...(deps.billingUrl ? { billingUrl: deps.billingUrl } : {}), log });
  const access = await withTenantTx(actor.tenantId, (tx) => senderAccess(tx, actor));
  if (access.editable.length === 0) throw new ToolError('You need to be able to edit at least one space to capture.');
}

export const uploadTool = defineTool({
  name: 'kinote_upload',
  annotations: { title: 'Add a file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scope: 'capture',
  limit: 'capture',
  writes: true,
  meta: { ui: { resourceUri: UPLOAD_RESOURCE } },
  description:
    'Add a file itself (a PDF, image, document or spreadsheet your user has) to the wiki: Kinote shows a panel where your user drops the original, and files it where it belongs. ' +
    'No page is made and the file needs no readable text. Say what the file is in about; Kinote places it by that and its name, or under place_under. ' +
    'To put what the file says on a page, write that page with kinote_capture.',
  input: {
    about: about.describe('What the file is, in a sentence: Kinote places it by this. Shown in the panel'),
    place_under: placeUnder.describe('A page ID to put the file under, or a space name or ID to put it at the top of. Leave out to let Kinote choose'),
    file_name: z.string().max(255).optional().describe('The name of the file your user means, shown in the panel'),
  },
  async run(args, ctx) {
    await assertCanCapture(ctx);
    const scope = args.place_under ? await scopeOf(ctx.actor, args.place_under) : null;
    const where = ctx.deps.publicUrl ? `${ctx.deps.publicUrl.replace(/\/$/, '')}/w/${ctx.agent.tenantSlug}/capture` : 'the Capture page in Kinote';
    const text =
      'Kinote opened a panel for your user to drop the file. When they press Capture, the receipt appears there and is shared with you. ' +
      `If no panel is shown (this client can't show MCP Apps), ask them to attach the file on the Capture page: ${where}`;
    const place = scope ? (scope.scope_page_id ? { page_id: scope.scope_page_id } : { space_id: scope.scope_space_id! }) : null;
    return { text, structured: { about: args.about, place_under: place, file_name: args.file_name ?? null } };
  },
});

export const uploadBeginTool = defineTool({
  name: 'kinote_upload_begin',
  annotations: { title: 'Start a file upload', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scope: 'capture',
  limit: 'upload',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Starts uploading the file your user dropped; send it with kinote_upload_chunk.`,
  input: { name: z.string().min(1).max(255), size: z.number().int().positive(), mime: z.string().max(255) },
  async run(args, ctx) {
    await assertCanCapture(ctx);
    const { uploadId: id, chunkBytes } = await beginUpload(ctx.deps, ctx.actor, ctx.agent.agentId, args);
    return { text: `Upload ${id} started; send ${chunkBytes}-byte chunks.`, structured: { upload_id: id, chunk_bytes: chunkBytes } };
  },
});

export const uploadChunkTool = defineTool({
  name: 'kinote_upload_chunk',
  annotations: { title: 'Send part of a file', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scope: 'capture',
  limit: 'upload',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Sends one base64 chunk of the file, in order from index 0.`,
  input: { upload_id: uploadId, index: z.number().int().min(0), data: z.string().min(1).max(MAX_CHUNK_CHARS) },
  async run(args, ctx) {
    const { receivedBytes } = await putChunk(ctx.deps, ctx.actor, ctx.agent.agentId, args.upload_id, args.index, args.data);
    return { text: `Received ${receivedBytes} bytes.`, structured: { received_bytes: receivedBytes } };
  },
});

export const uploadFinishTool = defineTool({
  name: 'kinote_upload_finish',
  annotations: { title: 'Finish a file upload', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scope: 'capture',
  limit: 'capture',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Finishes the upload: Kinote keeps the file as your user's and files it by its description.`,
  input: { upload_id: uploadId, about, place_under: placeUnder },
  async run(args, ctx) {
    const { actor, deps } = ctx;
    const owner = ownerActorOf(actor);
    if (!owner || !deps.storage) throw new ToolError('File uploads are not set up on this Kinote server.');
    await assertCanCapture(ctx);
    const scope = args.place_under ? await scopeOf(actor, args.place_under) : {};
    const { file } = await takeUpload(deps, actor, ctx.agent.agentId, args.upload_id, { purpose: 'panel' });
    let fileId: string;
    try {
      // Stored as the owner's upload: they dropped it, and an Inbox file is visible only to its creator. Always a
      // new document (copy): de-duplication would hand the agent an existing Inbox file the panel never uploaded.
      fileId = (await uploadFile(owner, { fields: { copy: 'true' }, file }, { storage: deps.storage })).response.document.id;
    } finally {
      await file.dispose();
    }
    // A file-only capture: the worker places the file by `about` and makes no page.
    const made = await createCapture(actor, { text: args.about, file_id: fileId, ...scope }, { channel: 'mcp', ownerFile: true, fileOnly: true });
    const detail = await waitForCapture(actor, made.id);
    let receipt = await renderCapture(ctx, made.id, detail);
    // A file left in the Inbox is the owner's, which the agent can't read, so the receipt has no line for it.
    const reason = detail.capture.fileReason;
    if (reason && !receipt.includes(reason)) receipt = `${receipt}\nfile (${shortId(fileId)}): ${reason}`;
    return { text: receipt, structured: { capture_id: made.id, file_id: fileId, status: detail.capture.status, receipt } };
  },
});

export const uploadCancelTool = defineTool({
  name: 'kinote_upload_cancel',
  annotations: { title: 'Cancel a file upload', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scope: 'capture',
  limit: 'upload',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Cancels an upload and discards what was sent.`,
  input: { upload_id: uploadId },
  async run(args, ctx) {
    await cancelUpload(ctx.deps, ctx.actor, ctx.agent.agentId, args.upload_id);
    return { text: 'Upload cancelled.', structured: { cancelled: true } };
  },
});

/** The file panel's tools: the one the model calls, then the panel's own. */
export const UPLOAD_TOOLS = [uploadTool, uploadBeginTool, uploadChunkTool, uploadFinishTool, uploadCancelTool];
