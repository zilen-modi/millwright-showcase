import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, ExternalLink, GitPullRequest,
  TerminalSquare, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { availableActions } from '../lib/ticketActions';
import { LogView } from '@/components/LogView';
import { Launcher } from '@/components/Launcher';
import { TicketDrawer } from '@/components/TicketDrawer';
import { useBoard } from '@/hooks/board';
import { useRuns } from '@/hooks/runs';
import { useTicketLog } from '@/hooks/useTicketLog';
import { money, shortDate, JIRA_BASE } from '@/lib/format';
import { phaseStyle } from '@/lib/phase';
import type { ColumnKey, TicketCard as Card } from '@/lib/types';
import { cn } from '@/lib/utils';

const COLLAPSED_KEY = 'autopilot.board.collapsed';

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* fall through to the default */ }
  return new Set(['archived']); // archived starts collapsed, as the legacy board did
}

export function Board() {
  const { state, error, loading } = useBoard();
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set());

  // The open drawer lives in the URL (`/board?ticket=PROJ-1234`) so the command palette can
  // jump straight to a ticket and a reload keeps the operator where they were.
  const [params, setParams] = useSearchParams();
  const detailKey = params.get('ticket');
  const setDetailKey = useCallback((key: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key) next.set('ticket', key); else next.delete('ticket');
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* private mode */ }
  }, [collapsed]);

  const toggleCol = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleLog = useCallback((key: string) => {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const byColumn = useMemo(() => {
    const map = new Map<ColumnKey, Card[]>();
    if (!state) return map;
    for (const c of state.columns) map.set(c.key, []);
    for (const t of state.tickets) {
      if (!map.has(t.column)) map.set(t.column, []);
      map.get(t.column)!.push(t);
    }
    for (const q of state.queue || []) {
      map.get('queued')?.push({
        key: q.key, summary: q.key, phase: 'queued', column: 'queued', queued: true,
        prUrl: null, jiraStatus: null, rubricScore: null, updatedAt: null, costUsd: 0,
        tokens: 0, running: false, manuallyArchived: false, planReady: false,
      });
    }
    return map;
  }, [state]);

  return (
    <>
      <Launcher />

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-critical">Could not load the board: {error}</p>
      ) : null}
      {loading && !state ? (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <Spinner label="Loading board" /> Loading the board…
        </p>
      ) : null}

      {state ? (
        <div
          className="mt-4 flex items-start gap-3 overflow-x-auto pb-4"
          role="list"
          aria-label="Phase board"
        >
          {state.columns.map((col) => {
            const cards = byColumn.get(col.key) || [];
            const isCollapsed = collapsed.has(col.key);
            return (
              <section
                key={col.key}
                role="listitem"
                aria-label={`${col.label} — ${cards.length} tickets`}
                style={phaseStyle(col.key)}
                className={cn(
                  'flex shrink-0 flex-col rounded-panel border border-border bg-surface-2/60',
                  isCollapsed ? 'w-[62px]' : 'w-[286px] max-w-[86vw]',
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleCol(col.key)}
                  aria-expanded={!isCollapsed}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-t-panel border-0 bg-transparent px-3 py-2.5 text-left',
                    'text-[11px] font-bold uppercase tracking-[.05em] text-fg-2 hover:text-fg',
                    isCollapsed && 'flex-col gap-1.5 py-3',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: 'var(--ph)' }}
                  />
                  {isCollapsed ? null : <span className="min-w-0 flex-1 truncate">{col.label}</span>}
                  <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10.5px] tabular-nums text-fg-2">
                    {cards.length}
                  </span>
                  {isCollapsed
                    ? <ChevronRight size={13} aria-hidden />
                    : <ChevronDown size={13} aria-hidden />}
                </button>

                {isCollapsed ? null : (
                  <div className="flex min-h-[64px] flex-col gap-2 px-2 pb-2">
                    {cards.length === 0 ? (
                      <p className="m-0 px-1 py-3 text-center text-xs text-muted">—</p>
                    ) : (
                      cards.map((t) => (
                        <TicketCard
                          key={t.key}
                          card={t}
                          onOpenDetail={() => setDetailKey(t.key)}
                          logOpen={openLogs.has(t.key)}
                          onToggleLog={() => toggleLog(t.key)}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : null}

      <TicketDrawer ticketKey={detailKey} onClose={() => setDetailKey(null)} />
    </>
  );
}

function TicketCard({
  card,
  onOpenDetail,
  logOpen,
  onToggleLog,
}: {
  card: Card;
  onOpenDetail: () => void;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const { pending, failed, run, cancel, setArchived, checkMerge, clearFailed } = useRuns();
  const starting = pending[card.key];
  const failure = failed[card.key];
  const { lines } = useTicketLog(card.key, logOpen);

  return (
    <article
      style={phaseStyle(card.phase || card.column)}
      className={cn(
        'phase-bar relative rounded-[10px] border border-border bg-surface py-2.5 pl-3.5 pr-2.5 shadow-card',
        'transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-pop',
        card.running && 'border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]',
      )}
    >
      <div className="flex items-center gap-2">
        <a
          href={JIRA_BASE + card.key}
          target="_blank"
          rel="noopener"
          className="font-mono text-xs font-bold text-accent no-underline hover:underline"
        >
          {card.key}
        </a>
        <span className="flex-1" />
        {card.updatedAt ? (
          <span className="text-[10.5px] tabular-nums text-muted">{shortDate(card.updatedAt)}</span>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onOpenDetail}
        className="mt-1 block w-full cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] font-semibold leading-snug text-fg hover:text-accent"
      >
        {card.summary || card.key}
      </button>

      <div className="mt-2 flex flex-wrap gap-1">
        {card.planReady ? <Badge tone="warning">Plan ready — review</Badge> : null}
        {card.blocked ? <Badge tone="critical">blocked{card.blockedStage ? ` · ${card.blockedStage}` : ''}</Badge> : null}
        {card.stale && !card.blocked ? (
          <Tooltip label={`Idle ${card.stale.idleHours ?? '?'}h (threshold ${card.stale.thresholdHours}h)`}>
            <Badge tone="warning">stale</Badge>
          </Tooltip>
        ) : null}
        {card.phase ? <Badge tone="phase">{card.phase}</Badge> : null}
        {typeof card.rubricScore === 'number' ? (
          <Badge tone={card.rubricScore >= 0.9 ? 'good' : 'warning'}>rubric {card.rubricScore.toFixed(2)}</Badge>
        ) : typeof card.rubricUnverified === 'number' ? (
          <Tooltip label={`status.json claims ${card.rubricUnverified.toFixed(2)}, but no rubric.jsonl receipt backs it. Only scripts/loop.mjs writes a real score — re-run review to get one. A PR cannot be opened on this.`}>
            <Badge tone="warning">rubric {card.rubricUnverified.toFixed(2)} unverified</Badge>
          </Tooltip>
        ) : null}
        {card.costUsd ? <Badge>{money(card.costUsd)}</Badge> : null}
        {card.jiraStatus ? <Badge>{card.jiraStatus}</Badge> : null}
        {card.prUrl ? (
          <a href={card.prUrl} target="_blank" rel="noopener" className="no-underline">
            <Badge tone="accent"><GitPullRequest size={11} aria-hidden />PR</Badge>
          </a>
        ) : null}
      </div>

      {card.blocked && card.blockedReason ? (
        <p className="mt-2 mb-0 rounded-lg bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2 py-1.5 text-[11.5px] leading-snug text-fg-2">
          {card.blockedReason}
        </p>
      ) : null}

      {failure ? (
        <div
          role="alert"
          className="mt-2 flex items-start gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,var(--border))] bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2 py-1.5"
        >
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-fg-2">
            <strong className="text-critical">
              {failure.mode} {failure.phase === 'run' ? 'failed.' : 'failed to start.'}
            </strong>{' '}
            {failure.reason || failure.message}
          </span>
          <button
            type="button"
            aria-label={`Dismiss the failure notice for ${card.key}`}
            onClick={() => clearFailed(card.key)}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-fg"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {card.running ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent">
              <Spinner /> running{card.runMode ? ` · ${card.runMode}` : ''}
            </span>
            <Button variant="danger" onClick={() => void cancel(card.key)}>Cancel</Button>
          </>
        ) : starting ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent">
            <Spinner /> starting {starting}…
          </span>
        ) : card.column === 'archived' ? (
          <Button onClick={() => void setArchived(card.key, false)}>
            <ArchiveRestore size={12} aria-hidden />Unarchive
          </Button>
        ) : card.column === 'ship' ? (
          <>
            <Button onClick={() => void checkMerge(card.key)}>Check merge</Button>
            <Button variant="muted" onClick={() => void setArchived(card.key, true)}>
              <Archive size={12} aria-hidden />Archive
            </Button>
          </>
        ) : card.planReady ? (
          <>
            <Button variant="approve" onClick={() => void run(card.key, 'build')}>Approve &amp; Build</Button>
            <Button onClick={onOpenDetail}>Review plan</Button>
            <Button variant="muted" onClick={() => void setArchived(card.key, true)}>
              <Archive size={12} aria-hidden />Archive
            </Button>
          </>
        ) : (
          <>
            {availableActions(card).map((action) => (
              <Tooltip key={`${action.mode}-${action.label}`} label={action.disabledReason ?? action.hint ?? ''}>
                <Button
                  variant={action.variant}
                  disabled={Boolean(action.disabledReason)}
                  onClick={() => void run(card.key, action.mode)}
                >
                  {action.label}
                </Button>
              </Tooltip>
            ))}
            {card.queued ? null : (
              <Button variant="muted" onClick={() => void setArchived(card.key, true)}>
                <Archive size={12} aria-hidden />Archive
              </Button>
            )}
          </>
        )}
      </div>

      {card.queued ? null : (
        <>
          <button
            type="button"
            onClick={onToggleLog}
            aria-expanded={logOpen}
            className="mt-2 flex w-fit cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[11px] font-semibold text-muted hover:text-accent"
          >
            {logOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            <TerminalSquare size={12} aria-hidden />
            live log
          </button>
          {logOpen ? (
            <LogView
              className="mt-1.5 max-h-[190px]"
              label={`Run log for ${card.key}`}
              lines={lines}
              empty="No log output yet."
            />
          ) : null}
        </>
      )}

      {card.prUrl ? (
        <a
          href={card.prUrl}
          target="_blank"
          rel="noopener"
          className="mt-2 flex w-fit items-center gap-1 text-[11px] font-semibold text-accent no-underline hover:underline"
        >
          open PR <ExternalLink size={11} aria-hidden />
        </a>
      ) : null}
    </article>
  );
}
