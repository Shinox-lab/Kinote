// Comment bodies are the comment editor's blocks (BlockNote JSON): the panel
// shows them as text and writes replies as plain paragraphs.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!isRecord(item)) return '';
      if (typeof item.text === 'string') return item.text;
      return inlineText(item.content);
    })
    .join('');
}

/** A comment's text: one line per block. */
export function commentText(body: unknown): string {
  if (!Array.isArray(body)) return '';
  return body
    .map((b) => (isRecord(b) ? inlineText(b.content) : ''))
    .filter((line) => line !== '')
    .join('\n');
}

/** A comment body for typed text: a paragraph per non-empty line. */
export function commentBody(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line, styles: {} }] }));
}

/** The page route's `?comments=1`: open the comments panel (where a comment notification lands). */
export function parseCommentsSearch(search: Record<string, unknown>): { comments?: 1 } {
  return search.comments === 1 || search.comments === '1' ? { comments: 1 } : {};
}
