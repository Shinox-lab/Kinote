import { z } from 'zod';
import { withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { runAgentEdits } from '../edit/apply.js';
import type { AgentEdit, EditOutcome } from '../edit/plan.js';
import { dataBlock, pageLink } from '../format.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool } from '../tool.js';

/** Most edits one call may carry, and the longest Markdown one insert may add. */
export const MAX_EDITS = 20;
export const MAX_EDIT_MARKDOWN = 10_000;
const FILE_REFUSED = 'kinote_edit changes pages, not files. Use kinote_capture to file what a file says.';

const blockId = z.string().min(1).max(64);
const editSchema = z.union([
  z.object({ block_id: blockId, old: z.string().min(1).max(MAX_EDIT_MARKDOWN), new: z.string().max(MAX_EDIT_MARKDOWN) }).strict(),
  z.object({ after_block_id: blockId.nullable(), markdown: z.string().min(1).max(MAX_EDIT_MARKDOWN) }).strict(),
  z.object({ remove_block_id: blockId }).strict(),
  z.object({ field: z.string().min(1).max(200), value: z.unknown() }).strict(),
]);

/** One reply line: `• <label> — applied · indexing`, `— suggested: <why>`, `— refused: <why>`. */
function line(o: EditOutcome): string {
  const tail = o.result === 'applied' ? (o.detail ? `applied · ${o.detail}` : 'applied') : `${o.result}: ${o.detail}`;
  return `• ${o.label} — ${tail}`;
}

export const editTool = defineTool({
  name: 'kinote_edit',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Make precise edits to a page you have read: replace exact words in a block ({block_id, old, new}; quote the words as they read, Markdown syntax is ignored, and new is plain text), insert Markdown after a block ({after_block_id, markdown}; null for the top), propose removing a block ({remove_block_id}), or set a collection field ({field, value}). Block ids come from kinote_read. Edits a person made recently, removals, and spaces you can only read become suggestions for a person.',
  input: {
    page_id: z.string().min(1).max(64),
    edits: z.array(editSchema).min(1).max(MAX_EDITS),
  },
  async run(args, ctx) {
    const { actor, agent, deps } = ctx;
    if (!deps.collab) throw new AppError('internal_error');
    const doc = await withTenantTx(actor.tenantId, (tx) => resolvePageRef(tx, actor, args.page_id));
    if (doc.kind === 'file') throw new ToolError(FILE_REFUSED);
    ctx.touch([doc.id]);
    const { outcomes } = await runAgentEdits(
      { actor, agentId: agent.agentId, agentName: agent.agentName, collab: deps.collab },
      doc,
      args.edits as AgentEdit[]
    );
    const body = [`${doc.title} · ${outcomes.length} ${outcomes.length === 1 ? 'edit' : 'edits'}`, ...outcomes.map(line)].join('\n');
    const link = pageLink(agent, deps.publicUrl, doc.id, doc.kind);
    const text = `${dataBlock('edit', body)}${link ? `\nLink: ${link}` : ''}`;
    if (outcomes.every((o) => o.result === 'refused')) throw new ToolError(text);
    return text;
  },
});
