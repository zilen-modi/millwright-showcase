import { useCallback, useEffect, useMemo, useState } from 'react';
import { availableActions } from '../lib/ticketActions';
import { AlertCircle, GitPullRequest, Hammer, Pause, Play, RefreshCw, ScanLine } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { Launcher } from '@/components/Launcher';
import { LogView } from '@/components/LogView';
import { PlanGate } from '@/components/PlanGate';
import { useBoard } from '@/hooks/board';
import { useRuns } from '@/hooks/runs';
import { useResource } from '@/hooks/useResource';
import { useTicketLog } from '@/hooks/useTicketLog';
import { api, postJson } from '@/lib/api';
import { clock, duration, JIRA_BASE, money, tokens } from '@/lib/format';
import { phaseStyle, STAGE_ORDER } from '@/lib/phase';
import type { Automation, TicketCard, TicketDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

type StepState = 'done' | 'active' | 'current' | 'blocked' | 'pending';

function isWorked(t: TicketCard) {
  return t.running || t.blocked || t.planReady || !!t.phase || !!t.costUsd;
}
function rank(t: TicketCard) {
  if (t.running) return 0;
  if (t.blocked) return 1;
  if (t.planReady) return 2;
  if (t.column === 'archived') return 5;
  return 3;
}

export function Console() {
  const { state } = useBoard();
  const [focus, setFocus] = useState<string | null>(null);
  const [tab, setTab] = useState('log');

  const runs = useMemo(() => {
    const tickets = (state?.tickets || []).filter(isWorked);
    return [...tickets].sort(
      (a, b) => rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    );
  }, [state]);

  // Follow whatever the server says is running when nothing has been picked yet, so the
  // logger is useful the moment the page opens.
  useEffect(() => {
    if (focus === null && state?.running.length) setFocus(state.running[0]);
  }, [focus, state]);

  const nRunning = runs.filter((t) => t.running).length;
  const nBlocked = runs.filter((t) => t.blocked).length;

  return (
    <>
      <Launcher autoFocus />
      {state?.automation ? <AutomationBar automation={state.automation} tickets={state.tickets} running={state.running} /> : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <span className="text-xs text-muted">
            {runs.length} active · {nRunning} running · {nBlocked} blocked
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2.5">
          {runs.length === 0 && !(state?.queue || []).length ? (
            <p className="m-0 text-[13px] text-muted">No runs yet — start one above.</p>
          ) : null}
          {runs.map((t) => (
            <RunRow
              key={t.key}
              ticket={t}
              focused={focus === t.key}
              onFocus={(nextTab) => { setFocus(t.key); if (nextTab) setTab(nextTab); }}
            />
          ))}
          {(state?.queue || []).map((q) => <QueuedRow key={q.key} ticketKey={q.key} />)}
        </CardBody>
      </Card>

      <Logger ticketKey={focus} tab={tab} onTabChange={setTab} />
    </>
  );
}

// ---- automation bar ----

function AutomationBar({
  automation,
  tickets,
  running,
}: {
  automation: Automation;
  tickets: TicketCard[];
  running: string[];
}) {
  const { setPaused, run, buildAllReady, setAutoBuild } = useRuns();
  const { refresh } = useBoard();
  const [interval, setIntervalValue] = useState(String(automation.cron.intervalMinutes));
  const [scanning, setScanning] = useState(false);

  useEffect(() => { setIntervalValue(String(automation.cron.intervalMinutes)); }, [automation.cron.intervalMinutes]);

  const patchCron = useCallback(async (body: Record<string, unknown>) => {
    try {
      await postJson('/api/cron', body);
      refresh();
    } catch (e) {
      toast.error('Could not update the scan schedule', { description: e instanceof Error ? e.message : String(e) });
    }
  }, [refresh]);

  const scanNow = useCallback(async () => {
    setScanning(true);
    try {
      const r = await postJson<{ scanned: number; error: string | null }>('/api/queue-run', {});
      if (r.error) toast.error('Queue scan failed', { description: r.error });
      else toast.success(`Queue scanned — ${r.scanned} labelled ticket(s)`);
      refresh();
    } catch (e) {
      toast.error('Queue scan failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const tracked = new Set(tickets.map((t) => t.key));
  const active = new Set(running);
  // The scan returns every key its JQL matched; a key we already have a ticket folder for is
  // on the board, not waiting. The badge used to show the raw scan total while this filtered
  // list rendered below it — so "2 waiting" sat above an empty list with no way to act on it.
  // Both now count the same set, and the difference is shown rather than silently dropped.
  const pending = (automation.pending || []).filter((k) => !tracked.has(k) && !active.has(k));
  const alreadyTracked = Math.max(0, (automation.pendingCount ?? 0) - pending.length);
  // Plan-ready tickets not already building/queued — the exact set "Build all ready" will act on.
  const planReadyKeys = tickets.filter((t) => t.planReady && !t.running && !t.queuedForBuild).map((t) => t.key);
  const [buildingAll, setBuildingAll] = useState(false);
  const buildAll = useCallback(async () => {
    setBuildingAll(true);
    try { await buildAllReady(); } finally { setBuildingAll(false); }
  }, [buildAllReady]);

  const status = automation.cron.scanning
    ? 'scanning…'
    : automation.cron.lastScanAt
      ? `last ${clock(automation.cron.lastScanAt)}${automation.cron.nextRunAt ? ` · next ${clock(automation.cron.nextRunAt)}` : ''}`
      : 'not scanned yet';

  return (
    <div className="mt-3">
      {automation.paused ? (
        <p
          role="status"
          className="m-0 mb-2 rounded-panel border border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-2.5 text-[13px] font-semibold text-fg"
        >
          Paused — active runs were cancelled and new runs are blocked. Resume to continue.
        </p>
      ) : null}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-2.5 pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-fg-2">
            <Switch
              checked={automation.cron.enabled}
              onCheckedChange={(v) => void patchCron({ enabled: v })}
              aria-label="Auto-scan the Jira queue"
            />
            Auto-scan queue
          </label>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            every
            <Input
              type="number"
              min={1}
              value={interval}
              aria-label="Scan interval in minutes"
              onChange={(e) => setIntervalValue(e.target.value)}
              onBlur={() => {
                const n = Number(interval);
                if (n >= 1 && n !== automation.cron.intervalMinutes) void patchCron({ intervalMinutes: n });
              }}
              className="w-[74px] px-2 py-1 text-xs"
            />
            min
          </span>
          <span className="text-xs text-muted">{status}</span>
          {automation.cron.error ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-critical">
              <AlertCircle size={12} aria-hidden />{automation.cron.error}
            </span>
          ) : null}

          <span className="flex-1" />

          <Tooltip label="While on, every ticket that reaches plan-ready is built automatically — 2 at a time, no per-ticket click. Persists across restarts.">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-fg-2">
              <Switch
                checked={!!automation.autoBuild}
                onCheckedChange={(v) => void setAutoBuild(v)}
                disabled={automation.paused}
                aria-label="Auto-build plan-ready tickets"
              />
              Auto-build
            </label>
          </Tooltip>
          <Tooltip
            label={
              planReadyKeys.length
                ? `Approve all ${planReadyKeys.length} plan-ready ticket(s) for build now. Two run at once; the rest queue and start automatically as slots free up.`
                : 'No plan-ready tickets waiting — approve a plan first.'
            }
          >
            <Button
              variant="approve"
              onClick={() => void buildAll()}
              disabled={buildingAll || automation.paused || planReadyKeys.length === 0}
            >
              {buildingAll ? <Spinner /> : <Hammer size={13} aria-hidden />}
              Build all ready{planReadyKeys.length ? ` (${planReadyKeys.length})` : ''}
            </Button>
          </Tooltip>

          <Button onClick={() => void scanNow()} disabled={scanning}>
            {scanning ? <Spinner /> : <ScanLine size={13} aria-hidden />}
            Run queue now
          </Button>
          <Tooltip
            label={
              alreadyTracked > 0
                ? `${automation.pendingCount} ticket(s) matched the queue's JQL; ${alreadyTracked} already have a local ticket folder and are on the board, so only ${pending.length} are genuinely waiting to be started.`
                : `${pending.length} scanned ticket(s) have no local ticket folder yet.`
            }
          >
            <Badge>
              {pending.length} waiting
              {alreadyTracked > 0 ? <span className="ml-1 font-normal text-muted">· {alreadyTracked} tracked</span> : null}
            </Badge>
          </Tooltip>
          <Button
            variant={automation.paused ? 'approve' : 'danger'}
            onClick={() => void setPaused(!automation.paused)}
          >
            {automation.paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
            {automation.paused ? 'Resume' : 'Pause'}
          </Button>
        </CardBody>

        {pending.length ? (
          <CardBody className="border-t border-grid pt-3">
            <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-[.05em] text-muted">
              Scanned · not started ({pending.length})
            </p>
            <p className="mt-0 mb-2.5 text-xs text-muted">
              Moving a ticket into the queue starts intake→plan. It stops for plan review before any
              code — no PR.
            </p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {pending.map((key) => (
                <li key={key} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
                  <a
                    href={JIRA_BASE + key}
                    target="_blank"
                    rel="noopener"
                    className="font-mono text-xs font-bold text-accent no-underline hover:underline"
                  >
                    {key}
                  </a>
                  <span className="flex-1" />
                  <Button variant="approve" onClick={() => void run(key, 'plan')}>Move into queue</Button>
                </li>
              ))}
            </ul>
          </CardBody>
        ) : null}
      </Card>
    </div>
  );
}

// ---- run rows ----

function statusOf(t: TicketCard): [string, 'accent' | 'critical' | 'warning' | 'good' | 'neutral'] {
  if (t.running) return [`Running${t.runMode ? ` · ${t.runMode}` : ''}`, 'accent'];
  if (t.blocked) return ['Blocked', 'critical'];
  if (t.planReady) return ['Plan ready', 'warning'];
  if (t.column === 'archived') return ['Archived', 'neutral'];
  if (t.column === 'ship') return ['Awaiting merge', 'good'];
  return [t.phase || 'idle', 'neutral'];
}

function RunRow({
  ticket: t,
  focused,
  onFocus,
}: {
  ticket: TicketCard;
  focused: boolean;
  onFocus: (tab?: string) => void;
}) {
  const { pending, failed, run, cancel, setArchived, checkMerge } = useRuns();
  const starting = pending[t.key];
  const failure = failed[t.key];
  const [label, tone] = statusOf(t);

  const doneIdx = t.lastCompleted ? STAGE_ORDER.indexOf(t.lastCompleted as (typeof STAGE_ORDER)[number]) : -1;

  return (
    <article
      style={phaseStyle(t.phase || t.column)}
      className={cn(
        'phase-bar relative rounded-panel border border-border bg-surface py-3 pl-4 pr-3.5',
        focused && 'border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] shadow-pop',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={JIRA_BASE + t.key}
          target="_blank"
          rel="noopener"
          className="font-mono text-[13px] font-bold text-accent no-underline hover:underline"
        >
          {t.key}
        </a>
        <button
          type="button"
          onClick={() => onFocus()}
          className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[13px] text-fg hover:text-accent"
        >
          {t.summary || t.key}
        </button>
        <Badge tone={tone}>
          {t.running ? <Spinner className="h-2.5 w-2.5 border" /> : null}
          {label}
        </Badge>
        {t.costUsd ? <Badge>{money(t.costUsd)}</Badge> : null}
        {t.prUrl ? (
          <a href={t.prUrl} target="_blank" rel="noopener" className="no-underline">
            <Badge tone="accent"><GitPullRequest size={11} aria-hidden />PR</Badge>
          </a>
        ) : null}
      </div>

      <ol className="m-0 mt-2.5 flex list-none flex-wrap gap-x-3 gap-y-1 p-0" aria-label={`${t.key} pipeline stages`}>
        {STAGE_ORDER.map((stage, i) => {
          let st: StepState = 'pending';
          if (t.blocked && stage === t.blockedStage) st = 'blocked';
          else if (i <= doneIdx) st = 'done';
          else if (stage === t.phase) st = t.running ? 'active' : 'current';
          return (
            <li key={stage} className="flex items-center gap-1" style={phaseStyle(stage)}>
              <span
                aria-hidden
                className={cn(
                  'h-[7px] w-[7px] shrink-0 rounded-full',
                  st === 'done' && 'bg-[var(--ph)]',
                  st === 'active' && 'bg-accent anim-pulse',
                  st === 'current' && 'border-2 border-[var(--ph)] bg-transparent',
                  st === 'blocked' && 'bg-critical',
                  st === 'pending' && 'bg-surface-3',
                )}
              />
              <span
                className={cn(
                  'text-[10.5px] capitalize',
                  st === 'pending' ? 'text-muted' : 'font-semibold text-fg-2',
                  st === 'blocked' && 'text-critical',
                )}
              >
                {stage}
              </span>
            </li>
          );
        })}
      </ol>

      {t.blocked ? (
        <p className="mt-2.5 mb-0 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,var(--border))] bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2.5 py-2 text-xs leading-snug text-fg-2">
          <strong className="text-critical">Blocked at {t.blockedStage || t.phase || '—'}.</strong>{' '}
          {t.blockedReason}
        </p>
      ) : t.planReady ? (
        <p className="mt-2.5 mb-0 rounded-lg border border-[color-mix(in_srgb,var(--ph-plan)_45%,var(--border))] bg-[color-mix(in_srgb,var(--ph-plan)_10%,var(--surface))] px-2.5 py-2 text-xs font-semibold text-fg-2">
          Plan complete — review it before build.
        </p>
      ) : null}

      {failure ? (
        <p role="alert" className="mt-2.5 mb-0 text-xs leading-snug text-critical">
          {failure.mode} {failure.phase === 'run' ? 'failed' : 'failed to start'} —{' '}
          {failure.reason || failure.message}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {starting && !t.running ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent">
            <Spinner /> starting {starting}…
          </span>
        ) : null}
        {t.running ? (
          <>
            <Button onClick={() => onFocus('log')}>View log</Button>
            <Button variant="danger" onClick={() => void cancel(t.key)}>Cancel</Button>
          </>
        ) : t.column === 'archived' ? (
          <Button onClick={() => void setArchived(t.key, false)}>Unarchive</Button>
        ) : (
          <>
            {t.planReady ? (
              <Button variant="primary" onClick={() => onFocus('plan')}>Review plan</Button>
            ) : null}
            {availableActions(t).map((action) => (
              <Tooltip key={`${action.mode}-${action.label}`} label={action.disabledReason ?? action.hint ?? ''}>
                <Button
                  variant={action.variant}
                  disabled={Boolean(action.disabledReason)}
                  onClick={() => void run(t.key, action.mode)}
                >
                  {action.label}
                </Button>
              </Tooltip>
            ))}
            {t.column === 'ship' ? (
              <Button onClick={() => void checkMerge(t.key)}>Check merge</Button>
            ) : null}
            <Button onClick={() => onFocus('log')}>View log</Button>
            <Button variant="muted" onClick={() => void setArchived(t.key, true)}>Archive</Button>
          </>
        )}
      </div>
    </article>
  );
}

function QueuedRow({ ticketKey }: { ticketKey: string }) {
  const { run } = useRuns();
  return (
    <article
      style={phaseStyle('queued')}
      className="phase-bar relative rounded-panel border border-dashed border-border bg-surface py-3 pl-4 pr-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={JIRA_BASE + ticketKey}
          target="_blank"
          rel="noopener"
          className="font-mono text-[13px] font-bold text-accent no-underline hover:underline"
        >
          {ticketKey}
        </a>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">labelled · not started</span>
        <Badge tone="phase">queued</Badge>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button onClick={() => void run(ticketKey, 'plan')}>Plan</Button>
        <Button onClick={() => void run(ticketKey, 'review')}>Review</Button>
      </div>
    </article>
  );
}

// ---- bottom logger ----

function Logger({
  ticketKey,
  tab,
  onTabChange,
}: {
  ticketKey: string | null;
  tab: string;
  onTabChange: (t: string) => void;
}) {
  const { lines, loading } = useTicketLog(ticketKey, tab === 'log');

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-baseline gap-2.5">
          <CardTitle>Logger</CardTitle>
          <span className="font-mono text-xs text-muted">{ticketKey ?? '— select a run —'}</span>
        </div>
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList aria-label="Logger view">
            <TabsTrigger value="log">Live log</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="plan">Plan</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardBody>
        {!ticketKey ? (
          <p className="m-0 text-[13px] text-muted">Select a run above to stream its log here.</p>
        ) : tab === 'log' ? (
          <LogView
            className="h-[320px]"
            label={`Run log for ${ticketKey}`}
            lines={lines}
            empty={loading ? 'Loading log…' : 'No log output yet.'}
          />
        ) : (
          <TicketDetailPane ticketKey={ticketKey} mode={tab === 'plan' ? 'plan' : 'events'} />
        )}
      </CardBody>
    </Card>
  );
}

function TicketDetailPane({ ticketKey, mode }: { ticketKey: string; mode: 'events' | 'plan' }) {
  const fetcher = useCallback((signal: AbortSignal) => api.ticket(ticketKey, signal), [ticketKey]);
  const { data, error } = useResource<TicketDetail>(fetcher, [ticketKey]);

  if (error) return <p className="m-0 text-[13px] text-critical">Failed to load {ticketKey}: {error}</p>;
  if (!data) {
    return (
      <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
        <Spinner label="Loading ticket" /> Loading {ticketKey}…
      </p>
    );
  }

  if (mode === 'plan') {
    return data.planReady ? (
      <PlanGate ticketKey={data.key} plan={data.artifacts.plan} running={data.running} />
    ) : (
      <>
        <p className="mt-0 mb-2 text-[13px] text-muted">
          {data.blocked
            ? `${ticketKey} is blocked at ${data.blockedStage ?? 'an unknown stage'}${data.blockedReason ? ` — ${data.blockedReason}` : ''}.`
            : `${ticketKey} is not parked at the plan gate.`}{' '}
          Continue resumes it from there; Re-plan sends it back to planning instead. Either can
          carry a note.
        </p>
        <ResumeOrReplan
          ticketKey={ticketKey}
          plan={data.artifacts.plan}
          running={data.running}
          canContinue={data.canContinue}
        />
      </>
    );
  }

  return (
    <Tabs value="events">
      <TabsContent value="events" className="pt-0">
        {data.timeline.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No stage events yet.</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {data.timeline.map((r, i) => (
              <li
                key={`${r.stage}-${i}`}
                style={phaseStyle(r.stage)}
                className="phase-bar relative flex flex-wrap items-center gap-2 border-b border-grid py-2 pl-3.5 last:border-b-0"
              >
                <span className="w-[68px] shrink-0 text-[12.5px] font-semibold capitalize text-fg">{r.stage}</span>
                <Badge tone={r.status === 'ok' ? 'good' : r.status === 'blocked' ? 'critical' : 'warning'}>
                  {r.status}
                </Badge>
                <span className="text-xs tabular-nums text-muted">{duration(r.durationSec)}</span>
                <span className="text-xs tabular-nums text-muted">{tokens(r.tokensTotal)} tok</span>
                {r.notes ? <span className="basis-full text-xs leading-snug text-fg-2">{r.notes}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </TabsContent>
    </Tabs>
  );
}

function ResumeOrReplan({
  ticketKey,
  plan,
  running,
  canContinue,
}: {
  ticketKey: string;
  plan: string | null;
  running: boolean;
  canContinue: boolean;
}) {
  const { run } = useRuns();
  const [notes, setNotes] = useState('');
  return (
    <div>
      <details className="md">
        <summary>Current plan.md</summary>
        <div className="max-h-[280px] overflow-y-auto">
          {plan ? <pre className="whitespace-pre-wrap">{plan}</pre> : <p className="text-muted">Not present.</p>}
        </div>
      </details>
      <textarea
        className="mt-2 min-h-[78px] w-full resize-y rounded-[10px] border border-border-strong bg-surface px-3 py-2.5 font-[inherit] text-[13px] text-fg placeholder:text-muted focus:border-accent focus:outline-none"
        value={notes}
        aria-label={`Resume note for ${ticketKey}`}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="What should whichever stage runs next know? (saved to resume-notes.md; read once, then deleted; never passed on the command line)…"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {canContinue ? (
          <Button
            variant="primary"
            size="md"
            disabled={running}
            onClick={() => void run(ticketKey, 'continue', { notes: notes.trim() || undefined })}
          >
            <Play size={14} aria-hidden />
            Continue
          </Button>
        ) : null}
        <Button
          variant={canContinue ? 'secondary' : 'primary'}
          size="md"
          disabled={running}
          onClick={() => void run(ticketKey, 'replan', { notes: notes.trim() || undefined })}
        >
          <RefreshCw size={14} aria-hidden />
          Submit re-plan
        </Button>
      </div>
    </div>
  );
}
