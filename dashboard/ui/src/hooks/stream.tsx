import {
  createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

/**
 * One EventSource for the whole app.
 *
 * The legacy pages each opened their own `/api/stream` connection and each hand-managed
 * the "live / reconnecting" chrome. Here a single connection fans out to every subscriber:
 *   - `state` bumps `stateTick`, which every resource hook watches and refetches on
 *   - `log` / `run-end` are delivered to imperative subscribers (log panes, run tracking)
 */

export interface LogEvent { key: string; mode: string; line: string }

/**
 * `code` is NOT the verdict: a run whose slash command didn't resolve exits 0 having done
 * nothing at all. `status`/`ok`/`failure` come from the server's evidence-based check
 * (dashboard/run-outcome-lib.mjs) and are what the UI should believe. They are optional only
 * so a frame from an older server still renders instead of crashing the stream.
 */
export interface RunEndEvent {
  key: string;
  mode: string;
  code: number;
  ok?: boolean;
  status?: 'success' | 'failed' | 'cancelled' | 'needs-input';
  failure?: string | null;
}

type Handlers = {
  log: Set<(e: LogEvent) => void>;
  'run-end': Set<(e: RunEndEvent) => void>;
};

interface StreamCtx {
  connected: boolean;
  /** Increments on every server-pushed `state` event. */
  stateTick: number;
  handlers: Handlers;
}

const Ctx = createContext<StreamCtx | null>(null);

export function StreamProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [stateTick, setStateTick] = useState(0);
  const handlers = useRef<Handlers>({ log: new Set(), 'run-end': new Set() });

  useEffect(() => {
    const es = new EventSource('/api/stream');
    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    const onState = () => { setConnected(true); setStateTick((n) => n + 1); };
    const onLog = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as LogEvent;
        handlers.current.log.forEach((fn) => fn(d));
      } catch { /* malformed frame — drop it rather than break the stream */ }
    };
    const onRunEnd = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as RunEndEvent;
        handlers.current['run-end'].forEach((fn) => fn(d));
      } catch { /* as above */ }
    };
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('state', onState);
    es.addEventListener('log', onLog);
    es.addEventListener('run-end', onRunEnd);
    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('state', onState);
      es.removeEventListener('log', onLog);
      es.removeEventListener('run-end', onRunEnd);
      es.close();
    };
  }, []);

  const value = useMemo(
    () => ({ connected, stateTick, handlers: handlers.current }),
    [connected, stateTick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useStream() {
  const v = useContext(Ctx);
  if (!v) throw new Error('stream hooks must be used inside <StreamProvider>');
  return v;
}

export function useStreamStatus() {
  const { connected } = useStream();
  return connected;
}

export function useStateTick() {
  return useStream().stateTick;
}

export function useLogEvents(fn: (e: LogEvent) => void) {
  const { handlers } = useStream();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const wrapped = (e: LogEvent) => ref.current(e);
    handlers.log.add(wrapped);
    return () => { handlers.log.delete(wrapped); };
  }, [handlers]);
}

export function useRunEndEvents(fn: (e: RunEndEvent) => void) {
  const { handlers } = useStream();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const wrapped = (e: RunEndEvent) => ref.current(e);
    handlers['run-end'].add(wrapped);
    return () => { handlers['run-end'].delete(wrapped); };
  }, [handlers]);
}
