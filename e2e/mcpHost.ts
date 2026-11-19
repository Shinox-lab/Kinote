import { expect, type APIRequestContext } from '@playwright/test';

/** One MCP request with an agent token; the JSON-RPC result. */
export async function mcp(request: APIRequestContext, token: string, method: string, params: object): Promise<any> {
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
export function stubHost(panelHtml: string, token: string, args: object): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html><body>
<iframe id="panel" title="Kinote panel" sandbox="allow-scripts allow-same-origin" style="width:640px;height:520px;border:0"></iframe>
<script>
const TOKEN = ${json(token)}, ARGS = ${json(args)}, PANEL = ${json(panelHtml)};
const frame = document.getElementById('panel');
window.__context = [];
window.__finish = null;
window.__calls = [];
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
    window.__calls.push({ name: m.params.name, result: body.result ?? null });
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
