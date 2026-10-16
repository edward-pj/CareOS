import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeTrace } from "../api/client";
import type { StateResponse, TraceFrame } from "../api/types";

const FALLBACK_POLL_MS = 10_000;
const MAX_FRAMES = 60;

export interface Household {
  data?: StateResponse;
  /** Server clock minus browser clock (ms); countdowns use the server's notion of "now". */
  clockSkewMs: number;
  error?: string;
  /** Bumped on every refresh that changed state, so the dashboard can flash. */
  version: number;
  frames: TraceFrame[];
  liveConnected: boolean;
  refresh: () => Promise<void>;
}

/**
 * Live dashboard state. The server pushes no state events, but every MCP tool call crosses /mcp and is
 * streamed on /api/trace, so a finished tool call triggers an immediate refetch of /api/state. A slow
 * poll is the fallback if the trace stream drops.
 */
export function useHousehold(): Household {
  const [data, setData] = useState<StateResponse>();
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const [frames, setFrames] = useState<TraceFrame[]>([]);
  const [liveConnected, setLive] = useState(false);
  const lastJson = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getState();
      const { now: _now, ...stable } = next;
      const json = JSON.stringify(stable);
      setClockSkewMs(Date.parse(next.now) - Date.now());
      setError(undefined);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setData(next);
        setVersion((v) => v + 1);
      } else {
        setData((d) => (d ? { ...d, now: next.now } : next));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    const unsubscribe = subscribeTrace(
      (frame) => {
        setFrames((prev) => [...prev, frame].slice(-MAX_FRAMES));
        if (frame.dir === "out" && (frame.kind === "result" || frame.kind === "blocked")) {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void refresh(), 120);
        }
      },
      setLive,
    );
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      unsubscribe();
    };
  }, [refresh]);

  return { data, clockSkewMs, error, version, frames, liveConnected, refresh };
}
