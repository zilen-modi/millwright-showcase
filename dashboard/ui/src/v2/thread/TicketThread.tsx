import { AlertTriangle, Check, CircleDot, FileText, GitPullRequest, Loader, XCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { LogView } from '@/components/LogView';
import { TicketShots } from '@/components/TicketShots';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBoard } from '@/hooks/board';
import { useResource } from '@/hooks/useResource';
import { useRuns } from '@/hooks/runs';
import { useTicketLog } from '@/hooks/useTicketLog';
import { api } from '@/lib/api';
import { JIRA_BASE, duration, money, tokens } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { STAGE_ORDER, phaseColor } from '@/lib/phase';
import type { TicketArtifacts, TicketDetail } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ticketCommands } from '../commands';
import { useTicketDispatch } from '../dispatch';
import { ExplainTab, useExplainerFor } from '../explain/ExplainTab';
import { cleanSummary } from '../rows';
import { Chat, askTicket } from './Chat';
import { Composer } from './Composer';
import { PlanReview } from './PlanReview';
import { Questions } from './Questions';
import { ThreadHeader } from './ThreadHeader';

const FILES: { id: keyof TicketArtifacts; label: string }[] = [
  { id: 'plan', label: 'plan.md' }, { id: 'design', label: 'design.md' }, { id: 'context', label: 'context.md' },
  { id: 'review', label: 'review.md' }, { id: 'verify', label: 'verify.md' }, { id: 'ticket', label: 'ticket.md' },
];

export function TicketThread({ ticketKey }: { ticketKey: string }) {
  const { state } = useBoard();
  const { failed, pending } = useRuns();
  const dispatch = useTicketDispatch();
  const card = state?.tickets.find((t) => t.key === ticketKey)
    || (state?.queue.some((q) => q.key === ticketKey) ? {
      key: ticketKey, summary: '', phase: 'queued', column: 'queued' as const, prUrl: null, jiraStatus: null, rubricScore: null,
      updatedAt: null, costUsd: 0, tokens: 0, running: false, manuallyArchived: false, planReady: false, queued: true,
    } : null);
  const fetcher = useCallback((signal: AbortSignal) => api.ticket(ticketKey, signal), [ticketKey]);
  const { data, error, refresh } = useResource<TicketDetail>(fetcher, [ticketKey]);
  const detail = data && data.key === ticketKey ? data : null;
  const [tab, setTab] = useState('thread');
  const [file, setFile] = useState<keyof TicketArtifacts>('plan');
  const { lines } = useTicketLog(ticketKey, tab === 'log' || !!card?.running);
  const explainer = useExplainerFor(ticketKey);

  if (!card) {
    return (
      <>
        <ThreadHeader title={<span className="font-mono">{ticketKey}</span>} subtitle={state ? 'Not on the board - it may have been removed.' : 'Loading…'} />
        <div className="p-4 text-[13px] text-muted">{state ? 'Nothing to show.' : <Spinner label="Loading" />}</div>
      </>
    );
  }

  const fail = failed[ticketKey];
  const commands = ticketCommands(card);
  const lastCompletedIdx = (STAGE_ORDER as readonly string[]).indexOf(card.lastCompleted || '');
  const openFile = (id: keyof TicketArtifacts) => { setFile(id); setTab('files'); };

  return (
    <>
      <ThreadHeader
        starId={card.key}
        title={<a href={JIRA_BASE + card.key} target="_blank" rel="noopener" className="font-mono text-accent">{card.key}</a>}
        subtitle={cleanSummary(card.key, card.summary) || (card.queued ? 'Labelled in Jira, not started yet' : '')}
        links={card.prUrl ? [{ href: card.prUrl, label: 'PR', icon: <GitPullRequest size={13} aria-hidden /> }] : []}
      >
        {card.queued ? null : (
          <>
            <ol aria-label="Pipeline stages" className="m-0 mt-2 flex list-none gap-[3px] p-0">
              {STAGE_ORDER.map((s, i) => {
                const st = card.blocked && (card.blockedStage || card.phase) === s ? 'blocked'
                  : i <= lastCompletedIdx ? 'done' : s === card.phase ? (card.running ? 'active' : 'current') : 'pending';
                return (
                  <li key={s} title={`${s}: ${st}`} className="flex-1">
                    <span className={cn('block h-[5px] rounded-full', st === 'active' && 'anim-pulse')} style={{
                      background: st === 'blocked' ? 'var(--critical)' : st === 'done' ? 'var(--good)' : st === 'active' || st === 'current' ? phaseColor(s) : 'var(--border-strong)',
                    }} />
                    <span className={cn('mt-0.5 block truncate text-center text-[10px]', s === card.phase ? 'font-semibold text-fg' : 'text-muted')}>{s}</span>
                  </li>
                );
              })}
            </ol>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {card.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />{card.runMode || 'running'}</Badge> : null}
              {card.rubricScore != null ? <Badge tone={card.rubricScore >= 0.9 ? 'good' : 'warning'}>rubric {card.rubricScore.toFixed(2)}</Badge>
                : card.rubricUnverified != null ? <Badge tone="warning">rubric {card.rubricUnverified.toFixed(2)} unverified</Badge> : null}
              <Badge>{money(card.costUsd)} · {tokens(card.tokens)} tok</Badge>
              {card.jiraStatus ? <Badge>{card.jiraStatus}</Badge> : null}
              {card.stale ? <Badge tone="warning">stale {card.stale.idleHours ?? '?'}h</Badge> : null}
              {card.manuallyArchived ? <Badge>archived</Badge> : null}
            </div>
          </>
        )}
      </ThreadHeader>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="px-3">
          <TabsTrigger value="thread">Thread</TabsTrigger>
          {detail?.planReview?.blocks.length ? (
            <TabsTrigger value="plan">Plan{detail.planReview.open ? ` · ${detail.planReview.open}` : ''}</TabsTrigger>
          ) : null}
          {card.queued ? null : <TabsTrigger value="chat">Chat</TabsTrigger>}
          <TabsTrigger value="files" disabled={!detail}>Files</TabsTrigger>
          {detail?.shots ? <TabsTrigger value="screens">Screens</TabsTrigger> : null}
          <TabsTrigger value="log">Log</TabsTrigger>
          {explainer ? <TabsTrigger value="explain">Explain</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="thread" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? <p className="text-[13px] text-critical">Could not load the ticket: {error}</p> : null}
          {detail?.planReview ? <Questions card={card} review={detail.planReview} /> : null}
          {card.planReady && detail?.planReview ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-panel border border-[color-mix(in_srgb,var(--warning)_40%,var(--border))] bg-surface px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13.5px] font-semibold text-fg">Plan{detail.planReview.current ? ` v${detail.planReview.current}` : ''} is ready for your review</p>
                <p className="m-0 mt-0.5 text-[12.5px] text-muted">
                  {detail.planReview.blocks.filter((b) => b.kind === 'step').length} steps
                  {detail.planReview.checklist.length ? ` · ${detail.planReview.checklist.length} acceptance criteria` : ''}
                  {detail.planReview.open ? ` · ${detail.planReview.open} open comment${detail.planReview.open === 1 ? '' : 's'}` : ''}
                  {detail.planReview.changed ? ' · changed since the last version' : ''}
                </p>
              </div>
              <button type="button" onClick={() => setTab('plan')} className="cursor-pointer rounded-[9px] border-0 bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-on-accent">Review the plan</button>
            </div>
          ) : null}
          {card.blocked ? (
            <Message icon={<AlertTriangle size={14} aria-hidden />} tone="critical" title={`Blocked at ${card.blockedStage || card.phase}`}>
              {card.blockedReason || 'No reason recorded.'}
              {commands.some((c) => c.name === 'continue' && !c.disabledReason) ? <p className="mt-1 mb-0 text-muted">Type <code>/continue</code> to resume, or <code>/continue</code> followed by what to do differently. Plain text asks a question instead.</p> : null}
            </Message>
          ) : null}
          {fail ? (
            <Message icon={<XCircle size={14} aria-hidden />} tone="critical" title={`${fail.mode} ${fail.phase === 'start' ? 'failed to start' : 'failed'}`}>{fail.reason || fail.message}</Message>
          ) : null}
          {pending[card.key] && !card.running ? <Message icon={<Loader size={14} aria-hidden />} tone="accent" title={`Starting ${pending[card.key]}…`} /> : null}

          {detail?.timeline.length ? detail.timeline.map((row, i) => (
            <Message
              key={`${row.stage}-${i}`}
              icon={row.status === 'ok' ? <Check size={14} aria-hidden /> : row.status === 'blocked' ? <AlertTriangle size={14} aria-hidden /> : <CircleDot size={14} aria-hidden />}
              tone={row.status === 'ok' ? 'good' : row.status === 'blocked' ? 'critical' : 'warning'}
              title={row.stage}
              meta={[row.agent, row.status, duration(row.durationSec), row.tokensTotal ? `${tokens(row.tokensTotal)} tok` : ''].filter(Boolean).join(' · ')}
            >
              {row.notes || null}
            </Message>
          )) : detail ? <p className="text-[13px] text-muted">{card.queued ? 'Nothing has run yet. /plan starts it.' : 'No stage events yet.'}</p> : <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p>}

          {detail ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {FILES.filter((f) => detail.artifacts[f.id]).map((f) => (
                <button key={f.id} type="button" onClick={() => openFile(f.id)} className="inline-flex cursor-pointer items-center gap-1 rounded-[7px] border border-border bg-surface px-2 py-1 text-[12px] text-fg-2 hover:border-border-strong hover:text-fg">
                  <FileText size={12} aria-hidden />{f.label}
                </button>
              ))}
            </div>
          ) : null}

          {card.running ? (
            <Message icon={<Spinner className="h-3 w-3 border" />} tone="accent" title={`${card.runMode || 'run'} in progress`}>
              <pre className="m-0 mt-1 max-h-[140px] overflow-hidden rounded-[7px] bg-log-bg px-2 py-1.5 font-mono text-[11px] text-log-fg">{lines.slice(-8).join('\n') || 'waiting for output…'}</pre>
            </Message>
          ) : null}
        </TabsContent>

        {detail?.planReview?.blocks.length ? (
          <TabsContent value="plan" className="min-h-0 flex-1 overflow-y-auto px-4 pt-0">
            <PlanReview card={card} review={detail.planReview} onChange={refresh} />
          </TabsContent>
        ) : null}

        {card.queued ? null : (
          <TabsContent value="chat" className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"><Chat card={card} /></TabsContent>
        )}

        <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {detail ? (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {FILES.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={!detail.artifacts[f.id]}
                    onClick={() => setFile(f.id)}
                    aria-pressed={file === f.id}
                    className={cn(
                      'cursor-pointer rounded-[7px] border px-2 py-1 font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-40',
                      file === f.id ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-fg-2',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <Markdown source={detail.artifacts[file]} />
            </>
          ) : null}
        </TabsContent>

        {detail?.shots ? (
          <TabsContent value="screens" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><TicketShots shots={detail.shots} /></TabsContent>
        ) : null}

        <TabsContent value="log" className="min-h-0 flex-1 px-4 pb-4">
          <LogView className="h-full max-h-none" label={`Run log for ${card.key}`} lines={lines} empty="No log output yet." />
        </TabsContent>

        {explainer ? (
          <TabsContent value="explain" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><ExplainTab slug={explainer} /></TabsContent>
        ) : null}
      </Tabs>

      <Composer
        commands={commands}
        onRun={async (c, args) => {
          if (c.action.type === 'ask') { if (await askTicket(card.key, args)) setTab('chat'); return; }
          return dispatch(card.key, c, args || undefined);
        }}
        placeholder={card.queued ? 'Type / for commands' : `Ask about ${card.key}, or type / for commands`}
      />
    </>
  );
}

export function Message({
  icon,
  tone,
  title,
  meta,
  children,
}: {
  icon: React.ReactNode;
  tone: 'good' | 'critical' | 'warning' | 'accent' | 'muted';
  title: string;
  meta?: string;
  children?: React.ReactNode;
}) {
  const color = { good: 'var(--good)', critical: 'var(--critical)', warning: 'var(--warning)', accent: 'var(--accent)', muted: 'var(--muted)' }[tone];
  return (
    <div className="flex gap-2.5 py-2">
      <span aria-hidden className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px]" style={{ background: `color-mix(in srgb, ${color} 14%, var(--surface))`, color }}>{icon}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        <p className="m-0"><span className="font-semibold text-fg">{title}</span>{meta ? <span className="ml-1.5 text-[11.5px] text-muted">{meta}</span> : null}</p>
        {children ? <div className="mt-0.5 text-fg-2">{children}</div> : null}
      </div>
    </div>
  );
}
