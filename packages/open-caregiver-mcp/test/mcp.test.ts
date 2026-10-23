import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpHandler, type Frame } from "../src/http.js";
import { CareService, FAIL_CLOSED_MESSAGE, MemoryAdapter, createCareMcpServer, createSeed } from "../src/server.js";

let http: Server;
let url: URL;
const CTX = { householdId: "h-test", caregiverId: "sarah" };
const frames: Frame<typeof CTX>[] = [];
const seenCtx: (typeof CTX)[] = [];

beforeAll(async () => {
  const service = new CareService(new MemoryAdapter(createSeed(Date.now())));
  const handle = createMcpHttpHandler<typeof CTX>({
    createServer: (ctx) => { seenCtx.push(ctx); return createCareMcpServer(service); },
    onFrame: (f) => frames.push(f),
  });
  http = createServer(async (req, res) => {
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    await handle(req, res, body, CTX);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
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
    expect(tools.map((t) => t.name).sort()).toEqual(["cancel_amazon_order", "confirm_amazon_order", "confirm_dose_given", "emergency_assist", "export_care_summary", "forget_patient", "get_household_context", "log_observation", "manage_prescriptions", "plan_medication", "query_pantry_remedies", "read_bottle_label", "stage_amazon_cart", "track_amazon_order", "triage_symptoms"]);
    await client.close();
  });

  it("tool schemas are flat: no $defs, $ref or anyOf (Bedrock-safe)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const s = JSON.stringify(tools.map((t) => t.inputSchema));
    for (const bad of ["$defs", "$ref", "anyOf", "oneOf", "allOf"]) expect(s).not.toContain(bad);
    await client.close();
  });

  it("GOLDEN over HTTP: Leo's dose is 1.875 mL, and the frames are tapped", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "plan_medication", arguments: { patient_id: "leo", product: "Motrin", symptom: "fever", last_dose_elsewhere: "none_today" } });
    expect(r.structuredContent).toMatchObject({
      status: "APPROVED",
      card_type: "SYRINGE_CALIBRATOR",
      dispense_volume_ml: 1.875,
      read_verbatim: true,
      speech: "Leo can have 1.875 milliliters of Infants' Motrin. That is one point eight seven five milliliters.",
    });
    expect(frames.some((f) => f.dir === "in" && (f.message as any).method === "tools/call")).toBe(true);
    expect(frames.some((f) => f.dir === "out" && (f.message as any).result?.structuredContent?.dispense_volume_ml === 1.875)).toBe(true);
    await client.close();
  });

  it("returns isError for an unknown patient and rejects bad input", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "nobody", symptom: "cough" } });
    expect(r.isError).toBe(true);
    const bad = await client.callTool({ name: "plan_medication", arguments: { patient_id: "leo", product: "Motrin", weight_value: 19, weight_unit: "stone" } }).catch((e) => e);
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

  it("tools carry annotations and an output schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ destructiveHint: t.name === "forget_patient", openWorldHint: false });
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(t.outputSchema?.properties, t.name).toHaveProperty("status");
    }
    expect(tools.find((t) => t.name === "get_household_context")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "query_pantry_remedies")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "confirm_dose_given")?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tools.find((t) => t.name === "plan_medication")?.annotations?.readOnlyHint).toBe(false); // it records a reported weight and an audit row
    await client.close();
  });
});

describe("stateless transport (no Mcp-Session-Id)", () => {
  const post = (body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  const rpc = async (res: Response) => {
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? text;
    return JSON.parse(data);
  };

  it("never issues a session id", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "curl", version: "0" } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((await rpc(res)).result.serverInfo.name).toBe("open-caregiver-mcp");
  });

  it("answers tools/list as a standalone request: no initialize, no session (curl-friendly)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(res.status).toBe(200);
    const body = await rpc(res);
    expect(body.id).toBe(7);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain("plan_medication");
  });

  it("ignores a stale or invented session id instead of failing", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "does-not-exist" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("declines GET and DELETE with 405 and an Allow header", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method, headers: { accept: "text/event-stream" } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect((await res.json()).error.message).toMatch(/stateless/i);
    }
  });

  it("serves concurrent callers that reuse the same JSON-RPC id without crosstalk", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_pantry_remedies", arguments: { patient_id: i % 2 ? "leo" : "frank", symptom: "cough" } } }).then(rpc),
      ),
    );
    for (const [i, r] of replies.entries()) {
      expect(r.id).toBe(1);
      expect(r.result.structuredContent.patient_name ?? r.result.structuredContent.status).toBeDefined();
      expect(r.result.isError, `reply ${i}`).toBe(false);
    }
  });

  it("hands the authenticated context to the server factory and tags every frame with it", async () => {
    seenCtx.length = 0;
    frames.length = 0;
    await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }).then((r) => r.text());
    expect(seenCtx).toEqual([CTX]);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((f) => f.ctx.householdId === "h-test")).toBe(true);
    const ids = new Set(frames.map((f) => f.exchangeId));
    expect(ids.size).toBe(1); // one exchange: the request and its reply
    await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }).then((r) => r.text());
    expect(new Set(frames.map((f) => f.exchangeId)).size).toBe(2); // same JSON-RPC id, different exchange
  });
});

describe("tool descriptions steer Alexa+ (PRD §8.2)", () => {
  it("the safety tools start with the user intent, say what they refuse, and forbid inventing numbers", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.plan_medication!.description).toMatch(/^Use this whenever anyone asks to give, take, or dose ANY medicine/);
    expect(byName.plan_medication!.description).toMatch(/refuses to return a dose/);
    expect(byName.plan_medication!.description).toMatch(/no one can override it/);
    for (const name of ["plan_medication", "confirm_dose_given", "log_observation"]) {
      expect(byName[name]!.description, name).toMatch(/Never state a dose, amount, interval, limit or time unless it came from this tool/);
      expect(byName[name]!.description, name).toMatch(/Read the `speech` field aloud exactly as written/);
    }
    expect(byName.confirm_dose_given!.description).toMatch(/Never log a dose without the read-back/);
    await client.close();
  });

  it("no tool accepts an override, bypass, role or doctor flag (H7)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(/override|bypass|skip|force|admin|doctor|role|pin/i);
    }
    await client.close();
  });

  it("extra arguments that try to bypass a check are ignored: a locked dose stays locked", async () => {
    const client = await connect();
    const caller = { patient_id: "leo", product: "Motrin", last_dose_elsewhere: "gave_earlier", elsewhere_minutes_ago: 20 };
    const locked = await client.callTool({ name: "plan_medication", arguments: caller });
    expect(locked.structuredContent).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    const sneaky = await client.callTool({ name: "plan_medication", arguments: { ...caller, override: true, i_am_a_doctor: true, skip_checks: true } }).catch((e) => e);
    if (sneaky instanceof Error) return; // a strict server may reject unknown fields outright: also fine
    expect(sneaky.structuredContent).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    await client.close();
  });
});

describe("S2 / H1: failing closed", () => {
  it("when the database breaks, the answer is one safe message with no internals, and isError is set", async () => {
    const broken = new CareService({ ...new MemoryAdapter(createSeed(Date.now())), getPatient: async () => { throw new Error("connection refused: db.internal:5432"); }, listPatients: async () => { throw new Error("connection refused: db.internal:5432"); } } as never);
    const handle = createMcpHttpHandler<undefined>({ createServer: () => createCareMcpServer(broken) });
    const srv = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      await handle(req, res, req.method === "POST" ? JSON.parse(Buffer.concat(chunks).toString()) : undefined, undefined);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`)));
      const r = await client.callTool({ name: "plan_medication", arguments: { patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" } });
      expect(r.isError).toBe(true);
      const text = (r.content as { text: string }[])[0]!.text;
      expect(text).toBe(FAIL_CLOSED_MESSAGE);
      expect(text).not.toMatch(/db\.internal|5432|connection/);
      expect(r.structuredContent).toBeUndefined(); // no dose, no card
      await client.close();
    } finally { srv.close(); }
  });
});
