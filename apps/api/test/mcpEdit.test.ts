import { describe, test, expect } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { agents, auditEvents, spaceGrants, suggestions, tenantBilling, users, versions, withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { blockText } from '@kinote/core';
import type { BlockLike } from '@kinote/shared';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { serverInstructions } from '../src/mcp/instructions.js';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { callTool, issueAgentToken, listToolNames } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
const CHANGED = 'changed since you read it: read the section again';
const NOT_FOUND = 'not found in the block: quote the words as they read, without Markdown, or read the section again if it changed';
const UNSUPPORTED = "This block can't be edited with kinote_edit; use kinote_capture to propose the change.";

describe('kinote_edit', () => {
  const k = useCaptureKit();

  const blocksOf = async (tenantId: string, pageId: string) => readBlocks(await storedDoc(tenantId, pageId)) as BlockLike[];
  const latestVersion = async (tenantId: string, pageId: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(versions).where(eq(versions.documentId, pageId)).orderBy(desc(versions.number))))[0];
  const openSuggestions = (tenantId: string, pageId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(suggestions).where(and(eq(suggestions.documentId, pageId), eq(suggestions.status, 'open'))));

  /** A member who edits Clients, their agent "Docs bot" with `role` on Clients, and a read+edit token. */
  async function setup(w: CaptureWorld, opts: { role?: 'editor' | 'viewer'; alwaysReview?: boolean; scopes?: Array<'read' | 'capture' | 'edit'> } = {}) {
    const member = await signUpMember(k.app, w.tenant.id, 'member');
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const agentId = await createAgent(w.tenant.id, member.userId, { name: 'Docs bot' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: opts.alwaysReview ?? false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: opts.role ?? 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: opts.scopes ?? ['read', 'edit'] });
    const george = (await blocksOf(w.tenant.id, w.george))[0]!;
    const edit = (edits: unknown[], pageId = w.george) => callTool(k.app, token, 'kinote_edit', { page_id: short(pageId), edits });
    return { member, agentId, token, george, edit };
  }

  /** A page in Clients with a nested list, a table and a closing paragraph. */
  async function opsPage(w: CaptureWorld) {
    const made = await k.post(w.headers, '/api/v1/pages', {
      space_id: w.clients,
      title: 'Ops',
      slug: 'ops',
      markdown: 'Intro text.\n\n- parent\n    - child\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nEnd.',
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    const blocks = await blocksOf(w.tenant.id, id);
    return { id, blocks };
  }

  test('replace applies as the agent', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([{ block_id: short(s.george.id), old: 'November', new: 'December' }]);
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain(`• ${short(s.george.id)} — applied · indexing`);
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in December.');
    const v = (await latestVersion(w.tenant.id, w.george))!;
    expect({ type: v.createdByType, id: v.createdBy, reason: v.reason }).toEqual({ type: 'agent', id: s.agentId, reason: 'agent' });
    const [audit] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.type, 'agent.edit')));
    expect(audit).toMatchObject({ actorType: 'agent', actorId: s.agentId, subjectId: w.george });
  });

  test('insert after a block and at the top, in order', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([
      { after_block_id: null, markdown: 'Top line.' },
      { after_block_id: short(s.george.id), markdown: 'First after.' },
      { after_block_id: short(s.george.id), markdown: 'Second after.' },
    ]);
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain('• top — applied · indexing');
    expect(res.text).toContain(`• after ${short(s.george.id)} — applied · indexing`);
    expect(await k.pageText(w.tenant.id, w.george)).toBe('Top line.\nGeorge is a client. Launch is in November.\nFirst after.\nSecond after.');
  });

  test('remove becomes a suggestion naming the agent', async () => {
    const w = await k.world();
    const s = await setup(w);
    const res = await s.edit([{ remove_block_id: short(s.george.id) }]);
    expect(res.text).toContain(`• ${short(s.george.id)} — suggested: removals wait for a person`);
    const [row] = await openSuggestions(w.tenant.id, w.george);
    expect(row).toMatchObject({ kind: 'remove', blockedBy: 'removal', proposedByType: 'agent', proposedBy: s.agentId, blockId: s.george.id, captureId: null });
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test("a person's recent edit makes a suggestion", async () => {
    const w = await k.world();
    const s = await setup(w);
    await k.collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.george,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'replace',
          blockId: s.george.id,
          blocks: [{ id: s.george.id, type: 'paragraph', props: {}, content: [{ type: 'text', text: 'George is a client. Launch is in November!', styles: {} }], children: [] }],
        },
      ],
    });
    const [owner] = await withTenantTx(w.tenant.id, (tx) => tx.select({ name: users.name }).from(users).where(eq(users.id, w.owner.userId)));
    const res = await s.edit([{ block_id: short(s.george.id), old: 'November', new: 'December' }]);
    expect(res.text).toContain(`suggested: ${owner!.name} edited this block just now`);
    const [row] = await openSuggestions(w.tenant.id, w.george);
    expect(row).toMatchObject({ kind: 'replace', blockedBy: 'protection', proposedBy: s.agentId });
    expect(row!.proposedMarkdown).toContain('December!');
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November!');
  });

  test("accepting an agent's replace suggestion keeps the block's type, props and styles", async () => {
    const w = await k.world();
    const s = await setup(w);
    await k.collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.george,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'replace',
          blockId: s.george.id,
          blocks: [
            {
              id: s.george.id,
              type: 'paragraph',
              props: { textAlignment: 'center', textColor: 'blue', backgroundColor: 'default' },
              content: [
                { type: 'text', text: '1. Launch', styles: { underline: true } },
                { type: 'text', text: ' is in November.', styles: {} },
              ],
              children: [],
            },
          ],
        },
      ],
    });
    const res = await s.edit([{ block_id: short(s.george.id), old: 'November', new: 'December' }]);
    expect(res.text).toContain('suggested:');
    const [row] = await openSuggestions(w.tenant.id, w.george);
    const accepted = await k.post(w.headers, `/api/v1/suggestions/${row!.id}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const [block] = await blocksOf(w.tenant.id, w.george);
    expect(block).toMatchObject({ id: s.george.id, type: 'paragraph', props: { textAlignment: 'center', textColor: 'blue' } });
    expect(block!.content).toEqual([
      { type: 'text', text: '1. Launch', styles: { underline: true } },
      { type: 'text', text: ' is in December.', styles: {} },
    ]);
  });

  test('words quoted with the Markdown kinote_read shows still match', async () => {
    const w = await k.world();
    const s = await setup(w);
    const id = 'abcdef12-3333-4333-8333-333333333333';
    await k.collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.george,
      actor: { type: 'agent', id: s.agentId },
      source: 'agent',
      ops: [
        {
          op: 'insert_after',
          after: s.george.id,
          blocks: [
            {
              id,
              type: 'paragraph',
              props: {},
              content: [
                { type: 'text', text: 'Price', styles: { bold: true } },
                { type: 'text', text: ' is ', styles: {} },
                { type: 'link', href: 'https://x.test/p', content: [{ type: 'text', text: '$10', styles: {} }] },
              ],
              children: [],
            },
          ],
        },
      ],
    });
    const res = await s.edit([{ block_id: 'abcdef12', old: '**Price** is [$10](https://x.test/p)', new: '**Price** is $12' }]);
    expect(res.text).toContain('• abcdef12 — applied');
    const block = (await blocksOf(w.tenant.id, w.george)).find((b) => b.id === id)!;
    expect(block.content).toEqual([{ type: 'text', text: 'Price is $12', styles: { bold: true } }]);
    const missing = await s.edit([{ block_id: 'abcdef12', old: 'Cost', new: 'x' }]);
    expect(missing.text).toContain(`• abcdef12 — refused: ${NOT_FOUND}`);
  });

  test('a viewer grant makes a suggestion', async () => {
    const w = await k.world();
    const s = await setup(w, { role: 'viewer' });
    const res = await s.edit([
      { block_id: short(s.george.id), old: 'November', new: 'December' },
      { after_block_id: short(s.george.id), markdown: 'More.' },
    ]);
    expect(res.text).toContain(`• ${short(s.george.id)} — suggested: no edit access`);
    expect(res.text).toContain(`• after ${short(s.george.id)} — suggested: no edit access`);
    expect((await openSuggestions(w.tenant.id, w.george)).map((r) => [r.kind, r.blockedBy]).sort()).toEqual([
      ['insert', 'no_edit_access'],
      ['replace', 'no_edit_access'],
    ]);
  });

  test("the owner's lost edit access makes a suggestion", async () => {
    const w = await k.world();
    const s = await setup(w);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(spaceGrants).set({ role: 'viewer' }).where(and(eq(spaceGrants.tenantId, w.tenant.id), eq(spaceGrants.principalId, s.member.userId)))
    );
    const res = await s.edit([{ block_id: short(s.george.id), old: 'November', new: 'December' }]);
    expect(res.text).toContain('suggested: no edit access');
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('refusals: missing or repeated words, unknown, ambiguous and repeated blocks', async () => {
    const w = await k.world();
    const s = await setup(w);
    const id = short(s.george.id);
    const res = await s.edit([
      { block_id: id, old: 'October', new: 'x' },
      { block_id: 'ffffffff', old: 'a', new: 'b' },
    ]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`• ${id} — refused: ${NOT_FOUND}`);
    expect(res.text).toContain('• ffffffff — refused: block not found: read the page again');
    const twice = await s.edit([{ block_id: id, old: 'is', new: 'was' }]);
    expect(twice.text).toContain(`refused: "old" appears 2 times in block ${id}; quote more words`);
    const same = await s.edit([
      { block_id: id, old: 'November', new: 'December' },
      { remove_block_id: id },
    ]);
    expect(same.text).toContain(`• ${id} — refused: one edit per block per call`);
    expect(same.isError).toBe(false);
  });

  test('an ambiguous block prefix is refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    const para = (id: string, text: string) => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
    await k.collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.george,
      actor: { type: 'agent', id: s.agentId },
      source: 'agent',
      ops: [{ op: 'insert_after', after: s.george.id, blocks: [para('abcdef12-1111-4111-8111-111111111111', 'One.'), para('abcdef12-2222-4222-8222-222222222222', 'Two.')] }],
    });
    const amb = await s.edit([{ block_id: 'abcdef12', old: 'One', new: 'Uno' }]);
    expect(amb.text).toContain('• abcdef12 — refused: Block id "abcdef12" is ambiguous; give more characters');
    const exact = await s.edit([{ block_id: 'abcdef121111', old: 'One', new: 'Uno' }]);
    expect(exact.text).toContain('• abcdef12 — applied');
  });

  test('nested and table blocks are refused; inserting after a table is allowed', async () => {
    const w = await k.world();
    const s = await setup(w);
    const page = await opsPage(w);
    const parent = page.blocks.find((b) => blockText(b) === 'parent')!;
    const child = parent.children![0]!;
    const table = page.blocks.find((b) => b.type === 'table')!;
    const res = await s.edit(
      [
        { block_id: short(child.id), old: 'child', new: 'kid' },
        { block_id: short(table.id), old: '1', new: '3' },
        { after_block_id: short(table.id), markdown: 'After the table.' },
      ],
      page.id
    );
    expect(res.text).toContain(`• ${short(child.id)} — refused: ${UNSUPPORTED}`);
    expect(res.text).toContain(`• ${short(table.id)} — refused: ${UNSUPPORTED}`);
    expect(res.text).toContain(`• after ${short(table.id)} — applied`);
    expect(await k.pageText(w.tenant.id, page.id)).toContain('After the table.');
  });

  test("collab block_changed refuses the call's applied edits", async () => {
    const w = await k.world();
    const s = await setup(w);
    const real = k.collab.applyBlockOps.bind(k.collab);
    k.collab.applyBlockOps = async () => {
      throw new AppError('block_changed');
    };
    try {
      const res = await s.edit([
        { block_id: short(s.george.id), old: 'November', new: 'December' },
        { after_block_id: short(s.george.id), markdown: 'More.' },
      ]);
      expect(res.isError).toBe(true);
      expect(res.text.match(new RegExp(`refused: ${CHANGED}`, 'g'))).toHaveLength(2);
    } finally {
      k.collab.applyBlockOps = real;
    }
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('an always-reviewed agent waits for review', async () => {
    const w = await k.world();
    const s = await setup(w, { alwaysReview: true });
    const res = await s.edit([{ block_id: short(s.george.id), old: 'November', new: 'December' }]);
    expect(res.text).toContain('— applied · waiting for review');
  });

  test('a file is refused', async () => {
    const w = await k.world();
    const s = await setup(w);
    const fileId = await k.upload(w.headers, w.clients, 'notes.txt', 'hello');
    const res = await s.edit([{ after_block_id: null, markdown: 'x' }], fileId);
    expect(res).toEqual({ isError: true, text: 'kinote_edit changes pages, not files. Use kinote_capture to file what a file says.' });
  });

  test('scope, suspension and the per-minute limit', async () => {
    const w = await k.world();
    const s = await setup(w);
    const readOnly = await issueAgentToken(w.tenant.id, s.agentId, { scopes: ['read'] });
    expect(await listToolNames(k.app, readOnly.token)).not.toContain('kinote_edit');
    expect(await listToolNames(k.app, s.token)).toContain('kinote_edit');

    for (let i = 0; i < 30; i++) {
      expect((await s.edit([{ block_id: 'ffffffff', old: 'a', new: 'b' }])).text).toContain('refused');
    }
    expect((await s.edit([{ block_id: 'ffffffff', old: 'a', new: 'b' }])).text).toMatch(/^Too many kinote_edit calls\. Try again in \d+ seconds\.$/);

    const other = await setup(w);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    expect((await other.edit([{ after_block_id: null, markdown: 'x' }])).text).toBe(
      'This workspace is suspended for billing; it is read-only until the plan is renewed.'
    );
  });

  test('instructions mention kinote_edit only for edit tokens', () => {
    const line =
      'Use kinote_edit for precise fixes: read the section first and quote the exact words to change. Check kinote_related so a fact written on several pages is fixed everywhere.';
    expect(serverInstructions(['Docs'], ['read', 'edit'])).toContain(line);
    expect(serverInstructions(['Docs'], ['read', 'capture'])).not.toContain('kinote_edit');
  });
});
