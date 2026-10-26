import { describe, test, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  jobs,
  spaces,
  captureFacts,
  captureChanges,
  captureMessages,
  captures,
} from '@living-wiki/db';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

describe('captures API', () => {
  const app = buildTestApp();
  useTestDb();

  async function post(headers: Headers, url: string, payload: unknown) {
    return app.inject({ method: 'POST', url, headers, payload: payload as any });
  }

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Capture Co', slug: 'capture-co' });
    const space = async (slug: string) => (await post(headers, '/api/v1/spaces', { name: slug, slug })).json() as { id: string; name: string };
    const eng = await space('eng');
    const secret = await space('secret');
    const page = async (spaceId: string, slug: string) =>
      (await post(headers, '/api/v1/pages', { space_id: spaceId, title: `Page ${slug}`, slug, markdown: 'Billing uses Stripe.' })).json()
        .id as string;
    const engPage = await page(eng.id, 'billing');
    const secretPage = await page(secret.id, 'vault');
    const member = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${eng.id}/grants`, { principal_type: 'user', principal_id: member.userId, role: 'editor' });
    const viewer = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${eng.id}/grants`, { principal_type: 'user', principal_id: viewer.userId, role: 'viewer' });
    const [inbox] = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(spaces).where(and(eq(spaces.tenantId, tenant.id), eq(spaces.kind, 'inbox')))
    );
    return { tenant, owner, headers, eng, secret, engPage, secretPage, member, viewer, inboxId: inbox!.id };
  }

  test('creates a queued capture and one routing job', async () => {
    const w = await world();
    const res = await post(w.member.headers, '/api/v1/captures', { text: 'Billing moved to Adyen.' });
    expect(res.statusCode, res.body).toBe(201);
    const capture = res.json();
    expect(capture).toMatchObject({ status: 'queued', text: 'Billing moved to Adyen.', channel: 'console' });
    const queued = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.tenantId, w.tenant.id), eq(jobs.queue, 'capture.route')))
    );
    expect(queued.map((j) => j.idempotencyKey)).toEqual([`capture:${capture.id}`]);
  });

  test('more than 20 000 characters is 400 capture_too_long', async () => {
    const w = await world();
    const res = await post(w.member.headers, '/api/v1/captures', { text: 'a'.repeat(20_001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('capture_too_long');
  });

  test('a member who can edit no space is 403', async () => {
    const w = await world();
    const res = await post(w.viewer.headers, '/api/v1/captures', { text: 'Billing moved to Adyen.' });
    expect(res.statusCode).toBe(403);
  });

  test('an Inbox or unreadable scope is 404', async () => {
    const w = await world();
    const inbox = await post(w.member.headers, '/api/v1/captures', { text: 'x', scope_space_id: w.inboxId });
    expect(inbox.statusCode).toBe(404);
    expect(inbox.json().error).toBe('space_not_found');
    const hidden = await post(w.member.headers, '/api/v1/captures', { text: 'x', scope_space_id: w.secret.id });
    expect(hidden.statusCode).toBe(404);
    const hiddenPage = await post(w.member.headers, '/api/v1/captures', { text: 'x', scope_page_id: w.secretPage });
    expect(hiddenPage.statusCode).toBe(404);
  });

  test("another member's capture is 404; the sender and admins see it", async () => {
    const w = await world();
    const id = (await post(w.member.headers, '/api/v1/captures', { text: 'Billing moved to Adyen.' })).json().id;
    const other = await app.inject({ method: 'GET', url: `/api/v1/captures/${id}`, headers: w.viewer.headers });
    expect(other.statusCode).toBe(404);
    expect(other.json().error).toBe('capture_not_found');
    const mine = await app.inject({ method: 'GET', url: `/api/v1/captures/${id}`, headers: w.member.headers });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ capture: { id }, thread: [] });
    const admin = await app.inject({ method: 'GET', url: `/api/v1/captures/${id}`, headers: w.headers });
    expect(admin.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/v1/captures', headers: w.member.headers });
    expect(list.json().map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/captures', headers: w.viewer.headers })).json()).toEqual([]);
  });

  test('answering with no open question is 409 capture_not_waiting', async () => {
    const w = await world();
    const id = (await post(w.member.headers, '/api/v1/captures', { text: 'Aisha owns Billing.' })).json().id;
    const res = await post(w.member.headers, `/api/v1/captures/${id}/answer`, {
      message_id: '00000000-0000-4000-8000-000000000000',
      choice: '00000000-0000-4000-8000-000000000001',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('capture_not_waiting');
  });

  test('answering a question records it, frees the waiting facts and routes again', async () => {
    const w = await world();
    const id = (await post(w.member.headers, '/api/v1/captures', { text: 'Aisha owns Billing.' })).json().id;
    const choice = '00000000-0000-4000-8000-000000000001';
    const questionId = await withTenantTx(w.tenant.id, async (tx) => {
      const [q] = await tx
        .insert(captureMessages)
        .values({ tenantId: w.tenant.id, captureId: id, author: 'engine', body: 'Which Aisha?', options: [{ entityId: choice, label: 'Aisha Rahman' }] })
        .returning();
      await tx.insert(captureFacts).values({
        tenantId: w.tenant.id, captureId: id, ordinal: 0, statement: 'Aisha owns Billing.', kind: 'new', waitingQuestionId: q!.id,
      });
      await tx.update(captures).set({ status: 'waiting_for_answer' }).where(eq(captures.id, id));
      await tx.delete(jobs);
      return q!.id;
    });
    const res = await post(w.member.headers, `/api/v1/captures/${id}/answer`, { message_id: questionId, choice });
    expect(res.statusCode, res.body).toBe(200);
    const [fact] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureFacts));
    expect(fact).toMatchObject({ outcome: 'pending', waitingQuestionId: null, pinnedEntityIds: [choice] });
    const queued = await withTenantTx(w.tenant.id, (tx) => tx.select().from(jobs));
    expect(queued.map((j) => j.queue)).toEqual(['capture.route']);
    expect(res.json().thread.map((m: { author: string }) => m.author)).toEqual(['engine', 'sender']);
    // Only the sender answers.
    const admin = await post(w.headers, `/api/v1/captures/${id}/answer`, { message_id: questionId, choice });
    expect(admin.statusCode).toBe(404);
  });

  test('the receipt groups by space and hides pages the viewer cannot read', async () => {
    const w = await world();
    const id = (await post(w.member.headers, '/api/v1/captures', { text: 'Billing moved to Adyen.' })).json().id;
    await withTenantTx(w.tenant.id, async (tx) => {
      const [fact] = await tx
        .insert(captureFacts)
        .values({ tenantId: w.tenant.id, captureId: id, ordinal: 0, statement: 'Billing moved to Adyen.', kind: 'change', outcome: 'applied', reason: 'It says Stripe.' })
        .returning();
      for (const [documentId, spaceId] of [
        [w.engPage, w.eng.id],
        [w.secretPage, w.secret.id],
      ] as const) {
        await tx.insert(captureChanges).values({
          tenantId: w.tenant.id, captureId: id, factId: fact!.id, documentId, spaceId, blockId: 'b1', op: 'replace',
          beforeMarkdown: 'Billing uses Stripe.', afterMarkdown: 'Billing moved to Adyen.',
        });
      }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/captures/${id}`, headers: w.member.headers });
    expect(res.statusCode, res.body).toBe(200);
    const receipt = res.json().receipt;
    expect(receipt.hiddenChanges).toBe(1);
    expect(receipt.spaces).toHaveLength(1);
    expect(receipt.spaces[0]).toMatchObject({ spaceId: w.eng.id, pages: [{ documentId: w.engPage, changes: [{ op: 'replace', reason: 'It says Stripe.' }] }] });
  });
});
