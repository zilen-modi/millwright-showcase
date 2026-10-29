import { useCallback, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PlanGate } from '@/components/PlanGate';
import { TicketShots } from '@/components/TicketShots';
import { api } from '@/lib/api';
import { duration, JIRA_BASE, money, tokens } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { phaseStyle } from '@/lib/phase';
import type { TicketDetail } from '@/lib/types';
import { useResource } from '@/hooks/useResource';

const ARTIFACTS = [
  ['plan', 'Plan'], ['design', 'Design'], ['context', 'Context'],
  ['review', 'Review'], ['verify', 'Verify'], ['ticket', 'Ticket'],
] as const;

/** The ticket detail side drawer. Radix Dialog gives focus trapping, restore-on-close and
 *  Escape for free — the legacy overlay hand-rolled all three and got focus wrong. */
export function TicketDrawer({ ticketKey, onClose }: { ticketKey: string | null; onClose: () => void }) {
  const fetcher = useCallback(
    (signal: AbortSignal) => (ticketKey ? api.ticket(ticketKey, signal) : Promise.resolve(null)),
    [ticketKey],
  );
  const { data, error, loading } = useResource<TicketDetail | null>(fetcher, [ticketKey]);
  const detail = data && data.key === ticketKey ? data : null;

  return (
    <Sheet open={ticketKey !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {ticketKey ? (
        <SheetContent
          title={
            <a
              href={JIRA_BASE + ticketKey}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 font-mono text-sm font-bold text-accent no-underline hover:underline"
            >
              {ticketKey}
              <ExternalLink size={13} aria-hidden />
            </a>
          }
          description={detail?.summary || (loading ? 'Loading…' : ticketKey)}
        >
          {error ? (
            <p className="text-[13px] text-critical">Failed to load {ticketKey}: {error}</p>
          ) : !detail ? (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Spinner label="Loading ticket" /> Loading {ticketKey}…
            </p>
          ) : (
            <TicketBody detail={detail} />
          )}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function TicketBody({ detail }: { detail: TicketDetail }) {
  const [tab, setTab] = useState<string>('plan');

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" style={phaseStyle(detail.phase || detail.column)}>
        {detail.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />running</Badge> : null}
        {detail.phase ? <Badge tone="phase">{detail.phase}</Badge> : null}
        {typeof detail.rubricScore === 'number' ? (
          <Badge tone={detail.rubricScore >= 0.9 ? 'good' : 'warning'}>rubric {detail.rubricScore.toFixed(2)}</Badge>
        ) : null}
        {detail.costUsd ? <Badge>{money(detail.costUsd)} · {tokens(detail.tokens)} tok</Badge> : null}
        {detail.jiraStatus ? <Badge>{detail.jiraStatus}</Badge> : null}
        {detail.manuallyArchived ? <Badge>archived</Badge> : null}
        {detail.prUrl ? (
          <a href={detail.prUrl} target="_blank" rel="noopener" className="no-underline">
            <Badge tone="accent">PR <ExternalLink size={11} aria-hidden /></Badge>
          </a>
        ) : null}
      </div>

      {detail.planReady ? (
        <PlanGate ticketKey={detail.key} plan={detail.artifacts.plan} running={detail.running} className="mt-4" />
      ) : null}

      <TicketShots shots={detail.shots} />

      <section className="mt-5" aria-labelledby="tl-h">
        <h3 id="tl-h" className="m-0 mb-2 text-[11px] font-bold uppercase tracking-[.05em] text-muted">Timeline</h3>
        {detail.timeline.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">No stage events yet.</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {detail.timeline.map((r, i) => (
              <li
                key={`${r.stage}-${i}`}
                className="relative flex flex-wrap items-center gap-2 border-b border-grid py-2 pl-3.5 last:border-b-0 phase-bar"
                style={phaseStyle(r.stage)}
              >
                <span className="w-[68px] shrink-0 text-[12.5px] font-semibold capitalize text-fg">{r.stage}</span>
                <Badge tone={r.status === 'ok' ? 'good' : r.status === 'blocked' ? 'critical' : 'warning'}>
                  {r.status}
                </Badge>
                <span className="text-xs tabular-nums text-muted">{duration(r.durationSec)}</span>
                <span className="text-xs tabular-nums text-muted">{tokens(r.tokensTotal)} tok</span>
                {r.notes ? <span className="basis-full text-xs leading-snug text-fg-2">{r.notes}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Ticket artifacts">
            {ARTIFACTS.map(([id, label]) => (
              <TabsTrigger key={id} value={id} disabled={detail.artifacts[id] == null}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {ARTIFACTS.map(([id]) => (
            <TabsContent key={id} value={id}>
              <Markdown source={detail.artifacts[id]} />
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </>
  );
}

/** Small helper reused by the board/console for a "jump to Jira" affordance. */
export function JiraLink({ ticketKey, className }: { ticketKey: string; className?: string }) {
  return (
    <a
      href={JIRA_BASE + ticketKey}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className={className}
    >
      {ticketKey}
    </a>
  );
}
