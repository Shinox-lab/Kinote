import { z, type ZodRawShape } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import { hitLimit, withTenantTx, writeAuditEvent } from '@kinote/db';
import { AppError, type AgentScope } from '@kinote/contracts';
import { estimateTokens, type Actor } from '@kinote/core';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuth } from '../auth/actor.js';
import { capResult } from './format.js';
import { ToolError } from './refs.js';
import type { McpDeps } from './route.js';

/** What a tool's `run` gets besides its arguments. */
export interface ToolContext {
  actor: Actor;
  agent: AgentAuth;
  deps: McpDeps;
  log: FastifyBaseLogger;
  /** Records the documents a result shows, for the audit row. */
  touch(pageIds: string[]): void;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  /** The token scope the tool needs; without it the tool is not listed and a call is refused. */
  scope: AgentScope;
  /** Which per-agent, per-minute limit the call counts against. */
  limit: 'search' | 'ask';
  description: string;
  input: S;
  /** The result text. Throw `ToolError` (or an `AppError`) for a refusal the agent should read. */
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<string>;
}

/** Declares a tool (typing only: the route lists and calls it). */
export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const ARG_AUDIT_CHARS = 500;
const MINUTE_MS = 60_000;

/** The `tools/list` entries this token may see. */
export function listTools(tools: readonly ToolDef[], agent: AgentAuth): Tool[] {
  return tools
    .filter((t) => agent.scopes.includes(t.scope))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchemaCompat(z.object(t.input), { strictUnions: true, pipeStrategy: 'input' }) as Tool['inputSchema'],
    }));
}

function cutArgs(args: unknown): unknown {
  if (typeof args === 'string') return args.slice(0, ARG_AUDIT_CHARS);
  if (Array.isArray(args)) return args.map(cutArgs);
  if (args && typeof args === 'object') {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, cutArgs(v)]));
  }
  return args;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/**
 * Runs one `tools/call`: refuses a tool the token's scopes do not cover, counts the per-agent rate limit,
 * validates the arguments, runs the tool in a usage scope, caps the result, turns refusals into `isError`
 * text, and writes one `mcp.tool_call` audit row (a failed audit write is logged, never fails the call).
 */
export async function callTool(
  tools: readonly ToolDef[],
  ctx: Omit<ToolContext, 'touch'>,
  name: string,
  rawArgs: unknown
): Promise<CallToolResult> {
  const { actor, agent, log } = ctx;
  const pages = new Set<string>();
  const { result, error } = await runCall(tools, ctx, name, rawArgs, pages);

  const resultText = (result.content[0] as { text: string }).text;
  try {
    await withTenantTx(actor.tenantId, (tx) =>
      writeAuditEvent(tx, {
        tenantId: actor.tenantId,
        type: 'mcp.tool_call',
        actorType: 'agent',
        actorId: agent.agentId,
        subjectType: 'agent',
        subjectId: agent.agentId,
        payload: {
          tool: name.slice(0, 100),
          args: cutArgs(rawArgs ?? {}),
          tokenId: agent.tokenId,
          pages: [...pages],
          resultTokens: estimateTokens(resultText),
          error,
        },
      })
    );
  } catch (err) {
    log.error({ err, tool: name }, 'mcp audit write failed');
  }
  return result;
}

/** The call itself, refusals included; `error` is the refusal text the agent sees, or null. */
async function runCall(
  tools: readonly ToolDef[],
  ctx: Omit<ToolContext, 'touch'>,
  name: string,
  rawArgs: unknown,
  pages: Set<string>
): Promise<{ result: CallToolResult; error: string | null }> {
  const { actor, agent, deps, log } = ctx;
  const refuse = (error: string) => ({ result: text(error, true), error });
  const tool = tools.find((t) => t.name === name);
  if (!tool) return refuse(`No tool named ${name.slice(0, 100)}. Call tools/list to see the tools this token can use.`);
  if (!agent.scopes.includes(tool.scope)) {
    return refuse(`This token cannot use ${tool.name}. Ask a workspace admin for a token with the "${tool.scope}" scope.`);
  }

  const max = tool.limit === 'ask' ? deps.limits.askPerMinute : deps.limits.searchPerMinute;
  try {
    const verdict = await hitLimit(`limit:mcp-${tool.limit}:${actor.tenantId}:${agent.agentId}`, max, MINUTE_MS);
    if (!verdict.allowed) {
      return refuse(`Too many ${tool.name} calls. Try again in ${Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))} seconds.`);
    }
  } catch (err) {
    log.error({ err }, `rate limit mcp-${tool.limit} unavailable; call allowed`);
  }

  const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
    return refuse(`Invalid arguments for ${tool.name}: ${issues}.`);
  }
  try {
    const out = await deps.meter(tool.limit === 'ask' ? 'ask' : 'index', actor, () =>
      tool.run(parsed.data, { ...ctx, touch: (ids) => ids.forEach((id) => pages.add(id)) })
    );
    return { result: text(capResult(out)), error: null };
  } catch (err) {
    if (err instanceof ToolError || err instanceof AppError) return refuse(err.message);
    log.error({ err, tool: tool.name }, 'mcp tool failed');
    return refuse('Something went wrong on the server. Try again in a moment.');
  }
}
