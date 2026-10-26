import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '@living-wiki/contracts';
import { loadConfig } from '@living-wiki/shared';
import { DeterministicPlacementModel, chatJson, createPlacementModel } from '../src/index.js';

const opts = { baseUrl: 'https://router.example/v1/', model: 'Qwen/Qwen3-8B', timeoutMs: 1000, maxTokens: 500 };
const Summary = z.object({ summary: z.string().min(1) });

function reply(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof AppError ? err.code : `not an AppError: ${String(err)}`;
  }
  return 'resolved';
}

describe('DeterministicPlacementModel', () => {
  const model = new DeterministicPlacementModel();

  it('extracts capitalised names and an owns edge', async () => {
    const out = await model.extractEntities({
      title: 'Billing',
      headingPath: [],
      text: 'Aisha Rahman owns Billing Service.',
    });
    expect(out.entities.map((e) => e.name).sort()).toEqual(['Aisha Rahman', 'Billing Service']);
    expect(out.edges).toEqual([{ from: 'Aisha Rahman', to: 'Billing Service', type: 'owns' }]);
  });

  it('skips sentence-start stop words', async () => {
    const out = await model.extractEntities({ title: 't', headingPath: [], text: 'We use Adyen.' });
    expect(out.entities.map((e) => e.name)).toEqual(['Adyen']);
  });

  it('treats a name prefix as the same entity', async () => {
    const a = { name: 'Aisha', kind: 'other' as const, aliases: [] };
    const b = { name: 'Aisha Rahman', kind: 'other' as const, aliases: [] };
    expect(await model.sameEntity({ a, b, context: '' })).toEqual({ same: true });
    expect(await model.sameEntity({ a, b: { ...b, name: 'Ben Tan' }, context: '' })).toEqual({ same: false });
  });

  it('summarises with the first two sentences, or the title when empty', async () => {
    expect(await model.summarizePage({ title: 'T', outline: [], markdown: 'One. Two. Three.' })).toEqual({
      summary: 'One. Two.',
    });
    expect(await model.summarizePage({ title: 'T', outline: [], markdown: '' })).toEqual({ summary: 'T' });
  });
});

describe('chatJson', () => {
  it('parses a valid JSON answer and asks for a JSON object', async () => {
    const { impl, calls } = fakeFetch(reply('{"summary":"ok"}'));
    await expect(chatJson({ ...opts, fetchImpl: impl }, { system: 's', user: 'u', schema: Summary })).resolves.toEqual({
      summary: 'ok',
    });
    expect(calls[0]!.url).toBe('https://router.example/v1/chat/completions');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body.temperature).toBe(0);
  });

  it('retries once after an invalid answer', async () => {
    const { impl, calls } = fakeFetch(reply('not json'), reply('{"summary":"ok"}'));
    await expect(chatJson({ ...opts, fetchImpl: impl }, { system: 's', user: 'u', schema: Summary })).resolves.toEqual({
      summary: 'ok',
    });
    expect(calls).toHaveLength(2);
  });

  it('invalid JSON twice throws router_unavailable', async () => {
    const { impl } = fakeFetch(reply('not json'), reply('{"summary":""}'));
    expect(await codeOf(chatJson({ ...opts, fetchImpl: impl }, { system: 's', user: 'u', schema: Summary }))).toBe(
      'router_unavailable'
    );
  });

  it('a 500 or a timeout is router_unavailable', async () => {
    const failing = fakeFetch(reply('{}', 500));
    expect(await codeOf(chatJson({ ...opts, fetchImpl: failing.impl }, { system: 's', user: 'u', schema: Summary }))).toBe(
      'router_unavailable'
    );
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const slow = fakeFetch(timeout);
    expect(await codeOf(chatJson({ ...opts, fetchImpl: slow.impl }, { system: 's', user: 'u', schema: Summary }))).toBe(
      'router_unavailable'
    );
  });
});

describe('router config', () => {
  const base = { DATABASE_URL: 'postgres://x', COLLAB_TOKEN_SECRET: 'c'.repeat(32), INTERNAL_SECRET: 'i'.repeat(32) };

  it('defaults to the deterministic model', () => {
    expect(createPlacementModel(loadConfig(base))).toBeInstanceOf(DeterministicPlacementModel);
  });

  it('requires ROUTER_MODEL for the openai provider', () => {
    expect(() =>
      loadConfig({ ...base, ROUTER_PROVIDER: 'openai', ROUTER_BASE_URL: 'https://router.example/v1' })
    ).toThrow(/ROUTER_MODEL/);
  });
});
