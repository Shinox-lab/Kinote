import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactInlineContentSpec } from '@blocknote/react';
import { mentionConfig, mentionPath, pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
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

/** The wiki's block schema: BlockNote's defaults plus page links and mentions (the same as the server's). */
export const wikiSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink, mention },
});

export type WikiEditor = typeof wikiSchema.BlockNoteEditor;
