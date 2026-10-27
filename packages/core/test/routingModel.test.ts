import { describe, expect, it } from 'vitest';
import { DeterministicPlacementModel, OpenAIPlacementModel, type CaptureFact, type PlanCandidate } from '../src/index.js';

const model = new DeterministicPlacementModel();

const tree = { spaceId: 's', parentId: null, path: [] as string[], siblings: [] as string[], children: [] as string[] };

const billing: PlanCandidate = {
  ...tree,
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
  ...tree,
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

describe('DeterministicPlacementModel shape', () => {
  it('a note with a title line and a list is a document; its title line is not a fact', async () => {
    const out = await model.splitCapture({
      text: 'Oct 14 meeting with Ryko\n1. Hero video swap.\n2. Shop The Look.\n3. Launch end of December.',
    });
    expect(out.shape).toEqual({ shape: 'document', confidence: 0.8, subject: 'Ryko', title: 'Oct 14 meeting with Ryko' });
    expect(out.facts.map((f) => f.statement)).toEqual(['Hero video swap.', 'Shop The Look.', 'Launch end of December.']);
    for (const f of out.facts) expect(f.names).toContain('Ryko');
  });

  it('one sentence is updates', async () => {
    const out = await model.splitCapture({ text: 'George video cost is RM200.' });
    expect(out.shape).toEqual({ shape: 'updates', confidence: 0.9, subject: null, title: null });
  });

  it('placeDocument picks the candidate with children, subject first', async () => {
    const meeting: PlanCandidate = { ...runbook, documentId: '29sep', title: '29Sep', parentId: 'george', siblings: ['Meeting 1'] };
    const george: PlanCandidate = { ...billing, documentId: 'george', title: 'Client - George', children: ['29Sep', 'Meeting 1'] };
    const input = { title: 'Oct 14 meeting', subject: 'George', text: 'x', examples: [], writableSpaces: [] };
    const { placements } = await model.placeDocument({ ...input, candidates: [meeting, george] });
    expect(placements[0]).toMatchObject({ parentId: 'george', spaceId: 's', title: 'Oct 14 meeting', confidence: 0.8 });
    const bare = await model.placeDocument({ ...input, candidates: [runbook, billing] });
    expect(bare.placements).toEqual([]);
  });

  it('a page next to siblings puts the document under its parent', async () => {
    const meeting: PlanCandidate = { ...runbook, documentId: '29sep', title: '29Sep', parentId: 'george', siblings: ['Meeting 1'] };
    const { placements } = await model.placeDocument({ title: 'T', subject: null, text: 'x', examples: [], writableSpaces: [], candidates: [meeting] });
    expect(placements[0]).toMatchObject({ parentId: 'george', title: 'T' });
  });
});

describe('DeterministicPlacementModel.planEdits', () => {
  it('fromDocument skips the low-confidence fallback', async () => {
    const { edits } = await model.planEdits({
      fact: fact('Lunch is at noon.', 'new', []),
      candidates: [runbook],
      examples: [],
      writableSpaces: [],
      fromDocument: { title: 'X' },
    });
    expect(edits).toEqual([]);
  });

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

  it('reads the flat edit shape models answer with', async () => {
    const m = new OpenAIPlacementModel({
      ...opts,
      fetchImpl: replying({
        edits: [
          { op: 'replace', documentId: 'doc-billing', blockId: 'p1', markdown: 'Billing uses Adyen.', confidence: 0.95, reason: 'moved' },
          { op: 'insert_after', documentId: 'doc-billing', after: null, markdown: 'Note.', confidence: 0.7, reason: 'r' },
        ],
      }),
    });
    const { edits } = await m.planEdits({ fact: fact('Billing moved to Adyen.', 'change', []), candidates: [billing], examples: [], writableSpaces: [] });
    expect(edits).toEqual([
      { op: { op: 'replace', documentId: 'doc-billing', blockId: 'p1', markdown: 'Billing uses Adyen.' }, confidence: 0.95, reason: 'moved' },
      { op: { op: 'insert_after', documentId: 'doc-billing', after: null, markdown: 'Note.' }, confidence: 0.7, reason: 'r' },
    ]);
  });

  it('asks again when it can read none of the edits, instead of planning nothing', async () => {
    const answers = [
      { edits: [{ action: 'replace', page: 'doc-billing', confidence: 0.9 }] },
      { edits: [{ op: 'remove', documentId: 'doc-billing', blockId: 'p1', confidence: 0.9, reason: 'gone' }] },
    ];
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new OpenAIPlacementModel({ ...opts, fetchImpl });
    const { edits } = await m.planEdits({ fact: fact('Billing no longer uses Stripe.', 'removal', []), candidates: [billing], examples: [], writableSpaces: [] });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('rejected');
    expect(edits).toEqual([{ op: { op: 'remove', documentId: 'doc-billing', blockId: 'p1' }, confidence: 0.9, reason: 'gone' }]);
  });

  it('the split reads the shape leniently', async () => {
    const facts = [{ statement: 'Shop the look.', kind: 'new', names: [] }];
    const odd = new OpenAIPlacementModel({ ...opts, fetchImpl: replying({ shape: 'memo', confidence: 3, subject: 'Ryko', title: 'T', facts }) });
    expect((await odd.splitCapture({ text: 'x' })).shape).toEqual({ shape: 'updates', confidence: 1, subject: 'Ryko', title: 'T' });
    const doc = new OpenAIPlacementModel({ ...opts, fetchImpl: replying({ shape: 'document', confidence: 0.7, facts }) });
    expect((await doc.splitCapture({ text: 'x' })).shape).toEqual({ shape: 'document', confidence: 0.7, subject: null, title: null });
    const none = new OpenAIPlacementModel({ ...opts, fetchImpl: replying({ facts }) });
    expect((await none.splitCapture({ text: 'x' })).shape).toBeNull();
  });

  function recording(content: unknown) {
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  it("the planner sees each candidate's page tree and the document rule", async () => {
    const meeting: PlanCandidate = { ...runbook, title: '29Sep', path: ['Clients', 'Client - George'], siblings: ['Meeting 1'], children: ['29Sep notes'] };
    const r = recording({ edits: [] });
    const m = new OpenAIPlacementModel({ ...opts, fetchImpl: r.fetchImpl });
    await m.planEdits({ fact: fact('x', 'new', []), candidates: [meeting], examples: [], writableSpaces: [] });
    const user = r.bodies[0]!.messages[1]!.content;
    expect(user).toContain('Path: Clients > Client - George | Siblings: Meeting 1 | Children: 29Sep notes');
    expect(r.bodies[0]!.messages[0]!.content).not.toContain('already filed as its own page');
    await m.planEdits({ fact: fact('x', 'new', []), candidates: [meeting], examples: [], writableSpaces: [], fromDocument: { title: '14Oct' } });
    expect(r.bodies[1]!.messages[0]!.content + r.bodies[1]!.messages[1]!.content).toContain('already filed as its own page');
  });

  it('placement reads flat placements and asks again when none is readable', async () => {
    const answers = [
      { placements: [{ where: 'george' }] },
      { placements: [{ spaceId: 's', parentId: 'george', title: '14Oct', confidence: 1.4, reason: 'meetings live here' }, { spaceId: 's', parentId: null, title: '14Oct', confidence: 0.3 }] },
    ];
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers.shift()) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new OpenAIPlacementModel({ ...opts, fetchImpl });
    const { placements } = await m.placeDocument({ title: '14Oct', subject: 'George', text: 'notes', candidates: [billing], examples: [], writableSpaces: [] });
    expect(bodies).toHaveLength(2);
    expect(placements).toEqual([
      { spaceId: 's', parentId: 'george', title: '14Oct', confidence: 1, reason: 'meetings live here' },
      { spaceId: 's', parentId: null, title: '14Oct', confidence: 0.3, reason: '' },
    ]);
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
      shape: null,
    });
  });
});
