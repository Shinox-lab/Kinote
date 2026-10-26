import { describe, expect, it } from 'vitest';
import { DeterministicPlacementModel, OpenAIPlacementModel, type CaptureFact, type PlanCandidate } from '../src/index.js';

const model = new DeterministicPlacementModel();

const billing: PlanCandidate = {
  documentId: 'doc-billing',
  title: 'Billing service',
  summary: 'How billing works.',
  outline: ['# Billing service'],
  blocks: [
    { id: 'h', type: 'heading', text: 'Billing service' },
    { id: 'p1', type: 'paragraph', text: 'Billing uses Stripe.' },
    { id: 'p2', type: 'paragraph', text: 'Aisha Rahman owns the service.' },
  ],
};
const runbook: PlanCandidate = {
  documentId: 'doc-runbook',
  title: 'Runbook',
  summary: 'On-call steps.',
  outline: [],
  blocks: [
    { id: 'r1', type: 'paragraph', text: 'Page the on-call.' },
    { id: 'r2', type: 'paragraph', text: 'Check the dashboard.' },
  ],
};

function fact(statement: string, kind: CaptureFact['kind'], names: string[]): CaptureFact {
  return { statement, kind, names, date: null };
}

function plan(f: CaptureFact, candidates: PlanCandidate[]) {
  return model.planEdits({ fact: f, candidates, examples: [], writableSpaces: [] });
}

describe('DeterministicPlacementModel.splitCapture', () => {
  it('makes one fact per sentence, with its kind and names', async () => {
    const { facts } = await model.splitCapture({
      text: 'Billing moved to Adyen. Billing no longer uses Stripe.\nAisha Rahman joined Platform.',
    });
    expect(facts).toEqual([
      { statement: 'Billing moved to Adyen.', kind: 'change', names: ['Billing', 'Adyen'], date: null },
      { statement: 'Billing no longer uses Stripe.', kind: 'removal', names: ['Billing', 'Stripe'], date: null },
      { statement: 'Aisha Rahman joined Platform.', kind: 'new', names: ['Aisha Rahman', 'Platform'], date: null },
    ]);
  });
});

describe('DeterministicPlacementModel.planEdits', () => {
  it('a block that already says it is already_known', async () => {
    const { edits } = await plan(fact('billing uses  Stripe', 'new', ['Billing', 'Stripe']), [billing]);
    expect(edits).toEqual([
      { op: { op: 'already_known', documentId: 'doc-billing', blockId: 'p1' }, confidence: 1, reason: expect.any(String) },
    ]);
  });

  it('a removal removes the block holding the phrase', async () => {
    const { edits } = await plan(fact('Billing no longer uses Stripe.', 'removal', ['Billing', 'Stripe']), [billing]);
    expect(edits.map((e) => [e.op, e.confidence])).toEqual([
      [{ op: 'remove', documentId: 'doc-billing', blockId: 'p1' }, 0.9],
    ]);
  });

  it('a change replaces the first non-heading block naming it', async () => {
    const { edits } = await plan(fact('Billing moved to Adyen.', 'change', ['Billing', 'Adyen']), [runbook, billing]);
    expect(edits.map((e) => [e.op, e.confidence])).toEqual([
      [{ op: 'replace', documentId: 'doc-billing', blockId: 'p1', markdown: 'Billing moved to Adyen.' }, 0.9],
    ]);
  });

  it('a new fact goes after the first block naming it', async () => {
    const { edits } = await plan(fact('Aisha Rahman is on leave.', 'new', ['Aisha Rahman']), [billing]);
    expect(edits.map((e) => [e.op, e.confidence])).toEqual([
      [{ op: 'insert_after', documentId: 'doc-billing', after: 'p2', markdown: 'Aisha Rahman is on leave.' }, 0.8],
    ]);
  });

  it('with no named block it falls back to the end of the first candidate at low confidence', async () => {
    const { edits } = await plan(fact('Lunch is at noon.', 'new', []), [runbook, billing]);
    expect(edits.map((e) => [e.op, e.confidence])).toEqual([
      [{ op: 'insert_after', documentId: 'doc-runbook', after: 'r2', markdown: 'Lunch is at noon.' }, 0.5],
    ]);
  });

  it('with no candidates it plans nothing', async () => {
    expect((await plan(fact('Lunch is at noon.', 'new', []), [])).edits).toEqual([]);
  });
});

describe('OpenAIPlacementModel routing', () => {
  function replying(content: unknown) {
    return (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }
  const opts = { baseUrl: 'https://router.example/v1', model: 'm', timeoutMs: 1000, maxTokens: 500 };

  it('drops an edit it cannot read and clamps confidence', async () => {
    const m = new OpenAIPlacementModel({
      ...opts,
      fetchImpl: replying({
        edits: [
          { op: { op: 'teleport', documentId: 'doc-billing' }, confidence: 0.9, reason: 'x' },
          { op: { op: 'remove', documentId: 'doc-billing', blockId: 'p1' }, confidence: 1.7, reason: 'gone' },
        ],
      }),
    });
    const { edits } = await m.planEdits({
      fact: fact('Billing no longer uses Stripe.', 'removal', []),
      candidates: [billing],
      examples: [],
      writableSpaces: [],
    });
    expect(edits).toEqual([{ op: { op: 'remove', documentId: 'doc-billing', blockId: 'p1' }, confidence: 1, reason: 'gone' }]);
  });

  it('reads facts leniently', async () => {
    const m = new OpenAIPlacementModel({
      ...opts,
      fetchImpl: replying({
        facts: [{ statement: 'Billing moved to Adyen.', kind: 'update', names: ['Billing', 7] }, { kind: 'new' }],
      }),
    });
    expect(await m.splitCapture({ text: 'Billing moved to Adyen.' })).toEqual({
      facts: [{ statement: 'Billing moved to Adyen.', kind: 'new', names: ['Billing'], date: null }],
    });
  });
});
