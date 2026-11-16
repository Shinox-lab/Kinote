import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { captureChanges, captureFacts, captureMessages, captures, documents, withTenantTx, type DocumentRow } from '@kinote/db';
import { MAX_CAPTURE_CHARS, type CaptureDetail } from '@kinote/contracts';
import { previewOf, type Actor } from '@kinote/core';
import { answerCapture, createCapture, getCapture } from '../../routes/captures.js';
import { moveCaptureChange, undoCapture, undoCaptureChange } from '../../routes/captureChanges.js';
import { applyCapturePreview, cancelCapturePreview } from '../../routes/capturePreview.js';
import { assertCredits } from '../../usageLimits.js';
import { formatCapture, previewDocumentIds } from '../captureFormat.js';
import { shortId } from '../format.js';
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

const Ref = z.string().trim().min(8).max(36);

/** A row of `rows` named by a full id or a unique prefix of 8+ hex characters (dashes optional); null when none or several. */
function byRef<T extends { id: string }>(rows: readonly T[], ref: string): T | null {
  const want = ref.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(want)) return null;
  const hits = rows.filter((r) => r.id.replaceAll('-', '').toLowerCase().startsWith(want));
  return hits.length === 1 ? hits[0]! : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const captureActionTool = defineTool({
  name: 'kinote_capture_action',
  scope: 'capture',
  limit: 'capture',
  description:
    'Act on a capture this agent sent: "status" (the receipt), "answer" a routing question (question_id, choice), "undo" it all or one change (change_id), ' +
    '"move" a change to another page (change_id, page_id), or, after a preview, "apply" it (skip facts, or place facts on pages you choose) or "cancel" it. IDs take 8+ characters.',
  input: {
    capture_id: Ref,
    action: z.enum(['status', 'answer', 'undo', 'move', 'apply', 'cancel']),
    question_id: Ref.optional(),
    choice: Ref.optional().describe('The id of one of the question’s choices'),
    change_id: Ref.optional(),
    page_id: Ref.optional(),
    skip: z.array(Ref).max(100).optional().describe('Fact ids not to file'),
    place: z
      .array(z.object({ fact_id: Ref, page_id: Ref }))
      .max(100)
      .optional()
      .describe('Facts to file on a page you choose instead'),
  },
  async run(args, ctx) {
    const { actor, agent, deps, log } = ctx;
    const mine = await withTenantTx(actor.tenantId, (tx) =>
      tx
        .select({ id: captures.id })
        .from(captures)
        .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.senderType, 'agent'), eq(captures.senderId, agent.agentId)))
    );
    const capture = byRef(mine, args.capture_id);
    if (!capture) throw new ToolError(`No capture "${args.capture_id}" sent by this agent.`);
    const id = capture.id;
    if (args.action === 'status') return renderCapture(ctx, id);
    await ctx.assertWritable();

    const pageOf = async (ref: string) => (await withTenantTx(actor.tenantId, (tx) => resolvePageRef(tx, actor, ref))).id;
    const factOf = async (ref: string) => {
      const facts = await withTenantTx(actor.tenantId, (tx) =>
        tx.select({ id: captureFacts.id }).from(captureFacts).where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.captureId, id)))
      );
      const fact = byRef(facts, ref);
      if (!fact) throw new ToolError(`No fact "${ref}" in this capture.`);
      return fact.id;
    };
    const changeOf = async (ref: string) => {
      const rows = await withTenantTx(actor.tenantId, (tx) =>
        tx.select({ id: captureChanges.id }).from(captureChanges).where(and(eq(captureChanges.tenantId, actor.tenantId), eq(captureChanges.captureId, id)))
      );
      const change = byRef(rows, ref);
      if (!change) throw new ToolError(`No change "${ref}" in this capture.`);
      return change.id;
    };

    let line: string;
    switch (args.action) {
      case 'answer': {
        if (!args.question_id || !args.choice) throw new ToolError('answer needs question_id and choice.');
        const messages = await withTenantTx(actor.tenantId, (tx) =>
          tx
            .select()
            .from(captureMessages)
            .where(and(eq(captureMessages.tenantId, actor.tenantId), eq(captureMessages.captureId, id), eq(captureMessages.author, 'engine')))
        );
        const question = byRef(messages, args.question_id);
        if (!question) throw new ToolError(`No question "${args.question_id}" on this capture.`);
        const options = ((question.options as Array<{ entityId: string; label: string }> | null) ?? []).map((o) => ({ id: o.entityId }));
        const choice = byRef(options, args.choice);
        if (!choice) throw new ToolError(`"${args.choice}" is not one of the choices. Call status to see them.`);
        await answerCapture(actor, id, { message_id: question.id, choice: choice.id });
        line = 'Answered; routing continues.';
        break;
      }
      case 'undo': {
        const r = args.change_id ? await undoCaptureChange(actor, await changeOf(args.change_id), deps.collab) : await undoCapture(actor, id, deps.collab);
        line = `Undone: ${plural(r.undone.length, 'change')}; ${r.changedSince.length} left because someone changed them since.`;
        break;
      }
      case 'move': {
        if (!args.change_id || !args.page_id) throw new ToolError('move needs change_id and page_id.');
        const changeId = await changeOf(args.change_id);
        const pageId = await pageOf(args.page_id);
        await moveCaptureChange(actor, changeId, { target_page_id: pageId }, { ...(deps.collab ? { collab: deps.collab } : {}), embedder: deps.embeddingProvider });
        line = `Moved change ${shortId(changeId)} to ${shortId(pageId)}; it is filed there when routing finishes.`;
        break;
      }
      case 'apply': {
        const skip = await Promise.all((args.skip ?? []).map(factOf));
        const place = await Promise.all((args.place ?? []).map(async (p) => ({ fact_id: await factOf(p.fact_id), document_id: await pageOf(p.page_id) })));
        // Placing runs the model; applying the rest does not.
        if (place.length > 0) await assertCredits(actor.tenantId, { ...(deps.billingUrl ? { billingUrl: deps.billingUrl } : {}), log });
        await applyCapturePreview(actor, id, { skip, place });
        line = 'Applying the preview; it files when routing finishes.';
        break;
      }
      case 'cancel': {
        await cancelCapturePreview(actor, id);
        line = 'Cancelled; nothing was filed.';
        break;
      }
    }
    return `${line}\n${await renderCapture(ctx, id)}`;
  },
});
