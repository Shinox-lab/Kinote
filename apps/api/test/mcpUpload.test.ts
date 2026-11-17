import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, captures, documents, tenantBilling, withTenantTx } from '@kinote/db';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';
import { issueAgentToken, mcpRequest } from './support/mcpkit.js';
import { createAgent, signUpMember } from './support/testkit.js';

const MiB = 1_048_576;
const INSTRUCTION =
  "When your user wants a file itself added, call kinote_capture_file: they drop the original in Kinote's panel, which keeps the file and files its text.";

describe('kinote_capture_file and the file panel upload tools', () => {
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

  test('tools/list shows the panel tool with its resource and the upload tools as app-only; a read token sees none', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const tools = (await mcpRequest(k.app, a.token, 'tools/list')).body.result.tools as Array<{ name: string; _meta?: any; description: string }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('kinote_capture_file')!._meta).toEqual({ ui: { resourceUri: 'ui://kinote/capture-file' } });
    for (const name of ['kinote_upload_begin', 'kinote_upload_chunk', 'kinote_upload_finish', 'kinote_upload_cancel']) {
      expect(byName.get(name)!._meta).toEqual({ ui: { visibility: ['app'] } });
      expect(byName.get(name)!.description.startsWith('Used by the Kinote file panel.')).toBe(true);
    }
    const capture = byName.get('kinote_capture')!;
    expect(JSON.stringify(capture)).not.toContain('file_id');
    const reader = await agentWith(w, ['read']);
    const readerTools = ((await mcpRequest(k.app, reader.token, 'tools/list')).body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(readerTools.filter((n) => n.includes('upload') || n === 'kinote_capture_file')).toEqual([]);
  });

  test('kinote_capture_file opens the panel and hands it the notes; a bad limit_to is refused first', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const res = await call(a.token, 'kinote_capture_file', { notes: 'put it under Clients', file_name: 'Q3.pdf' });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain('opened a panel');
    expect(res.structured).toEqual({ notes: 'put it under Clients', file_as: 'auto', limit_to: null, file_name: 'Q3.pdf' });
    const scoped = await call(a.token, 'kinote_capture_file', { limit_to: 'Clients' });
    expect(scoped.structured!.limit_to).toEqual({ space_id: w.clients });
    expect((await call(a.token, 'kinote_capture_file', { limit_to: 'Nope' })).isError).toBe(true);
  });

  test('an agent with no space it can edit is refused before the panel shows', async () => {
    const w = await k.world();
    const a = await agentWith(w, ['read', 'capture'], false);
    const res = await call(a.token, 'kinote_capture_file', {});
    expect(res).toMatchObject({ isError: true, text: 'You need to be able to edit at least one space to capture.' });
  });

  test("the uploaded file is stored as the owner's upload, captured, and filed with its page", async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const id = await uploadAll(a.token, 'notes.txt', Buffer.from('George renewed in December.'));
    setTimeout(() => void w.run(), 100);
    const done = await call(a.token, 'kinote_upload_finish', { upload_id: id, notes: '', file_as: 'auto' });
    expect(done.isError, done.text).toBe(false);
    expect(done.structured!.capture_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(done.structured!.receipt).toBe(done.text);
    expect(done.text.split('\n')[0]).toContain('· done');

    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, done.structured!.capture_id)));
    expect(row).toMatchObject({ senderType: 'agent', senderId: a.agentId, channel: 'mcp' });
    expect(row!.fileId).toBeTruthy();
    const [file] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, row!.fileId!)));
    expect(file).toMatchObject({ kind: 'file', createdByType: 'user', createdBy: w.owner.userId });

    // A file alone becomes its own page, and the file moves under it, as on the Capture page.
    expect(file!.spaceId).toBe(w.clients);
    expect(done.text).toContain('Filed with its page.');
    expect((await k.get(w.headers, `/api/v1/files/${file!.id}`)).statusCode).toBe(200);
  });

  test('the same file again, still in the Inbox with its capture, is refused like the Capture page does', async () => {
    const w = await k.world();
    const a = await agentWith(w);
    const bytes = Buffer.from('Notes nobody routes anywhere.');
    const firstId = await uploadAll(a.token, 'n.txt', bytes);
    setTimeout(() => void w.run(), 100);
    const first = await call(a.token, 'kinote_upload_finish', { upload_id: firstId, notes: '', file_as: 'auto' });
    expect(first.isError, first.text).toBe(false);
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.id, first.structured!.capture_id)));
    const [file] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, row!.fileId!)));
    const secondId = await uploadAll(a.token, 'n.txt', bytes);
    setTimeout(() => void w.run(), 100);
    const second = await call(a.token, 'kinote_upload_finish', { upload_id: secondId, notes: '', file_as: 'auto' });
    if (file!.spaceId === w.inbox) {
      // Still in the Inbox: the same bytes are that file, which already has its capture.
      expect(second).toMatchObject({ isError: true, text: 'This file was already sent with another capture.' });
    } else {
      // Kept under a page: the Inbox has no copy, so this is a new file and a new capture.
      expect(second.isError, second.text).toBe(false);
    }
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
    const unknown = await call(a.token, 'kinote_upload_finish', { upload_id: '11111111-1111-4111-8111-111111111111', notes: '', file_as: 'auto' });
    expect(unknown).toMatchObject({ isError: true, text: 'Upload not found' });
    const begin = await call(a.token, 'kinote_upload_begin', { name: 'big.txt', size: MiB + 1, mime: 'text/plain' });
    await call(a.token, 'kinote_upload_chunk', { upload_id: begin.structured!.upload_id, index: 0, data: Buffer.alloc(MiB, 97).toString('base64') });
    const partial = await call(a.token, 'kinote_upload_finish', { upload_id: begin.structured!.upload_id, notes: '', file_as: 'auto' });
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

  test('a capture token is told to use kinote_capture_file for a file itself', async () => {
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
