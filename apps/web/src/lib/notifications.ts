import type { Notification } from '@living-wiki/contracts';
import { documentHref } from './documentLink.js';

/** One line saying who did what, where. */
export function notificationHeadline(n: Notification): string {
  const where = n.documentTitle || 'Untitled';
  switch (n.kind) {
    case 'mention':
      return n.threadId ? `${n.actorName} mentioned you in a comment on ${where}` : `${n.actorName} mentioned you in ${where}`;
    case 'comment_reply':
      return `${n.actorName} replied to a comment on ${where}`;
    case 'review_requested':
      return `${n.actorName} asked for a review of ${where}`;
    case 'review_approved':
      return `${n.actorName} approved your changes to ${where}`;
    case 'review_rejected':
      return `${n.actorName} sent back your changes to ${where}`;
    case 'capture_waiting':
      return 'Something you captured needs your answer or a place';
  }
}

/**
 * Where a notification takes you: a review to Reviews, a capture to Capture,
 * a comment to its page with the comments open, a page mention to its block.
 */
export function notificationTarget(n: Notification, tenantSlug: string): { href: string } {
  const e = encodeURIComponent;
  if (n.kind === 'review_requested') return { href: `/w/${e(tenantSlug)}/reviews` };
  if (n.kind === 'capture_waiting' || !n.documentId) return { href: `/w/${e(tenantSlug)}/capture` };
  const base = documentHref(tenantSlug, n.documentKind ?? 'page', n.documentId);
  if (n.threadId) return { href: `${base}?comments=1` };
  if (n.blockId) return { href: `${base}#block-${e(n.blockId)}` };
  return { href: base };
}
