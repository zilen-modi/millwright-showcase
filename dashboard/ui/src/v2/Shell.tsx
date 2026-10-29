import { Activity, ArrowLeftRight, FolderGit2, BookOpen, CircleDollarSign, Command as CommandIcon, Hash, Inbox, Menu as MenuIcon, Monitor, Moon, Pause, Play, Search as SearchIcon, Settings, Star, Sun } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, NavLink, Navigate, useParams } from 'react-router-dom';
import { Toaster } from 'sonner';

import { Tooltip } from '@/components/ui/tooltip';
import { useStreamStatus } from '@/hooks/stream';
import { useRuns } from '@/hooks/runs';
import { useTheme } from '@/hooks/useTheme';
import { Config } from '@/routes/Config';
import { cn } from '@/lib/utils';
import { ActivityChannel, ActivityProvider } from './ActivityChannel';
import { CHANNELS, channelById, channelCount, type ChannelDef } from './channels';
import { ChannelView } from './ChannelView';
import { CodeChannel } from './code/CodeChannel';
import { WorktreeThread } from './code/WorktreeThread';
import { CostChannel } from './CostChannel';
import { V2DataProvider, useV2 } from './data';
import { ExplainChannel } from './explain/ExplainChannel';
import { ExplainTab } from './explain/ExplainTab';
import { QueueChannel } from './QueueChannel';
import { Search } from './Search';
import { ReviewThread } from './thread/ReviewThread';
import { ThreadHeader, ThreadPaneContext } from './thread/ThreadHeader';
import { TicketThread } from './thread/TicketThread';
import { useThread } from './useListQuery';

const WIDTH_KEY = 'millwright.v2.threadWidth';
const SECTIONS: { id: ChannelDef['section']; label: string }[] = [
  { id: 'tickets', label: 'Tickets' }, { id: 'reviews', label: 'Reviews' }, { id: 'code', label: 'Code' }, { id: 'insights', label: 'Insights' },
];
const ICON: Record<string, typeof Hash> = { code: FolderGit2, activity: Activity, starred: Star, settings: Settings, 'review-inbox': Inbox, explain: BookOpen, cost: CircleDollarSign };

export function V2Shell() {
  return (
    <V2DataProvider>
      <ActivityProvider>
        <Workspace />
      </ActivityProvider>
    </V2DataProvider>
  );
}

function Workspace() {
  const { channel: channelId } = useParams();
  const channel = channelById(channelId);
  const { thread, close } = useThread();
  const { resolved } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(() => { try { return Number(localStorage.getItem(WIDTH_KEY)) || 560; } catch { return 560; } });
  const dragging = useRef(false);

  useEffect(() => { setNavOpen(false); }, [channelId]);
  useEffect(() => { if (!thread) setExpanded(false); }, [thread]);
  // Esc closes the thread, unless a dialog, menu or field is handling it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !thread) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [role="dialog"], [role="menu"]') || document.querySelector('[role="dialog"]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [thread, close]);

  if (!channel) return <Navigate to="/v2/needs-you" replace />;

  const startDrag = (e: ReactPointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDrag = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const w = Math.max(380, Math.min(window.innerWidth - 420, window.innerWidth - e.clientX));
    setWidth(w);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* width resets next visit */ }
  };

  return (
    <ThreadPaneContext.Provider value={{ expanded, toggleExpand: () => setExpanded((x) => !x), close }}>
      <div className="flex h-dvh overflow-hidden bg-page text-fg">
        <a href="#v2-main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:font-semibold focus:shadow-pop">Skip to content</a>

        {navOpen ? <div className="fixed inset-0 z-30 bg-[rgba(10,12,16,.4)] lg:hidden" onClick={() => setNavOpen(false)} aria-hidden /> : null}
        <Sidebar active={channel.id} open={navOpen} onSearch={() => setSearchOpen(true)} />

        <main id="v2-main" className={cn('relative flex min-w-0 flex-1 flex-col', thread && expanded && 'hidden')}>
          <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
            <button type="button" aria-label="Open channels" onClick={() => setNavOpen(true)} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-fg-2 hover:bg-surface-2 lg:hidden">
              <MenuIcon size={17} aria-hidden />
            </button>
            <h1 className="m-0 min-w-0 truncate text-[15px] font-bold">
              {channel.layout === 'list' && !['starred'].includes(channel.id) ? <span className="text-muted">#</span> : null}
              {channel.label}
            </h1>
            <span className="hidden min-w-0 truncate text-[12.5px] text-muted sm:inline">· {channel.description}</span>
            <span className="flex-1" />
            <button type="button" onClick={() => setSearchOpen(true)} className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-border-strong bg-page px-2.5 py-1 text-[12.5px] text-muted hover:text-fg lg:hidden">
              <SearchIcon size={13} aria-hidden />Search
            </button>
          </header>
          <ChannelBody channel={channel} />
        </main>

        {thread ? (
          <aside
            aria-label="Thread"
            className={cn(
              'flex min-w-0 flex-col border-l border-border bg-surface',
              'max-lg:fixed max-lg:inset-0 max-lg:z-20 max-lg:w-full',
              expanded ? 'lg:flex-1' : 'lg:relative lg:flex-none',
            )}
            style={expanded ? undefined : { width: `min(${width}px, 100%)` }}
          >
            {!expanded ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the thread"
                onPointerDown={startDrag}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
                onDoubleClick={() => { setWidth(560); try { localStorage.removeItem(WIDTH_KEY); } catch { /* fine */ } }}
                className="absolute top-0 bottom-0 -left-[3px] z-10 hidden w-[6px] cursor-col-resize hover:bg-accent/30 lg:block"
              />
            ) : null}
            <ThreadBody thread={thread} />
          </aside>
        ) : null}
      </div>
      <Search open={searchOpen} setOpen={setSearchOpen} />
      <Toaster position="bottom-right" closeButton richColors={false} theme={resolved} />
    </ThreadPaneContext.Provider>
  );
}

function ChannelBody({ channel }: { channel: ChannelDef }) {
  if (channel.layout === 'list') return <ChannelView key={channel.id} channel={channel} />;
  if (channel.layout === 'queue') return <QueueChannel />;
  if (channel.layout === 'cost') return <CostChannel />;
  if (channel.layout === 'explain') return <ExplainChannel />;
  if (channel.layout === 'activity') return <ActivityChannel />;
  if (channel.layout === 'code') return <CodeChannel />;
  return <div className="min-h-0 flex-1 overflow-y-auto p-4"><Config /></div>;
}

function ThreadBody({ thread }: { thread: NonNullable<ReturnType<typeof useThread>['thread']> }) {
  if (thread.kind === 'ticket') return <TicketThread key={thread.id} ticketKey={thread.id} />;
  if (thread.kind === 'review') return <ReviewThread key={thread.id} reviewRef={thread.id} />;
  if (thread.kind === 'worktree') return <WorktreeThread key={thread.id} id={thread.id} />;
  return (
    <div key={thread.id} className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader title="Explainer" subtitle="Plain words: the old ERP and the new ERP, side by side" />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4"><ExplainTab slug={thread.id} /></div>
    </div>
  );
}

function Sidebar({ active, open, onSearch }: { active: string; open: boolean; onSearch: () => void }) {
  const data = useV2();
  const connected = useStreamStatus();
  const { setPaused } = useRuns();
  const { pref, resolved, toggle } = useTheme();
  const paused = data.board?.automation.paused ?? false;
  const ThemeIcon = pref === 'system' ? Monitor : pref === 'dark' ? Moon : Sun;

  const link = (c: ChannelDef) => {
    const n = channelCount(c, data);
    const Icon = ICON[c.id] || Hash;
    const alert = c.badge === 'alert' && n;
    return (
      <NavLink
        key={c.id}
        to={`/v2/${c.id}`}
        className={({ isActive }) => cn(
          'flex items-center gap-2 rounded-[8px] px-2.5 py-[6px] text-[13.5px] no-underline transition-colors',
          isActive ? 'bg-accent-soft font-semibold text-accent' : alert ? 'font-semibold text-fg hover:bg-surface-3' : 'text-fg-2 hover:bg-surface-3 hover:text-fg',
        )}
      >
        <Icon size={15} aria-hidden className="flex-none opacity-80" />
        <span className="min-w-0 flex-1 truncate">{c.label}</span>
        {n ? (
          <span className={cn('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', alert && active !== c.id ? 'bg-accent text-on-accent' : 'text-muted')}>{n}</span>
        ) : null}
      </NavLink>
    );
  };

  return (
    <nav
      aria-label="Channels"
      className={cn(
        'flex w-[248px] flex-none flex-col border-r border-border bg-surface-2',
        'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:shadow-drawer max-lg:transition-transform',
        open ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
      )}
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[linear-gradient(135deg,#0f766e,#0891b2)] text-[14px] font-bold text-white">M</span>
        <div className="min-w-0">
          <p className="m-0 text-[15px] leading-tight font-bold">Millwright</p>
          <p className="m-0 flex items-center gap-1 text-[11.5px] text-muted" role="status" aria-live="polite">
            <span aria-hidden className={cn('h-[7px] w-[7px] rounded-full', paused ? 'bg-warning' : connected ? 'bg-good' : 'bg-muted')} />
            {paused ? 'paused' : connected ? 'live' : 'reconnecting…'}
          </p>
        </div>
      </div>
      <div className="px-3 pb-2">
        <button type="button" onClick={onSearch} className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[6px] text-[13px] text-muted hover:text-fg">
          <SearchIcon size={14} aria-hidden /><span className="flex-1 text-left">Search</span>
          <kbd className="flex items-center gap-0.5 font-sans text-[11px]"><CommandIcon size={11} aria-hidden />K</kbd>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {link(CHANNELS.find((c) => c.id === 'activity')!)}
        {SECTIONS.map((s) => (
          <div key={s.id} className="mt-3">
            <p className="m-0 px-2.5 pb-1 text-[11px] font-semibold tracking-[.04em] text-muted uppercase">{s.label}</p>
            {CHANNELS.filter((c) => c.section === s.id).map(link)}
          </div>
        ))}
        <div className="mt-3">{link(CHANNELS.find((c) => c.id === 'starred')!)}</div>
      </div>
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        {link(CHANNELS.find((c) => c.id === 'settings')!)}
      </div>
      <div className="flex items-center gap-1 px-3 pb-3">
        <Tooltip label={`Theme: ${pref}${pref === 'system' ? ` (${resolved})` : ''}`}>
          <button type="button" aria-label="Cycle the theme" onClick={toggle} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-fg-2 hover:bg-surface-3"><ThemeIcon size={15} aria-hidden /></button>
        </Tooltip>
        <Tooltip label={paused ? 'Resume Millwright' : 'Pause Millwright (cancels active runs)'}>
          <button type="button" aria-label={paused ? 'Resume Millwright' : 'Pause Millwright'} onClick={() => void setPaused(!paused)} className={cn('flex h-8 w-8 cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent hover:bg-surface-3', paused ? 'text-warning' : 'text-fg-2')}>
            {paused ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />}
          </button>
        </Tooltip>
        <span className="flex-1" />
        <Link to="/" className="flex items-center gap-1 rounded-[8px] px-2 py-1.5 text-[12px] font-semibold text-fg-2 no-underline hover:bg-surface-3 hover:text-fg">
          <ArrowLeftRight size={13} aria-hidden />Classic
        </Link>
      </div>
    </nav>
  );
}
