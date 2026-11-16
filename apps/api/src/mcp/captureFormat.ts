import type { CaptureDetail } from '@kinote/contracts';
import type { CapturePreview, PlannedEdit } from '@kinote/core';
import type { AgentAuth } from '../auth/actor.js';
import { dataBlock, shortId } from './format.js';

const STATUS_WORDS: Record<CaptureDetail['capture']['status'], string> = {
  queued: 'queued',
  routing: 'routing',
  waiting_for_answer: 'needs an answer',
  previewed: 'preview ready',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
const OUTCOME_WORDS = { applied: 'applied', waiting_review: 'waiting review', suggestion: 'suggested' } as const;
const PREVIEW_NEXT = 'Nothing has changed yet. kinote_capture_action with "apply" files it (skip or place facts there), or "cancel".';
const MARKDOWN_CHARS = 300;

/** What to show for one capture: the capture, its stored preview, and titles for the pages the preview names. */
export interface CaptureView {
  agent: Pick<AgentAuth, 'tenantSlug'>;
  publicUrl?: string;
  preview: CapturePreview | null;
  titles: ReadonlyMap<string, string>;
}

const one = (text: string) => text.replace(/\s+/g, ' ').trim();
const cut = (text: string) => (one(text).length > MARKDOWN_CHARS ? `${one(text).slice(0, MARKDOWN_CHARS)}…` : one(text));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The document ids a preview names (edited pages, alternatives, parents): the caller looks up their titles. */
export function previewDocumentIds(preview: CapturePreview | null): string[] {
  if (!preview) return [];
  const ids = new Set<string>();
  for (const f of preview.facts) {
    if (f.plan.status === 'planned') {
      for (const e of f.plan.edits) {
        if ('documentId' in e.edit.op) ids.add(e.edit.op.documentId);
        if (e.edit.op.op === 'create_page' && e.edit.op.parentId) ids.add(e.edit.op.parentId);
      }
    }
    if (f.plan.status === 'already_known') ids.add(f.plan.documentId);
    for (const a of f.alternatives ?? []) ids.add(a.documentId);
  }
  if (preview.document?.status === 'place' && preview.document.parentId) ids.add(preview.document.parentId);
  if (preview.file?.parentId) ids.add(preview.file.parentId);
  return [...ids];
}

function editLine(edit: PlannedEdit, titleOf: (id: string) => string): string {
  const op = edit.op;
  switch (op.op) {
    case 'insert_after':
      return `would add to ${titleOf(op.documentId)}${op.after ? ` after block ${shortId(op.after)}` : ' at the start'}: ${cut(op.markdown)}`;
    case 'replace':
      return `would replace in ${titleOf(op.documentId)} block ${shortId(op.blockId)}: ${cut(op.markdown)}`;
    case 'remove':
      return `would remove from ${titleOf(op.documentId)} block ${shortId(op.blockId)}`;
    case 'set_field':
      return `would set a field on ${titleOf(op.documentId)}: ${shortId(op.fieldId)} = ${cut(JSON.stringify(op.value))}`;
    case 'create_page':
      return `would create "${one(op.title)}" ${op.parentId ? `under ${titleOf(op.parentId)}` : 'at the top of its space'}: ${cut(op.markdown)}`;
    case 'already_known':
      return `already known on ${titleOf(op.documentId)}`;
  }
}

function previewLines(preview: CapturePreview, titleOf: (id: string) => string): string[] {
  const lines: string[] = [];
  const doc = preview.document;
  if (doc?.status === 'place') {
    lines.push(`document: would create "${one(doc.title)}" ${doc.parentId ? `under ${titleOf(doc.parentId)}` : 'at the top of its space'}`);
  } else if (doc) {
    lines.push(`document: would wait for a person to choose its place: ${one(doc.reason)}`);
  }
  for (const f of preview.facts) {
    lines.push(`fact ${f.factId ? shortId(f.factId) : `#${f.ordinal + 1}`}: ${one(f.fact.statement)}`);
    const plan = f.plan;
    if (plan.status === 'planned') {
      for (const e of plan.edits) {
        lines.push(`  ${editLine(e.edit, titleOf)}${e.gate ? ` (as a suggestion: ${e.gate.replaceAll('_', ' ')})` : ''}`);
        lines.push(`  confidence ${e.edit.confidence.toFixed(2)} · ${one(e.edit.reason)}`);
      }
    } else if (plan.status === 'already_known') {
      lines.push(`  already known on ${titleOf(plan.documentId)}`);
    } else if (plan.status === 'question') {
      lines.push(`  needs an answer when applied: ${one(plan.question)}`);
    } else if (plan.status === 'filed_in_document') {
      lines.push(`  stays on the document's page only`);
    } else {
      lines.push(`  would wait in Needs a home: ${one(plan.reason)}`);
    }
    if (f.alternatives?.length) lines.push(`  also fits: ${f.alternatives.map((a) => titleOf(a.documentId)).join(', ')}`);
  }
  if (preview.file) lines.push(`file (would): ${one(preview.file.reason)}`);
  return lines;
}

function receiptLines(detail: CaptureDetail): string[] {
  const r = detail.receipt;
  const lines: string[] = [];
  if (r.document) {
    const where = r.document.parentTitle ? ` under ${one(r.document.parentTitle)}` : r.document.spaceName ? ` in ${one(r.document.spaceName)}` : '';
    const id = r.document.pageId ? ` (${shortId(r.document.pageId)})` : '';
    const outcome = r.document.outcome === 'created' ? 'created' : r.document.outcome === 'needs_home' ? 'waiting for a place' : 'pending';
    lines.push(`document: ${one(r.document.title)}${id} · ${outcome}${where}${r.document.reason ? ` · ${one(r.document.reason)}` : ''}`);
  }
  for (const space of r.spaces) {
    for (const page of space.pages) {
      const changes = page.changes.map((c) => shortId(c.id));
      const n = page.outcome === 'suggestion' ? plural(page.suggestions.length, 'suggestion') : plural(page.changes.length, 'change');
      lines.push(`- ${OUTCOME_WORDS[page.outcome]} · ${one(page.title)} (${shortId(page.documentId)}) · ${n}${changes.length ? ` [${changes.join(', ')}]` : ''}`);
    }
  }
  if (r.hiddenChanges > 0) lines.push(`${plural(r.hiddenChanges, 'change')} in spaces you cannot read`);
  for (const f of r.alreadyKnown) lines.push(`already known: ${one(f.statement)}`);
  for (const f of r.needsHome) lines.push(`needs a home (fact ${shortId(f.factId)}): ${one(f.statement)}${f.reason ? ` · ${one(f.reason)}` : ''}`);
  for (const f of r.filedInDocument) lines.push(`on the document's page only: ${one(f.statement)}`);
  if (r.file) lines.push(`file (${shortId(r.file.fileId)}): ${one(r.file.reason ?? r.file.outcome)}`);
  const answered = new Set(detail.thread.filter((m) => m.author === 'sender' && m.answersMessageId).map((m) => m.answersMessageId));
  for (const m of detail.thread) {
    if (m.author !== 'engine' || !m.options?.length || answered.has(m.id)) continue;
    const choices = m.options.map((o) => `${one(o.label)} (${shortId(o.entityId)})`).join(', ');
    lines.push(`question ${shortId(m.id)}: ${one(m.body)} — choices: ${choices}`);
  }
  return lines;
}

/**
 * A capture as the agent reads it. The first line is the server's (id, status, link); everything people or a
 * model wrote (statements, titles, planned text, reasons, questions) is inside `<kinote:content>`.
 */
export function formatCapture(detail: CaptureDetail, view: CaptureView): string {
  const c = detail.capture;
  const link = view.publicUrl
    ? ` · ${view.publicUrl.replace(/\/+$/, '')}/w/${encodeURIComponent(view.agent.tenantSlug)}/capture?c=${c.id}`
    : '';
  const out = [`Capture ${shortId(c.id)} · ${STATUS_WORDS[c.status]}${link}`];
  if (c.status === 'failed' && c.error) out.push(dataBlock('receipt', `error: ${one(c.error)}`));
  const titleOf = (id: string) => `${one(view.titles.get(id) ?? 'a page')} (${shortId(id)})`;
  if (c.status === 'previewed' && view.preview) {
    out.push(dataBlock('preview', previewLines(view.preview, titleOf).join('\n') || '(nothing to file)'));
    out.push(PREVIEW_NEXT);
    return out.join('\n');
  }
  const lines = receiptLines(detail);
  if (lines.length > 0) out.push(dataBlock('receipt', lines.join('\n')));
  else if (c.status === 'queued' || c.status === 'routing') out.push('Routing has not finished. Call kinote_capture_action with "status" to check again.');
  return out.join('\n');
}
