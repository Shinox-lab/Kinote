// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { withoutCdnSource } from '../src/components/drawing/excalidrawEnv.js';

describe('Excalidraw font sources', () => {
  test('drops the esm.sh fallback and keeps Kinote’s own source', () => {
    const source =
      "url(http://127.0.0.1:15173/excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2) format('woff2'), " +
      "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil-Regular.woff2) format('woff2')";
    expect(withoutCdnSource(source)).toBe(
      "url(http://127.0.0.1:15173/excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2) format('woff2')"
    );
  });

  test('leaves other sources and binary data alone', () => {
    const own = "url(/excalidraw-assets/fonts/a.woff2) format('woff2')";
    expect(withoutCdnSource(own)).toBe(own);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(withoutCdnSource(bytes)).toBe(bytes);
  });
});
