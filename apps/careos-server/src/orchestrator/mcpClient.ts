import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolDef } from "./toolBridge.js";

export interface ToolOutcome {
  text: string;
  payload?: Record<string, unknown>;
  isError: boolean;
}

export interface ToolRunner {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

/** Talks to our own /mcp endpoint over real HTTP, so the inspector shows genuine JSON-RPC traffic. */
export class McpToolClient implements ToolRunner {
  private client = new Client({ name: "careos-orchestrator", version: "0.1.0" });

  /** `token` is sent as a Bearer credential on every request, so tool calls run as that caller's household. */
  async connect(url: URL, token?: string): Promise<void> {
    const requestInit = token ? { headers: { authorization: `Bearer ${token}` } } : undefined;
    await this.client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  }

  async listTools(): Promise<McpToolDef[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const res = await this.client.callTool({ name, arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && first.type === "text" ? first.text : JSON.stringify(res.content ?? null);
    return { text, payload: res.structuredContent as Record<string, unknown> | undefined, isError: res.isError === true };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * One connected client per distinct bearer token (i.e. per caller), created on first use. The server is
 * stateless, so a cached client keeps working across server restarts and needs no keep-alive.
 */
export class McpRunnerPool {
  private clients = new Map<string, Promise<McpToolClient>>();

  constructor(private url: URL, private maxClients = 100) {}

  forToken(token: string | undefined): Promise<ToolRunner> {
    const key = token ? createHash("sha256").update(token).digest("hex") : "open";
    let c = this.clients.get(key);
    if (!c) {
      const client = new McpToolClient();
      c = client.connect(this.url, token).then(() => client);
      c.catch(() => this.clients.delete(key)); // do not cache a failed connection
      this.clients.set(key, c);
      if (this.clients.size > this.maxClients) {
        const oldest = this.clients.keys().next().value!;
        const evicted = this.clients.get(oldest);
        this.clients.delete(oldest);
        void evicted?.then((x) => x.close()).catch(() => {});
      }
    }
    return c;
  }
}
