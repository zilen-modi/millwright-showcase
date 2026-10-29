import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { phaseColor } from '@/lib/phase';
import { cn } from '@/lib/utils';
import { InboxStatus, ReviewUrlBox } from './ChannelExtras';
import type { ChannelDef } from './channels';
import { useV2 } from './data';
import { ListToolbar } from './ListToolbar';
import { COLUMN_ORDER, applyQuery, groupItems, type Item } from './query';
import { ItemRow, cleanSummary } from './rows';
import { useListQuery, useThread } from './useListQuery';

const COLLAPSE_KEY = 'millwright.v2.collapsed';

function readCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; }
}

/** A list channel: toolbar, then the grouped list (or the stage board for #tickets). */
export function ChannelView({ channel }: { channel: ChannelDef }) {
  const data = useV2();
  const { query, update, toggleFilter, clear } = useListQuery(channel.defaults);
  const { thread } = useThread();
  const items = useMemo(() => channel.select(data), [channel, data]);
  const scope = channel.scopes?.find((s) => s.id === query.scope)?.match;
  const shown = useMemo(() => applyQuery(items, query, scope), [items, query, scope]);
  const groups = useMemo(() => groupItems(shown, query.view === 'board' ? 'none' : query.group), [shown, query]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [focus, setFocus] = useState(-1);
  const loading = !data.board && channel.kinds.includes('ticket');

  const toggleGroup = (id: string) => setCollapsed((prev) => {
    const next = { ...prev, [`${channel.id}:${id}`]: !prev[`${channel.id}:${id}`] };
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* per-session then */ }
    return next;
  });
  const isCollapsed = (id: string) => !!collapsed[`${channel.id}:${id}`];
  const visible = groups.flatMap((g) => (isCollapsed(g.id) ? [] : g.items));

  // j/k move, Enter opens - only when typing is not happening elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setFocus((f) => {
          const n = Math.max(0, Math.min(visible.length - 1, f + (e.key === 'j' ? 1 : -1)));
          document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(visible[n]?.id || '')}"]`)?.scrollIntoView({ block: 'nearest' });
          return n;
        });
      } else if (e.key === 'Enter' && focus >= 0 && visible[focus]) {
        document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(visible[focus].id)}"]`)?.click();
      } else if (e.key === '/' && !thread) {
        const search = document.querySelector<HTMLInputElement>('[data-list-search]');
        if (search) { e.preventDefault(); search.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, focus, thread]);
  useEffect(() => { setFocus(-1); }, [query]);

  const selectedId = thread?.id;
  const focusedId = focus >= 0 ? visible[focus]?.id : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {channel.id === 'reviews' ? <ReviewUrlBox /> : channel.id === 'review-inbox' ? <InboxStatus /> : null}
      <ListToolbar channel={channel} items={items} shown={shown.length} query={query} update={update} toggleFilter={toggleFilter} clear={clear} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>
        ) : query.view === 'board' ? (
          <Board items={shown} selectedId={selectedId} />
        ) : shown.length === 0 ? (
          <Empty channel={channel} filtered={items.length > 0} onClear={clear} />
        ) : (
          groups.map((g) => (
            <section key={g.id} aria-label={g.label || channel.label}>
              {g.label ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  aria-expanded={!isCollapsed(g.id)}
                  className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 border-0 border-b border-border bg-page/95 px-4 py-1.5 text-left text-[11.5px] font-semibold text-fg-2 backdrop-blur"
                >
                  {isCollapsed(g.id) ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
                  {query.group === 'stage' ? <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: phaseColor(g.id) }} /> : null}
                  {g.label} <span className="font-normal text-muted">{g.items.length}</span>
                </button>
              ) : null}
              {isCollapsed(g.id) ? null : (
                <ul className="m-0 list-none p-0">
                  {g.items.map((it) => <ItemRow key={`${it.kind}:${it.id}`} item={it} focused={it.id === focusedId} selected={it.id === selectedId} />)}
                </ul>
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ channel, filtered, onClear }: { channel: ChannelDef; filtered: boolean; onClear: () => void }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="m-0 text-[14px] font-semibold text-fg">{filtered ? 'Nothing matches these filters' : channel.id === 'needs-you' ? 'Nothing is waiting on you' : `#${channel.label} is empty`}</p>
      <p className="mt-1 mb-0 text-[13px] text-muted">
        {filtered ? <button type="button" onClick={onClear} className="cursor-pointer border-0 bg-transparent p-0 text-accent hover:underline">Clear the filters</button>
          : channel.id === 'needs-you' ? 'Blocked runs, ready plans and findings to decide show up here.' : channel.description + '.'}
      </p>
    </div>
  );
}

/** #tickets as stage columns - the v1 Board, fed by the same filters as the list. */
function Board({ items, selectedId }: { items: Item[]; selectedId?: string }) {
  const { open } = useThread();
  const byCol = new Map<string, Item[]>();
  for (const it of items) if (it.kind === 'ticket') {
    const c = it.ticket.column;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c)!.push(it);
  }
  const cols = COLUMN_ORDER.filter((c) => byCol.has(c));
  if (!cols.length) return <p className="p-6 text-center text-[13px] text-muted">No tickets match these filters.</p>;
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {cols.map((c) => (
        <section key={c} aria-label={c} className="flex w-[250px] flex-none flex-col rounded-panel border border-border bg-surface-2">
          <h3 className="m-0 flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-bold uppercase tracking-[.04em] text-fg-2">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: phaseColor(c) }} />
            {c === 'ship' ? 'Awaiting merge' : c}
            <span className="ml-auto font-normal text-muted">{byCol.get(c)!.length}</span>
          </h3>
          <ul className="m-0 flex min-h-0 list-none flex-col gap-1.5 overflow-y-auto p-2 pt-0">
            {byCol.get(c)!.map((it) => {
              const t = (it as Extract<Item, { kind: 'ticket' }>).ticket;
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => open({ kind: 'ticket', id: t.key })}
                    className={cn(
                      'w-full cursor-pointer rounded-[9px] border bg-surface px-2.5 py-2 text-left shadow-card hover:border-border-strong',
                      t.key === selectedId ? 'border-accent' : t.blocked ? 'border-[color-mix(in_srgb,var(--critical)_45%,var(--border))]' : 'border-border',
                    )}
                  >
                    <span className="flex items-center justify-between font-mono text-[11.5px] font-semibold text-accent">{t.key}{t.running ? <Spinner className="h-2.5 w-2.5 border" /> : null}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-fg">{cleanSummary(t.key, t.summary)}</span>
                    <span className="mt-1 flex flex-wrap gap-1 text-[11px]">
                      {t.blocked ? <span className="text-critical">blocked</span> : null}
                      {t.planReady ? <span className="text-warning">plan ready</span> : null}
                      {t.costUsd ? <span className="text-muted">${t.costUsd.toFixed(2)}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
