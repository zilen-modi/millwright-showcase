import { useCallback, useEffect, useRef, useState } from 'react';
import { useStateTick } from './stream';

interface Resource<T> {
  data: T | null;
  error: string | null;
  /** True only for the first load — a live refresh never blanks the screen. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch a JSON resource once, then again on every server-pushed `state` event.
 * Keeps the previous data while refetching, so live updates don't flash empty.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualTick, setManualTick] = useState(0);
  const tick = useStateTick();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    fetcherRef.current(ctrl.signal)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive || ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, manualTick, ...deps]);

  const refresh = useCallback(() => setManualTick((n) => n + 1), []);
  return { data, error, loading, refresh };
}
