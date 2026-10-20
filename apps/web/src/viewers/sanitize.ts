import DOMPurify from 'dompurify';
import { Marked } from 'marked';

// The one place uploaded content may become markup. A file's text is shown as text (React text nodes)
// everywhere else; where a viewer needs structure (Markdown, DOCX) it comes through here, and only
// what this allow-list names survives: no scripts, styles, forms, embeds, images, ids, classes or
// inline styles, and links only to http, https or mailto.

const TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'i', 'b', 'u', 's', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'a',
];
const LINK_SCHEMES = /^(?:https?|mailto):/i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

function purify() {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_blank');
    } else if (node.hasAttribute('title')) {
      node.removeAttribute('title');
    }
  });
  purifier = instance;
  return instance;
}

/** The most characters of markup one preview will clean; a larger document is offered for download instead. */
export const HTML_LIMIT_CHARS = 2_000_000;

/** HTML reduced to the allow-list above. Text of removed tags is kept, except for scripts, styles and other code-bearing tags. */
export function sanitizeHtml(dirty: string): string {
  if (dirty.length > HTML_LIMIT_CHARS) throw new RangeError('The document is too large to preview.');
  return purify().sanitize(dirty, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: LINK_SCHEMES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Raw HTML in a Markdown file is text to read, not markup to run; images are not loaded (their alt text stays).
const marked = new Marked({
  async: false,
  gfm: true,
  renderer: {
    html: ({ text }) => escapeText(text),
    image: ({ text }) => escapeText(text),
  },
});

/** Markdown to HTML, then through the allow-list. */
export function markdownToHtml(source: string): string {
  return sanitizeHtml(marked.parse(source, { async: false }));
}
