// The Activity feed: what changed between two snapshots of the board and the review list.
// The server keeps no event history, so the panel derives one live - pure, so the diff rules
// are tested in tests/v2-query.test.mjs.

import type { PrReviewCard, TicketCard } from '../lib/types';

export interface Snapshot {
  tickets: Record<string, { running: boolean; runMode: string | null; phase: string; column: string; blocked: boolean; planReady: boolean; manuallyArchived: boolean; summary: string }>;
  reviews: Record<string, { running: boolean; result: string | null; posted: number; title: string }>;
}

export interface ActivityEvent {
  id: string;
  at: number;
  kind: 'ticket' | 'review' | 'explainer';
  ref: string;
  title: string;
  text: string;
  tone: 'good' | 'critical' | 'warning' | 'accent' | 'muted';
}

export function snapshot(tickets: TicketCard[], reviews: PrReviewCard[]): Snapshot {
  const s: Snapshot = { tickets: {}, reviews: {} };
  for (const t of tickets) {
    s.tickets[t.key] = {
      running: t.running, runMode: t.runMode || null, phase: t.phase, column: t.column, blocked: !!t.blocked,
      planReady: t.planReady, manuallyArchived: t.manuallyArchived, summary: t.summary,
    };
  }
  for (const r of reviews) {
    s.reviews[r.ref] = { running: r.running, result: r.result, posted: r.triage?.posted || 0, title: r.title };
  }
  return s;
}

/** Events between two snapshots. The first snapshot of a session yields none: a feed that
 * opens with forty "started" lines is noise, not news. */
export function diff(prev: Snapshot | null, next: Snapshot, at: number): ActivityEvent[] {
  if (!prev) return [];
  const out: ActivityEvent[] = [];
  const push = (kind: ActivityEvent['kind'], ref: string, title: string, text: string, tone: ActivityEvent['tone']) =>
    out.push({ id: `${at}:${kind}:${ref}:${text}`, at, kind, ref, title, text, tone });

  for (const [key, n] of Object.entries(next.tickets)) {
    const p = prev.tickets[key];
    if (!p) { push('ticket', key, n.summary, 'appeared on the board', 'muted'); continue; }
    if (!p.running && n.running) push('ticket', key, n.summary, `${n.runMode || 'run'} started`, 'accent');
    if (p.phase !== n.phase && n.phase) push('ticket', key, n.summary, `moved to ${n.phase}`, 'muted');
    if (!p.blocked && n.blocked) push('ticket', key, n.summary, `blocked at ${n.phase}`, 'critical');
    if (!p.planReady && n.planReady) push('ticket', key, n.summary, 'plan ready for your review', 'warning');
    if (p.column === 'ship' && n.column === 'archived' && !n.manuallyArchived) push('ticket', key, n.summary, 'PR merged', 'good');
    else if (p.column !== 'archived' && n.column === 'archived') push('ticket', key, n.summary, 'archived', 'muted');
    if (p.column !== 'ship' && n.column === 'ship') push('ticket', key, n.summary, 'PR opened, awaiting merge', 'good');
  }
  for (const [ref, n] of Object.entries(next.reviews)) {
    const p = prev.reviews[ref];
    if (!p) { if (n.running) push('review', ref, n.title, 'review started', 'accent'); continue; }
    if (!p.running && n.running) push('review', ref, n.title, 'review started', 'accent');
    if (p.running && !n.running) push('review', ref, n.title, `review finished: ${n.result || 'no result'}`, n.result === 'failed' ? 'critical' : 'good');
    if (n.posted > p.posted) push('review', ref, n.title, `${n.posted - p.posted} finding(s) posted to the PR`, 'good');
  }
  return out;
}
