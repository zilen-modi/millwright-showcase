import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, Columns3, LayoutList, Rows3, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ChannelDef } from './channels';
import { Chip, Menu, MenuItem } from './Menu';
import { FACETS, SORTS, activeFilterCount, facetOptions, type Item, type ListQuery } from './query';
import { cn } from '@/lib/utils';

const GROUP_LABEL: Record<string, string> = {
  stage: 'Stage', need: 'Why it waits', kind: 'Type', repo: 'Repo', owner: 'Owner', bucket: 'Inbox', none: 'No grouping',
};

export function ListToolbar({
  channel,
  items,
  shown,
  query,
  update,
  toggleFilter,
  clear,
}: {
  channel: ChannelDef;
  /** The channel's items before filtering - facet options and counts come from these. */
  items: Item[];
  shown: number;
  query: ListQuery;
  update: (p: Partial<ListQuery>) => void;
  toggleFilter: (facet: string, value: string) => void;
  clear: () => void;
}) {
  const [text, setText] = useState(query.q);
  const input = useRef<HTMLInputElement>(null);
  // Typing updates the URL after a short pause, so every keystroke is not a history entry.
  useEffect(() => { setText(query.q); }, [query.q]);
  useEffect(() => {
    if (text === query.q) return;
    const id = setTimeout(() => update({ q: text }), 180);
    return () => clearTimeout(id);
  }, [text, query.q, update]);

  const facets = FACETS.filter((f) => f.kinds.some((k) => channel.kinds.includes(k)))
    .map((f) => ({ facet: f, options: facetOptions(f, items) }))
    .filter((x) => x.options.length > 1 || (query.filters[x.facet.id]?.length ?? 0) > 0);
  const sorts = SORTS.filter((s) => s.kinds.some((k) => channel.kinds.includes(k)));
  const sortId = query.sort.replace(/^-/, '');
  const desc = query.sort.startsWith('-');
  const filtersOn = activeFilterCount(query);

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
      {channel.scopes ? (
        <div role="group" aria-label="Quick filter" className="flex flex-wrap gap-1.5">
          {channel.scopes.map((s) => (
            <button key={s.id} type="button" onClick={() => update({ scope: s.id })} aria-pressed={query.scope === s.id} className="cursor-pointer border-0 bg-transparent p-0">
              <Chip active={query.scope === s.id}>{s.label} <span className="text-[11px] opacity-70">{items.filter(s.match).length}</span></Chip>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[5px] focus-within:border-accent">
          <Search size={14} aria-hidden className="text-muted" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && text) { e.stopPropagation(); setText(''); } }}
            placeholder={`Filter #${channel.label}`}
            aria-label={`Filter #${channel.label}`}
            data-list-search
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-fg outline-none placeholder:text-muted"
          />
          {text ? (
            <button type="button" aria-label="Clear the filter text" onClick={() => setText('')} className="cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-fg">
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </label>

        {facets.map(({ facet, options }) => {
          const selected = query.filters[facet.id] || [];
          return (
            <Menu
              key={facet.id}
              label={`Filter by ${facet.label.toLowerCase()}`}
              trigger={() => (
                <Chip active={selected.length > 0}>
                  {facet.label}{selected.length ? `: ${selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label ?? selected[0]) : selected.length}` : ''}
                  <ChevronDown size={12} aria-hidden />
                </Chip>
              )}
            >
              {() => (
                <>
                  {options.map((o) => (
                    <MenuItem key={o.value} checked={selected.includes(o.value)} hint={o.count} onSelect={() => toggleFilter(facet.id, o.value)}>
                      {o.label}
                    </MenuItem>
                  ))}
                  {selected.length ? (
                    <div className="mt-1 border-t border-border pt-1">
                      <MenuItem onSelect={() => update({ filters: { ...query.filters, [facet.id]: [] } })}>Clear {facet.label.toLowerCase()}</MenuItem>
                    </div>
                  ) : null}
                </>
              )}
            </Menu>
          );
        })}

        <span className="flex-1" />

        {channel.groups.length > 1 && query.view === 'list' ? (
          <Menu
            label="Group by"
            align="right"
            trigger={() => <Chip><Rows3 size={12} aria-hidden /> {GROUP_LABEL[query.group] || 'Group'} <ChevronDown size={12} aria-hidden /></Chip>}
          >
            {(close) => channel.groups.map((g) => (
              <MenuItem key={g} checked={query.group === g} onSelect={() => { update({ group: g }); close(); }}>{GROUP_LABEL[g] || g}</MenuItem>
            ))}
          </Menu>
        ) : null}

        <Menu
          label="Sort"
          align="right"
          trigger={() => (
            <Chip>
              {desc ? <ArrowDownWideNarrow size={12} aria-hidden /> : <ArrowUpNarrowWide size={12} aria-hidden />}
              {sorts.find((s) => s.id === sortId)?.label || 'Sort'}
            </Chip>
          )}
        >
          {(close) => (
            <>
              {sorts.map((s) => (
                <MenuItem key={s.id} checked={sortId === s.id} onSelect={() => { update({ sort: (desc ? '-' : '') + s.id }); close(); }}>{s.label}</MenuItem>
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <MenuItem onSelect={() => { update({ sort: desc ? sortId : `-${sortId}` }); close(); }}>
                  {desc ? 'Ascending' : 'Descending'}
                </MenuItem>
              </div>
            </>
          )}
        </Menu>

        {channel.board ? (
          <span role="group" aria-label="View" className="inline-flex overflow-hidden rounded-[8px] border border-border-strong">
            {(['list', 'board'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={query.view === v}
                aria-label={v === 'list' ? 'List view' : 'Board view'}
                onClick={() => update({ view: v })}
                className={cn(
                  'flex cursor-pointer items-center border-0 px-2 py-[5px]',
                  query.view === v ? 'bg-accent-soft text-accent' : 'bg-surface text-fg-2 hover:bg-surface-2',
                )}
              >
                {v === 'list' ? <LayoutList size={14} aria-hidden /> : <Columns3 size={14} aria-hidden />}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {filtersOn ? (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span>{shown} of {items.filter(channel.scopes?.find((s) => s.id === query.scope)?.match || (() => true)).length} shown</span>
          <button type="button" onClick={() => { setText(''); clear(); }} className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent hover:underline">
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
