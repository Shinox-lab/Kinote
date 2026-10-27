import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec } from '@blocknote/react';
import { pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
import { PageLinkView } from './PageLinkView.js';

/** The web side of a page link (`pageLinkConfig`); the server editors share its type and props. */
const pageLink = createReactInlineContentSpec(pageLinkConfig, {
  render: ({ inlineContent }) => (
    <PageLinkView documentId={inlineContent.props.documentId} title={inlineContent.props.title} />
  ),
  // Copied out of the editor, a page link is a plain link with its title.
  toExternalHTML: ({ inlineContent }) => (
    <a href={pageLinkPath(inlineContent.props.documentId)}>{inlineContent.props.title || 'Untitled'}</a>
  ),
});

/** The wiki's block schema: BlockNote's defaults plus page links (the same as the server's). */
export const wikiSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink },
});

export type WikiEditor = typeof wikiSchema.BlockNoteEditor;
