import { describe, expect, test } from 'vitest';
import type { CaptureSummary, ReviewItem, SuggestionSummary } from '@living-wiki/contracts';
import {
  CAPTURE_MAX,
  SHAPE_OPTIONS,
  approvableInBundle,
  captureHighlightCss,
  captureStatusLabel,
  capturesBusy,
  documentHeadline,
  hiddenChangesText,
  keptText,
  outcomeLabel,
  parseCaptureSearch,
  parsePageCaptureSearch,
  suggestionAction,
  suggestionMarkerCss,
  undoNotice,
  type CaptureChange,
} from '../src/lib/capture.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const capture = (status: CaptureSummary['status']) => ({ status }) as CaptureSummary;

const change = (blockId: string, status: CaptureChange['status']): CaptureChange => ({
  id: ID,
  factId: ID,
  documentId: ID,
  op: 'replace',
  blockId,
  beforeMarkdown: 'before',
  afterMarkdown: 'after',
  status,
  reason: null,
});

const suggestion = (over: Partial<SuggestionSummary>): SuggestionSummary => ({
  id: ID,
  documentId: ID,
  kind: 'remove',
  blockId: 'b1',
  afterBlockId: null,
  proposedMarkdown: null,
  reason: 'r',
  blockedBy: 'removal',
  conflictWith: null,
  status: 'open',
  captureId: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  ...over,
});

describe('capture helpers', () => {
  test('the box takes 20,000 characters', () => {
    expect(CAPTURE_MAX).toBe(20_000);
  });

  test('capturesBusy is true only while a capture is queued or routing', () => {
    expect(capturesBusy(undefined)).toBe(false);
    const settled = [capture('done'), capture('failed'), capture('waiting_for_answer')];
    expect(capturesBusy(settled)).toBe(false);
    expect(capturesBusy([...settled, capture('routing')])).toBe(true);
    expect(capturesBusy([capture('queued')])).toBe(true);
  });

  test('status and outcome labels', () => {
    expect(captureStatusLabel('queued')).toBe('Waiting to route');
    expect(captureStatusLabel('routing')).toBe('Routing…');
    expect(captureStatusLabel('waiting_for_answer')).toBe('Needs your answer');
    expect(captureStatusLabel('done')).toBe('Done');
    expect(captureStatusLabel('failed')).toBe('Routing failed');
    expect(outcomeLabel('applied')).toBe('Applied');
    expect(outcomeLabel('waiting_review')).toBe('Waiting for review');
    expect(outcomeLabel('suggestion')).toBe('Suggestion');
  });

  test('hiddenChangesText', () => {
    expect(hiddenChangesText(0)).toBeNull();
    expect(hiddenChangesText(1)).toBe("1 change in a space you can't see");
    expect(hiddenChangesText(3)).toBe("3 changes in spaces you can't see");
  });

  test('undoNotice reports changed-since blocks', () => {
    expect(undoNotice({ undone: [ID, ID2], changedSince: [ID] })).toBe('Undid 2 changes. 1 changed since, not undone.');
    expect(undoNotice({ undone: [ID], changedSince: [] })).toBe('Undid 1 change.');
    expect(undoNotice({ undone: [], changedSince: [] })).toBe('Nothing to undo.');
    expect(undoNotice({ undone: [], changedSince: [ID, ID2] })).toBe('2 changed since, not undone.');
  });

  test('captureHighlightCss tints only applied changes', () => {
    const css = captureHighlightCss([change('kept', 'applied'), change('gone', 'undone'), change('away', 'moved')]);
    expect(css).toContain('[data-id="kept"]');
    expect(css).not.toContain('gone');
    expect(css).not.toContain('away');
    expect(css).toContain('var(--routing)');
    expect(captureHighlightCss([change('a"b', 'applied')])).toContain('[data-id="a\\"b"]');
    expect(captureHighlightCss([])).toBe('');
    // A lone carriage return or form feed also ends a CSS string: neither may break out of the selector.
    for (const id of ['x\r] {} body{display:none} [a="', 'x\f] {} body{display:none} [a="']) {
      const css = captureHighlightCss([change(id, 'applied')]);
      expect(css).not.toMatch(/[\r\n\f]/);
    }
  });

  test('suggestionMarkerCss skips closed suggestions and inserts', () => {
    const css = suggestionMarkerCss([
      suggestion({ blockId: 'open-one' }),
      suggestion({ blockId: 'closed', status: 'declined' }),
      suggestion({ blockId: null, kind: 'insert' }),
    ]);
    expect(css).toContain('[data-id="open-one"]');
    expect(css).not.toContain('closed');
    expect(css).toContain('dashed');
  });

  test('parseCaptureSearch keeps uuid strings only', () => {
    expect(parseCaptureSearch({ space: ID, page: ID2 })).toEqual({ space: ID, page: ID2 });
    expect(parseCaptureSearch({ space: 'x', page: 3 })).toEqual({});
    expect(parseCaptureSearch({ space: '' })).toEqual({});
    expect(parsePageCaptureSearch({ capture: ID })).toEqual({ capture: ID });
    expect(parsePageCaptureSearch({ capture: 'nope' })).toEqual({});
  });

  test("approvableInBundle splits a capture's items by canApprove", () => {
    const item = (captureId: string | null, canApprove: boolean) =>
      ({ canApprove, capture: captureId ? { id: captureId } : null }) as unknown as ReviewItem;
    const a = item(ID, true);
    const b = item(ID, false);
    const other = item(ID2, true);
    const none = item(null, true);
    expect(approvableInBundle([a, b, other, none], ID)).toEqual({ approve: [a], skipped: [b] });
  });

  test('suggestionAction', () => {
    expect(suggestionAction(suggestion({ kind: 'remove' }))).toBe('Approve removal');
    expect(suggestionAction(suggestion({ kind: 'replace' }))).toBe('Accept');
    expect(suggestionAction(suggestion({ kind: 'insert' }))).toBe('Accept');
  });

  test('documentHeadline words where the page went, or that it waits', () => {
    const doc = { pageId: ID, title: '14Oct', outcome: 'created' as const, parentTitle: 'Client - George', spaceName: 'Clients', reason: null, changeIds: [] };
    expect(documentHeadline(doc)).toBe('New page: 14Oct under Client - George');
    expect(documentHeadline({ ...doc, parentTitle: null })).toBe('New page: 14Oct in Clients');
    expect(documentHeadline({ ...doc, outcome: 'needs_home', pageId: null })).toBe('Where should “14Oct” go?');
    expect(documentHeadline({ ...doc, outcome: 'pending', pageId: null })).toBe('Creating 14Oct…');
  });

  test('keptText counts facts kept on the new page', () => {
    expect(keptText(0)).toBeNull();
    expect(keptText(1)).toBe('1 fact kept on the new page');
    expect(keptText(3)).toBe('3 facts kept on the new page');
    expect(outcomeLabel('filed_in_document')).toBe('On the new page');
  });

  test('the File as choices', () => {
    expect(SHAPE_OPTIONS).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'document', label: 'New page' },
      { value: 'updates', label: 'Updates only' },
    ]);
  });
});
