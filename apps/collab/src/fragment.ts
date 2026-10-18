/**
 * The Y.XmlFragment name inside each page's Y.Doc that holds the BlockNote
 * blocks. Must stay in sync with apps/api (encodePageYDoc), packages/core
 * (takePageSnapshot) and apps/worker (snapshot handler).
 */
export const BLOCK_FRAGMENT = 'document-store';
