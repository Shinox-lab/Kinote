import { describe, expect, test } from 'vitest';
import { applyOutcome, cardsFrom, contextLine, fileSummary, kindLabel, lineDiff, type CardState } from '../src/mcp/app/reviewLogic.js';
import { reviewPanelHtml } from '../src/mcp/app/panelHtml.js';
import type { ReviewPanelItem } from '../src/mcp/review/items.js';

const item = (over: Partial<ReviewPanelItem> = {}): ReviewPanelItem => ({
  type: 'suggestion',
  id: 's1',
  page: { id: 'p1', title: 'Handoff', space: 'Clients' },
  kind: 'replace',
  proposer: { type: 'agent', name: 'Docs bot' },
  created_at: '2026-11-19T10:00:00.000Z',
  reason: 'Clearer.',
  before: 'Old words.',
  after: 'New words.',
  decidable: true,
  ...over,
});

describe('the review panel logic', () => {
  test('an empty list says nothing is waiting', () => {
    expect(cardsFrom({ items: [], can_decide_here: true })).toEqual({ cards: [], canDecide: true, empty: 'Nothing is waiting for you.' });
  });

  test('each item becomes an idle card', () => {
    const { cards, empty } = cardsFrom({ items: [item()], can_decide_here: false });
    expect(empty).toBeNull();
    expect(cards).toEqual([{ item: item(), outcome: null, busy: false }]);
  });

  test('lineDiff marks removed and added lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'ins', text: 'c' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ op: 'ins', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ op: 'del', text: 'x' }]);
  });

  test('applyOutcome shows the decision or the refusal', () => {
    const card: CardState = { item: item(), outcome: null, busy: true };
    expect(applyOutcome(card, { ok: true, status: 'accepted' }, 'approve')).toEqual({ item: item(), outcome: { kind: 'done', text: 'Approved' }, busy: false });
    expect(applyOutcome(card, { ok: true, status: 'declined' }, 'reject').outcome).toEqual({ kind: 'done', text: 'Rejected' });
    expect(applyOutcome(card, { ok: false, message: 'Already decided.' }, 'approve').outcome).toEqual({ kind: 'error', text: 'Already decided.' });
  });

  test('contextLine tells the model what was decided', () => {
    expect(contextLine(item(), 'approve')).toBe('Approved: replace on "Handoff".');
    expect(contextLine(item({ kind: 'archive' }), 'reject')).toBe('Rejected: archive on "Handoff".');
  });

  test('kindLabel names each kind for a person', () => {
    expect(kindLabel(item({ kind: 'archive' }))).toBe('Delete this page');
    expect(kindLabel(item({ kind: 'version', type: 'version' }))).toBe('New version');
    expect(kindLabel(item({ kind: 'set_field' }))).toBe('Change a field');
  });

  test('a file item is labelled New version of <name> and its card shows sizes', () => {
    const file = item({
      type: 'version',
      kind: 'version',
      before: null,
      after: null,
      file: {
        name: 'budget.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        after: { version: 2, size: 48 * 1024, url: null },
        before: { version: 1, size: 47 * 1024, url: null },
        preview: { before: null, after: null },
      },
    });
    expect(kindLabel(file)).toBe('New version of budget.xlsx');
    expect(fileSummary(file)).toBe('v1 · 47 KB → v2 · 48 KB');
    expect(fileSummary(item({ file: { ...file.file!, before: null } }))).toBe('v2 · 48 KB');
  });

  test('the panel is one self-contained page', async () => {
    const html = await reviewPanelHtml();
    expect(html).toContain('<script>');
    expect(html).toContain('<title>Kinote review panel</title>');
    expect(/\ssrc=/.test(html)).toBe(false);
  });
});
