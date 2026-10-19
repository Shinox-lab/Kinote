import type { TreeNode } from '@living-wiki/contracts';
import { attentionLabel } from '../../lib/wiki.js';

const COLOR = {
  failed: 'bg-dot-failed',
  review: 'bg-dot-review',
  editing: 'bg-dot-editing',
} as const;

/** The small status dot of a page row. The colour is decoration; the accessible name says what it means. */
export function AttentionDot({ attention }: { attention: TreeNode['attention'] }) {
  if (attention === null) return null;
  const label = attentionLabel(attention);
  return <span role="img" aria-label={label} title={label} className={`size-2 shrink-0 rounded-full ${COLOR[attention]}`} />;
}
