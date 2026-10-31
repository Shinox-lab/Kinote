import { useMemo } from 'react';
import { Html } from './Html.js';
import { PROSE } from './prose.js';
import { markdownToHtml } from './sanitize.js';

/** Markdown held in memory (an Ask answer), parsed and cleaned like a Markdown file.
 * Loaded lazily, so marked and DOMPurify stay out of the main bundle. */
export default function MarkdownText({ source }: { source: string }) {
  const html = useMemo(() => markdownToHtml(source), [source]);
  return <Html html={html} className={`${PROSE} text-fg`} />;
}
