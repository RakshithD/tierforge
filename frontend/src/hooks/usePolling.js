// Generic polling hook used by pages and tables to keep job data fresh without manual refetching.

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Calls `fn` immediately and then every `intervalMs` until `stopWhen(data)` is true.
 * Pass `enabled: false` to skip fetching and polling entirely.
 * Each effect run owns its own `cancelled` flag, so a response from a superseded run
 * can never update state or schedule a second timer chain.
 * Returns { data, error, loading, refresh }.
 */
export function usePolling(fn, intervalMs, stopWhen = () => false, deps = [], { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const fnRef = useRef(fn);
  const stopRef = useRef(stopWhen);
  fnRef.current = fn;
  stopRef.current = stopWhen;
  const runRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      runRef.current = null;
      return undefined;
    }
    let cancelled = false;
    let timer = null;

    // One poll cycle: fetch, store the result, then schedule the next tick unless stopWhen says done.
    // A 404 also stops polling, since the resource does not exist.
    const tick = async () => {
      clearTimeout(timer);
      let done = false;
      try {
        const result = await fnRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
        done = stopRef.current(result);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        done = err.status === 404;
      }
      if (cancelled) return;
      setLoading(false);
      if (!done) timer = setTimeout(tick, intervalMs);
    };

    runRef.current = tick;
    setLoading(true);
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);

  // Trigger an immediate poll (e.g. after the user runs scoring).
  const refresh = useCallback(() => runRef.current?.(), []);

  return { data, error, loading, refresh };
}
