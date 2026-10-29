import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  auditEvents,
  documents,
  jobs,
  lockDocument,
  versionContributors,
  versions,
  withTenantTx,
} from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import { fileObjectPath, insertFileVersion, type InsertFileVersionParams } from '../src/files/versions.js';
import { seedFileDocument, type FileSeed } from './fixtures/fileSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const file = (over: Partial<InsertFileVersionParams['file']> = {}): InsertFileVersionParams['file'] => ({
  name: 'a.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 12,
  contentHash: randomUUID(),
  objectKey: 'k',
  handling: 'extractor',
  ...over,
});

async function add(seed: FileSeed, over: Partial<InsertFileVersionParams['file']> = {}, actorType: 'user' | 'agent' | 'connector' = 'user') {
  const versionId = randomUUID();
  const version = await withTenantTx(seed.tenantId, async (tx) => {
    const doc = await lockDocument(tx, seed.tenantId, seed.documentId);
    return insertFileVersion(tx, {
      tenantId: seed.tenantId,
      doc,
      versionId,
      file: file({ objectKey: `${seed.tenantId}/${fileObjectPath(seed.documentId, versionId, 'original')}`, ...over }),
      actor: { type: actorType, id: seed.userId },
      reason: actorType === 'connector' ? 'source' : 'upload',
    });
  });
  return version;
}

const allVersions = (seed: FileSeed) =>
  withTenantTx(seed.tenantId, (tx) =>
    tx.select().from(versions).where(eq(versions.tenantId, seed.tenantId)).orderBy(asc(versions.number))
  );

describe('fileObjectPath', () => {
  it('is files/{document}/{version}/{name} and never holds a file name', () => {
    expect(fileObjectPath('d', 'v', 'original')).toBe('files/d/v/original');
    expect(fileObjectPath('d', 'v', 'extracted.json')).toBe('files/d/v/extracted.json');
  });
});

describe('insertFileVersion', () => {
  it('writes version 1 as extracting with its job, contributor, audit event and document pointer', async () => {
    const seed = await seedFileDocument();
    const version = await add(seed);
    expect(version).toMatchObject({
      number: 1,
      status: 'extracting',
      title: 'a.pdf',
      reason: 'upload',
      createdByType: 'user',
      createdBy: seed.userId,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12,
      extractedKey: null,
      error: null,
    });
    await withTenantTx(seed.tenantId, async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.tenantId, seed.tenantId));
      expect(job).toMatchObject({
        queue: 'file.extract',
        idempotencyKey: `extract:${version.id}`,
        status: 'queued',
        payload: { versionId: version.id },
      });
      const contributors = await tx.select().from(versionContributors).where(eq(versionContributors.versionId, version.id));
      expect(contributors).toHaveLength(1);
      expect(contributors[0]).toMatchObject({ principalType: 'user', principalId: seed.userId });
      const [doc] = await tx.select().from(documents).where(eq(documents.id, seed.documentId));
      expect(doc!.latestVersionId).toBe(version.id);
      expect(doc!.title).toBe('a.pdf');
      const events = await tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, seed.tenantId), eq(auditEvents.subjectId, version.id)));
      expect(events.map((e) => e.type)).toEqual(['version.created']);
    });
  });

  it('numbers the next version and supersedes a version that is still extracting', async () => {
    const seed = await seedFileDocument();
    await add(seed);
    const second = await add(seed);
    expect(second.number).toBe(2);
    expect((await allVersions(seed)).map((v) => v.status)).toEqual(['superseded', 'extracting']);
  });

  it('supersedes a version waiting for review but never an indexed one', async () => {
    const seed = await seedFileDocument();
    const first = await add(seed);
    await withTenantTx(seed.tenantId, (tx) =>
      tx.update(versions).set({ status: 'pending_review' }).where(eq(versions.id, first.id))
    );
    const second = await add(seed);
    await withTenantTx(seed.tenantId, (tx) =>
      tx.update(versions).set({ status: 'indexed' }).where(eq(versions.id, second.id))
    );
    await add(seed);
    expect((await allVersions(seed)).map((v) => v.status)).toEqual(['superseded', 'indexed', 'extracting']);
  });

  it('stores audio and video without a job, with a plain reason', async () => {
    const seed = await seedFileDocument({ title: 'song.mp3' });
    const version = await add(seed, { name: 'song.mp3', mimeType: 'audio/mpeg', handling: 'stored' });
    expect(version.status).toBe('stored');
    expect(version.error).toBe('Kept for download. No text is read from audio or video.');
    await withTenantTx(seed.tenantId, async (tx) => {
      expect(await tx.select().from(jobs).where(eq(jobs.tenantId, seed.tenantId))).toEqual([]);
    });
  });

  it('records a connector as the creator without a contributor row', async () => {
    const seed = await seedFileDocument();
    const version = await add(seed, {}, 'connector');
    expect(version).toMatchObject({ createdByType: 'connector', reason: 'source' });
    await withTenantTx(seed.tenantId, async (tx) => {
      expect(await tx.select().from(versionContributors).where(eq(versionContributors.versionId, version.id))).toEqual([]);
    });
  });
});
