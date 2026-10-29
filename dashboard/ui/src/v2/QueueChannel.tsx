import { AlertTriangle, Pause, Play, RefreshCw, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Launcher } from '@/components/Launcher';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { useBoard } from '@/hooks/board';
import { useRuns } from '@/hooks/runs';
import { postJson } from '@/lib/api';
import { JIRA_BASE, clock } from '@/lib/format';
import { ticketItems } from './channels';
import { useV2 } from './data';
import { QueueTriage } from './QueueTriage';
import { ItemRow } from './rows';

/** #queue: start work by hand, and drive the automation (v1's Launcher + AutomationBar). */
export function QueueChannel() {
  const { state, refresh } = useBoard();
  const data = useV2();
  const { run, setPaused, setAutoBuild, buildAllReady } = useRuns();
  const a = state?.automation;
  const [interval, setIntervalText] = useState(String(a?.cron.intervalMinutes ?? ''));
  const [building, setBuilding] = useState(false);
  const [scanning, setScanning] = useState(false);
  useEffect(() => { setIntervalText(String(a?.cron.intervalMinutes ?? '')); }, [a?.cron.intervalMinutes]);

  const patchCron = async (body: { enabled?: boolean; intervalMinutes?: number }) => {
    try { await postJson('/api/cron', body); refresh(); }
    catch (e) { toast.error('Could not change the scan', { description: e instanceof Error ? e.message : String(e) }); }
  };

  if (!state || !a) return <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>;

  const tracked = new Set(state.tickets.map((t) => t.key));
  const pending = a.pending.filter((k) => !tracked.has(k) && !state.running.includes(k));
  const eligible = state.tickets.filter((t) => t.planReady && !t.running && !t.queuedForBuild);
  const queued = ticketItems(data).filter((i) => i.kind === 'ticket' && i.ticket.queued);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-border px-4 py-3" aria-label="Start a ticket">
        <Launcher autoFocus />
      </section>

      <section className="border-b border-border px-4 py-3" aria-label="Automation">
        {a.paused ? (
          <p role="status" className="mt-0 mb-3 flex items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3 py-2 text-[12.5px] text-fg-2">
            <Pause size={14} aria-hidden className="text-warning" /> Paused - active runs were cancelled and new runs are refused until you resume.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-panel border border-border bg-surface p-3">
            <div className="flex items-center gap-2.5">
              <Switch checked={a.cron.enabled} onCheckedChange={(v) => void patchCron({ enabled: v })} aria-label="Auto-scan the Jira queue" />
              <span className="text-[13px] font-semibold text-fg">Auto-scan the queue</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2">
              every
              <input
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setIntervalText(e.target.value)}
                onBlur={() => { const n = Number(interval); if (n >= 1 && n !== a.cron.intervalMinutes) void patchCron({ intervalMinutes: n }); else setIntervalText(String(a.cron.intervalMinutes)); }}
                aria-label="Scan interval in minutes"
                className="w-16 rounded-[7px] border border-border-strong bg-page px-2 py-1 text-[12.5px] text-fg"
              />
              minutes
              <span className="text-muted">· {a.cron.scanning ? 'scanning…' : a.cron.lastScanAt ? `last ${clock(a.cron.lastScanAt)} · next ${clock(a.cron.nextRunAt)}` : 'not scanned yet'}</span>
            </div>
            {a.cron.error ? <p className="mt-2 mb-0 flex items-center gap-1.5 text-[12px] text-critical"><AlertTriangle size={12} aria-hidden />{a.cron.error}</p> : null}
          </div>
          <div className="rounded-panel border border-border bg-surface p-3">
            <div className="flex items-center gap-2.5">
              <Tooltip label="Every ticket that reaches plan-ready is built automatically, two at a time. Stays on across restarts.">
                <span><Switch checked={!!a.autoBuild} disabled={a.paused} onCheckedChange={(v) => void setAutoBuild(v)} aria-label="Auto-build ready plans" /></span>
              </Tooltip>
              <span className="text-[13px] font-semibold text-fg">Auto-build ready plans</span>
            </div>
            <p className="mt-2 mb-0 text-[12.5px] text-muted">{eligible.length} plan{eligible.length === 1 ? '' : 's'} ready to build.</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Tooltip label={a.paused ? 'Resume first.' : eligible.length ? 'Approve every ready plan: two start now, the rest queue.' : 'No plan is ready, or every ready one is already running or queued.'}>
            <span>
              <Button variant="approve" disabled={building || a.paused || !eligible.length} onClick={async () => { setBuilding(true); await buildAllReady(); setBuilding(false); }}>
                {building ? <Spinner /> : <Rocket size={13} aria-hidden />}Build all ready ({eligible.length})
              </Button>
            </span>
          </Tooltip>
          <Button
            disabled={scanning || a.cron.scanning}
            onClick={async () => {
              setScanning(true);
              try {
                const r = await postJson<{ scanned: number; error: string | null }>('/api/queue-run', {});
                if (r.error) toast.error('The scan failed', { description: r.error }); else toast.success(`Queue scanned - ${r.scanned} labelled ticket(s)`);
              } catch (e) { toast.error('The scan failed', { description: e instanceof Error ? e.message : String(e) }); }
              setScanning(false); refresh();
            }}
          >
            {scanning ? <Spinner /> : <RefreshCw size={13} aria-hidden />}Run queue now
          </Button>
          <span className="flex-1" />
          <Button variant={a.paused ? 'primary' : 'danger'} onClick={() => void setPaused(!a.paused)}>
            {a.paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}{a.paused ? 'Resume Millwright' : 'Pause Millwright'}
          </Button>
        </div>
      </section>

      {a.triage ? <QueueTriage /> : (
      <section aria-label="Scanned, not started" className="border-b border-border">
        <h3 className="m-0 px-4 pt-3 pb-1.5 text-[11.5px] font-semibold text-fg-2">
          Scanned, not started <span className="font-normal text-muted">{pending.length}{a.pendingCount - pending.length > 0 ? ` · ${a.pendingCount - pending.length} already tracked` : ''}</span>
        </h3>
        {pending.length ? (
          <ul className="m-0 list-none p-0">
            {pending.map((k) => (
              <li key={k} className="flex items-center gap-2 border-t border-border px-4 py-2">
                <a href={JIRA_BASE + k} target="_blank" rel="noopener" className="font-mono text-[12.5px] font-semibold text-accent">{k}</a>
                <Badge>labelled in Jira</Badge>
                <span className="flex-1" />
                <Button size="sm" onClick={() => void run(k, 'plan')}>Move into queue</Button>
              </li>
            ))}
          </ul>
        ) : <p className="m-0 px-4 pb-3 text-[12.5px] text-muted">Nothing waiting from the last scan.</p>}
      </section>
      )}

      <section aria-label="Queued">
        <h3 className="m-0 px-4 pt-3 pb-1.5 text-[11.5px] font-semibold text-fg-2">Queued <span className="font-normal text-muted">{queued.length}</span></h3>
        {queued.length ? (
          <ul className="m-0 list-none border-t border-border p-0">{queued.map((it) => <ItemRow key={it.id} item={it} focused={false} selected={false} />)}</ul>
        ) : <p className="m-0 px-4 pb-3 text-[12.5px] text-muted">Nothing queued.</p>}
      </section>
    </div>
  );
}
