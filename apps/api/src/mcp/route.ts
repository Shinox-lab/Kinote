import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import type { Actor, AnswerProvider, EmbeddingProvider, ModelProviders } from '@kinote/core';
import type { CollabClient, ObjectStorage, UsageLimits } from '@kinote/shared';
import { serverInstructions } from './instructions.js';
import { APP_RESOURCES, listAppResources, readAppResource, type AppResource } from './resources.js';
import { namedSpaces } from './refs.js';
import { callTool, listTools, type ToolDef } from './tool.js';
import { ALL_TOOLS } from './tools/index.js';

export interface McpDeps {
  embeddingProvider: EmbeddingProvider;
  answerProvider: AnswerProvider;
  models?: ModelProviders;
  collab?: CollabClient;
  limits: UsageLimits;
  /** BILLING_URL: where a credits refusal points. */
  billingUrl?: string;
  /** PUBLIC_URL: results link pages when it is set. */
  publicUrl?: string;
  /** MCP_SEARCH_MAX_DISTANCE: vector hits farther than this cosine distance are dropped. */
  searchMaxDistance: number;
  /** Runs a tool's work in a usage scope, so its model calls are charged like the web routes' ('index' for search, 'ask'). */
  meter<T>(kind: 'ask' | 'index', actor: Actor, fn: () => Promise<T>): Promise<T>;
  /** Reported as serverInfo.version. */
  version: string;
  /** Where the file panel's upload parts and files are kept; without it the upload tools refuse. */
  storage?: ObjectStorage;
  /** MAX_UPLOAD_BYTES: the largest file the panel may upload (default 50 MB). */
  maxUploadBytes?: number;
  /** Where an assembled upload is spooled before it is stored (default the OS temp directory). */
  uploadTmpDir?: string;
}

/** Largest `/mcp` request body: a file-panel chunk is 1 MiB as base64 (about 1.4 MB) plus its JSON-RPC envelope. */
export const MCP_BODY_LIMIT = 4 * 1_048_576;

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
  opts: { path?: string; tools?: readonly ToolDef[]; resources?: readonly AppResource[] } = {}
): void {
  const path = opts.path ?? '/mcp';
  const tools = opts.tools ?? ALL_TOOLS;
  const resources = opts.resources ?? APP_RESOURCES;

  app.post(path, { bodyLimit: MCP_BODY_LIMIT, config: { auth: 'agent', whenSuspended: 'allow' } }, async (req, reply) => {
    const actor = req.actor;
    const agent = req.agentAuth;
    if (!actor || !agent) throw new AppError('unauthenticated');

    const instructions = hasInitialize(req.body)
      ? serverInstructions(
          (await withTenantTx(actor.tenantId, (tx) => namedSpaces(tx, actor))).map((s) => s.name),
          agent.scopes
        )
      : undefined;
    const server = new Server(
      { name: 'kinote', version: deps.version },
      { capabilities: { tools: {}, resources: {} }, ...(instructions !== undefined ? { instructions } : {}) }
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools(tools, agent) }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: listAppResources(resources) }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => readAppResource(resources, request.params.uri));
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
