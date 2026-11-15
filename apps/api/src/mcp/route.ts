import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import type { Actor, AnswerProvider, EmbeddingProvider, ModelProviders } from '@kinote/core';
import type { CollabClient, UsageLimits } from '@kinote/shared';
import { serverInstructions } from './instructions.js';
import { namedSpaces } from './refs.js';
import { callTool, listTools, type ToolDef } from './tool.js';
import { READ_TOOLS } from './tools/index.js';

export interface McpDeps {
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
  models?: ModelProviders;
  collab?: CollabClient;
  limits: UsageLimits;
  /** PUBLIC_URL: results link pages when it is set. */
  publicUrl?: string;
  /** MCP_SEARCH_MAX_DISTANCE: vector hits farther than this cosine distance are dropped. */
  searchMaxDistance: number;
  /** Runs a tool's work in a usage scope, so its model calls are charged like the web routes' ('index' for search, 'ask'). */
  meter<T>(kind: 'ask' | 'index', actor: Actor, fn: () => Promise<T>): Promise<T>;
  /** Reported as serverInfo.version. */
  version: string;
}

/** Whether a JSON-RPC body (one message or a batch) contains an `initialize` request. */
function hasInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => m !== null && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize');
}

/**
 * `POST /mcp`: the Model Context Protocol over Streamable HTTP, stateless. The `'agent'` auth mode has already
 * turned the bearer agent token into `req.actor` (the agent, carrying its owner) and `req.agentAuth`, or answered
 * 401. Each POST gets a fresh low-level `Server` and transport, closed when the response ends; there are no MCP
 * sessions, so `tools/call` works without `initialize` first. `Server` (not `McpServer`) because a tool outside
 * the token's scopes must be missing from `tools/list` yet answer a readable refusal when called.
 * Read-only: it keeps working while the workspace is suspended. `GET` (a server-sent event stream) and `DELETE`
 * (ending a session) do not apply to a stateless server and answer 405.
 */
export function registerMcpRoute(
  app: FastifyInstance,
  deps: McpDeps,
  opts: { path?: string; tools?: readonly ToolDef[] } = {}
): void {
  const path = opts.path ?? '/mcp';
  const tools = opts.tools ?? READ_TOOLS;

  app.post(path, { config: { auth: 'agent', whenSuspended: 'allow' } }, async (req, reply) => {
    const actor = req.actor;
    const agent = req.agentAuth;
    if (!actor || !agent) throw new AppError('unauthenticated');

    const instructions = hasInitialize(req.body)
      ? serverInstructions((await withTenantTx(actor.tenantId, (tx) => namedSpaces(tx, actor))).map((s) => s.name))
      : undefined;
    const server = new Server(
      { name: 'kinote', version: deps.version },
      { capabilities: { tools: {} }, ...(instructions !== undefined ? { instructions } : {}) }
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools(tools, agent) }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      callTool(tools, { actor, agent, deps, log: req.log }, request.params.name, request.params.arguments)
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    // The SDK writes the response itself: keep the security headers the onRequest hooks set.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value as string | number | readonly string[]);
    }
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: path,
      config: { auth: 'public' },
      handler: async (_req, reply) =>
        reply
          .status(405)
          .header('allow', 'POST')
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null }),
    });
  }
}
