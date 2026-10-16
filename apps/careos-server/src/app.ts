import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createCareMcpServer, createSeed, type CareService, type StorageAdapter } from "open-caregiver-mcp";
import { createMcpHttpHandler } from "open-caregiver-mcp/http";
import type { Orchestrator } from "./orchestrator/index.js";
import { openSse } from "./sse.js";
import { TraceBus } from "./trace.js";

export interface AppDeps {
  service: CareService;
  storage: StorageAdapter;
  trace?: TraceBus;
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

const overrideBody = z.object({ patient_id: z.string(), ingredient: z.string(), caregiver: z.string(), pin: z.string().regex(/^\d{4}$/) });
const resetBody = z.object({ sarah_dosed_minutes_ago: z.number().min(0).max(24 * 60).optional() }).default({});

export function createApp(deps: AppDeps): { app: Express; trace: TraceBus } {
  const { service, storage } = deps;
  const trace = deps.trace ?? new TraceBus();
  const heartbeat = deps.sseHeartbeatMs ?? 25_000;
  const mcp = createMcpHttpHandler({ createServer: () => createCareMcpServer(service), onFrame: (f) => trace.push(f) });

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
        "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, last-event-id",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-expose-headers": "mcp-session-id",
      });
      if (req.method === "OPTIONS") { res.sendStatus(204); return; }
      next();
    });
  }

  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

  // MCP over Streamable HTTP (spec 2025-11-25): POST / GET (SSE) / DELETE on one endpoint.
  app.all("/mcp", express.json({ limit: "1mb" }), (req, res, next) => { mcp(req, res, req.body).catch(next); });

  app.get("/api/state", async (_req, res, next) => {
    try {
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

  app.post("/api/demo/reset", express.json(), async (req, res, next) => {
    try {
      const body = resetBody.parse(req.body ?? {});
      await storage.reset(createSeed(service.now(), { sarahDosedMinutesAgo: body.sarah_dosed_minutes_ago }));
      trace.clear();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post("/api/override", express.json(), async (req, res, next) => {
    try {
      res.json(await service.overrideLockout(overrideBody.parse(req.body)));
    } catch (e) { next(e); }
  });

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
    const started = o.start(body);
    if (started === "busy") { res.status(409).json({ error: "turn_in_progress" }); return; }
    res.status(202).json({ turn_id: started.turnId });
  });

  app.get("/api/turns/:id/events", async (req, res) => {
    const o = requireOrchestrator(res);
    if (!o) return;
    const id = String(req.params.id);
    if (!o.turns.has(id)) { res.status(404).json({ error: "unknown_turn" }); return; }
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
    if (!o.turns.has(id)) { res.status(404).json({ error: "unknown_turn" }); return; }
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
    for (const e of trace.since(last)) sse.send("frame", e, e.id);
    const onEvent = (e: unknown) => sse.send("frame", e, (e as { id: number }).id);
    trace.on("event", onEvent);
    res.on("close", () => trace.off("event", onEvent));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "invalid_request", issues: err.issues }); return; }
    if (err instanceof Error && /Unknown patient/.test(err.message)) { res.status(404).json({ error: err.message }); return; }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

  return { app, trace };
}
