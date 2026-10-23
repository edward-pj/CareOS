import { TURN_EVENT_TYPES, type ConverseRequest, type Health, type InspectResponse, type ShopEvent, type ShopScenario, type ShopView, type StateResponse, type TraceFrame, type TurnEvent } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export const UNREACHABLE = "Cannot reach the CareOS server. Is `pnpm dev:server` running?";

/**
 * A real server error is JSON (`{"error": ...}`). When the upstream is down, the Vite dev proxy (or any gateway)
 * answers 5xx with an empty or text body, which `fetch` does not throw on, so it is treated as "unreachable".
 */
export function isGatewayFailure(status: number, body: string): boolean {
  return status >= 500 && !/^\s*\{/.test(body);
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(UNREACHABLE);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isGatewayFailure(res.status, body)) throw new ApiError(UNREACHABLE, res.status);
    throw new ApiError(`${method} ${path} failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  getState: () => request<StateResponse>("GET", "/api/state"),
  getInspect: () => request<InspectResponse>("GET", "/api/inspect"),
  getHealth: () => request<Health>("GET", "/healthz"),
  resetDemo: (sarahDosedMinutesAgo?: number) =>
    request<{ ok: true }>("POST", "/api/demo/reset", sarahDosedMinutesAgo === undefined ? {} : { sarah_dosed_minutes_ago: sarahDosedMinutesAgo }),
  getShop: () => request<ShopView>("GET", "/api/shop"),
  shopAdd: (itemName: string) => request<{ status: string }>("POST", "/api/shop/cart", { items: [{ item_name: itemName }] }),
  shopOrder: (cartId: string) => request<{ status: string }>("POST", `/api/shop/carts/${encodeURIComponent(cartId)}/order`),
  shopCancel: (cartId: string) => request<{ status: string; speech?: string }>("POST", `/api/shop/carts/${encodeURIComponent(cartId)}/cancel`),
  shopScenario: (scenario: ShopScenario) => request<unknown>("POST", `/api/demo/shop/${scenario}`),
  /** Sends raw image bytes. The server checks the bytes, not the type we claim. */
  uploadPhoto: async (file: Blob): Promise<{ upload_id: string; mime: string }> => {
    let res: Response;
    try { res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file }); } catch { throw new ApiError(UNREACHABLE); }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(e.error === "not_an_image" ? "That file isn't a photo I can read." : e.error === "too_large" ? "That photo is too large. Try a smaller one." : `Upload failed (${res.status})`, res.status);
    }
    return (await res.json()) as { upload_id: string; mime: string };
  },
  readPrescriptionPhoto: (uploadId: string, patientId: string) => request<Record<string, unknown>>("POST", "/api/photos/prescription", { upload_id: uploadId, patient_id: patientId }),
  readLabelPhoto: (uploadId: string, patientId: string) => request<Record<string, unknown>>("POST", "/api/photos/label", { upload_id: uploadId, patient_id: patientId }),
  confirmRx: (id: string, fields: { drug?: string; strength?: string; frequency?: string; prescriber?: string }) => request<Record<string, unknown>>("POST", `/api/prescriptions/${encodeURIComponent(id)}/confirm`, fields),
  rejectRx: (id: string) => request<Record<string, unknown>>("POST", `/api/prescriptions/${encodeURIComponent(id)}/reject`),
  converse: (body: ConverseRequest) => request<{ turn_id: string }>("POST", "/api/converse", body),
};

/**
 * Follows one turn over SSE.
 * Returns a cancel function. `onFail` fires only if the stream drops before `done`.
 */
export function followTurn(turnId: string, onEvent: (e: TurnEvent) => void, onFail: (e: Error) => void): () => void {
  const es = new EventSource(`/api/turns/${turnId}/stream`);
  let finished = false;
  const finish = () => {
    finished = true;
    es.close();
  };
  for (const type of TURN_EVENT_TYPES) {
    es.addEventListener(type, (m) => {
      const msg = m as MessageEvent<string>;
      onEvent({ seq: Number(msg.lastEventId) || 0, type, data: JSON.parse(msg.data) } as TurnEvent);
      if (type === "done") finish();
    });
  }
  // EventSource reconnects by itself and resumes from Last-Event-ID, so a proxy idle-timeout or a server restart is not
  // fatal. Give up only when the browser has stopped retrying, or after several failed attempts in a row.
  let failures = 0;
  es.onopen = () => { failures = 0; };
  es.onerror = () => {
    if (finished) return;
    failures += 1;
    if (es.readyState === EventSource.CLOSED || failures >= 5) {
      finish();
      onFail(new Error("Lost connection to the CareOS server."));
    }
  };
  return finish;
}

/** Live MCP wire frames (GET /api/trace). EventSource reconnects on its own and resumes via Last-Event-ID. */
export function subscribeTrace(onFrame: (f: TraceFrame) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource("/api/trace");
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.addEventListener("frame", (m) => onFrame(JSON.parse((m as MessageEvent<string>).data) as TraceFrame));
  return () => es.close();
}

/** Live shopping changes (GET /api/shop/stream). EventSource reconnects by itself; `onStatus` drives the LIVE indicator. */
export function subscribeShop(onEvent: (e: ShopEvent) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource("/api/shop/stream");
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.addEventListener("shop", (m) => onEvent(JSON.parse((m as MessageEvent<string>).data) as ShopEvent));
  return () => es.close();
}
