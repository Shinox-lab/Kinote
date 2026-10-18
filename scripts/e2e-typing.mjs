// Final E2E: type into the BlockNote editor in headless Chrome via CDP
// (focus + Input.insertText — the automated-typing path for contenteditable),
// then assert the server's LIVE read of the collab session sees the text.
const CHROME_DEBUG_PORT = 9224;
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cdp(ws, id, method, params) {
  return new Promise((resolve) => {
    const onMsg = (e) => {
      const data = JSON.parse(e.data);
      if (data.id === id) { ws.removeEventListener('message', onMsg); resolve(data); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const runId = Math.random().toString(36).slice(2, 8);
const t = await (await fetch(`${API}/api/v1/tenants`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Docs', slug: `ty-${runId}`, owner_email: 'o@x.com', owner_name: 'Owner' }),
})).json();
const headers = { 'content-type': 'application/json', 'x-tenant-id': t.tenant.id, 'x-principal-type': 'user', 'x-principal-id': t.owner.id, 'x-tenant-role': 'owner' };
const spaces = await (await fetch(`${API}/api/v1/spaces`, { headers })).json();
const inbox = spaces.find((s) => s.kind === 'inbox');
const mkRes = await fetch(`${API}/api/v1/pages`, { method: 'POST', headers, body: JSON.stringify({ space_id: inbox.id, title: 'Typing', slug: `typing-${runId}`, markdown: '', parent_id: null }) });
if (!mkRes.ok) { console.error('page create failed:', mkRes.status, await mkRes.text()); process.exit(1); }
const pageId = (await mkRes.json()).document.id;
console.log('typed page:', pageId);

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
  '--user-data-dir=/tmp/cdp-profile-ty', 'chrome://blank',
], { stdio: 'ignore' });
await sleep(2500);

const targets = await (await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json`)).json();
const target = targets.find((x) => x.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const failures = [];
ws.addEventListener('message', (e) => {
  const d = JSON.parse(e.data);
  if (d.method === 'Runtime.exceptionThrown') failures.push(String(d.params.exceptionDetails?.text ?? 'unknown'));
});
await cdp(ws, ++id, 'Page.enable', {});
await cdp(ws, ++id, 'Runtime.enable', {});
await cdp(ws, ++id, 'Input.setIgnoreInputEvents', { ignore: false });
await cdp(ws, ++id, 'Page.navigate', { url: BASE + '/' });
await sleep(1200);
const session = { apiBase: '', collabBase: 'ws://127.0.0.1:1234', tenantId: t.tenant.id, tenantSlug: t.tenant.slug, userId: t.owner.id, userName: t.owner.name, tenantRole: 'owner' };
await cdp(ws, ++id, 'Runtime.evaluate', { expression: `localStorage.setItem('lw-session', ${JSON.stringify(JSON.stringify(session))}); 'ok'`, returnByValue: true });
await cdp(ws, ++id, 'Page.navigate', { url: `${BASE}/#/page/${pageId}` });
await sleep(6000);

// Focus the editor surface, then type via insertText (IME path that contenteditable editors handle)
const focus = await cdp(ws, ++id, 'Runtime.evaluate', {
  expression: `(() => { const el = document.querySelector('.bn-editor, [data-content-editable-root]'); if (!el) return 'NO_EDITOR'; el.focus(); return document.activeElement?.className?.toString?.().slice(0, 40) ?? 'focused'; })()`,
  returnByValue: true,
});
console.log('focus:', JSON.stringify(focus.result?.result?.value));
if (focus.result?.result?.value === 'NO_EDITOR') { console.log('CDP TYPING: FAIL no editor'); process.exit(1); }

await cdp(ws, ++id, 'Input.insertText', { text: 'Typed in a real browser ' + runId });
await sleep(1500);

// Read the editor text back from the DOM
const dom = await cdp(ws, ++id, 'Runtime.evaluate', {
  expression: `document.querySelector('.bn-editor, [data-content-editable-root]')?.textContent ?? ''`,
  returnByValue: true,
});
console.log('editor dom text:', JSON.stringify(dom.result?.result?.value));

// Leave the editor first — the Database extension persists the ydoc when the
// last connection for the doc unloads, so the persisted state is fresh only
// after navigation away (which destroys the provider).
await cdp(ws, ++id, 'Page.navigate', { url: BASE + '/' });
await sleep(2000);

// Server-side live read of the collab session
const live = await (await fetch(`${API}/api/v1/pages/${pageId}`, { headers })).json();
const liveText = JSON.stringify(live.liveBlocks ?? []);
console.log('server liveBlocks:', liveText.slice(0, 220));
console.log('badge:', live.badge, '| changed:', live.liveChangedSinceSnapshot);

chrome.kill();
const typed = `Typed in a real browser ${runId}`;
const okDom = (dom.result?.result?.value ?? '').includes(typed);
const okServer = liveText.includes(typed) || liveText.includes('Typed in a real browser');
if (okDom && okServer && failures.length === 0) console.log('CDP TYPING: ALL PASS');
else console.log('CDP TYPING: FAIL', { okDom, okServer, failures });
process.exit(0);
