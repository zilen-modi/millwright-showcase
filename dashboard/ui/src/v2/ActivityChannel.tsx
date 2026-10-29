import { Activity } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRunEndEvents } from '@/hooks/stream';
import { cn } from '@/lib/utils';
import { diff, snapshot, type ActivityEvent, type Snapshot } from './activity';
import { ticketItems } from './channels';
import { useV2 } from './data';
import { sortItems, type Item } from './query';
import { ItemRow, ago } from './rows';
import { useThread } from './useListQuery';

const KEY = 'millwright.v2.activity';
const MAX = 200;

const Ctx = createContext<ActivityEvent[]>([]);

function readFeed(): ActivityEvent[] {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; }
}

/** Collects the feed for the whole session, whichever channel is open. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const { board, reviews } = useV2();
  const [feed, setFeed] = useState<ActivityEvent[]>(readFeed);
  const prev = useRef<Snapshot | null>(null);

  const add = (events: ActivityEvent[]) => {
    if (!events.length) return;
    setFeed((f) => {
      const next = [...events.reverse(), ...f].slice(0, MAX);
      try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* the feed lives in memory then */ }
      return next;
    });
  };

  useEffect(() => {
    if (!board) return;
    const next = snapshot(board.tickets, reviews);
    add(diff(prev.current, next, Date.now()));
    prev.current = next;
  }, [board, reviews]);

  useRunEndEvents((e) => {
    if (e.mode === 'chat') return; // an answer shows up in the ticket's chat, not as activity
    const kind = e.mode === 'explain' ? 'explainer' : /^PROJ-\d+$/.test(e.key) ? 'ticket' : 'review';
    const failed = e.status ? e.status === 'failed' : e.code !== 0;
    add([{
      id: `${Date.now()}:end:${e.key}:${e.mode}`, at: Date.now(), kind, ref: e.key, title: '',
      text: e.status === 'cancelled' ? `${e.mode} cancelled` : e.status === 'needs-input' ? `${e.mode} stopped to ask a question`
        : failed ? `${e.mode} failed${e.failure ? `: ${e.failure}` : ''}` : `${e.mode} finished`,
      tone: e.status === 'cancelled' ? 'muted' : failed ? 'critical' : e.status === 'needs-input' ? 'accent' : 'good',
    }]);
  });

  return <Ctx.Provider value={feed}>{children}</Ctx.Provider>;
}

export const useActivity = () => useContext(Ctx);

const DOT: Record<ActivityEvent['tone'], string> = {
  good: 'var(--good)', critical: 'var(--critical)', warning: 'var(--warning)', accent: 'var(--accent)', muted: 'var(--muted)',
};

export function ActivityChannel() {
  const feed = useActivity();
  const data = useV2();
  const { open } = useThread();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);
  const recent = useMemo(() => sortItems([
    ...ticketItems(data).filter((i) => i.kind === 'ticket' && i.ticket.column !== 'archived' && i.ticket.updatedAt),
    ...data.reviews.map((r): Item => ({ kind: 'review', id: r.ref, review: r })),
  ], '-updated').slice(0, 12), [data]);
  const titleOf = (ev: ActivityEvent) => ev.title
    || data.board?.tickets.find((t) => t.key === ev.ref)?.summary
    || data.reviews.find((r) => r.ref === ev.ref)?.title || '';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section aria-label="Live activity" className="border-b border-border">
        <h3 className="m-0 px-4 pt-3 pb-1.5 text-[11.5px] font-semibold text-fg-2">Since you opened the panel</h3>
        {feed.length === 0 ? (
          <p className="m-0 flex items-center gap-2 px-4 pb-4 text-[13px] text-muted">
            <Activity size={14} aria-hidden />Quiet so far. Runs starting and finishing, blocks, ready plans, merges and posted reviews appear here as they happen.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {feed.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={() => open({ kind: ev.kind, id: ev.ref })}
                  className="flex w-full cursor-pointer items-baseline gap-2.5 border-0 border-t border-border bg-transparent px-4 py-2 text-left hover:bg-surface-2"
                >
                  <span aria-hidden className="relative top-[-1px] h-2 w-2 flex-none rounded-full" style={{ background: DOT[ev.tone] }} />
                  <span className={cn('font-mono text-[12px] font-semibold', ev.kind === 'ticket' ? 'text-accent' : 'text-fg-2')}>{ev.kind === 'review' ? `#${ev.ref.split('-').pop()}` : ev.kind === 'explainer' ? 'explainer' : ev.ref}</span>
                  <span className="min-w-0 flex-1 text-[13px] text-fg">
                    {ev.text}
                    {titleOf(ev) ? <span className="ml-1.5 text-muted">· {titleOf(ev)}</span> : null}
                  </span>
                  <span className="text-[11.5px] text-muted">{ago(new Date(ev.at).toISOString())}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Recently updated">
        <h3 className="m-0 px-4 pt-3 pb-1.5 text-[11.5px] font-semibold text-fg-2">Recently updated</h3>
        <ul className="m-0 list-none border-t border-border p-0">
          {recent.map((it) => <ItemRow key={`${it.kind}:${it.id}`} item={it} focused={false} selected={false} />)}
        </ul>
      </section>
    </div>
  );
}
