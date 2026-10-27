/**
 * The custom inline content of the wiki's editor, shared by the web editor
 * (React rendering) and the server editors (plain rendering), which must
 * agree on type and props or a server conversion drops the node.
 */
export const pageLinkConfig = {
  type: 'pageLink',
  propSchema: {
    documentId: { default: '' },
    /** The target's title when the link was made: what plain text, search and the router read. */
    title: { default: '' },
  },
  content: 'none',
} as const;

/** The Markdown form of a page link is a link to this path, so it survives a Markdown round trip. */
export const pageLinkPath = (documentId: string) => `/p/${documentId}`;
export const PAGE_LINK_PATH = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
