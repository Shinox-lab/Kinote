import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { captures, withTenantTx } from '@kinote/db';
import { useCaptureKit } from './support/capturekit.js';
import { pdf } from './support/sourcekit.js';

describe('filing instructions in a capture', () => {
  const k = useCaptureKit();
  const row = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(captures).where(eq(captures.id, id))))[0]!;

  test('a typed "only update" with a file routes as updates', async () => {
    const w = await k.world();
    const file = await k.upload(w.headers, w.inbox, 'notes.pdf', pdf('George launch moved to December.'));
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'only update the pages', file_id: file });
    expect(res.statusCode, res.body).toBe(201);
    await w.run();
    const detail = (await k.get(w.headers, `/api/v1/captures/${res.json().id}`)).json();
    expect(detail.capture.shape).toBe('updates');
  });

  test('a stored hint', async () => {
    const w = await k.world();
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'George launch moved to December. put it under 29Sep' });
    await w.run();
    expect((await row(w.tenant.id, res.json().id)).filingHint).toBe('29Sep');
  });
});
