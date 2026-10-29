import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useResource } from '@/hooks/useResource';
import { api } from '@/lib/api';
import { dateTime, duration, money, tokens } from '@/lib/format';
import { phaseColor } from '@/lib/phase';
import type { CostState } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Chip } from './Menu';
import { useThread } from './useListQuery';

export interface Column<T> {
  id: string;
  label: string;
  value: (row: T) => number | string;
  render?: (row: T) => ReactNode;
  num?: boolean;
}

/** A table whose header cells sort it (click again to reverse), with a text filter on top. */
export function SortableTable<T>({
  rows,
  columns,
  initial,
  search,
  rowKey,
  onRow,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  initial: string;
  search?: (row: T) => string;
  rowKey: (row: T) => string;
  onRow?: (row: T) => void;
  empty: string;
}) {
  const [sort, setSort] = useState(initial);
  const [q, setQ] = useState('');
  const desc = sort.startsWith('-');
  const col = columns.find((c) => c.id === sort.replace(/^-/, '')) || columns[0];
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = search ? rows.filter((r) => words.every((w) => search(r).toLowerCase().includes(w))) : rows;
    return [...filtered].sort((a, b) => {
      const va = col.value(a); const vb = col.value(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return desc ? -c : c;
    });
  }, [rows, q, search, col, desc]);

  return (
    <div>
      {search ? (
        <label className="mx-4 mb-2 flex items-center gap-1.5 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[5px] focus-within:border-accent">
          <Search size={14} aria-hidden className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter the table" className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-fg outline-none placeholder:text-muted" />
          {q ? <span className="text-[11.5px] text-muted">{shown.length} of {rows.length}</span> : null}
        </label>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {columns.map((c) => {
                const on = col.id === c.id;
                return (
                  <th key={c.id} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'} className={cn('sticky top-0 border-b border-border bg-surface-2 px-4 py-2 text-[11.5px] font-semibold uppercase tracking-[.04em] text-muted', c.num ? 'text-right' : 'text-left')}>
                    <button type="button" onClick={() => setSort(on ? (desc ? c.id : `-${c.id}`) : c.num ? `-${c.id}` : c.id)} className={cn('inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-semibold uppercase', on ? 'text-fg' : 'text-muted hover:text-fg')}>
                      {c.label}{on ? (desc ? <ArrowDown size={11} aria-hidden /> : <ArrowUp size={11} aria-hidden />) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? <tr><td colSpan={columns.length} className="px-4 py-3 text-muted">{empty}</td></tr> : shown.map((r) => (
              <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined} className={cn('border-b border-border', onRow && 'cursor-pointer hover:bg-surface-2')}>
                {columns.map((c) => <td key={c.id} className={cn('px-4 py-2 text-fg-2', c.num && 'text-right tabular-nums')}>{c.render ? c.render(r) : String(c.value(r))}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TABS = ['tickets', 'reviews', 'stages', 'budget', 'escaped'] as const;
type Tab = (typeof TABS)[number];

export function CostChannel() {
  const { data, error } = useResource<CostState>((signal) => api.cost(signal));
  const { open } = useThread();
  const [tab, setTab] = useState<Tab>('tickets');
  if (error) return <p className="p-4 text-[13px] text-critical">Could not load cost: {error}</p>;
  if (!data) return <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>;
  const reg = data.regression;
  const tiles: [string, string][] = [
    ['Total cost', money(data.totals.cost)],
    ['Tokens', tokens(data.totals.tokens)],
    ['Tickets', String(data.totals.tickets)],
    ['Budget per ticket', data.budget.capPerTicket != null ? money(data.budget.capPerTicket) : '—'],
    ['PR reviews', `${money(data.prReviewTotals.cost)} · ${data.prReviewTotals.count}`],
    ['Escaped defects', !reg ? '—' : reg.pending || typeof reg.escapedDefectRate !== 'number' ? 'computing…' : `${(reg.escapedDefectRate * 100).toFixed(1)}% (${reg.escaped}/${reg.shipped})`],
  ];
  const counts: Record<Tab, number> = {
    tickets: data.tickets.length, reviews: data.prReviews.length, stages: data.stages.filter((s) => s.count > 0).length,
    budget: data.budget.tickets.length, escaped: reg?.byComponent?.length || 0,
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-6">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 p-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-panel bg-surface-2 px-3.5 py-3">
            <p className="m-0 text-[12px] text-muted">{label}</p>
            <p className="m-0 mt-0.5 text-[19px] font-bold tabular-nums tracking-[-.01em] text-fg">{value}</p>
          </div>
        ))}
      </div>
      {reg && !reg.pending && (reg.escaped || 0) > 0 && reg.rubricCorrelation?.verdict ? (
        <p className="mx-4 mt-0 mb-3 rounded-panel border border-border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-2">
          {reg.escaped} of {reg.shipped} shipped tickets later produced a fidelity defect. {reg.rubricCorrelation.verdict}
          <span className="ml-1 text-muted">{reg.stale ? '(cached · refreshing)' : reg.computedAt ? `(as of ${dateTime(reg.computedAt)})` : ''}</span>
        </p>
      ) : null}
      <div role="tablist" aria-label="Cost tables" className="flex flex-wrap gap-1.5 px-4 pb-3">
        {TABS.filter((t) => t !== 'escaped' || reg).filter((t) => t !== 'budget' || data.budget.capPerTicket != null).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="cursor-pointer border-0 bg-transparent p-0">
            <Chip active={tab === t}>{t === 'escaped' ? 'Escaped defects' : t[0].toUpperCase() + t.slice(1)} <span className="text-[11px] opacity-70">{counts[t]}</span></Chip>
          </button>
        ))}
      </div>

      {tab === 'tickets' ? (
        <SortableTable
          rows={data.tickets} initial="-updated" rowKey={(t) => t.key} empty="No tickets match."
          search={(t) => `${t.key} ${t.summary} ${t.jiraStatus || ''} ${t.status} ${t.running ? 'running' : ''}`}
          onRow={(t) => open({ kind: 'ticket', id: t.key })}
          columns={[
            { id: 'key', label: 'Ticket', value: (t) => Number(t.key.split('-')[1]) || 0, render: (t) => <span className="font-mono font-semibold whitespace-nowrap text-accent">{t.key}</span> },
            { id: 'summary', label: 'Summary', value: (t) => t.summary, render: (t) => <span className="line-clamp-1 text-fg">{t.summary}</span> },
            { id: 'cost', label: 'Cost', num: true, value: (t) => t.costUsd, render: (t) => money(t.costUsd) },
            { id: 'tokens', label: 'Tokens', num: true, value: (t) => t.tokens, render: (t) => tokens(t.tokens) },
            { id: 'status', label: 'Status', value: (t) => (t.running ? '0' : t.jiraStatus || t.status), render: (t) => (t.running ? <span className="text-accent">running</span> : t.jiraStatus || t.status) },
            { id: 'updated', label: 'Updated', value: (t) => t.updatedAt || '', render: (t) => dateTime(t.updatedAt) },
          ]}
        />
      ) : tab === 'reviews' ? (
        <SortableTable
          rows={data.prReviews} initial="-updated" rowKey={(r) => r.ref} empty="No reviews match."
          search={(r) => `${r.ref} ${r.title} ${r.running ? 'running' : r.result || ''} ${r.isOwn === true ? 'mine you' : r.isOwn === false ? 'others other' : ''}`}
          onRow={(r) => open({ kind: 'review', id: r.ref })}
          columns={[
            { id: 'pr', label: 'PR', value: (r) => r.ref, render: (r) => <span className="font-mono text-accent">#{r.ref.split('-').pop()}</span> },
            { id: 'title', label: 'Title', value: (r) => r.title, render: (r) => <span className="line-clamp-1 text-fg">{r.title}</span> },
            { id: 'cost', label: 'Cost', num: true, value: (r) => r.costUsd, render: (r) => money(r.costUsd) },
            { id: 'tokens', label: 'Tokens', num: true, value: (r) => r.tokens, render: (r) => tokens(r.tokens) },
            { id: 'owner', label: 'Owner', value: (r) => (r.isOwn === true ? 'you' : r.isOwn === false ? 'other' : '—') },
            { id: 'result', label: 'Result', value: (r) => (r.running ? 'running' : r.result || '—') },
            { id: 'updated', label: 'Updated', value: (r) => r.updatedAt || '', render: (r) => dateTime(r.updatedAt) },
          ]}
        />
      ) : tab === 'stages' ? (
        <SortableTable
          rows={data.stages.filter((s) => s.count > 0)} initial="-cost" rowKey={(s) => s.stage} empty="No stage events yet."
          columns={[
            { id: 'stage', label: 'Stage', value: (s) => s.stage, render: (s) => <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full" style={{ background: phaseColor(s.stage) }} />{s.stage}</span> },
            { id: 'cost', label: 'Cost', num: true, value: (s) => s.costUsd, render: (s) => money(s.costUsd) },
            { id: 'tokens', label: 'Tokens', num: true, value: (s) => s.tokens, render: (s) => tokens(s.tokens) },
            { id: 'count', label: 'Events', num: true, value: (s) => s.count },
            { id: 'avg', label: 'Avg duration', num: true, value: (s) => s.avgDurationSec, render: (s) => duration(s.avgDurationSec) },
          ]}
        />
      ) : tab === 'budget' ? (
        <SortableTable
          rows={data.budget.tickets} initial="-ratio" rowKey={(b) => b.key} empty="No spend yet." search={(b) => b.key}
          onRow={(b) => open({ kind: 'ticket', id: b.key })}
          columns={[
            { id: 'key', label: 'Ticket', value: (b) => b.key, render: (b) => <span className="font-mono font-semibold whitespace-nowrap text-accent">{b.key}</span> },
            {
              id: 'ratio', label: 'Of budget', value: (b) => b.ratio, render: (b) => (
                <span className="flex items-center gap-2">
                  <span role="meter" aria-valuenow={Math.round(b.ratio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${b.key} budget used`} className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-3">
                    <span className="block h-full rounded-full" style={{ width: `${Math.min(100, b.ratio * 100)}%`, background: b.over ? 'var(--critical)' : 'var(--accent)' }} />
                  </span>
                  <span className={b.over ? 'font-semibold text-critical' : ''}>{Math.round(b.ratio * 100)}%{b.over ? ' over' : ''}</span>
                </span>
              ),
            },
            { id: 'spent', label: 'Spent', num: true, value: (b) => b.spentUsd, render: (b) => money(b.spentUsd) },
            { id: 'cap', label: 'Cap', num: true, value: (b) => b.capUsd, render: (b) => money(b.capUsd) },
          ]}
        />
      ) : (
        <SortableTable
          rows={reg?.byComponent || []} initial="-escapes" rowKey={(c) => c.component} empty="No escaped defects." search={(c) => `${c.component} ${c.shippedBy} ${c.escapes.join(' ')}`}
          columns={[
            { id: 'component', label: 'Component', value: (c) => c.component },
            { id: 'shippedBy', label: 'Shipped by', value: (c) => c.shippedBy, render: (c) => <span className="font-mono">{c.shippedBy}</span> },
            { id: 'escapes', label: 'Escapes', num: true, value: (c) => c.escapes.length, render: (c) => <span title={c.escapes.join(', ')}>{c.escapes.length} · {c.escapes.slice(0, 3).join(', ')}{c.escapes.length > 3 ? '…' : ''}</span> },
          ]}
        />
      )}
    </div>
  );
}
