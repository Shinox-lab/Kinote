import { describe, test, expect, beforeEach } from 'vitest';
import { InMemoryObjectStorage } from '@kinote/shared';
import { tenantBilling, withTenantTx } from '@kinote/db';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { makeSource, putFile, sourceWorld } from './support/sourcekit.js';

// A workspace suspended for billing is read-only: writes answer 423 workspace_suspended,
// reads (and searching) still work, and live editing tokens are read-only.

async function setState(tenantId: string, state: 'ok' | 'past_due' | 'suspended') {
  await withTenantTx(tenantId, (tx) =>
    tx
      .insert(tenantBilling)
      .values({ tenantId, state, manageUrl: 'https://cp.test/portal' })
      .onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state } })
  );
}

describe('suspended workspaces', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp({ storage: new InMemoryObjectStorage() });
  });

  async function world(slug: string) {
    const w = await sourceWorld(app, slug);
    const page = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: w.ownerHeaders,
      payload: { space_id: w.open.id, title: 'Plan', slug: 'plan', markdown: 'Text.' },
    });
    expect(page.statusCode, page.body).toBe(201);
    const src = await makeSource(app, w.ownerHeaders, { name: 'Reports', spaceId: w.open.id });
    return { ...w, page: page.json() as { id: string }, src };
  }

  const editorHeaders = (w: Awaited<ReturnType<typeof world>>) => ({
    authorization: `Bearer ${w.editor.token}`,
    'x-tenant-id': w.tenant.id,
  });

  async function attempts(w: Awaited<ReturnType<typeof world>>) {
    const h = editorHeaders(w);
    return {
      capture: await app.inject({ method: 'POST', url: '/api/v1/captures', headers: h, payload: { text: 'Invoices go out weekly.' } }),
      ask: await app.inject({ method: 'POST', url: '/api/v1/ask', headers: h, payload: { question: 'When do invoices go out?' } }),
      space: await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.ownerHeaders, payload: { name: 'More', slug: 'more' } }),
      source: await putFile(app, w.src.token, 'one', { name: 'a.txt', data: 'hello source' }),
      read: await app.inject({ method: 'GET', url: `/api/v1/pages/${w.page.id}`, headers: h }),
      search: await app.inject({ method: 'POST', url: '/api/v1/search', headers: h, payload: { query: 'invoices' } }),
      collab: await app.inject({ method: 'POST', url: `/api/v1/pages/${w.page.id}/collab-token`, headers: h }),
    };
  }

  test('writes, Ask and source uploads answer 423; reads, search and a read-only collab token work', async () => {
    const w = await world('suspended-co');
    await setState(w.tenant.id, 'suspended');
    const r = await attempts(w);
    for (const [name, res] of [['capture', r.capture], ['ask', r.ask], ['space', r.space], ['source', r.source]] as const) {
      expect(res.statusCode, `${name}: ${res.body}`).toBe(423);
      expect(res.json().error, name).toBe('workspace_suspended');
    }
    expect(r.read.statusCode, r.read.body).toBe(200);
    expect(r.search.statusCode, r.search.body).toBe(200);
    expect(r.collab.statusCode, r.collab.body).toBe(200);
    expect(r.collab.json().access).toBe('read');
  });

  test('owners get the manage link in the refusal; members do not', async () => {
    const w = await world('suspended-link-co');
    await setState(w.tenant.id, 'suspended');
    const owner = await app.inject({ method: 'POST', url: '/api/v1/captures', headers: w.ownerHeaders, payload: { text: 'x' } });
    expect(owner.statusCode).toBe(423);
    expect(owner.json().manageUrl).toBe('https://cp.test/portal');
    const member = await app.inject({ method: 'POST', url: '/api/v1/captures', headers: editorHeaders(w), payload: { text: 'x' } });
    expect(member.statusCode).toBe(423);
    expect(member.json().manageUrl).toBeUndefined();
  });

  test('past_due changes nothing', async () => {
    const w = await world('past-due-co');
    await setState(w.tenant.id, 'past_due');
    const r = await attempts(w);
    expect(r.capture.statusCode, r.capture.body).toBe(201);
    expect(r.space.statusCode, r.space.body).toBe(201);
    expect(r.source.statusCode, r.source.body).toBe(201);
    expect(r.collab.json().access).toBe('write');
  });

  test('another workspace is unaffected', async () => {
    const a = await world('suspended-a');
    const b = await world('active-b');
    await setState(a.tenant.id, 'suspended');
    const capture = await app.inject({ method: 'POST', url: '/api/v1/captures', headers: editorHeaders(b), payload: { text: 'Fine.' } });
    expect(capture.statusCode, capture.body).toBe(201);
  });
  test('personal actions still work: marking notifications read and leaving the workspace', async () => {
    const w = await world('suspended-personal-co');
    await setState(w.tenant.id, 'suspended');
    const read = await app.inject({ method: 'POST', url: '/api/v1/notifications/read', headers: editorHeaders(w), payload: { all: true } });
    expect(read.statusCode, read.body).not.toBe(423);
    const leave = await app.inject({ method: 'DELETE', url: '/api/v1/members/me', headers: editorHeaders(w) });
    expect(leave.statusCode, leave.body).not.toBe(423);
    expect(leave.statusCode).toBeLessThan(300);
  });
});
