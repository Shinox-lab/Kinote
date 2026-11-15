import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agents, periodOf, tenantLimits, tenantUsage, withTenantTx } from '@kinote/db';
import { defaultEmbeddingProvider, NO_RELEVANT_ANSWER } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, TEST_LIMITS, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, publishPage, type AgentWorld } from './support/mcpkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

describe('kinote_ask', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;

  async function world(slug: string, tenantDailyAiActions = 0) {
    app = buildTestApp({ limits: { ...TEST_LIMITS, tenantDailyAiActions }, publicUrl: 'https://wiki.example.com' });
    const w = await agentWorld(app, slug);
    const page = await publishPage(app, w.ownerHeaders, w.open.id, 'Laptop policy', 'New starters receive a laptop on their first day.');
    await publishPage(app, w.ownerHeaders, w.hidden.id, 'Secret budget', 'The laptop budget is twelve million.');
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    return { w, page };
  }
  const ask = (w: AgentWorld, args: object) => callTool(app, w.token, 'kinote_ask', args);

  test('an answer lists its sources with short ids and links', async () => {
    const { w, page } = await world('ask-sources');
    const res = await ask(w, { question: 'When do new starters receive a laptop?' });
    assert.equal(res.isError, false, res.text);
    const [answer, sources] = res.text.split('\nSources:\n');
    assert.ok(answer && answer.length > 0);
    assert.ok(sources, res.text);
    assert.match(
      sources!,
      new RegExp(`^- Laptop policy \\(v1, updated \\d{4}-\\d{2}-\\d{2}\\) \\(${short(page)}\\)  https://wiki\\.example\\.com/w/ask-sources/p/${page}$`, 'm')
    );
    assert.ok(!res.text.includes('twelve million'));
    assert.ok(!res.text.includes('Secret budget'));
  });

  test('a question nothing answers gives the no-answer text', async () => {
    const { w } = await world('ask-none');
    const res = await ask(w, { question: 'volcano eruption forecast', space: 'Strict' });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.text, NO_RELEVANT_ANSWER);
  });

  test('daily_ai_limit 2: the third call is refused and the workspace allowance is not charged for it', async () => {
    const { w } = await world('ask-cap', 3);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ dailyAiLimit: 2 }).where(eq(agents.id, w.agentId)));
    for (let i = 0; i < 2; i++) assert.equal((await ask(w, { question: 'laptop first day' })).isError, false);
    const third = await ask(w, { question: 'laptop first day' });
    assert.equal(third.isError, true);
    assert.equal(third.text, 'This agent has used its 2 AI actions for today. Use kinote_search, or ask an admin to raise its limit.');
    // The workspace allows 3 a day: the refused call did not use one, so a person can still ask once.
    const person = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: w.ownerHeaders, payload: { question: 'laptop' } });
    assert.equal(person.statusCode, 200, person.body);
    const fourth = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: w.ownerHeaders, payload: { question: 'laptop' } });
    assert.equal(fourth.statusCode, 429, fourth.body);
  });

  test('an agent with no limit set gets 100 a day', async () => {
    const { w } = await world('ask-default');
    const { DEFAULT_AGENT_DAILY_AI_ACTIONS } = await import('../src/usageLimits.js');
    assert.equal(DEFAULT_AGENT_DAILY_AI_ACTIONS, 100);
    assert.equal((await ask(w, { question: 'laptop' })).isError, false);
  });

  test("the workspace's daily allowance and monthly credits refuse with their own text", async () => {
    const { w } = await world('ask-budget', 1);
    assert.equal((await ask(w, { question: 'laptop' })).isError, false);
    const spent = await ask(w, { question: 'laptop' });
    assert.equal(spent.isError, true);
    assert.equal(spent.text, 'This workspace has used its AI allowance for today. It resets at midnight UTC.');

    const { w: w2 } = await world('ask-credits');
    await withTenantTx(w2.tenant.id, async (tx) => {
      await tx.insert(tenantLimits).values({ tenantId: w2.tenant.id, creditsPerMonth: 100 }).onConflictDoUpdate({ target: tenantLimits.tenantId, set: { creditsPerMonth: 100 } });
      await tx
        .insert(tenantUsage)
        .values({ tenantId: w2.tenant.id, period: periodOf(1, new Date()).key, creditsUsedMilli: 110_000 })
        .onConflictDoUpdate({ target: [tenantUsage.tenantId, tenantUsage.period], set: { creditsUsedMilli: 110_000 } });
    });
    const broke = await ask(w2, { question: 'laptop' });
    assert.equal(broke.isError, true);
    assert.match(broke.text, /^This workspace has used this month's AI credits\. They renew on /);
  });
});
