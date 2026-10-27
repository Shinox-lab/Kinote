import { describe, expect, it } from 'vitest';
import {
  CaptureChangeSchema,
  CaptureReceiptSchema,
  CreateCaptureRequestSchema,
  FactStatusSchema,
  MoveDocumentRequestSchema,
  NeedsHomeDocumentListSchema,
  PlaceDocumentRequestSchema,
  ERROR_STATUS,
} from '../src/index.js';

const id = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('routing documents contracts', () => {
  it('a capture is filed automatically unless the sender says otherwise', () => {
    expect(CreateCaptureRequestSchema.parse({ text: 'x' }).shape).toBe('auto');
    expect(CreateCaptureRequestSchema.parse({ text: 'x', shape: 'document' }).shape).toBe('document');
    expect(CreateCaptureRequestSchema.safeParse({ text: 'x', shape: 'memo' }).success).toBe(false);
  });

  it('placing a document takes exactly one of a parent page or a space', () => {
    expect(PlaceDocumentRequestSchema.safeParse({ parent_page_id: id }).success).toBe(true);
    expect(PlaceDocumentRequestSchema.safeParse({ space_id: id, title: '14Oct' }).success).toBe(true);
    expect(PlaceDocumentRequestSchema.safeParse({ parent_page_id: id, space_id: id }).success).toBe(false);
    expect(PlaceDocumentRequestSchema.safeParse({}).success).toBe(false);
    expect(PlaceDocumentRequestSchema.safeParse({ space_id: id, title: '' }).success).toBe(false);
    expect(MoveDocumentRequestSchema.safeParse({ parent_page_id: id }).success).toBe(true);
  });

  it('a change of the document page has no fact; a fact may be kept on the new page', () => {
    const change = { id, factId: null, documentId: id, op: 'create_page', blockId: 'b', beforeMarkdown: null, afterMarkdown: 'x', status: 'applied', reason: null };
    expect(CaptureChangeSchema.parse(change).factId).toBeNull();
    expect(FactStatusSchema.parse({ factId: id, outcome: 'filed_in_document' }).outcome).toBe('filed_in_document');
  });

  it('the receipt carries the document and the facts kept on it', () => {
    const receipt = CaptureReceiptSchema.parse({
      spaces: [],
      hiddenChanges: 0,
      alreadyKnown: [],
      needsHome: [],
      document: { pageId: id, title: '14Oct', outcome: 'created', parentTitle: 'Client - George', spaceName: 'Clients', reason: null, changeIds: [id] },
      filedInDocument: [{ factId: id, statement: 'Shop the look.' }],
    });
    expect(receipt.document?.parentTitle).toBe('Client - George');
    const list = NeedsHomeDocumentListSchema.parse([
      { captureId: id, title: '14Oct', subject: null, reason: 'r', options: [{ pageId: id, title: 'T', spaceId: id, spaceName: 'S' }], createdAt: '2026-10-27T00:00:00.000Z' },
    ]);
    expect(list[0]!.options).toHaveLength(1);
  });

  it('document_not_waiting is a 409', () => {
    expect(ERROR_STATUS.document_not_waiting).toBe(409);
  });
});
