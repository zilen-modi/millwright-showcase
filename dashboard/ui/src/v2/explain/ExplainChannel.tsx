import { BookOpen, Search, Sparkles } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useStartExplain } from '../dispatch';
import { Chip } from '../Menu';
import { ago } from '../rows';
import { useThread } from '../useListQuery';
import { useExplainers, type ExplainerCard } from './ExplainTab';

const TYPES = [
  { id: 'all', label: 'All' }, { id: 'topic', label: 'Topics' }, { id: 'ticket', label: 'Tickets' }, { id: 'pr', label: 'PRs' },
] as const;

const EXAMPLES = ['Branch transfers', 'Ship via', 'Will call orders', 'PROJ-3907'];

/** #explain: ask for an explainer of a topic, ticket or PR, and browse the ones written. */
export function ExplainChannel() {
  const { data, error } = useExplainers();
  const { thread, open } = useThread();
  const start = useStartExplain();
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]['id']>('all');
  const [sort, setSort] = useState<'recent' | 'title'>('recent');

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (data?.explainers || []).filter((e) => (type === 'all' || e.subject?.type === type)
      && words.every((w) => `${e.title} ${e.subject?.label || ''} ${e.summary || ''}`.toLowerCase().includes(w)));
    return sort === 'title' ? [...rows].sort((a, b) => a.title.localeCompare(b.title)) : rows;
  }, [data, q, type, sort]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!subject.trim()) return;
    setBusy(true);
    const slug = await start(subject.trim());
    setBusy(false);
    if (slug) setSubject('');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="border-b border-border px-4 py-3" aria-label="Explain something">
        <p className="m-0 mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-fg"><Sparkles size={14} aria-hidden className="text-accent" />Explain something in plain words</p>
        <div className="flex gap-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="A topic, a ticket key or a PR link"
            aria-label="What to explain"
            className="min-w-0 flex-1 rounded-[9px] border border-border-strong bg-surface px-3 py-2 text-[13.5px] text-fg outline-none placeholder:text-muted focus:border-accent"
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !subject.trim()}>{busy ? 'Starting…' : 'Explain'}</Button>
        </div>
        <p className="m-0 mt-1.5 text-[12px] text-muted">
          Compares the old ERP (read through Atlas) with the new ERP, for someone who knows neither. Try{' '}
          {EXAMPLES.map((x, i) => (
            <span key={x}>{i ? ', ' : ''}<button type="button" onClick={() => setSubject(x)} className="cursor-pointer border-0 bg-transparent p-0 text-accent hover:underline">{x}</button></span>
          ))}.
        </p>
      </form>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <label className="flex min-w-[160px] flex-1 items-center gap-1.5 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[5px] focus-within:border-accent">
          <Search size={14} aria-hidden className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter #explain" aria-label="Filter explainers" data-list-search className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-fg outline-none placeholder:text-muted" />
        </label>
        {TYPES.map((t) => (
          <button key={t.id} type="button" aria-pressed={type === t.id} onClick={() => setType(t.id)} className="cursor-pointer border-0 bg-transparent p-0">
            <Chip active={type === t.id}>{t.label}</Chip>
          </button>
        ))}
        <button type="button" onClick={() => setSort((s) => (s === 'recent' ? 'title' : 'recent'))} className="cursor-pointer border-0 bg-transparent p-0">
          <Chip>{sort === 'recent' ? 'Newest first' : 'A to Z'}</Chip>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-4 text-[13px] text-critical">Could not load explainers: {error}</p> : null}
        {!data ? <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>
          : list.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <BookOpen size={22} aria-hidden className="mx-auto text-muted" />
              <p className="m-0 mt-2 text-[14px] font-semibold text-fg">{data.explainers.length ? 'Nothing matches' : 'No explainers yet'}</p>
              <p className="m-0 mt-1 text-[13px] text-muted">{data.explainers.length ? 'Try other words or another type.' : 'Ask for one above - a topic is a good start.'}</p>
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {list.map((e) => <ExplainerRow key={e.slug} e={e} selected={thread?.kind === 'explainer' && thread.id === e.slug} onOpen={() => open({ kind: 'explainer', id: e.slug })} />)}
            </ul>
          )}
      </div>
    </div>
  );
}

function ExplainerRow({ e, selected, onOpen }: { e: ExplainerCard; selected: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={cn('w-full cursor-pointer border-0 border-b border-border px-4 py-2.5 text-left', selected ? 'bg-accent-soft' : 'bg-transparent hover:bg-surface-2')}>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{e.title}</span>
          <span className="text-[11.5px] text-muted">{ago(e.updatedAt || e.startedAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <Badge>{e.subject?.type === 'pr' ? 'PR' : e.subject?.type || 'topic'}</Badge>
          {e.subject && e.subject.label !== e.title ? <span className="font-mono text-[11.5px] text-muted">{e.subject.label}</span> : null}
          {e.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />writing</Badge> : e.result === 'failed' ? <Badge tone="critical">failed</Badge> : null}
        </span>
        {e.summary ? <span className="mt-1 line-clamp-2 block text-[12.5px] leading-snug text-fg-2">{e.summary}</span> : null}
      </button>
    </li>
  );
}
