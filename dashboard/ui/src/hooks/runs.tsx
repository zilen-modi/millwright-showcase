import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { ApiError, postJson } from '@/lib/api';
import { runFailed } from '@/lib/format';
import type { RunMode } from '@/lib/types';
import { useBoard } from './board';
import { useRunEndEvents } from './stream';
import { ShipGateDialog, type ShipGateBlock } from '@/components/ShipGateDialog';
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';

/**
 * Every state-changing call the panel can make, in one place.
 *
 * The legacy pages did `POST` → `alert()` → `location.reload()`. Here a launch is
 * optimistic: the card flips to "starting…" the instant the button is pressed, clears when
 * the server's own state says the run is live, and turns into a real, dismissible failure
 * if the POST is refused — including the ship gate's 409, whose `reason` sentence is the
 * entire point of the gate and is therefore surfaced verbatim in a dialog of its own.
 */

export interface FailedRun {
  mode: RunMode;
  message: string;
  /** Set only by the ship gate (contract §3). */
  reason: string | null;
  /** `start` — the POST was refused, nothing ran. `run` — the run started and then failed,
   * including the no-op case where it exited 0 without doing any work. */
  phase: 'start' | 'run';
}

export interface RunOptions {
  /** Human notes for a re-plan or a Continue — written server-side to resume-notes.md,
   *  read by whichever stage runs next, never passed to argv. */
  notes?: string;
  /** Contract §3: honoured for manual `ship` only. */
  override?: boolean;
  overrideReason?: string;
  /** Skip the ship confirmation (already confirmed by a dialog). */
  confirmed?: boolean;
  /** Re-plan from the open plan-review comments (server composes the notes; `notes` is extra). */
  planComments?: boolean;
  /** Answers to the planner's questions, by question id - sent with a Continue. */
  answers?: Record<string, string>;
}

interface RunsCtx {
  pending: Record<string, RunMode>;
  failed: Record<string, FailedRun>;
  run: (key: string, mode: RunMode, opts?: RunOptions) => Promise<boolean>;
  cancel: (key: string) => Promise<void>;
  setArchived: (key: string, archived: boolean) => Promise<void>;
  checkMerge: (key: string) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  /** Approve every plan-ready ticket for BUILD; 2 run now, the rest queue and auto-start. */
  buildAllReady: () => Promise<void>;
  /** Toggle continuous auto-build: every ticket reaching plan-ready is built automatically. */
  setAutoBuild: (enabled: boolean) => Promise<void>;
  clearFailed: (key: string) => void;
}

const Ctx = createContext<RunsCtx | null>(null);

const SHIP_WARNING =
  'Manual ship runs `/resolve-ticket --from ship --yes`: it opens a PR and writes to Jira. It never merges.';

export function RunsProvider({ children }: { children: ReactNode }) {
  const { state, refresh } = useBoard();
  const [pending, setPending] = useState<Record<string, RunMode>>({});
  const [failed, setFailed] = useState<Record<string, FailedRun>>({});
  const [gate, setGate] = useState<ShipGateBlock | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // A launch stays "starting…" until the server's own state confirms the run — the
  // optimistic flag is never the source of truth, it only covers the spawn latency.
  useEffect(() => {
    if (!state) return;
    const live = new Set(state.running);
    setPending((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of Object.keys(prev)) {
        if (live.has(key)) { delete next[key]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [state]);

  /* A run that STARTED and then failed is the case the panel used to hide completely: an
   * unresolved slash command exits 0 with a `success` result event, so the card just went quiet
   * as though the stage had passed. The server now sends a real verdict — surface it exactly
   * like a refused launch, and toast it, because nothing else on screen would say otherwise. */
  useRunEndEvents((e) => {
    if (e.status === 'cancelled' || !runFailed(e)) return;
    const mode = e.mode as RunMode;
    const message = e.failure || `exited with code ${e.code}`;
    setFailed((f) => ({ ...f, [e.key]: { mode, message, reason: null, phase: 'run' } }));
    toast.error(`${e.key} — ${mode} failed`, { description: message, duration: 12000 });
  });

  const clearFailed = useCallback((key: string) => {
    setFailed((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const run = useCallback<RunsCtx['run']>(async (key, mode, opts = {}) => {
    if (mode === 'ship' && !opts.confirmed && !opts.override) {
      setConfirm({
        title: `Ship ${key}?`,
        body: SHIP_WARNING,
        confirmLabel: 'Open the PR',
        onConfirm: () => { void run(key, mode, { ...opts, confirmed: true }); },
      });
      return false;
    }

    clearFailed(key);
    setPending((p) => ({ ...p, [key]: mode }));
    try {
      const body: Record<string, unknown> = { key, mode };
      if (opts.notes) body.notes = opts.notes;
      if (opts.planComments) body.planComments = true;
      if (opts.answers) body.answers = opts.answers;
      if (opts.override) {
        body.override = true;
        if (opts.overrideReason) body.overrideReason = opts.overrideReason;
      }
      await postJson('/api/run', body);
      toast.success(`${key} — ${mode} started`, {
        description: opts.override
          ? 'Ship gate overridden. The override is recorded in events.jsonl.'
          : 'Streaming to the Console log.',
      });
      refresh();
      return true;
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const message = e instanceof Error ? e.message : String(e);
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
      setFailed((f) => ({ ...f, [key]: { mode, message, reason: err?.reason ?? null, phase: 'start' } }));
      if (err?.isShipGate) {
        // The gate's sentence IS the outcome — a dialog, never a toast that scrolls away.
        setGate({ key, mode, error: err.message, reason: err.reason as string });
      } else {
        toast.error(`${key} — could not start ${mode}`, { description: message, duration: 8000 });
      }
      return false;
    }
  }, [clearFailed, refresh]);

  const post = useCallback(async (path: string, body: Record<string, unknown>, fail: string) => {
    try {
      const out = await postJson(path, body);
      refresh();
      return out;
    } catch (e) {
      toast.error(fail, { description: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, [refresh]);

  const cancel = useCallback(async (key: string) => {
    const ok = await post('/api/cancel', { key }, `Could not cancel ${key}`);
    if (ok) toast(`${key} — cancelling…`);
  }, [post]);

  const setArchived = useCallback(async (key: string, archived: boolean) => {
    const ok = await post(archived ? '/api/archive' : '/api/unarchive', { key },
      `Could not ${archived ? 'archive' : 'unarchive'} ${key}`);
    if (ok) toast.success(`${key} ${archived ? 'archived' : 'unarchived'}`);
  }, [post]);

  const checkMerge = useCallback(async (key: string) => {
    const r = await post('/api/check-merge', { key }, `Merge check failed for ${key}`) as
      { state?: string; failure?: string; detail?: string; prRef?: string } | null;
    if (!r) return;
    if (r.state === 'MERGED') toast.success(`${key} merged`, { description: 'Moved to Archived.' });
    else if (r.state === 'unverified') {
      // Blaming gh for every failure sent us hunting a PATH problem when the real cause was a
      // PR recorded as a bare number that could not be resolved to a repo. Say what happened.
      const because = r.failure === 'no-pr-ref'
        ? `${r.detail ?? 'the recorded PR reference is unusable'} — fix the PR link on the ticket.`
        : r.failure === 'gh-missing'
          ? `${r.detail ?? 'the gh CLI is unreachable'} — nothing was assumed.`
          : `gh could not answer: ${r.detail ?? 'unknown error'}`;
      toast.warning(`${key} — merge state unverified`, { description: because });
    } else toast(`${key} — PR is ${r.state}`, { description: 'Not merged yet.' });
  }, [post]);

  const setPaused = useCallback(async (paused: boolean) => {
    const doIt = async () => {
      const ok = await post('/api/pause', { paused }, 'Could not change the pause state');
      if (ok) {
        if (paused) toast.warning('Millwright paused', { description: 'Active runs cancelled; new runs blocked.' });
        else toast.success('Millwright resumed');
      }
    };
    if (paused) {
      setConfirm({
        title: 'Pause Millwright?',
        body: 'Every active run is cancelled and new runs are blocked until you resume.',
        confirmLabel: 'Pause',
        destructive: true,
        onConfirm: () => { void doIt(); },
      });
      return;
    }
    await doIt();
  }, [post]);

  const buildAllReady = useCallback(async () => {
    const r = await post('/api/build-all', {}, 'Could not start bulk build') as
      { accepted: number; started: string[]; queued: string[]; skipped: { key: string; reason: string }[] } | null;
    if (!r) return;
    if (r.accepted === 0) {
      toast('Nothing to build', { description: 'No plan-ready tickets are eligible right now.' });
      return;
    }
    const parts = [`${r.started.length} started`];
    if (r.queued.length) parts.push(`${r.queued.length} queued`);
    toast.success(`Building ${r.accepted} ticket(s)`, {
      description: parts.join(' · ') + (r.skipped.length ? ` · ${r.skipped.length} skipped` : ''),
    });
  }, [post]);

  const setAutoBuild = useCallback(async (enabled: boolean) => {
    const ok = await post('/api/auto-build', { enabled }, 'Could not change auto-build');
    if (ok) {
      if (enabled) toast.success('Auto-build on', { description: 'Every plan-ready ticket now builds automatically, 2 at a time.' });
      else toast('Auto-build off', { description: 'Plan-ready tickets wait at the gate again.' });
    }
  }, [post]);

  const value = useMemo(
    () => ({ pending, failed, run, cancel, setArchived, checkMerge, setPaused, buildAllReady, setAutoBuild, clearFailed }),
    [pending, failed, run, cancel, setArchived, checkMerge, setPaused, buildAllReady, setAutoBuild, clearFailed],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ShipGateDialog
        block={gate}
        onDismiss={() => setGate(null)}
        onOverride={(reason) => {
          const key = gate?.key;
          setGate(null);
          if (key) void run(key, 'ship', { override: true, overrideReason: reason });
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Ctx.Provider>
  );
}

export function useRuns() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRuns must be used inside <RunsProvider>');
  return v;
}
