import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpHandler, type Frame } from "../src/http.js";
import { CareService, MemoryAdapter, createCareMcpServer, createSeed } from "../src/server.js";

let http: Server;
let url: URL;
const frames: Frame[] = [];

beforeAll(async () => {
  const service = new CareService(new MemoryAdapter(createSeed(Date.now())));
  const handle = createMcpHttpHandler({ createServer: () => createCareMcpServer(service), onFrame: (f) => frames.push(f) });
  http = createServer(async (req, res) => {
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    await handle(req, res, body);
  });
  await new Promise<void>((r) => http.listen(0, r));
  url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});
afterAll(() => { http.close(); });

async function connect() {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe("MCP over Streamable HTTP", () => {
  it("negotiates 2025-11-25 and lists all tools", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe("open-caregiver-mcp");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["calculate_pediatric_dose", "confirm_amazon_order", "log_administration_event", "override_lockout", "query_pantry_remedies", "stage_amazon_cart", "verify_medication_safety"]);
    await client.close();
  });

  it("tool schemas are flat: no $defs, $ref or anyOf (Bedrock-safe)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const s = JSON.stringify(tools.map((t) => t.inputSchema));
    for (const bad of ["$defs", "$ref", "anyOf", "oneOf", "allOf"]) expect(s).not.toContain(bad);
    await client.close();
  });

  it("calls the golden dose over HTTP and taps the frames", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "calculate_pediatric_dose", arguments: { patient_id: "infant_leo", weight_value: 19, weight_unit: "lbs", medication: "ibuprofen", formulation: "infant_drops" } });
    expect(r.structuredContent).toMatchObject({ status: "APPROVED", dispense_volume_ml: 2, card_type: "SYRINGE_CALIBRATOR" });
    expect(frames.some((f) => f.dir === "in" && (f.message as any).method === "tools/call")).toBe(true);
    expect(frames.some((f) => f.dir === "out" && (f.message as any).result?.structuredContent?.dispense_volume_ml === 2)).toBe(true);
    await client.close();
  });

  it("returns isError for an unknown patient and rejects bad input", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "nobody", symptom: "cough" } });
    expect(r.isError).toBe(true);
    const bad = await client.callTool({ name: "override_lockout", arguments: { patient_id: "leo", ingredient: "ibuprofen", caregiver: "x", pin: "12" } }).catch((e) => e);
    expect(bad.isError === true || bad instanceof Error).toBe(true);
    await client.close();
  });

  it("serves resources including the FHIR view", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(["careos://patients/leo", "careos://patients/frank", "careos://household/inventory"]));
    const leo = await client.readResource({ uri: "careos://patients/leo" });
    const data = JSON.parse((leo.contents[0] as any).text);
    expect(data.fhir.patient.resourceType).toBe("Patient");
    const ledger = await client.readResource({ uri: "careos://patients/leo/ledger" });
    expect(JSON.parse((ledger.contents[0] as any).text)).toEqual([]);
    await client.close();
  });

  it("rejects a non-initialize request without a session", async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(400);
  });
});
