import { useMemo } from 'react';
import { TEXT_PREVIEW_CHARS, capText } from '../lib/viewers.js';
import { Html } from './Html.js';
import { PROSE } from './prose.js';
import { markdownToHtml } from './sanitize.js';

/** A Markdown file as a document: parsed, raw HTML turned into text, then cleaned (see sanitize.ts). */
export default function MarkdownViewer({ bytes }: { bytes: ArrayBuffer }) {
  const { html, truncated } = useMemo(() => {
    const { text, truncated: cut } = capText(new TextDecoder('utf-8').decode(bytes), TEXT_PREVIEW_CHARS);
    return { html: markdownToHtml(text), truncated: cut };
  }, [bytes]);
  return (
    <div className="flex flex-col gap-2">
      <div className="mx-auto w-full max-w-[660px]"><Html html={html} className={PROSE} /></div>
      {truncated && <p className="text-xs text-muted">Showing the first {TEXT_PREVIEW_CHARS.toLocaleString('en-US')} characters. Download the file to read the rest.</p>}
    </div>
  );
}
