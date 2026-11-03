import { describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@kinote/db';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { InMemoryObjectStorage, type UsageLimits } from '@kinote/shared';
import { TEST_LIMITS, asUser, bootstrapTenant, buildTestApp, createTenant, signUp, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

/** A server with `over` replacing the generous test limits. */
function appWith(over: Partial<UsageLimits>) {
  return buildTestApp({ limits: { ...TEST_LIMITS, ...over }, storage: new InMemoryObjectStorage() });
}

const ask = (app: ReturnType<typeof buildTestApp>, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/api/v1/ask', headers, payload: { question: 'what changed?' } });

describe('usage limits', () => {
  useTestDb();

  test('Ask is limited per person per minute, and says how long to wait', async () => {
    const app = appWith({ askPerMinute: 2 });
    const { headers } = await bootstrapTenant(app, { name: 'Ask Co', slug: 'ask-co' });
    expect((await ask(app, headers)).statusCode).toBe(200);
    expect((await ask(app, headers)).statusCode).toBe(200);
    const third = await ask(app, headers);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: 'rate_limited', message: ERROR_SENTENCES.rate_limited });
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

    // Another person in another workspace has a count of their own.
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    expect((await ask(app, other.headers)).statusCode).toBe(200);
  });

  test('Search has its own per-minute limit', async () => {
    const app = appWith({ searchPerMinute: 1 });
    const { headers } = await bootstrapTenant(app, { name: 'Search Co', slug: 'search-co' });
    const search = () => app.inject({ method: 'POST', url: '/api/v1/search', headers, payload: { query: 'billing' } });
    expect((await search()).statusCode).toBe(200);
    expect((await search()).statusCode).toBe(429);
    // Ask is counted separately.
    expect((await ask(app, headers)).statusCode).toBe(200);
  });

  test('past the daily AI allowance Ask and new captures are refused until midnight UTC', async () => {
    const app = appWith({ tenantDailyAiActions: 2 });
    const { headers } = await bootstrapTenant(app, { name: 'Budget Co', slug: 'budget-co' });
    // A capture needs a space to route into.
    const space = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers, payload: { name: 'Eng', slug: 'eng' } });
    expect(space.statusCode, space.body).toBe(201);
    const capture = () => app.inject({ method: 'POST', url: '/api/v1/captures', headers, payload: { text: 'Billing moved.' } });

    expect((await capture()).statusCode).toBe(201);
    expect((await ask(app, headers)).statusCode).toBe(200);
    expect((await ask(app, headers)).statusCode).toBe(200);
    const over = await ask(app, headers);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('ai_budget_exhausted');
    const secondsToMidnight = (Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000;
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(Math.ceil(secondsToMidnight));

    const refused = await capture();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('ai_budget_exhausted');

    // Search and indexing are not AI actions.
    expect((await app.inject({ method: 'POST', url: '/api/v1/search', headers, payload: { query: 'billing' } })).statusCode).toBe(200);
    // Another workspace has its own allowance.
    const other = await bootstrapTenant(app, { name: 'Fresh Co', slug: 'fresh-co' });
    expect((await ask(app, other.headers)).statusCode).toBe(200);
  });

  test('one person may own only so many workspaces', async () => {
    const app = appWith({ maxTenantsPerUser: 2 });
    const owner = await signUp(app);
    await createTenant(app, owner, { name: 'One', slug: 'one' });
    await createTenant(app, owner, { name: 'Two', slug: 'two' });
    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: asUser(owner),
      payload: { name: 'Three', slug: 'three' },
    });
    expect(third.statusCode).toBe(403);
    expect(third.json().error).toBe('tenant_limit_reached');
  });

  test('creating workspaces is limited to 5 an hour, even under the ownership cap', async () => {
    const app = appWith({});
    const owner = await signUp(app);
    for (let i = 1; i <= 5; i++) await createTenant(app, owner, { name: `W${i}`, slug: `w${i}` });
    const sixth = await app.inject({ method: 'POST', url: '/api/v1/tenants', headers: asUser(owner), payload: { name: 'W6', slug: 'w6' } });
    expect(sixth.statusCode).toBe(429);
  });

  test('uploads are limited per person per minute, new files and new versions together', async () => {
    const app = appWith({ uploadPerMinute: 2 });
    const { headers, inboxSpace } = await bootstrapTenant(app, { name: 'Files Co', slug: 'files-co' });
    const upload = (name: string) =>
      app.inject(uploadRequest('/api/v1/files', headers, { name, data: `hello ${name}` }, { space_id: inboxSpace.id }));
    const first = await upload('a.txt');
    expect(first.statusCode, first.body).toBe(201);
    const replaced = await app.inject(
      uploadRequest(`/api/v1/files/${first.json().document.id}/versions`, headers, { name: 'a.txt', data: 'hello again' })
    );
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect((await upload('b.txt')).statusCode).toBe(429);
  });

  test('a per-minute limit lets requests through when the counters cannot be read', async () => {
    const app = appWith({ askPerMinute: 1 });
    const { headers } = await bootstrapTenant(app, { name: 'Down Co', slug: 'down-co' });
    try {
      await getDb().execute(sql`RESET ROLE`);
      await getDb().execute(sql`ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_away`);
      await getDb().execute(sql`SET ROLE kinote_app`);
      expect((await ask(app, headers)).statusCode).toBe(200);
      expect((await ask(app, headers)).statusCode).toBe(200);
    } finally {
      await getDb().execute(sql`RESET ROLE`);
      await getDb().execute(sql`ALTER TABLE IF EXISTS rate_limit_counters_away RENAME TO rate_limit_counters`);
      await getDb().execute(sql`SET ROLE kinote_app`);
    }
  });
});
