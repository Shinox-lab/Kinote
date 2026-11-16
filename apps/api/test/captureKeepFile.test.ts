import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents, spaces, withTenantTx } from '@kinote/db';
import { useCaptureKit } from './support/capturekit.js';
import { pdf } from './support/sourcekit.js';

describe('keeping a capture’s file', () => {
  const k = useCaptureKit();
  const fileRow = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
  const spaceKind = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select({ kind: spaces.kind }).from(spaces).where(eq(spaces.id, id))))[0]!.kind;
  const detailOf = async (headers: Record<string, string>, id: string) => (await k.get(headers, `/api/v1/captures/${id}`)).json();

  test('an updates capture with "keep the file" files the file too', async () => {
    const w = await k.world();
    const file = await k.upload(w.headers, w.inbox, 'contract.pdf', pdf('George signs for two years.'));
    const text = 'George launch moved to December. keep the file as a copy. put it under Client - George. only update the pages.';
    const res = await k.post(w.headers, '/api/v1/captures', { text, file_id: file });
    expect(res.statusCode, res.body).toBe(201);
    await w.run();
    const detail = await detailOf(w.headers, res.json().id);
    expect(detail.capture).toMatchObject({ status: 'done', shape: 'updates', fileOutcome: 'placed' });
    expect(await k.pageText(w.tenant.id, w.george)).toContain('December');
    expect(await fileRow(w.tenant.id, file)).toMatchObject({ parentId: w.george, spaceId: w.clients });
    expect(detail.receipt.file).toMatchObject({ outcome: 'placed', reason: 'Filed under "Client - George".', fileId: file, parentId: w.george });
  });

  test('a chat export only carries facts', async () => {
    const w = await k.world();
    const file = await k.upload(w.headers, w.inbox, 'chat.txt', 'George launch moved to December.', 'text/plain');
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'only update', file_id: file });
    await w.run();
    const detail = await detailOf(w.headers, res.json().id);
    expect(detail.capture).toMatchObject({ shape: 'updates', fileOutcome: 'inbox', fileReason: 'Kept in your Inbox: the file only carried facts.' });
    expect(await spaceKind(w.tenant.id, (await fileRow(w.tenant.id, file)).spaceId)).toBe('inbox');
  });

  test('keep_file: inbox wins over the model', async () => {
    const w = await k.world();
    const file = await k.upload(w.headers, w.inbox, 'contract.pdf', pdf('George signs for two years.'));
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'only update', file_id: file, keep_file: 'inbox' });
    await w.run();
    const detail = await detailOf(w.headers, res.json().id);
    expect(detail.capture).toMatchObject({ fileOutcome: 'inbox', fileReason: 'Kept in your Inbox, as asked.' });
    expect(await spaceKind(w.tenant.id, (await fileRow(w.tenant.id, file)).spaceId)).toBe('inbox');
  });

  test('a document capture keeps its file with the page', async () => {
    const w = await k.world();
    const file = await k.upload(w.headers, w.inbox, 'George kickoff.pdf', pdf('George launch moved to December.'));
    const res = await k.post(w.headers, '/api/v1/captures', { file_id: file });
    await w.run();
    const detail = await detailOf(w.headers, res.json().id);
    expect(detail.capture).toMatchObject({ shape: 'document', fileOutcome: 'with_document' });
    expect((await fileRow(w.tenant.id, file)).parentId).toBe(detail.receipt.document.pageId);
    expect(detail.receipt.file).toMatchObject({ outcome: 'with_document', parentId: detail.receipt.document.pageId });
  });

  test('a hint places a new document page', async () => {
    const w = await k.world();
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'Kickoff notes\n- Hero video is final.\n- Shop the look.\n- Launch in December.\nput it under 29Sep' });
    await w.run();
    const detail = await detailOf(w.headers, res.json().id);
    expect(detail.capture.shape).toBe('document');
    expect(detail.receipt.document).toMatchObject({ outcome: 'created' });
    expect((await fileRow(w.tenant.id, detail.receipt.document.pageId)).parentId).toBe(w.sep29);
  });
});
