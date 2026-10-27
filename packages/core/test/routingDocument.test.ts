import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import {
  planDocument,
  recordRoutingExample,
  type DocumentPlacement,
  type PlaceDocumentInput,
  type RoutingModel,
} from '../src/index.js';
import { addCapture, addMember, addRoutingSpace, embedder, livePage, model, routingWorld } from './fixtures/routingSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const NOTE = 'Oct 14 meeting with George\n- George hero video swap.\n- Shop the look.\n- George launch moved to December.';
const TITLE = 'Oct 14 meeting with George';

async function georgeWorld() {
  const w = await routingWorld();
  const clients = await addRoutingSpace(w, { name: 'Clients' });
  const george = await livePage(w, clients, 'Client - George', 'George is a client. Launch is in November.');
  await livePage(w, clients, 'Meeting 1', 'George first meeting agenda.', { parentId: george.documentId });
  await livePage(w, clients, '29Sep', 'George hero video notes.', { parentId: george.documentId });
  return { w, clients, george };
}

function recordingModel(over: Partial<RoutingModel> = {}) {
  const calls: PlaceDocumentInput[] = [];
  const m: RoutingModel = Object.assign(Object.create(model), {
    async placeDocument(input: PlaceDocumentInput) {
      calls.push(input);
      return over.placeDocument ? over.placeDocument(input) : model.placeDocument(input);
    },
  });
  return { m, calls };
}

const plan = (tenantId: string, captureId: string, m: RoutingModel = model) =>
  planDocument({ tenantId, captureId, title: TITLE, subject: 'George', names: ['George'] }, { model: m, embedder });

describe('planDocument', () => {
  it('a meeting note goes under the client page, titled as given', async () => {
    const { w, clients, george } = await georgeWorld();
    const result = await plan(w.tenantId, await addCapture(w, w.userId, NOTE));
    expect(result).toMatchObject({ status: 'place', spaceId: clients, parentId: george.documentId, title: TITLE });
  });

  it('a taken title gets a suffix', async () => {
    const { w, clients, george } = await georgeWorld();
    await livePage(w, clients, 'oct 14 MEETING with george', 'Earlier notes.', { parentId: george.documentId });
    const result = await plan(w.tenantId, await addCapture(w, w.userId, NOTE));
    expect(result).toMatchObject({ status: 'place', parentId: george.documentId, title: `${TITLE} (2)` });
  });

  it('a page scope is the parent without asking the model', async () => {
    const { w, george } = await georgeWorld();
    const { m, calls } = recordingModel();
    const result = await plan(w.tenantId, await addCapture(w, w.userId, NOTE, { pageId: george.documentId }), m);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: 'place', parentId: george.documentId, confidence: 1 });
  });

  it('the best place in a read-only space waits', async () => {
    const { w, clients } = await georgeWorld();
    const other = await addRoutingSpace(w, { name: 'Other' });
    const member = await addMember(w, [
      [clients, 'viewer'],
      [other, 'editor'],
    ]);
    const result = await plan(w.tenantId, await addCapture(w, member, NOTE));
    expect(result).toMatchObject({ status: 'needs_home', reason: "The best place is in a space you can't edit." });
  });

  it('two parents within the margin wait, with options', async () => {
    const { w, clients, george } = await georgeWorld();
    const other = await livePage(w, clients, 'George archive', 'George old notes.');
    const placements: DocumentPlacement[] = [
      { spaceId: clients, parentId: george.documentId, title: TITLE, confidence: 0.8, reason: 'a' },
      { spaceId: clients, parentId: other.documentId, title: TITLE, confidence: 0.75, reason: 'b' },
    ];
    const { m } = recordingModel({ placeDocument: async () => ({ placements }) });
    const result = await plan(w.tenantId, await addCapture(w, w.userId, NOTE), m);
    expect(result.status).toBe('needs_home');
    if (result.status !== 'needs_home') return;
    expect(result.reason).toBe('Two places fit this page about equally well.');
    expect(result.options.map((o) => o.pageId).slice(0, 2)).toEqual([george.documentId, other.documentId]);
    expect(result.options[0]).toMatchObject({ title: 'Client - George', spaceId: clients, spaceName: 'Clients' });
  });

  it('nothing that fits waits', async () => {
    const { w } = await georgeWorld();
    const { m } = recordingModel({ placeDocument: async () => ({ placements: [] }) });
    const result = await plan(w.tenantId, await addCapture(w, w.userId, NOTE), m);
    expect(result).toMatchObject({ status: 'needs_home', reason: 'No place fits this page well enough.' });
  });

  it('document examples teach placement; fact examples do not', async () => {
    const { w, george } = await georgeWorld();
    await recordRoutingExample(
      w.tenantId,
      { statement: 'George Oct 1 meeting', chosenDocumentId: george.documentId, wrongDocumentId: null, createdBy: w.userId, kind: 'document' },
      embedder
    );
    await recordRoutingExample(
      w.tenantId,
      { statement: 'George pays monthly.', chosenDocumentId: george.documentId, wrongDocumentId: null, createdBy: w.userId },
      embedder
    );
    const { m, calls } = recordingModel();
    await plan(w.tenantId, await addCapture(w, w.userId, NOTE), m);
    expect(calls[0]!.examples).toEqual([{ statement: 'George Oct 1 meeting', chosenTitle: 'Client - George' }]);
  });
});
