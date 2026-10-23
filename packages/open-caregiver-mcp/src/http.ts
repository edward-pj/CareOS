import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface Frame<Ctx = unknown> {
  ts: number;
  dir: "in" | "out";
  /** One HTTP request/response pair. JSON-RPC ids are only unique within one exchange, so key on this. */
  exchangeId: string;
  /** Whatever the caller authenticated the request as (e.g. household + caregiver). */
  ctx: Ctx;
  message: JSONRPCMessage;
}

export interface McpHttpOptions<Ctx> {
  /** Builds a fresh server for this request, bound to the authenticated context. */
  createServer: (ctx: Ctx) => McpServer;
  /** Taps every JSON-RPC message in both directions (feeds the inspector). */
  onFrame?: (f: Frame<Ctx>) => void;
}

const methodNotAllowed = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed. This server is stateless: POST JSON-RPC requests to this endpoint." },
  id: null,
};

/**
 * Streamable HTTP (MCP 2025-11-25), STATELESS: every POST gets its own server + transport and nothing is
 * remembered between requests. There is no Mcp-Session-Id, so any instance can answer any request (Lambda,
 * App Runner, several replicas) and there is no idle-session timeout to hit. All the state a tool needs
 * comes from the request itself (the authenticated `ctx`) and from the database.
 *
 * GET and DELETE return 405: with no sessions there is no server-initiated stream to open or terminate,
 * and the spec lets servers decline the GET stream this way.
 */
export function createMcpHttpHandler<Ctx = undefined>(opts: McpHttpOptions<Ctx>) {
  return async function handle(req: IncomingMessage, res: ServerResponse, body: unknown, ctx: Ctx): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      res.end(JSON.stringify(methodNotAllowed));
      return;
    }

    const server = opts.createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    if (opts.onFrame) tap(transport, randomUUID(), ctx, opts.onFrame);
    await transport.handleRequest(req, res, body);
  };
}

function tap<Ctx>(t: StreamableHTTPServerTransport, exchangeId: string, ctx: Ctx, onFrame: (f: Frame<Ctx>) => void) {
  const onmessage = t.onmessage;
  t.onmessage = (message, extra) => {
    onFrame({ ts: Date.now(), dir: "in", exchangeId, ctx, message });
    onmessage?.(message, extra);
  };
  const send = t.send.bind(t);
  t.send = (message, options) => {
    onFrame({ ts: Date.now(), dir: "out", exchangeId, ctx, message });
    return send(message, options);
  };
}
