import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { BookOpen, GitPullRequest, Hash, Inbox, Moon, Pause, Play, Sparkles, Ticket } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useRuns } from '@/hooks/runs';
import { useTheme } from '@/hooks/useTheme';
import { parseTicketKey } from '@/lib/api';
import { money } from '@/lib/format';
import { phaseColor } from '@/lib/phase';
import { cn } from '@/lib/utils';
import { CHANNELS, inboxItems, reviewItems, ticketItems } from './channels';
import { useV2 } from './data';
import { useStartExplain, useStartReview } from './dispatch';
import { useExplainers } from './explain/ExplainTab';
import { Chip } from './Menu';
import { haystack, sortItems } from './query';

const TYPES = ['all', 'tickets', 'reviews', 'inbox', 'explainers', 'commands'] as const;
type Type = (typeof TYPES)[number];
const GROUP = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted';
const ITEM = 'flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent';

/** ⌘K: one search across tickets, reviews, inbox PRs, explainers, channels and commands. */
export function Search({ open, setOpen }: { open: boolean; setOpen: (v: boolean | ((p: boolean) => boolean)) => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<Type>('all');
  const navigate = useNavigate();
  const data = useV2();
  const { run, setPaused } = useRuns();
  const { resolved, setPref } = useTheme();
  const startReview = useStartReview();
  const startExplain = useStartExplain();
  const explainers = useExplainers().data?.explainers || [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setOpen((v) => !v); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOpen]);
  useEffect(() => { if (!open) { setQ(''); setType('all'); } }, [open]);

  const tickets = useMemo(() => sortItems(ticketItems(data), '-updated'), [data]);
  const reviews = useMemo(() => sortItems(reviewItems(data), '-updated'), [data]);
  const inbox = useMemo(() => inboxItems(data), [data]);
  const key = parseTicketKey(q);
  const prUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(q.trim()) ? q.trim() : null;
  const paused = data.board?.automation.paused ?? false;
  const show = (t: Type) => type === 'all' || type === t;
  const go = (fn: () => void) => { setOpen(false); fn(); };
  const thread = (param: string, id: string, channel: string) => go(() => navigate(`/v2/${channel}?${param}=${encodeURIComponent(id)}`));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="anim-fade-in fixed inset-0 z-40 bg-[rgba(10,12,16,.45)]" />
        <DialogPrimitive.Content aria-label="Search" className="anim-fade-in fixed top-[10vh] left-1/2 z-50 w-[min(640px,94vw)] -translate-x-1/2 overflow-hidden rounded-panel border border-border bg-surface shadow-drawer focus:outline-none">
          <DialogPrimitive.Title className="sr-only">Search Millwright</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search tickets, reviews, inbox PRs and explainers, or run a command.</DialogPrimitive.Description>
          <Command loop label="Search" filter={(value, search) => (search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => value.toLowerCase().includes(w)) ? 1 : 0)}>
            <Command.Input
              autoFocus
              value={q}
              onValueChange={setQ}
              placeholder="Search tickets, PRs, explainers - or paste a ticket key or PR link"
              className="w-full border-0 border-b border-border bg-transparent px-4 py-3.5 text-[14px] text-fg placeholder:text-muted focus:outline-none"
            />
            <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
              {TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)} className="cursor-pointer border-0 bg-transparent p-0">
                  <Chip active={type === t}>{t[0].toUpperCase() + t.slice(1)}</Chip>
                </button>
              ))}
            </div>
            <Command.List className="max-h-[56vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">No match. Paste a ticket key or PR link to start one.</Command.Empty>

              {(key || prUrl) && show('commands') ? (
                <Command.Group heading="Start" className={GROUP}>
                  {key ? (
                    <>
                      <Row value={`plan ${key} ${q}`} icon={<Play size={14} />} onSelect={() => go(() => void run(key, 'plan'))}>Plan {key}</Row>
                      <Row value={`review ${key} ${q}`} icon={<Play size={14} />} onSelect={() => go(() => void run(key, 'review'))}>Review {key} (full pipeline)</Row>
                    </>
                  ) : null}
                  {prUrl ? <Row value={`review pr ${q}`} icon={<GitPullRequest size={14} />} onSelect={() => go(() => void startReview(prUrl, 'PR'))}>Review this PR</Row> : null}
                  <Row value={`explain ${q}`} icon={<Sparkles size={14} />} onSelect={() => go(() => void startExplain(q.trim()))}>Explain {key || 'this PR'} in plain words</Row>
                </Command.Group>
              ) : null}

              {show('tickets') ? (
                <Command.Group heading="Tickets" className={GROUP}>
                  {tickets.slice(0, type === 'tickets' ? 200 : 40).map((it) => it.kind === 'ticket' && (
                    <Row key={it.id} value={`ticket ${haystack(it)}`} icon={<span className="h-2 w-2 rounded-full" style={{ background: it.ticket.blocked ? 'var(--critical)' : phaseColor(it.ticket.phase) }} />} onSelect={() => thread('t', it.id, 'tickets')} hint={it.ticket.running ? 'running' : it.ticket.blocked ? 'blocked' : it.ticket.costUsd ? money(it.ticket.costUsd) : it.ticket.phase}>
                      <span className="font-mono font-semibold">{it.id}</span> <span className="text-fg-2">{it.ticket.summary}</span>
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {show('reviews') ? (
                <Command.Group heading="Reviews" className={GROUP}>
                  {reviews.slice(0, type === 'reviews' ? 200 : 25).map((it) => it.kind === 'review' && (
                    <Row key={it.id} value={`review ${haystack(it)}`} icon={<GitPullRequest size={14} />} onSelect={() => thread('r', it.id, 'reviews')} hint={it.review.running ? 'running' : it.review.triage?.undecided ? `${it.review.triage.undecided} to decide` : it.review.result || ''}>
                      <span className="font-mono">#{it.id.split('-').pop()}</span> <span className="text-fg-2">{it.review.title}</span>
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {show('inbox') ? (
                <Command.Group heading="Inbox PRs" className={GROUP}>
                  {inbox.map((it) => it.kind === 'inbox' && (
                    <Row key={it.id} value={`inbox ${haystack(it)}`} icon={<Inbox size={14} />}
                      onSelect={() => (it.pr.review ? thread('r', it.pr.review.ref, 'review-inbox') : go(() => navigate(`/v2/review-inbox?q=${encodeURIComponent(`${it.pr.repo}#${it.pr.number}`)}`)))}
                      hint={it.pr.bucket === 'mine' ? 'yours' : it.pr.author}>
                      <span className="font-mono">{it.pr.repo.replace(/^erp-next-/, '')}#{it.pr.number}</span> <span className="text-fg-2">{it.pr.title}</span>
                    </Row>
                  ))}
                </Command.Group>
              ) : null}

              {show('explainers') ? (
                <Command.Group heading="Explainers" className={GROUP}>
                  {explainers.map((e) => (
                    <Row key={e.slug} value={`explainer ${e.title} ${e.subject?.label || ''} ${e.summary || ''}`} icon={<BookOpen size={14} />} onSelect={() => thread('e', e.slug, 'explain')} hint={e.subject?.type}>
                      {e.title}
                    </Row>
                  ))}
                  {q.trim() && !key && !prUrl ? (
                    <Row value={`explain new ${q}`} icon={<Sparkles size={14} />} onSelect={() => go(() => void startExplain(q.trim()))}>Explain “{q.trim()}” in plain words</Row>
                  ) : null}
                </Command.Group>
              ) : null}

              {show('commands') ? (
                <Command.Group heading="Go to" className={GROUP}>
                  {CHANNELS.map((c) => (
                    <Row key={c.id} value={`go channel ${c.label} ${c.description}`} icon={<Hash size={14} />} onSelect={() => go(() => navigate(`/v2/${c.id}`))} hint={c.description}>
                      {c.layout === 'list' || ['queue', 'cost', 'explain'].includes(c.id) ? `#${c.label}` : c.label}
                    </Row>
                  ))}
                  <Row value="command pause resume millwright kill switch" icon={paused ? <Play size={14} /> : <Pause size={14} />} onSelect={() => go(() => void setPaused(!paused))}>{paused ? 'Resume Millwright' : 'Pause Millwright'}</Row>
                  <Row value="command theme dark light mode" icon={<Moon size={14} />} onSelect={() => go(() => setPref(resolved === 'dark' ? 'light' : 'dark'))}>Switch to {resolved === 'dark' ? 'light' : 'dark'} theme</Row>
                  <Row value="command classic v1 old panel" icon={<Ticket size={14} />} onSelect={() => go(() => navigate('/'))}>Open the classic panel</Row>
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Row({ value, icon, onSelect, hint, children }: { value: string; icon: ReactNode; onSelect: () => void; hint?: ReactNode; children: ReactNode }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={ITEM}>
      <span aria-hidden className="flex w-4 flex-none justify-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className={cn('max-w-[40%] truncate text-[11.5px] text-muted')}>{hint}</span> : null}
    </Command.Item>
  );
}
