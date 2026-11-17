import { expect, test, type APIRequestContext } from '@playwright/test';
import { call, openAs, seedWorld } from './support.js';

/** One MCP request with an agent token; the JSON-RPC result. */
async function mcp(request: APIRequestContext, token: string, method: string, params: object): Promise<any> {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).result;
}

/**
 * A minimal MCP Apps host: it loads the panel in a sandboxed iframe, answers ui/initialize, sends the tool input,
 * relays the panel's tools/call to /mcp with the agent's token, and records ui/update-model-context.
 */
function stubHost(panelHtml: string, token: string, args: object): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html><body>
<iframe id="panel" title="Kinote panel" sandbox="allow-scripts allow-same-origin" style="width:640px;height:520px;border:0"></iframe>
<script>
const TOKEN = ${json(token)}, ARGS = ${json(args)}, PANEL = ${json(panelHtml)};
const frame = document.getElementById('panel');
window.__context = [];
window.__finish = null;
const send = (msg) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...msg }, '*');
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.method === 'ui/initialize') {
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'stub', version: '0' },
      hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'light' } } });
  } else if (m.method === 'ui/notifications/initialized') {
    send({ method: 'ui/notifications/tool-input', params: { arguments: ARGS } });
  } else if (m.method === 'tools/call') {
    const res = await fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: m.params }) });
    const body = await res.json();
    if (m.params.name === 'kinote_upload_finish') window.__finish = body.result ?? null;
    if (body.result) send({ id: m.id, result: body.result });
    else send({ id: m.id, error: body.error ?? { code: -32000, message: 'host error' } });
  } else if (m.method === 'ui/update-model-context') {
    window.__context.push(m.params);
    send({ id: m.id, result: {} });
  } else if (m.id !== undefined) {
    send({ id: m.id, result: {} });
  }
});
frame.srcdoc = PANEL;
</script></body></html>`;
}

test('a person drops a file into the Kinote panel and it is filed with its page', async ({ browser, request, baseURL }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Docs bot' } });
  await call(request, `/agents/${agent.id}`, { ...as, method: 'PATCH', data: { always_review: false } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, {
    ...as,
    method: 'POST',
    data: { name: 'Laptop', scopes: ['read', 'capture'] },
  });

  const opened = await mcp(request, token, 'tools/call', { name: 'kinote_capture_file', arguments: { notes: 'put it with the office notes' } });
  expect(opened.isError ?? false).toBe(false);
  const panelHtml = (await mcp(request, token, 'resources/read', { uri: 'ui://kinote/capture-file' })).contents[0].text as string;

  const page = await browser.newPage();
  await page.route(`${baseURL}/__stub-host`, (route) =>
    route.fulfill({ contentType: 'text/html', body: stubHost(panelHtml, token, { notes: 'put it with the office notes', file_as: 'auto' }) })
  );
  await page.goto('/__stub-host');
  const panel = page.frameLocator('#panel');
  await expect(panel.getByText('put it with the office notes')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Capture' })).toBeDisabled();

  await panel.locator('input[type=file]').setInputFiles({
    name: 'office-move.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Office move\n\nThe office moves to Leeds in May. Desks are packed the week before.'),
  });
  await expect(panel.getByText('office-move.txt')).toBeVisible();
  await panel.getByRole('button', { name: 'Capture' }).click();
  await expect(panel.getByText(/Capture [0-9a-f]{8} · /)).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__context.length)).toBeGreaterThan(0);

  const finish = await page.evaluate(() => (window as any).__finish);
  const captureId = finish.structuredContent.capture_id as string;
  // The person sees the file where the receipt says it went.
  await expect
    .poll(async () => (await call<{ capture: { status: string } }>(request, `/captures/${captureId}`, as)).capture.status, { timeout: 45_000 })
    .toBe('done');
  const detail = await call<{ capture: { file: { id: string; name: string } | null; fileOutcome: string | null } }>(request, `/captures/${captureId}`, as);
  expect(detail.capture.file?.name).toBe('office-move.txt');
  const owner = await openAs(browser, world, world.owner);
  await owner.goto(`/w/${world.slug}/f/${detail.capture.file!.id}`);
  await expect(owner.getByText('office-move.txt').first()).toBeVisible();
});

test('a full 1 MiB chunk passes the proxy in front of /mcp', async ({ request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const as = { account: world.owner, tenantId: world.tenantId };
  const agent = await call<{ id: string }>(request, '/agents', { ...as, method: 'POST', data: { name: 'Big file bot' } });
  await call(request, `/spaces/${world.spaceId}/grants`, { ...as, method: 'POST', data: { principal_type: 'agent', principal_id: agent.id, role: 'editor' } });
  const { token } = await call<{ token: string }>(request, `/agents/${agent.id}/tokens`, { ...as, method: 'POST', data: { name: 'Laptop', scopes: ['capture'] } });
  const begin = await mcp(request, token, 'tools/call', { name: 'kinote_upload_begin', arguments: { name: 'big.txt', size: 2_097_152, mime: 'text/plain' } });
  const uploadId = begin.structuredContent.upload_id as string;
  const chunk = await mcp(request, token, 'tools/call', {
    name: 'kinote_upload_chunk',
    arguments: { upload_id: uploadId, index: 0, data: Buffer.alloc(1_048_576, 97).toString('base64') },
  });
  expect(chunk.structuredContent).toEqual({ received_bytes: 1_048_576 });
  await mcp(request, token, 'tools/call', { name: 'kinote_upload_cancel', arguments: { upload_id: uploadId } });
});
