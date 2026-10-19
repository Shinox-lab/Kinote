// Evidence for items 1 (two tenants cannot see each other) and 5 (withdraw removes results at once)
// of docs/live-checks/2026-10-slice-0-1-live-check.md, against the local PGlite harness.
//
//   node --import tsx e2e/harness/local-stack.ts &        # wait for READY
//   node docs/live-checks/tenants-and-withdraw.mjs        # prints the output pasted in the doc
//   kill %1
//
// Ports and the internal secret default to the harness's; override with E2E_API_PORT,
// E2E_COLLAB_PORT and INTERNAL_SECRET. Page text is written through the collab internal
// endpoint, so this needs the harness (the compose stack does not publish the secret).
const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18787}/api/v1`;
const COLLAB = `http://127.0.0.1:${process.env.E2E_COLLAB_PORT ?? 11234}`;
const INTERNAL = process.env.INTERNAL_SECRET ?? 'e2e-internal-secret-0123456789abcdef0123456789';
const pw = 'correct-horse-battery';
const sfx = Date.now().toString(36);

async function call(label, path, { token, tenant, method = 'GET', body, quiet } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (label) {
    let shown = text.length > 300 ? text.slice(0, 300) + '…' : text;
    const j = text ? JSON.parse(text) : null;
    // Search and Ask replies are long: show which pages they came from (the document ids are what isolation is about).
    if (res.status === 200 && j && Array.isArray(j.passages)) shown = JSON.stringify({ passages: j.passages.map((p) => ({ documentId: p.documentId, versionTitle: p.versionTitle, citeAs: p.citeAs })) });
    if (res.status === 200 && j && j.citations) shown = JSON.stringify({ foundRelevant: j.foundRelevant, answer: j.answer.slice(0, 110), citations: j.citations.map((c) => ({ documentId: c.documentId, citeAs: c.citeAs })) });
    if (res.status === 200 && Array.isArray(j) && path === '/spaces') shown = JSON.stringify(j.map((s) => ({ tenantId: s.tenantId, name: s.name, myRole: s.myRole })));
    console.log(`${label}\n    -> ${res.status} ${shown}`);
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const ok = async (...a) => { const r = await call(...a); if (r.status >= 300) throw new Error(`unexpected ${r.status}`); return r.json; };

async function world(name) {
  const u = await ok(null, '/auth/sign-up', { method: 'POST', body: { email: `${name}-${sfx}@example.test`, name, password: pw } });
  const t = await ok(null, '/tenants', { token: u.session.token, method: 'POST', body: { name: `${name} Co`, slug: `${name}-${sfx}` } });
  const tenant = t.tenant.id;
  const space = await ok(null, '/spaces', { token: u.session.token, tenant, method: 'POST', body: { name: 'Docs', slug: 'docs' } });
  const page = await ok(null, '/pages', { token: u.session.token, tenant, method: 'POST', body: { space_id: space.id, parent_id: null, title: `${name} page`, slug: `${name}-page` } });
  return { token: u.session.token, userId: u.user.id, tenant, space, page };
}
async function write(w, text) {
  const res = await fetch(`${COLLAB}/internal/replace-blocks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL },
    body: JSON.stringify({
      documentName: `${w.tenant}:${w.page.id}`,
      title: w.page.title,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }],
      actor: { type: 'user', id: w.userId },
      source: 'restore',
    }),
  });
  if (res.status !== 204) throw new Error(`replace-blocks ${res.status} ${await res.text()}`);
}
async function indexNow(w) {
  await ok(null, `/pages/${w.page.id}/snapshot`, { token: w.token, tenant: w.tenant, method: 'POST', body: {} });
  for (let i = 0; i < 60; i++) {
    const p = await ok(null, `/pages/${w.page.id}`, { token: w.token, tenant: w.tenant });
    if (/^Indexed/.test(p.badge)) return p.badge;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('not indexed');
}

console.log('== Tenant isolation ==');
const one = await world('one');
const two = await world('two');
await write(one, 'Falcon protocol: tenant one confidential launch checklist.');
console.log('tenant one page indexed; badge:', await indexNow(one));
await write(two, 'Heron protocol: tenant two unrelated notes.');
console.log('tenant two page indexed; badge:', await indexNow(two));
console.log(`tenant1=${one.tenant} page1=${one.page.id} space1=${one.space.id}\ntenant2=${two.tenant} page2=${two.page.id}`);
console.log('-- positive control: tenant one finds its own text');
await call('user1 / tenant1  POST /search {query: "falcon protocol"}', '/search', { token: one.token, tenant: one.tenant, method: 'POST', body: { query: 'falcon protocol' } });
console.log('-- user2 acting in tenant2 reaches for tenant1 data');
await call('user2 / tenant2  POST /search {query: "falcon protocol"}', '/search', { token: two.token, tenant: two.tenant, method: 'POST', body: { query: 'falcon protocol' } });
await call('user2 / tenant2  POST /ask {question: "falcon protocol"}', '/ask', { token: two.token, tenant: two.tenant, method: 'POST', body: { question: 'falcon protocol' } });
await call('user2 / tenant2  GET /pages/<tenant1 page>', `/pages/${one.page.id}`, { token: two.token, tenant: two.tenant });
await call('user2 / tenant2  GET /pages/<tenant1 page>/versions', `/pages/${one.page.id}/versions`, { token: two.token, tenant: two.tenant });
await call('user2 / tenant2  POST /pages/<tenant1 page>/collab-token', `/pages/${one.page.id}/collab-token`, { token: two.token, tenant: two.tenant, method: 'POST', body: {} });
await call('user2 / tenant2  GET /spaces/<tenant1 space>/tree', `/spaces/${one.space.id}/tree`, { token: two.token, tenant: two.tenant });
await call('user2 / tenant2  GET /spaces (own list only)', '/spaces', { token: two.token, tenant: two.tenant });
console.log('-- user2 names tenant1 in x-tenant-id');
await call('user2 / tenant1  GET /spaces', '/spaces', { token: two.token, tenant: one.tenant });
await call('user2 / tenant1  POST /search', '/search', { token: two.token, tenant: one.tenant, method: 'POST', body: { query: 'falcon protocol' } });
await call('user2 / tenant1  GET /members', '/members', { token: two.token, tenant: one.tenant });
console.log('-- and the other way round');
await call('user1 / tenant2  GET /pages/<tenant2 page>', `/pages/${two.page.id}`, { token: one.token, tenant: two.tenant });
await call('user1 / tenant1  GET /pages/<tenant2 page>', `/pages/${two.page.id}`, { token: one.token, tenant: one.tenant });
await call('user1 / tenant1  POST /search {query: "heron protocol"}', '/search', { token: one.token, tenant: one.tenant, method: 'POST', body: { query: 'heron protocol' } });
await call('no token         GET /spaces', '/spaces', { tenant: one.tenant });

console.log('\n== Withdraw removes results at once ==');
await call('before: user1 searches "falcon protocol"', '/search', { token: one.token, tenant: one.tenant, method: 'POST', body: { query: 'falcon protocol' } });
await call('POST /pages/<page>/withdraw', `/pages/${one.page.id}/withdraw`, { token: one.token, tenant: one.tenant, method: 'POST', body: {} });
await call('after (immediately): user1 searches "falcon protocol"', '/search', { token: one.token, tenant: one.tenant, method: 'POST', body: { query: 'falcon protocol' } });
await call('after (immediately): user1 asks "falcon protocol"', '/ask', { token: one.token, tenant: one.tenant, method: 'POST', body: { question: 'falcon protocol' } });
const after = await ok(null, `/pages/${one.page.id}`, { token: one.token, tenant: one.tenant });
console.log('page badge after withdraw:', after.badge);
