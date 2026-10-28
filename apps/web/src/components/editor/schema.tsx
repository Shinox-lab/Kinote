import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import { fileEmbedConfig, mentionConfig, mentionPath, pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
import { FileEmbedView } from './FileEmbedView.js';
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

/** A mentioned person, by the name they had when mentioned (`mentionConfig`; the server's has the same type and props). */
const mention = createReactInlineContentSpec(mentionConfig, {
  render: ({ inlineContent }) => (
    <span className="mention" data-mention={inlineContent.props.userId}>
      @{inlineContent.props.name || 'Someone'}
    </span>
  ),
  toExternalHTML: ({ inlineContent }) => (
    <a href={mentionPath(inlineContent.props.userId)}>@{inlineContent.props.name || 'Someone'}</a>
  ),
});

/** A pasted file: a card or an inline preview, always pointing at the file document. */
const fileEmbed = createReactBlockSpec(fileEmbedConfig, {
  render: ({ block }) => (
    <FileEmbedView documentId={block.props.documentId} name={block.props.name} error={block.props.error} />
  ),
})();

/** The wiki's block schema: BlockNote's defaults plus page links, mentions and embedded files (the same as the server's). */
export const wikiSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, fileEmbed },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink, mention },
});

export type WikiEditor = typeof wikiSchema.BlockNoteEditor;
