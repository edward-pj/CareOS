import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Health, InspectResponse } from "../api/types";

/** Read-only stored data for the Data Inspector. Refetches when `refreshKey` changes, but only while the tab is open. */
export function useInspect(active: boolean, refreshKey: number): { data?: InspectResponse; error?: string } {
  const [data, setData] = useState<InspectResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.getInspect().then(
      (d) => { if (live) { setData(d); setError(undefined); } },
      (e) => { if (live) setError(e instanceof Error ? e.message : "Could not load stored data"); },
    );
    return () => { live = false; };
  }, [active, refreshKey]);
  return { data, error };
}

/** What the server says about itself (transport, spec, statelessness): the facts the MCP Inspector banner shows. */
export function useHealth(): Health | undefined {
  const [health, setHealth] = useState<Health>();
  useEffect(() => {
    let live = true;
    api.getHealth().then((h) => { if (live) setHealth(h); }, () => { /* the banner just stays generic */ });
    return () => { live = false; };
  }, []);
  return health;
}
