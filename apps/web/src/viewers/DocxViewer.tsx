import { VIEWER_TIMEOUT_MS, withTimeout } from '../lib/viewers.js';
import { Loading } from '../components/ui.js';
import { Html } from './Html.js';
import { PROSE } from './prose.js';
import { docxToHtml } from './docx.js';
import { useAsyncOrThrow } from './useAsyncOrThrow.js';

/** Word's text and structure, cleaned (see sanitize.ts); pictures are not shown. A file Word's reader refuses falls back to the download. */
export default function DocxViewer({ bytes, versionId }: { bytes: ArrayBuffer; versionId: string }) {
  const html = useAsyncOrThrow(versionId, () => withTimeout(docxToHtml(bytes), VIEWER_TIMEOUT_MS));
  if (html === undefined) return <Loading what="document" />;
  return <Html html={html} className={PROSE} />;
}
