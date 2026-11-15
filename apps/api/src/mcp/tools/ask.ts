import { z } from 'zod';
import { chargeAiAction, hitLimit, withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { NO_RELEVANT_ANSWER } from '@kinote/core';
import { askWiki } from '../../search/askWiki.js';
import { assertCredits, DEFAULT_AGENT_DAILY_AI_ACTIONS } from '../../usageLimits.js';
import { dataBlock, pageLink, shortId } from '../format.js';
import { resolveSpaceRef, ToolError } from '../refs.js';
import { defineTool } from '../tool.js';

const DAY_MS = 86_400_000;

export const askTool = defineTool({
  name: 'kinote_ask',
  scope: 'read',
  limit: 'ask',
  description:
    'Ask a question; get an answer written from the wiki with its sources and versions. Slower and costs an AI action; prefer kinote_search when you can read passages yourself.',
  input: {
    question: z.string().trim().min(1).max(2000),
    space: z.string().max(200).optional().describe('A space name or ID'),
  },
  async run(args, ctx) {
    const { actor, agent, deps, log } = ctx;
    const spaceIds =
      args.space === undefined ? undefined : [(await withTenantTx(actor.tenantId, (tx) => resolveSpaceRef(tx, actor, args.space!))).id];

    // In order: the workspace's monthly credits, this agent's own daily cap, then the workspace's daily
    // allowance, so a call the agent's cap refuses never uses the workspace's allowance.
    await assertCredits(actor.tenantId, { ...(deps.billingUrl ? { billingUrl: deps.billingUrl } : {}), log });
    const cap = agent.dailyAiLimit ?? DEFAULT_AGENT_DAILY_AI_ACTIONS;
    let capped = false;
    try {
      capped = !(await hitLimit(`ai:agent:${agent.agentId}`, cap, DAY_MS)).allowed;
    } catch (err) {
      log.error({ err }, 'agent AI cap unavailable; action allowed');
    }
    if (capped) {
      throw new ToolError(`This agent has used its ${cap} AI actions for today. Use kinote_search, or ask an admin to raise its limit.`);
    }
    let allowed = true;
    try {
      allowed = (await chargeAiAction(actor.tenantId, deps.limits.tenantDailyAiActions)).allowed;
    } catch (err) {
      log.error({ err }, 'AI allowance unavailable; action allowed');
    }
    if (!allowed) throw new AppError('ai_budget_exhausted');

    const res = await askWiki(actor, { question: args.question, ...(spaceIds ? { spaceIds } : {}) }, deps);
    if (!res.foundRelevant) {
      return !res.answer || res.answer === NO_RELEVANT_ANSWER ? NO_RELEVANT_ANSWER : dataBlock('answer', res.answer);
    }
    const seen = new Set<string>();
    const sources: string[] = [];
    for (const c of res.citations) {
      const key = `${c.documentId}:${c.versionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = pageLink(agent, deps.publicUrl, c.documentId, c.documentKind);
      sources.push(`- ${c.citeAs} (${shortId(c.documentId)})${link ? `  ${link}` : ''}`);
    }
    ctx.touch([...new Set(res.citations.map((c) => c.documentId))]);
    // The answer is model text written from page text, and the sources are page titles: both are wiki content.
    return dataBlock('answer', sources.length > 0 ? `${res.answer}\nSources:\n${sources.join('\n')}` : res.answer);
  },
});
