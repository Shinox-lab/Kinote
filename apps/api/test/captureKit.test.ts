import { describe, test, expect } from 'vitest';
import { useCaptureKit } from './support/capturekit.js';

describe('capture kit', () => {
  const k = useCaptureKit();

  test('captureWorld boots a routable workspace', async () => {
    const w = await k.world();
    const res = await k.post(w.headers, '/api/v1/captures', { text: 'George launch moved to December.' });
    expect(res.statusCode, res.body).toBe(201);
    await w.run();
    const detail = (await k.get(w.headers, `/api/v1/captures/${res.json().id}`)).json();
    expect(detail.capture).toMatchObject({ status: 'done', preview: false, fileOutcome: null, fileReason: null });
  });
});
