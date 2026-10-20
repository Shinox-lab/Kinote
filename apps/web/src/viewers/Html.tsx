import { useMemo } from 'react';
import { sanitizeHtml } from './sanitize.js';

/** The only place the console sets markup: the string has just been through `sanitizeHtml`. */
export function Html({ html, className }: { html: string; className?: string }) {
  const safe = useMemo(() => sanitizeHtml(html), [html]);
  // eslint-disable-next-line react/no-danger -- sanitised on the line above
  return <div className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
}
