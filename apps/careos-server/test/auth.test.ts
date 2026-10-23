import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryStorage, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import { TokenAuth, bearerToken, isLoopbackHost } from "../src/auth.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { McpRunnerPool, McpToolClient } from "../src/orchestrator/mcpClient.js";
import { MockLlm } from "../src/orchestrator/mock.js";
import { createTenants } from "../src/tenants.js";

const TOKEN_A = "household-a-sarah-token-0001";
const TOKEN_B = "household-b-maya-token-00002";

let server: Server;
let base: string;
let mcpClient: McpToolClient;

beforeAll(async () => {
  const auth = TokenAuth.fromSpec(`${TOKEN_A}=hh-a:sarah, ${TOKEN_B}=hh-b:maya`);
  const root = new MemoryStorage();
  for (const h of auth.households()) await root.forHousehold(h).reset(createSeed(Date.now()));
  const internal = auth.mint({ householdId: "_system", caregiverId: "system" });

  // The runner pool needs the listening port, which only exists after app.listen: resolve it lazily.
  const url = () => new URL(`${base}/mcp`);
  let runners: McpRunnerPool | undefined;
  mcpClient = new McpToolClient();
  const orchestrator = new Orchestrator({ llm: new MockLlm(), runner: mcpClient, runnerFor: (bearer) => (runners ??= new McpRunnerPool(url())).forToken(bearer) });
  const { app } = createApp({ tenants: createTenants(root), auth, orchestrator, sseHeartbeatMs: 60 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mcpClient.connect(url(), internal);
  await orchestrator.init();
});
afterAll(async () => { await mcpClient.close(); server.closeAllConnections(); server.close(); });

const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function mcp(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const state = async (token: string) => (await call(token, "GET", "/api/state")).json();
const ledgerOf = (s: any, patient = "leo") => s.patients.find((p: any) => p.profile.id === patient).medication_history as unknown[];

describe("healthz", () => {
  it("is public and states the transport, spec and auth mode without leaking data", async () => {
    const res = await call(undefined, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: "careos-server",
      version: "0.1.0",
      mcp: { endpoint: "/mcp", transport: "streamable-http", spec: "2025-11-25", stateless: true },
      auth: "bearer",
    });
  });
});

describe("bearer authentication", () => {
  it("rejects missing, malformed and unknown credentials on /mcp and /api with a Bearer challenge", async () => {
    for (const path of ["/api/state", "/mcp"]) {
      for (const header of [undefined, "Bearer", "Basic abc", "Bearer wrong-token-value-0000", `Bearer ${TOKEN_A}x`, TOKEN_A]) {
        const res = await fetch(`${base}${path}`, {
          method: path === "/mcp" ? "POST" : "GET",
          headers: { ...(header ? { authorization: header } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: path === "/mcp" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
        });
        expect(res.status, `${path} ${header}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      }
    }
  });

  it("accepts a valid token over MCP and over the REST API", async () => {
    const client = await mcp(TOKEN_A);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    expect((await call(TOKEN_A, "GET", "/api/state")).status).toBe(200);
  });

  it("accepts the scheme case-insensitively (RFC 7235)", async () => {
    const res = await fetch(`${base}/api/state`, { headers: { authorization: `bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
  });

  it("never returns the credential in an error body", async () => {
    const res = await call("wrong-token-value-0000", "GET", "/api/state");
    expect(JSON.stringify(await res.json())).not.toContain("wrong-token");
  });
});

describe("household isolation", () => {
  /** The full two-step flow over MCP: read back, then confirm with the token. */
  async function giveOverMcp(token: string, caregiver: string) {
    const c = await mcp(token);
    const args = { patient_id: "leo", product: "Motrin", caregiver_id: caregiver };
    const readBack = await c.callTool({ name: "confirm_dose_given", arguments: args });
    const done = await c.callTool({ name: "confirm_dose_given", arguments: { ...args, confirmation_token: (readBack.structuredContent as any).confirmation_token } });
    await c.close();
    return { readBack: readBack.structuredContent as any, done: done.structuredContent as any };
  }

  it("a dose logged by household A is invisible to B, and does not lock B", async () => {
    await call(TOKEN_A, "POST", "/api/demo/reset", {});
    await call(TOKEN_B, "POST", "/api/demo/reset", {});

    const { done } = await giveOverMcp(TOKEN_A, "Sarah");
    expect(done).toMatchObject({ status: "LOGGED", replay: false });

    expect(ledgerOf(await state(TOKEN_A))).toHaveLength(1);
    expect(ledgerOf(await state(TOKEN_B))).toHaveLength(0);

    const b = await mcp(TOKEN_B);
    const verdict = await b.callTool({ name: "plan_medication", arguments: { patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" } });
    expect(verdict.structuredContent).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875 }); // B's Leo was never dosed
    await b.close();

    const own = await giveOverMcp(TOKEN_B, "Dad");
    expect(own.done).toMatchObject({ status: "LOGGED", replay: false });
  });

  it("a confirmation token issued to one household is useless in another", async () => {
    await call(TOKEN_A, "POST", "/api/demo/reset", {});
    await call(TOKEN_B, "POST", "/api/demo/reset", {});
    const a = await mcp(TOKEN_A);
    const args = { patient_id: "leo", product: "Motrin", caregiver_id: "Sarah" };
    const token = ((await a.callTool({ name: "confirm_dose_given", arguments: args })).structuredContent as any).confirmation_token as string;
    await a.close();

    const b = await mcp(TOKEN_B);
    const replayed = await b.callTool({ name: "confirm_dose_given", arguments: { ...args, confirmation_token: token } });
    expect(replayed.structuredContent).toMatchObject({ status: "REJECTED_CONFIRMATION" });
    await b.close();
    expect(ledgerOf(await state(TOKEN_B))).toHaveLength(0);
    expect(ledgerOf(await state(TOKEN_A))).toHaveLength(0);
  });

  it("resetting A leaves B's data alone", async () => {
    await call(TOKEN_A, "POST", "/api/demo/reset", {});
    await call(TOKEN_B, "POST", "/api/demo/reset", {});
    await giveOverMcp(TOKEN_A, "Sarah");
    await giveOverMcp(TOKEN_B, "Dad");
    expect(ledgerOf(await state(TOKEN_B))).toHaveLength(1);
    expect((await call(TOKEN_A, "POST", "/api/demo/reset", {})).status).toBe(200);
    expect(ledgerOf(await state(TOKEN_A))).toHaveLength(0);
    expect(ledgerOf(await state(TOKEN_B))).toHaveLength(1);
  });

  it("an LLM turn acts as the caller's household, even with the same session id", async () => {
    await call(TOKEN_A, "POST", "/api/demo/reset", {});
    await call(TOKEN_B, "POST", "/api/demo/reset", {});

    const say = async (token: string, transcript: string) => {
      const res = await call(token, "POST", "/api/converse", { session_id: "shared-session", active_profile: "leo", caregiver: "Sarah (Mom)", transcript });
      expect(res.status).toBe(202);
      const turnId = (await res.json()).turn_id as string;
      for (let i = 0; i < 20; i++) {
        const page = await (await call(token, "GET", `/api/turns/${turnId}/events?after=0&wait=3`)).json();
        if (page.done) return { turnId, events: page.events as { type: string }[] };
      }
      throw new Error("turn did not finish");
    };

    // The same client-chosen session id in two households must not collide ("busy") or share history.
    const [ra, rb] = await Promise.all([call(TOKEN_A, "POST", "/api/converse", { session_id: "shared-session", active_profile: "leo", caregiver: "Sarah (Mom)", transcript: "I gave Leo Motrin" }), call(TOKEN_B, "POST", "/api/converse", { session_id: "shared-session", active_profile: "leo", caregiver: "Sarah (Mom)", transcript: "I gave Leo Motrin" })]);
    expect([ra.status, rb.status]).toEqual([202, 202]);
    const ta = (await ra.json()).turn_id as string;
    const tb = (await rb.json()).turn_id as string;
    for (const [token, id] of [[TOKEN_A, ta], [TOKEN_B, tb]] as const) {
      for (let i = 0; i < 20; i++) if ((await (await call(token, "GET", `/api/turns/${id}/events?after=0&wait=3`)).json()).done) break;
    }
    expect(ledgerOf(await state(TOKEN_A))).toHaveLength(0); // read-back only
    await Promise.all([say(TOKEN_A, "yes"), say(TOKEN_B, "yes")]);

    expect(ledgerOf(await state(TOKEN_A))).toHaveLength(1);
    expect(ledgerOf(await state(TOKEN_B))).toHaveLength(1);

    // Turns belong to the household that started them.
    expect((await call(TOKEN_B, "GET", `/api/turns/${ta}/events?after=0`)).status).toBe(404);
    expect((await call(TOKEN_B, "GET", `/api/turns/${ta}/stream`)).status).toBe(404);
    expect((await call(TOKEN_A, "GET", `/api/turns/${ta}/events?after=0`)).status).toBe(200);
  });

  it("the trace stream only carries the caller's own MCP traffic", async () => {
    await call(TOKEN_A, "POST", "/api/demo/reset", {});
    await call(TOKEN_B, "POST", "/api/demo/reset", {});
    const b = await mcp(TOKEN_B);
    await b.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "frank", symptom: "cough" } });
    await b.close();

    const read = async (token: string) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 400);
      let raw = "";
      try {
        const res = await fetch(`${base}/api/trace`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += new TextDecoder().decode(value);
        }
      } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) throw e;
      }
      return raw;
    };
    const [forB, forA] = [await read(TOKEN_B), await read(TOKEN_A)];
    expect(forB).toContain("query_pantry_remedies");
    expect(forA).not.toContain("query_pantry_remedies");
    expect(forA).not.toContain("hh-b");
  });
});

describe("TokenAuth", () => {
  it("parses token=household:caregiver pairs and lists the households", () => {
    const a = TokenAuth.fromSpec("aaaaaaaaaaaaaaaa=h1:c1,bbbbbbbbbbbbbbbb=h2:c2, cccccccccccccccc=h1:c3");
    expect(a.households().sort()).toEqual(["h1", "h2"]);
    expect(a.authenticate("Bearer cccccccccccccccc")).toEqual({ householdId: "h1", caregiverId: "c3" });
    expect(a.authenticate("Bearer nope")).toBeUndefined();
  });

  it("accepts tokens that contain '=' (base64 padding)", () => {
    const a = TokenAuth.fromSpec("dG9rZW4tdG9rZW4tdG9rZW4=pad==h1:c1");
    expect(a.authenticate("Bearer dG9rZW4tdG9rZW4tdG9rZW4=pad=")).toEqual({ householdId: "h1", caregiverId: "c1" });
  });

  it("rejects short tokens and malformed entries instead of silently weakening auth", () => {
    expect(() => TokenAuth.fromSpec("short=h:c")).toThrow(/shorter than 16/);
    expect(() => TokenAuth.fromSpec("aaaaaaaaaaaaaaaa=onlyhousehold")).toThrow(/token=household:caregiver/);
    expect(() => TokenAuth.fromSpec("aaaaaaaaaaaaaaaa=a:b:c")).toThrow(/token=household:caregiver/);
    expect(() => TokenAuth.fromSpec("noequalsign")).toThrow(/token=household:caregiver/);
    expect(() => TokenAuth.fromSpec(" , ")).toThrow(/no tokens/);
  });

  it("mints distinct internal tokens", () => {
    const a = TokenAuth.fromSpec("aaaaaaaaaaaaaaaa=h1:c1");
    const t1 = a.mint({ householdId: "_system", caregiverId: "system" });
    const t2 = a.mint({ householdId: "_system", caregiverId: "system" });
    expect(t1).not.toBe(t2);
    expect(a.authenticate(`Bearer ${t1}`)?.householdId).toBe("_system");
  });

  it("open mode resolves everyone to the demo household and bearer parsing is strict", () => {
    expect(TokenAuth.open().authenticate(undefined)).toEqual({ householdId: "demo", caregiverId: "sarah" });
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("Bearer  abc def")).toBeUndefined();
    expect(bearerToken("abc")).toBeUndefined();
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
