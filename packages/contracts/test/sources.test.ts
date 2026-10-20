import { describe, expect, it } from 'vitest';
import {
  CreateSourceRequestSchema,
  CreateSourceTokenRequestSchema,
  CreateSourceTokenResponseSchema,
  ERROR_SENTENCES,
  ERROR_STATUS,
  ExternalIdSchema,
  SourceDeleteResponseSchema,
  SourceListSchema,
  SourcePutResponseSchema,
  UpdateSourceRequestSchema,
} from '../src/index.js';

describe('source contracts', () => {
  it('accepts external ids of 1 to 256 characters, Unicode included', () => {
    expect(ExternalIdSchema.safeParse('a').success).toBe(true);
    expect(ExternalIdSchema.safeParse('x'.repeat(256)).success).toBe(true);
    expect(ExternalIdSchema.safeParse('報告書/2026 q3.pdf').success).toBe(true);
  });

  it('rejects empty, over-long and control-character external ids', () => {
    expect(ExternalIdSchema.safeParse('').success).toBe(false);
    expect(ExternalIdSchema.safeParse('x'.repeat(257)).success).toBe(false);
    expect(ExternalIdSchema.safeParse('a\u0000b').success).toBe(false);
    expect(ExternalIdSchema.safeParse('a\nb').success).toBe(false);
  });

  it('trims a source name and rejects one over 80 characters', () => {
    const space = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(CreateSourceRequestSchema.parse({ name: '  Reports ', target_space_id: space }).name).toBe('Reports');
    expect(CreateSourceRequestSchema.safeParse({ name: 'n'.repeat(81), target_space_id: space }).success).toBe(false);
    expect(CreateSourceRequestSchema.safeParse({ name: '  ', target_space_id: space }).success).toBe(false);
  });

  it('requires at least one field to update a source', () => {
    expect(UpdateSourceRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateSourceRequestSchema.safeParse({ trusted: true }).success).toBe(true);
    expect(UpdateSourceRequestSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('bounds a token expiry to 1 to 3650 days', () => {
    expect(CreateSourceTokenRequestSchema.safeParse({ name: 'ci', expires_in_days: 0 }).success).toBe(false);
    expect(CreateSourceTokenRequestSchema.safeParse({ name: 'ci', expires_in_days: 3651 }).success).toBe(false);
    expect(CreateSourceTokenRequestSchema.safeParse({ name: 'ci', expires_in_days: 3650 }).success).toBe(true);
    expect(CreateSourceTokenRequestSchema.safeParse({ name: 'ci' }).success).toBe(true);
  });

  it('has the new error codes at 409 with sentences', () => {
    for (const code of ['not_removed', 'source_name_taken'] as const) {
      expect(ERROR_STATUS[code]).toBe(409);
      expect(ERROR_SENTENCES[code].length).toBeGreaterThan(10);
    }
  });

  it('parses the reply shapes', () => {
    const id = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    const info = { id, name: 'ci', prefix: 'abcd1234', createdAt: '2026-10-20T00:00:00.000Z', lastUsedAt: null, expiresAt: null, revokedAt: null };
    expect(CreateSourceTokenResponseSchema.parse({ token: 'lws_x', info }).info.prefix).toBe('abcd1234');
    expect(
      SourceListSchema.parse([
        { id, kind: 'upload_api', name: 'S', targetSpaceId: id, targetSpaceName: 'Docs', trusted: false, status: 'active', itemCount: 0, lastSyncAt: null, createdAt: '2026-10-20T00:00:00.000Z', tokens: [info] },
      ])
    ).toHaveLength(1);
    expect(SourceDeleteResponseSchema.parse({ removed: true })).toEqual({ removed: true });
    expect(SourceDeleteResponseSchema.safeParse({ removed: false }).success).toBe(false);
    expect(SourcePutResponseSchema.shape.created).toBeDefined();
  });
});
