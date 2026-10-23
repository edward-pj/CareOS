import express, { type Express, type Response } from "express";
import { z } from "zod";
import type { AuthContext } from "../auth.js";
import type { TenantResolver } from "../tenants.js";
import { MAX_UPLOAD_BYTES, type UploadStore } from "../uploads.js";

interface Deps {
  tenants: TenantResolver;
  uploads: UploadStore;
  who: (res: Response) => AuthContext;
}

const photoBody = z.object({ upload_id: z.string().min(1).max(64), patient_id: z.string().min(1).max(32).optional() });
const confirmBody = z.object({
  drug: z.string().max(120).optional(),
  strength: z.string().max(60).optional(),
  frequency: z.string().max(80).optional(),
  prescriber: z.string().max(80).optional(),
}).default({});
const hoursQuery = z.coerce.number().min(1).max(168).default(48);

/** Photos, prescriptions and the doctor's PDF: the on-screen buttons call these directly, so a tap never depends on a model. */
export function registerCareRoutes(app: Express, { tenants, uploads, who }: Deps) {
  const svc = (res: Response) => tenants(who(res).householdId).service;
  const ctx = (res: Response) => ({ caregiverId: who(res).caregiverId });

  // Raw image bytes. The type is sniffed from the bytes, not taken from the header.
  app.post("/api/uploads", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
    const r = uploads.put(who(res).householdId, body);
    if ("error" in r) {
      const status = r.error === "too_large" ? 413 : r.error === "too_many" ? 429 : 400;
      res.status(status).json({ error: r.error });
      return;
    }
    res.status(201).json({ upload_id: r.id, mime: r.mime, bytes: body.length, expires_in_seconds: 600 });
  });

  app.post("/api/photos/prescription", express.json({ limit: "4kb" }), async (req, res, next) => {
    try {
      const b = photoBody.parse(req.body);
      res.json(await svc(res).prescriptions.manage({ action: "ingest", patient_id: b.patient_id, upload_id: b.upload_id }, ctx(res)));
    } catch (e) { next(e); }
  });

  app.post("/api/photos/label", express.json({ limit: "4kb" }), async (req, res, next) => {
    try {
      const b = photoBody.parse(req.body);
      res.json(await svc(res).prescriptions.readBottleLabel({ upload_id: b.upload_id, patient_id: b.patient_id }, ctx(res)));
    } catch (e) { next(e); }
  });

  app.post("/api/prescriptions/:id/confirm", express.json({ limit: "4kb" }), async (req, res, next) => {
    try {
      const b = confirmBody.parse(req.body ?? {});
      res.json(await svc(res).prescriptions.manage({ action: "confirm", rx_id: String(req.params.id), ...b }, ctx(res)));
    } catch (e) { next(e); }
  });

  app.post("/api/prescriptions/:id/reject", async (req, res, next) => {
    try { res.json(await svc(res).prescriptions.manage({ action: "reject", rx_id: String(req.params.id) }, ctx(res))); } catch (e) { next(e); }
  });

  app.get("/api/patients/:id/dossier.pdf", async (req, res, next) => {
    try {
      const hours = hoursQuery.parse(req.query.hours ?? 48);
      const { bytes, filename } = await svc(res).escalation.dossierPdf(String(req.params.id), hours);
      res.status(200).set({ "content-type": "application/pdf", "content-disposition": `inline; filename="${filename}"`, "cache-control": "no-store", "content-length": String(bytes.length) }).end(Buffer.from(bytes));
    } catch (e) { next(e); }
  });
}
