// CDP-driven check of the full editor page in headless Chrome:
// seed a session (tenant created via API), navigate to #/page/<id>,
// assert the BlockNote editor table mounts AND a ws:// collab connection is made.
const CHROME_DEBUG_PORT = 9223;
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8787';

function cdp(ws, id, method, params) {
  return new Promise((resolve) => {
    const onMsg = (e) => {
      const data = JSON.parse(e.data);
      if (data.id === id) {
        ws.removeEventListener('message', onMsg);
        resolve(data);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// API: tenant + page
const runId = Math.random().toString(36).slice(2, 8);
const t = await (await fetch(`${API}/api/v1/tenants`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Docs', slug: `cdp-${runId}`, owner_email: 'o@x.com', owner_name: 'Owner' }),
})).json();
const headers = { 'content-type': 'application/json', 'x-tenant-id': t.tenant.id, 'x-principal-type': 'user', 'x-principal-id': t.owner.id, 'x-tenant-role': 'owner' };
const spaces = await (await fetch(`${API}/api/v1/spaces`, { headers })).json();
const inbox = spaces.find((s) => s.kind === 'inbox');
const pageRes = await fetch(`${API}/api/v1/pages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ space_id: inbox.id, title: 'CDP Page', slug: 'cdp-page', markdown: '# CDP Page\n\nHello from CDP.', parent_id: null }),
});
if (!pageRes.ok) { console.error('page create failed:', pageRes.status, await pageRes.text()); process.exit(1); }
const page = await pageRes.json();
const pageId = page.document.id;
console.log('cdp page:', pageId);

// chrome: launch with debugging port
const { execSync, spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
  '--user-data-dir=/tmp/cdp-profile', 'chrome://blank',
], { stdio: 'ignore' });
await sleep(2500);

const targets = await (await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`)).json();
const pageTarget = targets.find((x) => x.type === 'page');
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const wsUrls = [];
const failures = [];
ws.addEventListener('message', (e) => {
  const d = JSON.parse(e.data);
  if (d.method === 'Network.webSocketCreated') wsUrls.push(d.params.url);
  if (d.method === 'Runtime.exceptionThrown') failures.push(String(d.params.exceptionDetails?.text ?? d.params?.exceptionDetails?.exception?.description ?? 'unknown'));
});

await cdp(ws, ++id, 'Page.enable', {});
await cdp(ws, ++id, 'Network.enable', {});
await cdp(ws, ++id, 'Runtime.enable', {});
await cdp(ws, ++id, 'Page.navigate', { url: BASE + '/' });
await sleep(1200);

const session = { apiBase: '', collabBase: 'ws://127.0.0.1:1234', tenantId: t.tenant.id, tenantSlug: t.tenant.slug, userId: t.owner.id, userName: t.owner.name, tenantRole: 'owner' };
await cdp(ws, ++id, 'Runtime.evaluate', {
  expression: `localStorage.setItem('lw-session', ${JSON.stringify(JSON.stringify(session))}); 'stored'`,
  returnByValue: true,
});
await cdp(ws, ++id, 'Page.navigate', { url: `${BASE}/#/page/${pageId}` });
await sleep(6000); // let editor mount + provider connect

const evalRes = await cdp(ws, ++id, 'Runtime.evaluate', {
  expression: `(() => { const c = document.getElementById('root'); return { len: c ? c.innerHTML.length : -1, hasEditor: !!document.querySelector('.bn-container, .bn-editor, [data-block-type], .bn-block'), text: (c?.innerText || '').slice(0, 200) }; })()`,
  returnByValue: true,
});
console.log('DOM state:', JSON.stringify(evalRes.result?.result?.value));
console.log('WS connections:', JSON.stringify(wsUrls));
console.log('Runtime failures:', failures.length ? failures : 'none');

chrome.kill();
const okRender = (evalRes.result?.result?.value?.len ?? 0) > 500;
const okEditor = evalRes.result?.result?.value?.hasEditor === true;
const okWs = wsUrls.some((u) => u.includes('127.0.0.1:1234') || u.includes('localhost:1234'));
if (okRender && okEditor && okWs && failures.length === 0) console.log('CDP EDITOR: ALL PASS');
else console.log('CDP EDITOR: FAIL', { okRender, okEditor, okWs, failures: failures.length });
process.exit(0);
