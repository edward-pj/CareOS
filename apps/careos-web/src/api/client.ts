import { TURN_EVENT_TYPES, type ConverseRequest, type OverrideRequest, type StateResponse, type TraceFrame, type TurnEvent } from "./types";

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
  resetDemo: (sarahDosedMinutesAgo?: number) =>
    request<{ ok: true }>("POST", "/api/demo/reset", sarahDosedMinutesAgo === undefined ? {} : { sarah_dosed_minutes_ago: sarahDosedMinutesAgo }),
  converse: (body: ConverseRequest) => request<{ turn_id: string }>("POST", "/api/converse", body),
  override: (body: OverrideRequest) => request<{ status: string; reason?: string }>("POST", "/api/override", body),
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
  es.onerror = () => {
    if (finished) return;
    finish();
    onFail(new Error("Lost connection to the CareOS server."));
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
