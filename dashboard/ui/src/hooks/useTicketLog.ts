import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { runEndLine } from '@/lib/format';
import { useLogEvents, useRunEndEvents } from './stream';

/**
 * One ticket's run log: the tail on disk (`/api/log`) followed by live SSE lines.
 *
 * The legacy pages kept a module-level `Map<key, lines[]>` alive across full re-renders and
 * appended into the DOM by hand. Here the history load and the live append are the same
 * piece of state, scoped to whichever component is showing it.
 */
export function useTicketLog(key: string | null, enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!key || !enabled) { setLines([]); return; }
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true);
    api.log(key, ctrl.signal)
      .then((d) => { if (alive && d.key === key) setLines(d.lines || []); })
      .catch(() => { if (alive) setLines([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [key, enabled]);

  useLogEvents((e) => {
    if (!enabled || e.key !== key) return;
    setLines((prev) => [...prev, e.line]);
  });

  useRunEndEvents((e) => {
    if (!enabled || e.key !== key) return;
    setLines((prev) => [...prev, runEndLine(e)]);
  });

  return { lines, loading };
}
