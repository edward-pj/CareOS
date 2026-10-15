import {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '../api/client';
import type {StateResponse} from '../api/types';
import {STATE_POLL_MS} from '../config';

export interface HouseholdState {
  data?: StateResponse;
  /** Server clock minus device clock (ms); countdowns use the server's notion of "now". */
  clockSkewMs: number;
  error?: string;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useHouseholdState(): HouseholdState {
  const [data, setData] = useState<StateResponse>();
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getState();
      if (!mounted.current) {
        return;
      }
      setData(next);
      setClockSkewMs(Date.parse(next.now) - Date.now());
      setError(undefined);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), STATE_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return {data, clockSkewMs, error, loading, refresh};
}
