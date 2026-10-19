/**
 * The principal key stored in `chunks.inbox_owner` and compared against the
 * searching actor: `"{type}:{id}"`, e.g. `user:5f0c…`.
 */
export function principalKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * `chunks.inbox_owner` for a document's chunks: its creator's principal key
 * while the document sits in the Inbox (the one space with per-item
 * visibility), otherwise null.
 */
export function chunkInboxOwner(
  spaceKind: 'normal' | 'inbox',
  doc: { createdByType: string; createdBy: string }
): string | null {
  return spaceKind === 'inbox' ? principalKey(doc.createdByType, doc.createdBy) : null;
}

/**
 * `pages.slug_scope` for a page: its creator's principal key while it sits in
 * the Inbox (so each member's private slugs are unique only among their own
 * items and never collide with, or reveal, another member's), otherwise ''
 * (one slug per space).
 */
export function pageSlugScope(
  spaceKind: 'normal' | 'inbox',
  doc: { createdByType: string; createdBy: string }
): string {
  return spaceKind === 'inbox' ? principalKey(doc.createdByType, doc.createdBy) : '';
}
