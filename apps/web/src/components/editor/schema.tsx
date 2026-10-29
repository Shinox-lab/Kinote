import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import { calloutConfig, collectionViewConfig, fileEmbedConfig, mentionConfig, mentionPath, pageLinkConfig, pageLinkPath } from '@living-wiki/contracts';
import { FileEmbedView } from './FileEmbedView.js';
import { PageLinkView } from './PageLinkView.js';
import { CollectionViewBlock } from '../views/CollectionViewBlock.js';

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

/** The emoji a callout cycles through when its emoji is clicked. */
export const CALLOUT_EMOJI = ['💡', '⚠️', '✅', '❗', '📌', 'ℹ️'];

/** A callout: a tinted block led by an emoji (`calloutConfig`; the server's has the same type and props). */
const callout = createReactBlockSpec(calloutConfig, {
  render: ({ block, editor, contentRef }) => {
    const next = CALLOUT_EMOJI[(CALLOUT_EMOJI.indexOf(block.props.emoji) + 1) % CALLOUT_EMOJI.length]!;
    return (
      <div className="callout" data-emoji={block.props.emoji}>
        <button
          type="button"
          contentEditable={false}
          className="callout-emoji"
          aria-label={`Callout icon ${block.props.emoji}; change it`}
          disabled={!editor.isEditable}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.updateBlock(block, { props: { emoji: next } })}
        >
          {block.props.emoji}
        </button>
        <div className="callout-text" ref={contentRef} />
      </div>
    );
  },
})();

/** A collection view: tabs of table, board, calendar and timeline views of a collection (`collectionViewConfig`). */
const collectionView = createReactBlockSpec(collectionViewConfig, {
  render: ({ block, editor }) => (
    <CollectionViewBlock
      collectionId={block.props.collectionId}
      title={block.props.title}
      views={block.props.views}
      editable={editor.isEditable}
      update={(props) => editor.updateBlock(block, { props })}
    />
  ),
  toExternalHTML: ({ block }) => (
    <p>
      Collection view: <a href={pageLinkPath(block.props.collectionId)}>collection</a>
    </p>
  ),
})();

/** The wiki's block schema: BlockNote's defaults plus page links, mentions, embedded files, callouts and collection views (the same as the server's). */
export const wikiSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, fileEmbed, callout, collectionView },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink, mention },
});

export type WikiEditor = typeof wikiSchema.BlockNoteEditor;
