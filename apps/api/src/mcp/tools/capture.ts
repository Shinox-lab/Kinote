import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { captures, documents, withTenantTx, type DocumentRow } from '@kinote/db';
import { MAX_CAPTURE_CHARS, type CaptureDetail } from '@kinote/contracts';
import { previewOf, type Actor } from '@kinote/core';
import { createCapture, getCapture } from '../../routes/captures.js';
import { assertCredits } from '../../usageLimits.js';
import { formatCapture, previewDocumentIds } from '../captureFormat.js';
import { resolvePageRef, resolveSpaceRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

/** How long `wait: true` blocks for routing to finish, and how often it looks. */
export const CAPTURE_WAIT_MS = 30_000;
const POLL_MS = 500;
const TOO_LONG = 'Text is over 20,000 characters; split it into several captures.';
const SETTLED = new Set(['waiting_for_answer', 'previewed', 'done', 'failed', 'cancelled']);

/** The capture as the agent reads it now: detail, stored preview and the titles the preview names. */
export async function renderCapture(ctx: Pick<ToolContext, 'actor' | 'agent' | 'deps'>, captureId: string, detail?: CaptureDetail): Promise<string> {
  const { actor, agent, deps } = ctx;
  const d = detail ?? (await getCapture(actor, captureId));
  const { preview, titles } = await withTenantTx(actor.tenantId, async (tx) => {
    const [row] = await tx.select({ previewPlan: captures.previewPlan }).from(captures).where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, captureId)));
    const preview = row ? previewOf(row) : null;
    const ids = previewDocumentIds(preview);
    const rows = ids.length
      ? await tx.select({ id: documents.id, title: documents.title }).from(documents).where(and(eq(documents.tenantId, actor.tenantId), inArray(documents.id, ids)))
      : [];
    return { preview, titles: new Map(rows.map((r) => [r.id, r.title])) };
  });
  return formatCapture(d, { agent, ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}), preview, titles });
}

/** Waits up to CAPTURE_WAIT_MS for routing to settle; returns the capture as it stands then. */
export async function waitForCapture(actor: Actor, captureId: string): Promise<CaptureDetail> {
  const until = Date.now() + CAPTURE_WAIT_MS;
  let detail = await getCapture(actor, captureId);
  while (!SETTLED.has(detail.capture.status) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    detail = await getCapture(actor, captureId);
  }
  return detail;
}

/** `limit_to`: a page (by id or an 8+ hex prefix) first, then a space by name or id. */
async function scopeOf(actor: Actor, ref: string): Promise<{ scope_space_id?: string; scope_page_id?: string }> {
  return withTenantTx(actor.tenantId, async (tx) => {
    if (/^[0-9a-f-]{8,36}$/i.test(ref.trim())) {
      let page: DocumentRow | null = null;
      try {
        page = await resolvePageRef(tx, actor, ref);
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
      }
      if (page) {
        if (page.kind !== 'page') throw new ToolError(`"${ref}" is a file; limit_to takes a page or a space.`);
        return { scope_page_id: page.id };
      }
    }
    return { scope_space_id: (await resolveSpaceRef(tx, actor, ref)).id };
  });
}

export const captureTool = defineTool({
  name: 'kinote_capture',
  scope: 'capture',
  limit: 'capture',
  writes: true,
  description:
    'File new information into the wiki: routing finds where each fact belongs, applies it with a receipt, and every change can be undone. ' +
    'Put filing instructions in the text ("make a new page", "put it under Clients"). preview: true plans only, so your user can check where it would go; then call kinote_capture_action "apply" or "cancel".',
  input: {
    text: z.string().max(1_000_000),
    file_as: z.enum(['auto', 'document', 'updates']).default('auto').describe('auto, document (always a new page) or updates (only change pages)'),
    limit_to: z.string().max(200).optional().describe('A space name or ID, or a page ID, to file within'),
    wait: z.boolean().default(false).describe('Wait up to 30 seconds for the receipt'),
    source: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('Where this came from (a URL or ticket ID); a retry with the same source and text returns the first capture'),
    preview: z.boolean().default(false).describe('Plan only; nothing changes until you apply it'),
  },
  async run(args, ctx) {
    const { actor, agent, deps, log } = ctx;
    const text = args.text.trim();
    if (text.length > MAX_CAPTURE_CHARS) throw new ToolError(TOO_LONG);
    if (text === '') throw new ToolError('Write the information to file in text.');

    // The same source and text from this agent again: the first capture, not a second one.
    if (args.source) {
      const [earlier] = await withTenantTx(actor.tenantId, (tx) =>
        tx
          .select({ id: captures.id })
          .from(captures)
          .where(
            and(
              eq(captures.tenantId, actor.tenantId),
              eq(captures.senderType, 'agent'),
              eq(captures.senderId, agent.agentId),
              eq(captures.sourceRef, args.source!),
              eq(captures.text, text),
              ne(captures.status, 'cancelled')
            )
          )
          .orderBy(desc(captures.createdAt))
          .limit(1)
      );
      if (earlier) {
        const detail = args.wait ? await waitForCapture(actor, earlier.id) : undefined;
        return renderCapture(ctx, earlier.id, detail);
      }
    }

    await assertCredits(actor.tenantId, { ...(deps.billingUrl ? { billingUrl: deps.billingUrl } : {}), log });
    const scope = args.limit_to ? await scopeOf(actor, args.limit_to) : {};
    const made = await createCapture(
      actor,
      { text, shape: args.file_as, ...scope },
      { channel: 'mcp', sourceRef: args.source ?? null, preview: args.preview }
    );
    const detail = args.wait ? await waitForCapture(actor, made.id) : undefined;
    return renderCapture(ctx, made.id, detail);
  },
});
