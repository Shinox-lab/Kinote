import type { z } from 'zod';
import { AppError } from '@kinote/contracts';

export interface ChatJsonOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  /** `off` asks the model not to reason first (OpenRouter's `reasoning` field); unset sends nothing. */
  reasoning?: 'off';
  fetchImpl?: typeof fetch;
  /** Called after every answer that came back, with what the provider reported (cost only where it reports one, e.g. OpenRouter). */
  onUsage?: (usage: ChatUsage) => void;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** In the provider's billing currency (USD on OpenRouter); null when the answer carried none. */
  cost: number | null;
  ms: number;
}

function usageOf(body: unknown, ms: number): ChatUsage {
  const u = (body as { usage?: Record<string, unknown> })?.usage ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    promptTokens: num(u.prompt_tokens) ?? 0,
    completionTokens: num(u.completion_tokens) ?? 0,
    cost: num(u.cost),
    ms,
  };
}

function unavailable(cause: string): AppError {
  const error = new AppError('router_unavailable');
  error.cause = new Error(cause);
  return error;
}

function firstChoice(body: unknown): { finish_reason?: unknown; message?: { content?: unknown } } | undefined {
  const choices = (body as { choices?: unknown })?.choices;
  return Array.isArray(choices) ? choices[0] : undefined;
}

function contentOf(body: unknown): string {
  const content = firstChoice(body)?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * One OpenAI-compatible `/chat/completions` call that must answer a JSON
 * object matching `schema`. A malformed or invalid answer is retried once with
 * the validation error added; a second one, an answer cut off at the token
 * limit, or any transport failure, is
 * `router_unavailable` (the caller's job retries). The answer is untrusted
 * model output: only what `schema` accepts comes back.
 */
export async function chatJson<T>(
  opts: ChatJsonOptions,
  req: { system: string; user: string; schema: z.ZodType<T, z.ZodTypeDef, unknown> }
): Promise<T> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  let user = req.user;

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    const started = Date.now();
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: opts.maxTokens,
          response_format: { type: 'json_object' },
          stream: false,
          ...(opts.reasoning === 'off' ? { reasoning: { enabled: false } } : {}),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw unavailable(timedOut ? 'the routing model did not answer in time' : 'the routing model could not be reached');
    }
    if (!response.ok) throw unavailable(`the routing model answered ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable('the routing model returned an unexpected answer');
    }
    opts.onUsage?.(usageOf(body, Date.now() - started));

    // Cut off at max_tokens (a reasoning model can spend them all thinking): asking again pays for the same cut.
    if (firstChoice(body)?.finish_reason === 'length') {
      throw unavailable('the routing model ran out of tokens before answering: raise ROUTER_MAX_TOKENS or set ROUTER_REASONING=off');
    }

    let problem: string;
    try {
      const parsed = req.schema.safeParse(JSON.parse(contentOf(body)));
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    } catch {
      problem = 'the answer was not a JSON object';
    }
    user = `${req.user}\n\nYour previous answer was rejected (${problem}). Answer again with only the JSON object.`;
  }
  throw unavailable('the routing model returned invalid JSON twice');
}
