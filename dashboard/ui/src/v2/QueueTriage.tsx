import { AlarmClock, ChevronDown, ChevronRight, EyeOff, GripVertical, Play, RotateCcw } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useBoard } from '@/hooks/board';
import { postJson } from '@/lib/api';
import { JIRA_BASE, money } from '@/lib/format';
import type { QueueItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Chip, Menu, MenuItem } from './Menu';
import { ago, cleanSummary } from './rows';

const PRIORITY_TONE: Record<string, 'critical' | 'warning' | undefined> = { Highest: 'critical', Critical: 'critical', Blocker: 'critical', High: 'warning' };
const SNOOZE = [
  { label: 'Until tomorrow', days: 1 },
  { label: 'For 3 days', days: 3 },
  { label: 'For a week', days: 7 },
];
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

/**
 * The scanned Jira queue as a triage list: what each ticket is and roughly costs, in the order
 * you want them planned. Plan one, several (they start as slots free up), skip one until Jira
 * changes it, or snooze it.
 */
export function QueueTriage() {
  const { state, refresh } = useBoard();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const triage = state?.automation.triage;
  if (!triage) return null;
  const { visible, hidden } = triage;
  const paused = state?.automation.paused;

  const act = async (path: string, body: Record<string, unknown>, ok?: (r: Record<string, unknown>) => string) => {
    setBusy(true);
    try {
      const r = await postJson<Record<string, unknown>>(path, body);
      if (ok) toast.success(ok(r));
      setSelected(new Set());
      refresh();
    } catch (e) { toast.error('That did not work', { description: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  };
  const plan = (keys: string[]) => act('/api/plan-batch', { keys }, (r) => {
    const started = (r.started as string[]).length; const queued = (r.queued as string[]).length - started;
    return `${started} planning now${queued > 0 ? `, ${queued} waiting for a slot` : ''}`;
  });
  const triageAct = (keys: string[], action: string, extra: Record<string, unknown> = {}) => act('/api/queue-triage', { keys, action, ...extra });
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const onDrop = (e: DragEvent, target: string) => {
    e.preventDefault();
    if (!dragKey || dragKey === target) return;
    const keys = visible.map((i) => i.key).filter((k) => k !== dragKey);
    keys.splice(keys.indexOf(target), 0, dragKey);
    setDragKey(null);
    void triageAct([], 'order', { order: keys });
  };

  const total = visible.reduce((n, i) => n + (i.estimate?.median || 0), 0);
  const sel = [...selected].filter((k) => visible.some((i) => i.key === k));

  return (
    <section aria-label="Scanned, not started" className="border-b border-border">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <h3 className="m-0 text-[11.5px] font-semibold text-fg-2">
          Scanned, not started <span className="font-normal text-muted">{visible.length}{total ? ` · about ${money(total)} to plan and build them all` : ''}</span>
        </h3>
        <span className="flex-1" />
        {visible.length ? (
          <button type="button" onClick={() => setSelected(sel.length === visible.length ? new Set() : new Set(visible.map((i) => i.key)))} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-accent hover:underline">
            {sel.length === visible.length ? 'Select none' : 'Select all'}
          </button>
        ) : null}
      </div>

      {sel.length ? (
        <div className="sticky top-0 z-10 mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-accent-soft px-3 py-2">
          <span className="text-[12.5px] font-semibold text-accent">{sel.length} selected</span>
          <span className="flex-1" />
          <Button size="sm" variant="primary" disabled={busy || paused} onClick={() => void plan(sel)}><Play size={12} aria-hidden />Plan selected</Button>
          <Button size="sm" disabled={busy} onClick={() => void triageAct(sel, 'skip')}><EyeOff size={12} aria-hidden />Skip</Button>
          <Menu label="Snooze the selected tickets" align="right" trigger={() => <Chip><AlarmClock size={12} aria-hidden />Snooze<ChevronDown size={12} aria-hidden /></Chip>}>
            {(close) => SNOOZE.map((s) => <MenuItem key={s.days} onSelect={() => { close(); void triageAct(sel, 'snooze', { until: inDays(s.days) }); }}>{s.label}</MenuItem>)}
          </Menu>
        </div>
      ) : null}

      {visible.length ? (
        <ul className="m-0 list-none p-0">
          {visible.map((it) => (
            <QueueRow
              key={it.key}
              item={it}
              selected={selected.has(it.key)}
              dragging={dragKey === it.key}
              disabled={busy}
              paused={!!paused}
              onToggle={() => toggle(it.key)}
              onPlan={() => void plan([it.key])}
              onSkip={() => void triageAct([it.key], 'skip')}
              onSnooze={(days) => void triageAct([it.key], 'snooze', { until: inDays(days) })}
              onDragStart={() => setDragKey(it.key)}
              onDrop={(e) => onDrop(e, it.key)}
            />
          ))}
        </ul>
      ) : <p className="m-0 px-4 pb-3 text-[12.5px] text-muted">Nothing waiting from the last scan.</p>}

      {hidden.length ? (
        <div className="border-t border-border">
          <button type="button" onClick={() => setShowHidden((v) => !v)} aria-expanded={showHidden} className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-4 py-2 text-left text-[12px] font-semibold text-fg-2">
            {showHidden ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Skipped and snoozed <span className="font-normal text-muted">{hidden.length}</span>
          </button>
          {showHidden ? (
            <ul className="m-0 list-none p-0">
              {hidden.map((it) => (
                <li key={it.key} className="flex items-center gap-2 border-t border-border px-4 py-2 text-[12.5px]">
                  <a href={JIRA_BASE + it.key} target="_blank" rel="noopener" className="font-mono font-semibold text-accent">{it.key}</a>
                  <span className="min-w-0 flex-1 truncate text-fg-2">{cleanSummary(it.key, it.summary)}</span>
                  <span className="text-[11.5px] text-muted">{it.hiddenBy === 'snooze' ? `snoozed until ${new Date(it.until!).toLocaleDateString()}` : 'skipped until Jira changes it'}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void triageAct([it.key], 'restore')}><RotateCcw size={12} aria-hidden />Restore</Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function QueueRow({ item, selected, dragging, disabled, paused, onToggle, onPlan, onSkip, onSnooze, onDragStart, onDrop }: {
  item: QueueItem; selected: boolean; dragging: boolean; disabled: boolean; paused: boolean;
  onToggle: () => void; onPlan: () => void; onSkip: () => void; onSnooze: (days: number) => void;
  onDragStart: () => void; onDrop: (e: DragEvent) => void;
}) {
  const e = item.estimate;
  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={onDrop}
      className={cn('group flex items-start gap-2 border-t border-border px-3 py-2.5', selected && 'bg-accent-soft', dragging && 'opacity-40')}
    >
      <span aria-hidden title="Drag to reorder" className="mt-0.5 cursor-grab text-muted opacity-40 group-hover:opacity-100"><GripVertical size={14} /></span>
      <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${item.key}`} className="mt-1 h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a href={JIRA_BASE + item.key} target="_blank" rel="noopener" className="font-mono text-[12.5px] font-semibold text-accent">{item.key}</a>
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg" title={item.summary}>{cleanSummary(item.key, item.summary) || 'No summary in the last scan'}</span>
          <span className="w-12 flex-none text-right text-[11.5px] whitespace-nowrap text-muted">{ago(item.updated)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {item.type ? <Badge>{item.type}</Badge> : null}
          {item.priority ? <Badge tone={PRIORITY_TONE[item.priority]}>{item.priority}</Badge> : null}
          {item.status ? <span className="text-[11.5px] text-muted">{item.status}</span> : null}
          {item.epic ? <Tooltip label={item.epic.summary || item.epic.key}><span className="rounded-[6px] bg-surface-2 px-1.5 text-[11.5px] text-fg-2">{item.epic.key}{item.epic.summary ? ` · ${item.epic.summary}` : ''}</span></Tooltip> : null}
          {item.labels.slice(0, 3).map((l) => <span key={l} className="text-[11px] text-muted">#{l}</span>)}
          {item.changedSinceSkip ? <Badge tone="accent">changed since you skipped it</Badge> : null}
          {item.queuedForPlan ? <Badge tone="accent">waiting for a slot</Badge> : null}
          {e ? (
            <Tooltip label={`Median of ${e.n} ${e.basis === 'all tickets' ? 'past tickets' : `past [${e.basis}] tickets`}; three in four cost under ${money(e.p75)}.`}>
              <span className="text-[11.5px] text-muted">≈ {money(e.median)}</span>
            </Tooltip>
          ) : null}
          <span className="flex-1" />
          <span className="flex items-center gap-1">
            <Tooltip label={paused ? 'Resume Millwright first.' : 'Plan it now - stops at the plan gate for your review.'}>
              <span><Button size="sm" variant="primary" disabled={disabled || paused || item.queuedForPlan} onClick={onPlan}>Plan</Button></span>
            </Tooltip>
            <Tooltip label="Hide it until Jira changes it">
              <Button size="sm" variant="ghost" disabled={disabled} onClick={onSkip} aria-label={`Skip ${item.key}`}><EyeOff size={12} aria-hidden /></Button>
            </Tooltip>
            <Menu label={`Snooze ${item.key}`} align="right" trigger={() => <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-fg-2 hover:bg-surface-2"><AlarmClock size={13} aria-hidden /></span>}>
              {(close) => SNOOZE.map((s) => <MenuItem key={s.days} onSelect={() => { close(); onSnooze(s.days); }}>{s.label}</MenuItem>)}
            </Menu>
          </span>
        </div>
      </div>
    </li>
  );
}
