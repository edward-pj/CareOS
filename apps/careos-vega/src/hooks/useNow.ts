import {useEffect, useState} from 'react';

/** Ticks once a second so countdowns re-render; a single timer per consumer, cleaned up on unmount. */
export function useNow(skewMs: number): number {
  const [now, setNow] = useState(() => Date.now() + skewMs);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skewMs), 1000);
    return () => clearInterval(id);
  }, [skewMs]);
  return now;
}
