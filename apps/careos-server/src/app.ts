import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createCareMcpServer, createSeed } from "open-caregiver-mcp";
import { createMcpHttpHandler } from "open-caregiver-mcp/http";
import { requireAuth, TokenAuth, type AuthContext } from "./auth.js";
import type { Orchestrator } from "./orchestrator/index.js";
import { registerCareRoutes } from "./routes/care.js";
import { registerShopRoutes } from "./routes/shop.js";
import { UploadStore } from "./uploads.js";
import { ShopBus } from "./shop.js";
import { openSse } from "./sse.js";
import type { TenantResolver } from "./tenants.js";
import { TraceBus } from "./trace.js";

export const SERVER_NAME = "careos-server";
export const SERVER_VERSION = "0.1.0";
export const MCP_SPEC = "2025-11-25";

export interface AppDeps {
  /** Resolves a household to its scoped service + storage. */
  tenants: TenantResolver;
  /** Name of the storage backend, shown in the Data Inspector so judges can see the data is real ("memory", "supabase", "dynamo"). */
  backend?: string;
  /** Bearer auth for /mcp and /api. Defaults to open mode (everything is the demo household): tests and local dev only. */
  auth?: TokenAuth;
  trace?: TraceBus;
  /** Live shopping changes. Create it first and pass the same bus to createTenants so service events reach it. */
  shopBus?: ShopBus;
  /** Where photos wait to be read. Share the same store with createTenants so a tenant can read what the route stored. */
  uploads?: UploadStore;
  orchestrator?: Orchestrator;
  allowedOrigin?: string;
  sseHeartbeatMs?: number;
}

const converseBody = z.object({
  session_id: z.string().min(1).max(64),
  active_profile: z.string().min(1).max(32),
  caregiver: z.string().min(1).max(64),
  transcript: z.string().trim().min(1).max(500),
});
const MAX_LONG_POLL_S = 25;

const resetBody = z.object({ sarah_dosed_minutes_ago: z.number().min(0).max(24 * 60).optional() }).default({});

export function createApp(deps: AppDeps): { app: Express; trace: TraceBus } {
  const { tenants } = deps;
  const auth = deps.auth ?? TokenAuth.open();
  const trace = deps.trace ?? new TraceBus();
  const shopBus = deps.shopBus ?? new ShopBus();
  const uploads = deps.uploads ?? new UploadStore();
  const heartbeat = deps.sseHeartbeatMs ?? 25_000;
  // Stateless Streamable HTTP: each request builds a server bound to the caller's household.
  const mcp = createMcpHttpHandler<AuthContext>({
    createServer: (ctx) => createCareMcpServer(tenants(ctx.householdId).service, { caregiverId: ctx.caregiverId }),
    onFrame: (f) => trace.push(f),
  });
  const who = (res: Response): AuthContext => res.locals.auth;

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // The web app reaches this server through the Vite dev proxy (same origin), so CORS is opt-in:
  // set ALLOWED_ORIGIN only for browser tools such as the MCP Inspector.
  if (deps.allowedOrigin) {
    const origin = deps.allowedOrigin;
    app.use((req, res, next) => {
      res.set({
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, last-event-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      if (req.method === "OPTIONS") { res.sendStatus(204); return; }
      next();
    });
  }

  // Public on purpose: version and transport facts for judges and uptime checks. Reveals no household data.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, mcp: { endpoint: "/mcp", transport: "streamable-http", spec: MCP_SPEC, stateless: true }, auth: auth.mode === "bearer" ? "bearer" : "open-loopback" });
  });

  // MCP over Streamable HTTP, stateless: POST only (GET/DELETE answer 405), bearer-authenticated.
  app.all("/mcp", requireAuth(auth), express.json({ limit: "1mb" }), (req, res, next) => { mcp(req, res, req.body, who(res)).catch(next); });

  app.use("/api", requireAuth(auth));

  app.get("/api/state", async (_req, res, next) => {
    try {
      const { service, storage } = tenants(who(res).householdId);
      const patients = await storage.listPatients();
      const snapshots = await Promise.all(patients.map((p) => service.patientSnapshot(p.id)));
      res.json({
        now: new Date(service.now()).toISOString(),
        patients: snapshots,
        caregivers: await storage.getCaregivers(),
        inventory: await storage.getInventory(),
      });
    } catch (e) { next(e); }
  });

  // Read-only view of what is actually stored for this household: the ledger, audit trail, observations and remembered advice.
  app.get("/api/inspect", async (_req, res, next) => {
    try {
      const { householdId } = who(res);
      const { storage } = tenants(householdId);
      const patients = await storage.listPatients();
      const [audit, advice, ledgers, observations, episodes, prescriptions] = await Promise.all([
        storage.getAudit(50),
        storage.getAdvice(),
        Promise.all(patients.map((p) => storage.getLedger(p.id))),
        Promise.all(patients.map((p) => storage.getObservations(p.id))),
        storage.getEpisodes(),
        storage.getPrescriptions(),
      ]);
      res.json({
        backend: deps.backend ?? "memory",
        household_id: householdId,
        ledger: ledgers.flat().sort((a, b) => b.at - a.at).slice(0, 50),
        observations: observations.flat().sort((a, b) => b.at - a.at).slice(0, 50),
        audit,
        advice,
        episodes,
        prescriptions,
      });
    } catch (e) { next(e); }
  });

  app.post("/api/demo/reset", express.json(), async (req, res, next) => {
    try {
      const body = resetBody.parse(req.body ?? {});
      const { service, storage } = tenants(who(res).householdId);
      await storage.reset(createSeed(service.now(), { sarahDosedMinutesAgo: body.sarah_dosed_minutes_ago }));
      trace.clear(who(res).householdId);
      service.shop.announce("Demo data was reset", "Demo");
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  registerShopRoutes(app, { tenants, bus: shopBus, heartbeatMs: heartbeat, who });
  registerCareRoutes(app, { tenants, uploads, who });

  // ---- conversation: POST starts a turn; events are read over SSE (the web app) or by cursor long-poll (plain request/response clients).
  const orchestrator = deps.orchestrator;
  const requireOrchestrator = (res: Response): Orchestrator | undefined => {
    if (!orchestrator || !orchestrator.isReady) { res.status(503).json({ error: "orchestrator_unavailable" }); return undefined; }
    return orchestrator;
  };

  app.post("/api/converse", express.json({ limit: "16kb" }), (req, res) => {
    const o = requireOrchestrator(res);
    if (!o) return;
    const body = converseBody.parse(req.body);
    const started = o.start(body, { householdId: who(res).householdId, bearer: res.locals.bearer });
    if (started === "busy") { res.status(409).json({ error: "turn_in_progress" }); return; }
    res.status(202).json({ turn_id: started.turnId });
  });

  app.get("/api/turns/:id/events", async (req, res) => {
    const o = requireOrchestrator(res);
    if (!o) return;
    const id = String(req.params.id);
    if (!o.turns.has(id, who(res).householdId)) { res.status(404).json({ error: "unknown_turn" }); return; }
    const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)) || 0);
    const waitS = Math.min(MAX_LONG_POLL_S, Math.max(0, Number(req.query.wait ?? 0) || 0));
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    if (waitS > 0) await o.turns.wait(id, after, waitS * 1000, ac.signal);
    if (ac.signal.aborted) return;
    const r = o.turns.after(id, after)!;
    res.json({ events: r.events, done: r.done, next: after + r.events.length });
  });

  app.get("/api/turns/:id/stream", async (req, res) => {
    const o = requireOrchestrator(res);
    if (!o) return;
    const id = String(req.params.id);
    if (!o.turns.has(id, who(res).householdId)) { res.status(404).json({ error: "unknown_turn" }); return; }
    const sse = openSse(req, res, heartbeat);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    let sent = Math.max(0, Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0);
    for (;;) {
      const r = o.turns.after(id, sent);
      if (!r) { sse.close(); return; }
      for (const e of r.events) { sse.send(e.type, e.data, e.seq); sent = e.seq; }
      if (r.done) { sse.close(); return; }
      if (sse.closed || ac.signal.aborted) return;
      await o.turns.wait(id, sent, heartbeat, ac.signal);
    }
  });

  app.get("/api/trace", (req, res) => {
    const sse = openSse(req, res, heartbeat);
    // Resume support: clients resend Last-Event-ID (or ?since=) on reconnect.
    const last = Number(req.headers["last-event-id"] ?? req.query.since ?? 0) || 0;
    const hid = who(res).householdId;
    for (const e of trace.since(hid, last)) sse.send("frame", e, e.id);
    const onEvent = (e: { id: number; householdId: string }) => { if (e.householdId === hid) sse.send("frame", e, e.id); };
    trace.on("event", onEvent);
    res.on("close", () => trace.off("event", onEvent));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "invalid_request", issues: err.issues }); return; }
    // Body-parser failures carry their own status (413 too large, 400 malformed): pass those through rather than calling them a server fault.
    const st = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (typeof st === "number" && st >= 400 && st < 500) { res.status(st).json({ error: st === 413 ? "too_large" : "bad_request" }); return; }
    if (err instanceof Error && /Unknown patient/.test(err.message)) { res.status(404).json({ error: err.message }); return; }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

  return { app, trace };
}
