import { sanitizeHtml } from './sanitize.js';

/**
 * Word's text and structure as cleaned HTML. Pictures are dropped before conversion: mammoth would otherwise
 * inline every one as base64, and a few megabytes of photos would push the markup past the size limit.
 */
export async function docxToHtml(
  bytes: ArrayBuffer,
  // The browser build of mammoth reads an ArrayBuffer; the Node build (tests) wants a Buffer.
  input: { arrayBuffer: ArrayBuffer } | { buffer: Buffer } = { arrayBuffer: bytes }
): Promise<string> {
  const m = await import('mammoth');
  const lib = (m as unknown as { default?: typeof m }).default ?? m;
  const { value } = await lib.convertToHtml(
    input,
    { ignoreEmptyParagraphs: true, convertImage: lib.images.imgElement(async () => ({ src: '' })) }
  );
  return sanitizeHtml(value);
}
