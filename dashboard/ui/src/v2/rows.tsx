import { ExternalLink, GitPullRequest, MoreHorizontal, Star } from 'lucide-react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LiveDot, Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { useRuns } from '@/hooks/runs';
import { JIRA_BASE, money } from '@/lib/format';
import { phaseColor } from '@/lib/phase';
import { blocker } from '@/lib/prInbox';
import type { PrInboxRow, PrReviewCard, TicketCard } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ticketCommands, type Command } from './commands';
import { useV2 } from './data';
import { useStartReview, useTicketDispatch } from './dispatch';
import { Menu, MenuItem } from './Menu';
import type { Item } from './query';
import { useThread } from './useListQuery';

/** "3m", "5h", "2d" - lists read faster with relative times; the thread shows the exact one. */
export function ago(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/** Jira summaries here often repeat the key ("PROJ-3907 — Branch…"); the row already shows it. */
export const cleanSummary = (key: string, summary: string) => summary.replace(new RegExp(`^\\s*${key}\\s*[-—:]\\s*`, 'i'), '');

/** The one action most likely wanted next, shown on the row; the rest live in ⋯. */
function primaryOf(t: TicketCard, cmds: Command[]): Command | null {
  const order = t.running ? ['cancel'] : t.blocked ? ['continue'] : t.planReady ? ['build'] : t.column === 'ship' ? ['check-merge']
    : t.column === 'archived' ? ['unarchive'] : t.canContinue ? ['continue'] : t.queued ? ['plan'] : [];
  for (const name of order) {
    const c = cmds.find((x) => x.name === name && !x.disabledReason);
    if (c) return c;
  }
  return null;
}

function RowShell({
  item,
  focused,
  selected,
  accent,
  children,
}: {
  item: Item;
  focused: boolean;
  selected: boolean;
  accent: string;
  children: ReactNode;
}) {
  const { open } = useThread();
  const openIt = () => open(item.kind === 'ticket' ? { kind: 'ticket', id: item.id }
    : item.kind === 'review' ? { kind: 'review', id: item.id }
    : item.pr.review ? { kind: 'review', id: item.pr.review.ref } : null);
  return (
    <li
      data-row-id={item.id}
      tabIndex={-1}
      aria-selected={selected}
      onClick={openIt}
      onKeyDown={(e) => { if (e.key === 'Enter') openIt(); }}
      className={cn(
        'group relative cursor-pointer border-b border-border py-2 pr-3 pl-4 outline-none',
        selected ? 'bg-accent-soft' : focused ? 'bg-surface-2' : 'hover:bg-surface-2',
      )}
    >
      <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-[3px] rounded-full" style={{ background: accent }} />
      {children}
    </li>
  );
}

function StarButton({ id }: { id: string }) {
  const { starred, toggleStar } = useV2();
  const on = starred.has(id);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Unstar ${id}` : `Star ${id}`}
      onClick={(e) => { stop(e); toggleStar(id); }}
      className={cn('cursor-pointer border-0 bg-transparent p-0.5', on ? 'text-warning' : 'text-muted opacity-0 group-hover:opacity-100 focus:opacity-100')}
    >
      <Star size={13} aria-hidden fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

export function TicketRow({ item, focused, selected }: { item: Extract<Item, { kind: 'ticket' }>; focused: boolean; selected: boolean }) {
  const t = item.ticket;
  const { pending, failed, clearFailed } = useRuns();
  const dispatch = useTicketDispatch();
  const cmds = ticketCommands(t);
  const primary = primaryOf(t, cmds);
  // Asking happens in the thread's chat; the row menu keeps to actions.
  const rest = cmds.filter((c) => c !== primary && c.name !== 'ask');
  const fail = failed[t.key];

  return (
    <RowShell item={item} focused={focused} selected={selected} accent={t.blocked || fail ? 'var(--critical)' : phaseColor(t.column === 'archived' ? 'archived' : t.phase || t.column)}>
      <div className="flex items-center gap-2">
        <a href={JIRA_BASE + t.key} target="_blank" rel="noopener" onClick={stop} className="font-mono text-[12.5px] font-semibold text-accent">{t.key}</a>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{cleanSummary(t.key, t.summary) || (t.queued ? 'Labelled in Jira, not started' : '—')}</span>
        <StarButton id={t.key} />
        <span className="text-[11.5px] tabular-nums text-muted">{t.costUsd ? money(t.costUsd) : ''}</span>
        <span className="w-12 flex-none whitespace-nowrap text-right text-[11.5px] text-muted">{ago(t.updatedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {t.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />{t.runMode || 'running'}</Badge>
          : pending[t.key] ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />starting {pending[t.key]}</Badge> : null}
        {t.blocked ? <Badge tone="critical">blocked · {t.blockedStage || t.phase}</Badge> : null}
        {fail ? (
          <Badge tone="critical">
            {fail.mode} failed
            <button type="button" aria-label="Dismiss" onClick={(e) => { stop(e); clearFailed(t.key); }} className="cursor-pointer border-0 bg-transparent p-0 text-critical">×</button>
          </Badge>
        ) : null}
        {t.planReady ? <Badge tone="warning">plan ready</Badge> : null}
        {t.queued ? <Badge>queued</Badge> : null}
        {!t.running && !t.blocked && !t.planReady && !t.queued ? <Badge tone="phase" style={{ ['--ph' as string]: phaseColor(t.phase) }}>{t.column === 'ship' ? 'awaiting merge' : t.phase || t.column}</Badge> : null}
        {t.stale && !t.blocked ? <Tooltip label={`Idle ${t.stale.idleHours ?? '?'}h (threshold ${t.stale.thresholdHours}h)`}><Badge tone="warning">stale</Badge></Tooltip> : null}
        {t.rubricScore != null ? <Badge tone={t.rubricScore >= 0.9 ? 'good' : 'warning'}>rubric {t.rubricScore.toFixed(2)}</Badge>
          : t.rubricUnverified != null ? <Tooltip label="No rubric.jsonl receipt - a PR cannot open on this score"><Badge tone="warning">rubric {t.rubricUnverified.toFixed(2)} unverified</Badge></Tooltip> : null}
        {t.jiraStatus ? <span className="text-[11.5px] text-muted">{t.jiraStatus}</span> : null}
        {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noopener" onClick={stop} className="inline-flex items-center gap-0.5 text-[11.5px] text-accent"><GitPullRequest size={11} aria-hidden />PR</a> : null}
        {t.blocked && t.blockedReason ? <span className="min-w-0 max-w-full truncate text-[11.5px] text-muted">{t.blockedReason}</span> : null}
        <span className="flex-1" />
        <span className="flex items-center gap-1" onClick={stop}>
          {primary ? (
            <Tooltip label={primary.hint || primary.label}>
              <Button size="sm" variant={primary.name === 'build' ? 'approve' : primary.name === 'cancel' ? 'danger' : 'secondary'} onClick={() => void dispatch(t.key, primary)}>
                {primary.label}
              </Button>
            </Tooltip>
          ) : null}
          {rest.length ? (
            <Menu label={`More actions for ${t.key}`} align="right" trigger={() => (
              <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border border-border bg-surface text-fg-2 opacity-60 group-hover:opacity-100 hover:bg-surface-2"><MoreHorizontal size={14} aria-hidden /></span>
            )}>
              {(close) => rest.map((c) => (
                <MenuItem key={c.name} hint={c.disabledReason ? 'unavailable' : `/${c.name}`} onSelect={() => { close(); if (!c.disabledReason) void dispatch(t.key, c); }}>
                  <span className={c.disabledReason ? 'text-muted' : ''} title={c.disabledReason || c.hint}>{c.label}</span>
                </MenuItem>
              ))}
            </Menu>
          ) : null}
        </span>
      </div>
    </RowShell>
  );
}

const RESULT_TONE: Record<string, 'critical' | 'accent' | 'good' | 'warning'> = {
  failed: 'critical', cancelled: 'critical', blocked: 'critical', 'needs-input': 'accent', 'pushed-fix': 'good',
};

export function ReviewRow({ item, focused, selected }: { item: Extract<Item, { kind: 'review' }>; focused: boolean; selected: boolean }) {
  const r: PrReviewCard = item.review;
  const start = useStartReview();
  const num = r.prUrl?.match(/\/pull\/(\d+)/)?.[1] || r.ref.split('-').pop();
  const repo = r.prUrl?.match(/github\.com\/[^/]+\/([^/]+)\//)?.[1]?.replace(/^erp-next-/, '') || '';
  const f = r.triage;
  return (
    <RowShell item={item} focused={focused} selected={selected} accent={r.running ? 'var(--accent)' : r.failure ? 'var(--critical)' : f?.undecided ? 'var(--warning)' : 'var(--muted)'}>
      <div className="flex items-center gap-2">
        {r.prUrl ? (
          <a href={r.prUrl} target="_blank" rel="noopener" onClick={stop} className="font-mono text-[12.5px] font-semibold text-accent">{repo}#{num}</a>
        ) : <span className="font-mono text-[12.5px] text-muted">{r.ref}</span>}
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{r.title || r.ref}</span>
        <StarButton id={r.ref} />
        <span className="text-[11.5px] tabular-nums text-muted">{r.costUsd ? money(r.costUsd) : ''}</span>
        <span className="w-12 flex-none whitespace-nowrap text-right text-[11.5px] text-muted">{ago(r.updatedAt || r.startedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {r.running ? <Badge tone="accent"><LiveDot />reviewing</Badge>
          : r.resultUnrecorded ? <Badge>finished</Badge>
          : r.result ? <Badge tone={RESULT_TONE[r.result] || (r.retryable ? 'warning' : undefined)}>{r.result}</Badge> : null}
        {r.prState === 'MERGED' ? <Badge>PR merged</Badge> : r.prState === 'CLOSED' ? <Badge>PR closed</Badge> : null}
        <span className="text-[11.5px] text-muted">{r.isOwn === true ? 'yours' : r.isOwn === false ? 'someone else' : ''}</span>
        {f ? (
          <>
            {f.undecided ? <Badge tone="warning">{f.undecided} to decide</Badge> : null}
            {f.toPost ? <Badge tone="accent">{f.toPost} to post</Badge> : null}
            {f.posted ? <Badge tone="good">{f.posted} on the PR</Badge> : null}
            {f.round > 1 ? <span className="text-[11.5px] text-muted">round {f.round}</span> : null}
          </>
        ) : null}
        {r.result === 'needs-input' && r.question ? <span className="min-w-0 truncate text-[11.5px] text-muted">asked: {r.question}</span>
          : r.failure ? <span className="min-w-0 truncate text-[11.5px] text-muted">{r.failure}</span> : null}
        <span className="flex-1" />
        {r.retryable && r.prUrl && !r.running ? (
          <span onClick={stop}><Button size="sm" onClick={() => void start(r.prUrl as string, r.ref)}>Retry</Button></span>
        ) : null}
      </div>
    </RowShell>
  );
}

export function InboxRow({ item, focused, selected }: { item: Extract<Item, { kind: 'inbox' }>; focused: boolean; selected: boolean }) {
  const p: PrInboxRow = item.pr;
  const { inboxState } = useV2();
  const start = useStartReview();
  const block = blocker(p);
  const cap = inboxState?.capacity;
  const full = !!cap && cap.running >= cap.max;
  const why = !p.inManifest ? `${p.repoSlug} is not in repo-manifest.json, so a review would stop straight away.`
    : full ? `${cap!.running} of ${cap!.max} reviews are already running.` : null;
  return (
    <RowShell item={item} focused={focused} selected={selected} accent={block?.tone === 'critical' ? 'var(--critical)' : block ? 'var(--warning)' : p.isDraft ? 'var(--muted)' : 'var(--good)'}>
      <div className="flex items-center gap-2">
        <a href={p.url} target="_blank" rel="noopener" onClick={stop} className="font-mono text-[12.5px] font-semibold text-accent">{p.repo.replace(/^erp-next-/, '')}#{p.number}</a>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg" title={p.title}>{p.title}</span>
        <span className="text-[11.5px] text-muted">{p.bucket === 'mine' ? `→ ${p.baseRefName || ''}` : p.author}</span>
        <span className="w-12 flex-none whitespace-nowrap text-right text-[11.5px] text-muted">{ago(p.updatedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {p.isDraft ? <Badge>draft</Badge> : null}
        {p.reviewDecision === 'APPROVED' ? <Badge tone="good">approved</Badge> : p.reviewDecision === 'CHANGES_REQUESTED' ? <Badge tone="warning">changes requested</Badge> : null}
        {p.requestedVia?.kind === 'team' ? <Tooltip label={`Requested from ${p.requestedVia.label}`}><Badge tone="accent">via team</Badge></Tooltip> : null}
        {p.myReviewState === 'CHANGES_REQUESTED' ? <Badge tone="warning">you asked changes</Badge> : null}
        {p.myReviewStale ? <Tooltip label="New commits since your last review"><Badge tone="warning">branch moved</Badge></Tooltip> : null}
        {block ? <Tooltip label={block.why}><Badge tone={block.tone}>{block.label}</Badge></Tooltip> : !p.isDraft ? <Badge tone="good">ready to merge</Badge> : null}
        {p.review?.running ? <Badge tone="accent"><LiveDot />reviewing</Badge>
          : p.review ? <span className="text-[11.5px] text-muted">{p.reviewStatus === 'done-stale' ? 'reviewed · branch moved since' : `reviewed: ${p.review.result || p.reviewStatus}`}</span> : null}
        <span className="flex-1" />
        <span onClick={stop} className="flex items-center gap-1">
          {p.review?.running ? null : (
            <Tooltip label={why || (p.reviewStatus === 'never' ? 'Review this PR' : 'Review it again, compared with the last round')}>
              <Button size="sm" variant={p.reviewStatus === 'never' ? 'primary' : 'secondary'} disabled={!!why} onClick={() => void start(p.url, `${p.repo}#${p.number}`)}>
                {p.reviewStatus === 'never' ? 'Review' : 'Re-review'}
              </Button>
            </Tooltip>
          )}
          <a href={p.url} target="_blank" rel="noopener" aria-label="Open on GitHub" className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-fg-2 hover:bg-surface-2"><ExternalLink size={13} aria-hidden /></a>
        </span>
      </div>
    </RowShell>
  );
}

export function ItemRow({ item, focused, selected }: { item: Item; focused: boolean; selected: boolean }) {
  if (item.kind === 'ticket') return <TicketRow item={item} focused={focused} selected={selected} />;
  if (item.kind === 'review') return <ReviewRow item={item} focused={focused} selected={selected} />;
  return <InboxRow item={item} focused={focused} selected={selected} />;
}
