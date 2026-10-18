// Live smoke test: one real Bedrock turn through the full stack (model -> MCP over HTTP -> engines).
// Needs AWS credentials with Bedrock InvokeModel access and a region where BEDROCK_MODEL_ID is available.
//   AWS_REGION=us-east-1 BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0 pnpm --filter careos-server smoke:bedrock
import type { AddressInfo } from "node:net";
import { CareService, MemoryAdapter, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { BedrockLlm } from "../src/orchestrator/bedrock.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { McpToolClient } from "../src/orchestrator/mcpClient.js";

const cfg = loadConfig({ ...process.env, LLM_MODE: "bedrock" });
const storage = new MemoryAdapter(createSeed(Date.now()));
const service = new CareService(storage);
const mcp = new McpToolClient();
const orchestrator = new Orchestrator({ llm: new BedrockLlm({ region: cfg.region, modelId: cfg.bedrockModelId }), runner: mcp });
const { app } = createApp({ service, storage, orchestrator });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  await mcp.connect(new URL(`${base}/mcp`));
  await orchestrator.init();
  console.log(`model=${cfg.bedrockModelId} region=${cfg.region} tools=${orchestrator.toolNames.join(",")}`);

  const start = await fetch(`${base}/api/converse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "smoke", active_profile: "leo", caregiver: "Sarah (Mom)", transcript: "Leo is 19 pounds and has a fever. How much Motrin can I give?" }),
  });
  const { turn_id } = (await start.json()) as { turn_id: string };

  let after = 0;
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const page = (await (await fetch(`${base}/api/turns/${turn_id}/events?after=${after}&wait=20`)).json()) as { events: Array<{ type: string; data: any }>; done: boolean; next: number };
    for (const e of page.events) { seen.push(e.type); console.log(e.type, JSON.stringify(e.data).slice(0, 200)); }
    after = page.next;
    if (page.done) break;
  }

  const ok = seen.includes("card") && seen.includes("assistant_delta") && !seen.includes("error");
  console.log(ok ? "SMOKE OK: card + reply, no errors" : "SMOKE FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await mcp.close();
  server.closeAllConnections();
  server.close();
}
