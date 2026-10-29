import { describe, expect, test } from 'vitest';
import type { Notification } from '@kinote/contracts';
import { notificationHeadline, notificationTarget } from '../src/lib/notifications.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const n = (over: Partial<Notification>): Notification => ({
  id: ID,
  kind: 'mention',
  actorName: 'Ed Editor',
  documentId: ID2,
  documentKind: 'page',
  documentTitle: 'Plan',
  blockId: 'b1',
  threadId: null,
  captureId: null,
  excerpt: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  readAt: null,
  ...over,
});

describe('notificationHeadline', () => {
  test('says who did what, where', () => {
    expect(notificationHeadline(n({}))).toBe('Ed Editor mentioned you in Plan');
    expect(notificationHeadline(n({ kind: 'mention', threadId: ID }))).toBe('Ed Editor mentioned you in a comment on Plan');
    expect(notificationHeadline(n({ kind: 'comment_reply', threadId: ID }))).toBe('Ed Editor replied to a comment on Plan');
    expect(notificationHeadline(n({ kind: 'review_requested' }))).toBe('Ed Editor asked for a review of Plan');
    expect(notificationHeadline(n({ kind: 'review_approved' }))).toBe('Ed Editor approved your changes to Plan');
    expect(notificationHeadline(n({ kind: 'review_rejected' }))).toBe('Ed Editor sent back your changes to Plan');
    expect(notificationHeadline(n({ kind: 'capture_waiting', documentId: null, documentTitle: null, captureId: ID }))).toBe(
      'Something you captured needs your answer or a place'
    );
  });

  test('a page without a title is Untitled', () => {
    expect(notificationHeadline(n({ documentTitle: '' }))).toBe('Ed Editor mentioned you in Untitled');
  });
});

describe('notificationTarget', () => {
  test('a page opens at the block, a thread with its comments, a review in Reviews, a capture on Capture', () => {
    expect(notificationTarget(n({}), 'acme')).toEqual({ href: `/w/acme/p/${ID2}#block-b1` });
    expect(notificationTarget(n({ threadId: ID }), 'acme')).toEqual({ href: `/w/acme/p/${ID2}?comments=1` });
    expect(notificationTarget(n({ kind: 'review_requested' }), 'acme')).toEqual({ href: '/w/acme/reviews' });
    expect(notificationTarget(n({ kind: 'capture_waiting', documentId: null, captureId: ID }), 'acme')).toEqual({ href: '/w/acme/capture' });
  });
});
