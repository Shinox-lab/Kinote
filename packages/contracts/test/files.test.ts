import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ChunkInspectorSchema,
  ExtractedDocumentSchema,
  FileDetailsSchema,
  FileTypeSchema,
  FileVersionListSchema,
  FileVersionSchema,
  UploadFileFieldsSchema,
  UploadFileResponseSchema,
  MoveFileRequestSchema,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/extracted-sample.json', import.meta.url), 'utf8')
);

const id = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const summary = {
  id, number: 1, status: 'indexed', reason: 'upload', createdByType: 'user', createdBy: id,
  createdAt: '2026-10-20T00:00:00.000Z', reviewedBy: null, reviewedAt: null, reviewNote: null,
  indexedAt: '2026-10-20T00:00:01.000Z', error: null,
};
const version = { ...summary, fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 12, hasText: true };

describe('file contracts', () => {
  it('parses the shared extracted-document fixture', () => {
    const parsed = ExtractedDocumentSchema.parse(fixture);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[1]!.kind).toBe('table');
  });

  it('refuses a section on page 0', () => {
    const bad = { ...fixture, sections: [{ ...fixture.sections[0], pageFrom: 0 }] };
    expect(ExtractedDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses svg and xml as file types', () => {
    expect(FileTypeSchema.safeParse('svg').success).toBe(false);
    expect(FileTypeSchema.safeParse('xml').success).toBe(false);
    expect(FileTypeSchema.safeParse('pdf').success).toBe(true);
  });

  it('needs the unchanged flag on an upload reply', () => {
    const document = {
      id, spaceId: id, parentId: null, position: 'a0', title: 'a.pdf', icon: null, archivedAt: null, indexedVersionId: null,
    };
    expect(UploadFileResponseSchema.safeParse({ document, version }).success).toBe(false);
    expect(UploadFileResponseSchema.safeParse({ document, version, unchanged: false }).success).toBe(true);
  });

  it('carries the file facts on a version and a name on the history list', () => {
    expect(FileVersionSchema.parse(version).fileName).toBe('a.pdf');
    expect(FileVersionListSchema.parse([{ ...version, createdByName: 'Aisha' }])[0]!.createdByName).toBe('Aisha');
    expect(FileVersionSchema.safeParse(summary).success).toBe(false);
  });

  it('describes a file with its badge and versions', () => {
    const details = {
      id, spaceId: id, parentId: null, title: 'a.pdf', archivedAt: null, placement: 'pinned',
      sourceDeletedAt: null, badge: 'Indexed · v1', latestVersion: version, indexedVersion: version,
    };
    expect(FileDetailsSchema.parse(details).badge).toBe('Indexed · v1');
  });

  it('validates upload fields and a move request', () => {
    expect(UploadFileFieldsSchema.parse({})).toEqual({});
    expect(UploadFileFieldsSchema.safeParse({ space_id: 'nope' }).success).toBe(false);
    expect(MoveFileRequestSchema.parse({ target_space_id: id }).position).toBe('a0');
  });

  it('describes the chunk inspector', () => {
    const parsed = ChunkInspectorSchema.parse({
      versionId: id, indexed: false, ready: true, pageCount: 2, ocrUsed: false,
      sections: fixture.sections,
      chunks: [{ ordinal: 0, headingPath: ['A'], pageFrom: 1, pageTo: null, text: 't', tokenCount: 1 }],
    });
    expect(parsed.chunks[0]!.pageTo).toBeNull();
  });
});
