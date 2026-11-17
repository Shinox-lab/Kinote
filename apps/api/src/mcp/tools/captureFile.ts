import { z } from 'zod';
import { withTenantTx } from '@kinote/db';
import { MAX_CAPTURE_CHARS } from '@kinote/contracts';
import { ownerActorOf, senderAccess } from '@kinote/core';
import { createCapture } from '../../routes/captures.js';
import { uploadFile } from '../../routes/files.js';
import { assertCredits } from '../../usageLimits.js';
import { ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';
import { beginUpload, cancelUpload, putChunk, takeUpload } from '../upload/store.js';
import { renderCapture, scopeOf, waitForCapture } from './capture.js';

/** The panel `kinote_capture_file` shows. */
export const CAPTURE_FILE_RESOURCE = 'ui://kinote/capture-file';
const APP_ONLY = { ui: { visibility: ['app' as const] } };
const PANEL = 'Used by the Kinote file panel.';
/** base64 of one 1 MiB chunk is 1 398 104 characters. */
const MAX_CHUNK_CHARS = 1_500_000;

const fileAs = z.enum(['auto', 'document', 'updates']).default('auto');
const notes = z.string().max(MAX_CAPTURE_CHARS).default('');
const limitTo = z.string().max(200).optional();
const uploadId = z.string().min(1).max(64);

/** Refuses a capture the workspace or the agent could not make, before the panel or an upload starts. */
async function assertCanCapture(ctx: ToolContext): Promise<void> {
  const { actor, deps, log } = ctx;
  await assertCredits(actor.tenantId, { ...(deps.billingUrl ? { billingUrl: deps.billingUrl } : {}), log });
  const access = await withTenantTx(actor.tenantId, (tx) => senderAccess(tx, actor));
  if (access.editable.length === 0) throw new ToolError('You need to be able to edit at least one space to capture.');
}

export const captureFileTool = defineTool({
  name: 'kinote_capture_file',
  scope: 'capture',
  limit: 'capture',
  writes: true,
  meta: { ui: { resourceUri: CAPTURE_FILE_RESOURCE } },
  description:
    'Add a file itself (a PDF, document or spreadsheet your user has) to the wiki: Kinote shows a panel where your user drops the original; Kinote keeps the file and files what it says, like kinote_capture. ' +
    'Put filing instructions in notes ("put it under Clients"). Use kinote_capture instead when only the text matters.',
  input: {
    notes: notes.describe('Filing instructions, shown in the panel and sent with the file'),
    file_as: fileAs.describe('auto, document (always a new page) or updates (only change pages)'),
    limit_to: limitTo.describe('A space name or ID, or a page ID, to file within'),
    file_name: z.string().max(255).optional().describe('The name of the file your user means, shown in the panel'),
  },
  async run(args, ctx) {
    await assertCanCapture(ctx);
    const scope = args.limit_to ? await scopeOf(ctx.actor, args.limit_to) : null;
    const where = ctx.deps.publicUrl ? `${ctx.deps.publicUrl.replace(/\/$/, '')}/w/${ctx.agent.tenantSlug}/capture` : 'the Capture page in Kinote';
    const text =
      'Kinote opened a panel for your user to drop the file. When they press Capture, the receipt appears there and is shared with you. ' +
      `If no panel is shown (this client can't show MCP Apps), ask them to attach the file on the Capture page: ${where}`;
    const limit = scope ? (scope.scope_page_id ? { page_id: scope.scope_page_id } : { space_id: scope.scope_space_id! }) : null;
    return { text, structured: { notes: args.notes, file_as: args.file_as, limit_to: limit, file_name: args.file_name ?? null } };
  },
});

export const uploadBeginTool = defineTool({
  name: 'kinote_upload_begin',
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
  scope: 'capture',
  limit: 'capture',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Finishes the upload: Kinote keeps the file in your user's Inbox and captures it with the notes.`,
  input: { upload_id: uploadId, notes, file_as: fileAs, limit_to: limitTo },
  async run(args, ctx) {
    const { actor, deps } = ctx;
    const owner = ownerActorOf(actor);
    if (!owner || !deps.storage) throw new ToolError('File uploads are not set up on this Kinote server.');
    await assertCanCapture(ctx);
    const scope = args.limit_to ? await scopeOf(actor, args.limit_to) : {};
    const { file } = await takeUpload(deps, actor, ctx.agent.agentId, args.upload_id);
    let fileId: string;
    try {
      // Stored as the owner's upload: they dropped it, and an Inbox file is visible only to its creator.
      fileId = (await uploadFile(owner, { fields: {}, file }, { storage: deps.storage })).response.document.id;
    } finally {
      await file.dispose();
    }
    const made = await createCapture(
      actor,
      { text: args.notes.trim(), shape: args.file_as, file_id: fileId, ...scope },
      { channel: 'mcp', ownerFile: true }
    );
    const receipt = await renderCapture(ctx, made.id, await waitForCapture(actor, made.id));
    return { text: receipt, structured: { capture_id: made.id, status: made.status, receipt } };
  },
});

export const uploadCancelTool = defineTool({
  name: 'kinote_upload_cancel',
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
export const CAPTURE_FILE_TOOLS = [captureFileTool, uploadBeginTool, uploadChunkTool, uploadFinishTool, uploadCancelTool];
