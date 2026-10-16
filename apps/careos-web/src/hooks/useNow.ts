import { useEffect, useState } from "react";

/** Server-aligned "now" in epoch ms, ticking once a second. */
export function useNow(clockSkewMs: number): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return tick + clockSkewMs;
}
