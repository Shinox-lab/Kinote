import { VIEWER_TIMEOUT_MS, withTimeout } from '../lib/viewers.js';
import { Loading } from '../components/ui.js';
import { Html } from './Html.js';
import { PROSE } from './prose.js';
import { sanitizeHtml } from './sanitize.js';
import { useAsyncOrThrow } from './useAsyncOrThrow.js';

/** Word's text and structure, cleaned (see sanitize.ts); pictures are not shown. A file Word's reader refuses falls back to the download. */
export default function DocxViewer({ bytes, versionId }: { bytes: ArrayBuffer; versionId: string }) {
  const html = useAsyncOrThrow(versionId, () =>
    withTimeout(
      import('mammoth').then(async (m) => {
        const lib = (m as unknown as { default?: typeof m }).default ?? m;
        const { value } = await lib.convertToHtml({ arrayBuffer: bytes }, { ignoreEmptyParagraphs: true });
        return sanitizeHtml(value);
      }),
      VIEWER_TIMEOUT_MS
    )
  );
  if (html === undefined) return <Loading what="document" />;
  return <Html html={html} className={PROSE} />;
}
