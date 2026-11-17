import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, captures, documents, tenantBilling, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { issueAgentToken, mcpRequest } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

const MiB = 1_048_576;
const INSTRUCTION =
  "When your user wants a file itself added, call kinote_upload with what the file is: they drop the original in Kinote's panel and Kinote files it where it belongs. To put what it says on a page, write that page with kinote_capture.";

// finish waits up to 30 s for routing, as kinote_capture with wait does: more than the default test timeout under load.
describe('kinote_upload and the file panel upload tools', { timeout: 60_000 }, () => {
  const k = useCaptureKit();

  async function agentWith(w: CaptureWorld, scopes: Array<'read' | 'capture'> = ['read', 'capture'], grant = true) {
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Panel agent' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    if (grant) await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes });
    return { agentId, token };
  }

  /** One tools/call: text, error flag and structuredContent. */
  async function call(token: string, name: string, args: object) {
    const res = await mcpRequest(k.app, token, 'tools/call', { name, arguments: args });
    const result = res.body.result;
    if (!result) throw new Error(JSON.stringify(res.body));
    return {
      text: (result.content as Array<{ text: string }>).map((c) => c.text).join('\n'),
      isError: result.isError === true,
      structured: result.structuredContent as Record<string, any> | undefined,
    };
  }

  async function uploadAll(token: string, name: string, bytes: Uint8Array): Promise<string> {
    const begin = await call(token, 'kinote_upload_begin', { name, size: bytes.byteLength, mime: 'text/plain' });
    expect(begin.isError, begin.text).toBe(false);
    expect(begin.structured!.chunk_bytes).toBe(MiB);
    const id = begin.structured!.upload_id as string;
    for (let i = 0; i * MiB < bytes.byteLength; i++) {
      const chunk = await call(token, 'kinote_upload_chunk', {
        upload_id: id,
        index: i,
        data: Buffer.from(bytes.subarray(i * MiB, (i + 1) * MiB)).toString('base64'),
      });
      expect(chunk.isError, chunk.text).toBe(false);
    }
    return id;
  }

  /** Finishes an upload while the worker keeps running, as it does beside the panel. */
  async function finish(w: CaptureWorld, token: string, args: object) {
    let finished = false;
    const worker = (async () => {
      while (!finished) {
        await new Promise((r) => setTimeout(r, 150));
        await w.run();
      }
    })();
    try {
      return await call(token, 'kinote_upload_finish', args);
    } finally {
      finished = true;
      await worker;
    }
  }

  async function fileOf(w: CaptureWorld, captureId: string) {
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, captureId)));
    const [file] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, row!.fileId!)));
    return { capture: row!, file: file! };
  }

  /** A PNG with no text in it: nothing can be read from it, and it is still filed. */
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('tools/list shows kinote_upload with its panel and the upload tools as app-only; a read token sees none', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const tools = (await mcpRequest(k.app, a.token, 'tools/list')).body.result.tools as Array<{ name: string; _meta?: any; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('kinote_upload')!._meta).toEqual({ ui: { resourceUri: 'ui://kinote/upload' } });
    expect(byName.has('kinote_capture_file')).toBe(false);
    for (const name of ['kinote_upload_begin', 'kinote_upload_chunk', 'kinote_upload_finish', 'kinote_upload_cancel']) {
      expect(byName.get(name)!._meta).toEqual({ ui: { visibility: ['app'] } });
      expect(byName.get(name)!.description.startsWith('Used by the Kinote file panel.')).toBe(true);
    }
    const capture = byName.get('kinote_capture')!;
    expect(JSON.stringify(capture)).not.toContain('file_id');
    const reader = await agentWith(w, ['read']);
    const readerTools = ((await mcpRequest(k.app, reader.token, 'tools/list')).body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(readerTools.filter((n) => n.includes('upload'))).toEqual([]);
  });

  test('kinote_upload opens the panel and hands it the description and place; a bad place_under is refused first', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const res = await call(a.token, 'kinote_upload', { about: 'Signed contract with George', file_name: 'contract.pdf' });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain('opened a panel');
    expect(res.structured).toEqual({ about: 'Signed contract with George', place_under: null, file_name: 'contract.pdf' });
    const scoped = await call(a.token, 'kinote_upload', { about: 'x', place_under: 'Clients' });
    expect(scoped.structured!.place_under).toEqual({ space_id: w.clients });
    expect((await call(a.token, 'kinote_upload', { about: 'x', place_under: 'Nope' })).isError).toBe(true);
    expect((await call(a.token, 'kinote_upload', {})).isError).toBe(true);
  });

  test('an agent with no space it can edit is refused before the panel shows', async () => {
    const w = await k.world();
    const a = await agentWith(w, ['read', 'capture'], false);
    const res = await call(a.token, 'kinote_upload', { about: 'x' });
    expect(res).toMatchObject({ isError: true, text: 'You need to be able to edit at least one space to capture.' });
  });

  test('a file with no text is placed by its description, as the owner\'s file, and no page is made', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const pagesBefore = await withTenantTx(w.tenant.id, (tx) => tx.select({ id: documents.id }).from(documents).where(eq(documents.kind, 'page')));
    const id = await uploadAll(a.token, 'scan.png', PNG);
    const done = await finish(w, a.token, { upload_id: id, about: 'A photo of the signed contract for Client - George' });
    expect(done.isError, done.text).toBe(false);
    expect(done.structured!.capture_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(done.structured!.file_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(done.text.split('\n')[0]).toContain('· done');
    expect(done.text).toContain('Filed under "Client - George".');

    const { capture, file } = await fileOf(w, done.structured!.capture_id);
    expect(capture).toMatchObject({ senderType: 'agent', senderId: a.agentId, channel: 'mcp', status: 'done', fileOutcome: 'placed' });
    expect(file).toMatchObject({ kind: 'file', createdByType: 'user', createdBy: w.owner.userId, spaceId: w.clients, parentId: w.george });
    const pagesAfter = await withTenantTx(w.tenant.id, (tx) => tx.select({ id: documents.id }).from(documents).where(eq(documents.kind, 'page')));
    expect(pagesAfter.length).toBe(pagesBefore.length);
  });

  test('place_under a page puts the file under that page; a space puts it at its top', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const underPage = await finish(w, a.token, { upload_id: await uploadAll(a.token, 'hero.png', PNG), about: 'Hero shot', place_under: w.sep29 });
    expect(underPage.isError, underPage.text).toBe(false);
    expect(underPage.text).toContain('Filed under "29Sep".');
    expect((await fileOf(w, underPage.structured!.capture_id)).file).toMatchObject({ spaceId: w.clients, parentId: w.sep29 });

    const top = await finish(w, a.token, { upload_id: await uploadAll(a.token, 'logo.png', PNG), about: 'Logo', place_under: 'Clients' });
    expect(top.text).toContain('Filed at the top of Clients.');
    expect((await fileOf(w, top.structured!.capture_id)).file).toMatchObject({ spaceId: w.clients, parentId: null });
  });

  test("a place the agent can't add to keeps the file in the Inbox, and says why", async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const other = (await k.post(w.headers, '/api/v1/spaces', { name: 'Finance', slug: 'finance' })).json().id as string;
    await k.post(w.headers, `/api/v1/spaces/${other}/grants`, { principal_type: 'agent', principal_id: a.agentId, role: 'viewer' });
    const done = await finish(w, a.token, { upload_id: await uploadAll(a.token, 'q3.png', PNG), about: 'Q3 numbers', place_under: 'Finance' });
    expect(done.isError, done.text).toBe(false);
    expect(done.text).toContain("Kept in your Inbox: you can't add files there.");
    expect((await fileOf(w, done.structured!.capture_id)).file.spaceId).toBe(w.inbox);
  });

  test("the same bytes as an uncaptured file in the owner's Inbox make a new file; the existing one is untouched", async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const bytes = 'George renewed in December.';
    const existing = await k.upload(w.headers, w.inbox, 'private.txt', bytes);
    const id = await uploadAll(a.token, 'notes.txt', Buffer.from(bytes));
    const done = await finish(w, a.token, { upload_id: id, about: 'George renewal notes' });
    expect(done.isError, done.text).toBe(false);
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, done.structured!.capture_id)));
    expect(row!.fileId).not.toBe(existing);
    const [kept] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, existing)));
    expect(kept).toMatchObject({ spaceId: w.inbox, title: 'private.txt', archivedAt: null });
  });

  test('audio under a neutral name is refused before anything is stored', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
    const begin = await call(a.token, 'kinote_upload_begin', { name: 'clip', size: mp3.byteLength, mime: 'application/octet-stream' });
    expect(begin.isError, begin.text).toBe(false);
    const id = begin.structured!.upload_id as string;
    await call(a.token, 'kinote_upload_chunk', { upload_id: id, index: 0, data: mp3.toString('base64') });
    const done = await call(a.token, 'kinote_upload_finish', { upload_id: id, about: 'A clip' });
    // Detection follows the name, and begin refuses audio and video names, so audio never reaches the Inbox.
    expect(done).toMatchObject({ isError: true, text: 'This file type is not supported for security reasons.' });
    const live = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.title, 'clip')));
    expect(live.filter((d) => d.archivedAt === null)).toEqual([]);
  });

  test("a member's own Inbox file cannot be captured by sending ownerFile in the HTTP body", async () => {
    const w = await k.world();
    const other = await signUpMember(k.app, w.tenant.id, 'member');
    const theirs = await k.upload(other.headers, w.inbox, 'theirs.txt', 'Private notes.');
    const res = await k.post(w.headers, '/api/v1/captures', { file_id: theirs, ownerFile: true });
    expect(res.statusCode).toBe(404);
  });

  test('finish refuses an unknown upload and an incomplete one', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const unknown = await call(a.token, 'kinote_upload_finish', { upload_id: '11111111-1111-4111-8111-111111111111', about: 'x' });
    expect(unknown).toMatchObject({ isError: true, text: 'Upload not found' });
    const begin = await call(a.token, 'kinote_upload_begin', { name: 'big.txt', size: MiB + 1, mime: 'text/plain' });
    await call(a.token, 'kinote_upload_chunk', { upload_id: begin.structured!.upload_id, index: 0, data: Buffer.alloc(MiB, 97).toString('base64') });
    const partial = await call(a.token, 'kinote_upload_finish', { upload_id: begin.structured!.upload_id, about: 'x' });
    expect(partial).toMatchObject({ isError: true, text: 'The upload is incomplete: 1048576 of 1048577 bytes.' });
    const cancel = await call(a.token, 'kinote_upload_cancel', { upload_id: begin.structured!.upload_id });
    expect(cancel.structured).toEqual({ cancelled: true });
  });

  test('begin is refused while the workspace is suspended', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    const res = await call(a.token, 'kinote_upload_begin', { name: 'a.txt', size: 3, mime: 'text/plain' });
    expect(res).toMatchObject({ isError: true, text: 'This workspace is suspended for billing; it is read-only until the plan is renewed.' });
  });

  test('a capture token is told to use kinote_upload for a file itself', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const init = await mcpRequest(k.app, a.token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    expect(init.body.result.instructions).toContain(INSTRUCTION);
  });
});
