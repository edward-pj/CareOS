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

  async connect(url: URL): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(url));
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
