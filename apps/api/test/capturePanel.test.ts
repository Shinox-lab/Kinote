import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'vitest';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, mcpRequest } from './support/mcpkit.js';
import { chunkCount, linkify, toBase64, uploadFile, type CallServerTool, type ToolReply } from '../src/mcp/app/panelLogic.js';
import { capturePanelHtml } from '../src/mcp/app/panelHtml.js';

const MiB = 1_048_576;
const form = { about: 'The signed contract', place_under: undefined };

function fakeFile(size: number) {
  const bytes = randomBytes(size);
  return { size, slice: (a: number, b: number) => ({ arrayBuffer: async () => new Uint8Array(bytes.subarray(a, b)).buffer }) };
}

/** A host stand-in: records calls; `failChunk(i)` says how many times chunk i fails first. */
function fakeHost(o: { failChunk?: (i: number) => number; begin?: { isError: boolean; text: string } } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const failures = new Map<number, number>();
  const ok = (structured: Record<string, unknown>, text = ''): ToolReply => ({ content: [{ type: 'text', text }], structuredContent: structured });
  const call: CallServerTool = async (name, raw) => {
    const args = raw as any;
    calls.push({ name, args });
    if (name === 'kinote_upload_begin') {
      if (o.begin) return { content: [{ type: 'text', text: o.begin.text }], isError: o.begin.isError };
      return ok({ upload_id: 'u1', chunk_bytes: MiB });
    }
    if (name === 'kinote_upload_chunk') {
      const seen = failures.get(args.index) ?? 0;
      if (seen < (o.failChunk?.(args.index) ?? 0)) {
        failures.set(args.index, seen + 1);
        throw new Error('network');
      }
      return ok({ received_bytes: 0 });
    }
    if (name === 'kinote_upload_finish') return ok({ capture_id: 'c1', status: 'done', receipt: 'Capture c1 · done' }, 'Capture c1 · done');
    return ok({ cancelled: true });
  };
  return { calls, call };
}

describe('the file panel logic', () => {
  test('chunkCount rounds up', () => {
    assert.equal(chunkCount(0, MiB), 0);
    assert.equal(chunkCount(1, MiB), 1);
    assert.equal(chunkCount(MiB, MiB), 1);
    assert.equal(chunkCount(MiB + 1, MiB), 2);
  });

  test('toBase64 matches Node', () => {
    const bytes = randomBytes(3000);
    assert.equal(toBase64(new Uint8Array(bytes)), bytes.toString('base64'));
    assert.equal(toBase64(new Uint8Array(0)), '');
  });

  test('a 2.5 MiB file is begun, sent in three chunks and finished with the form', async () => {
    const host = fakeHost();
    const progress: number[] = [];
    const out = await uploadFile({ ...fakeFile(2.5 * MiB), name: 'q3.pdf', type: 'application/pdf' }, host.call, (sent) => progress.push(sent), form);
    assert.deepEqual(out, { ok: true, receipt: 'Capture c1 · done' });
    assert.deepEqual(
      host.calls.map((c) => [c.name, c.args.index]),
      [
        ['kinote_upload_begin', undefined],
        ['kinote_upload_chunk', 0],
        ['kinote_upload_chunk', 1],
        ['kinote_upload_chunk', 2],
        ['kinote_upload_finish', undefined],
      ]
    );
    assert.deepEqual(host.calls[0]!.args, { name: 'q3.pdf', size: 2.5 * MiB, mime: 'application/pdf' });
    assert.deepEqual(host.calls[4]!.args, { upload_id: 'u1', about: 'The signed contract' });
    assert.equal(progress.at(-1), 2.5 * MiB);
  });

  test('a chunk that fails twice is retried; three failures stop the upload and cancel it', async () => {
    const twice = fakeHost({ failChunk: (i) => (i === 1 ? 2 : 0) });
    assert.equal((await uploadFile({ ...fakeFile(2 * MiB), name: 'a', type: '' }, twice.call, () => {}, form)).ok, true);
    const thrice = fakeHost({ failChunk: (i) => (i === 1 ? 3 : 0) });
    const out = await uploadFile({ ...fakeFile(2 * MiB), name: 'a', type: '' }, thrice.call, () => {}, form);
    assert.deepEqual(out, { ok: false, stage: 'upload', message: 'Upload stopped — try again' });
    assert.equal(thrice.calls.at(-1)!.name, 'kinote_upload_cancel');
  });

  test("begin's refusal is shown and nothing is sent", async () => {
    const host = fakeHost({ begin: { isError: true, text: 'This file is larger than 50 MB.' } });
    const out = await uploadFile({ ...fakeFile(10), name: 'big.pdf', type: 'application/pdf' }, host.call, () => {}, form);
    assert.deepEqual(out, { ok: false, stage: 'begin', message: 'This file is larger than 50 MB.' });
    assert.equal(host.calls.length, 1);
  });

  test('an empty file is refused without calling the server', async () => {
    const host = fakeHost();
    const out = await uploadFile({ ...fakeFile(0), name: 'empty.txt', type: 'text/plain' }, host.call, () => {}, form);
    assert.deepEqual(out, { ok: false, stage: 'begin', message: 'This file is empty.' });
    assert.equal(host.calls.length, 0);
  });

  test('linkify splits out URLs', () => {
    assert.deepEqual(linkify('See https://k.example/p/1 now'), [{ text: 'See ' }, { url: 'https://k.example/p/1' }, { text: ' now' }]);
    assert.deepEqual(linkify('none'), [{ text: 'none' }]);
  });

  test('the panel HTML is one self-contained page', async () => {
    const html = await capturePanelHtml();
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<script>'));
    assert.equal(/\ssrc=/.test(html), false);
    assert.equal(await capturePanelHtml(), html);
  });
});

describe('the file panel resource', () => {
  useTestDb();
  test('resources/read on /mcp serves the panel HTML with the MCP App mime type', async () => {
    const app = buildTestApp();
    const w = await agentWorld(app, 'panel-resource');
    const list = await mcpRequest(app, w.token, 'resources/list');
    assert.deepEqual(
      (list.body.result.resources as Array<{ uri: string; mimeType: string }>).map((r) => [r.uri, r.mimeType]),
      [
        ['ui://kinote/upload', 'text/html;profile=mcp-app'],
        ['ui://kinote/review', 'text/html;profile=mcp-app'],
      ]
    );
    const read = await mcpRequest(app, w.token, 'resources/read', { uri: 'ui://kinote/upload' });
    const content = read.body.result.contents[0];
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.equal(content.text, await capturePanelHtml());
    assert.equal(content._meta.ui.prefersBorder, true);
  });
});
