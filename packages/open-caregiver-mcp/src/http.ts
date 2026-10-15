import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface Frame {
  ts: number;
  dir: "in" | "out";
  sessionId?: string;
  message: JSONRPCMessage;
}

/**
 * Streamable HTTP (MCP 2025-11-25): one endpoint handling POST, GET (SSE) and DELETE.
 * Each session gets its own McpServer. `onFrame` taps every JSON-RPC message.
 */
export function createMcpHttpHandler(opts: { createServer: () => McpServer; onFrame?: (f: Frame) => void }) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return async function handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(sessionId ? 404 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sessionId ? "Unknown session" : "Missing session; send initialize first" }, id: null }));
        return;
      }
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, t); },
      });
      t.onclose = () => { if (t.sessionId) transports.delete(t.sessionId); };
      const server = opts.createServer();
      await server.connect(t);
      if (opts.onFrame) tap(t, opts.onFrame);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  };
}

function tap(t: StreamableHTTPServerTransport, onFrame: (f: Frame) => void) {
  const onmessage = t.onmessage;
  t.onmessage = (message, extra) => {
    onFrame({ ts: Date.now(), dir: "in", sessionId: t.sessionId, message });
    onmessage?.(message, extra);
  };
  const send = t.send.bind(t);
  t.send = (message, options) => {
    onFrame({ ts: Date.now(), dir: "out", sessionId: t.sessionId, message });
    return send(message, options);
  };
}
