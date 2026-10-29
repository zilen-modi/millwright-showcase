// The v2 sidebar: every channel, what it holds, and how its list starts out. Pure, so the
// rules for "which ticket lands where" are tested in tests/v2-channels.test.mjs.

import type { BoardState, PrInboxRow, PrReviewCard, TicketCard } from '../lib/types';
import { needOf, reviewFinished, type Item, type ItemKind, type QueryDefaults } from './query';

export interface ChannelData {
  board: BoardState | null;
  reviews: PrReviewCard[];
  inbox: PrInboxRow[];
  /** Keys whose last run failed (RunsProvider's `failed` map). */
  failed: Record<string, unknown>;
  starred: Set<string>;
}

export interface Scope { id: string; label: string; match: (item: Item) => boolean }

export interface ChannelDef {
  id: string;
  label: string;
  section: 'home' | 'tickets' | 'reviews' | 'code' | 'insights';
  description: string;
  /** 'list' channels render the shared toolbar + list; the rest have their own view. */
  layout: 'list' | 'queue' | 'cost' | 'explain' | 'activity' | 'settings' | 'code';
  kinds: ItemKind[];
  select: (d: ChannelData) => Item[];
  defaults: QueryDefaults;
  groups: string[];
  scopes?: Scope[];
  /** Board view offered (tickets only). */
  board?: boolean;
  /** Sidebar badge: 'count' shows every item, 'alert' shows only when non-zero and highlights it. */
  badge?: 'count' | 'alert';
}

/** Every ticket card, plus a synthetic `queued` card for each labelled key with no ticket
 * folder yet - the same cards v1's Board puts in its Queued column. */
export function ticketItems(d: ChannelData): Item[] {
  const cards: TicketCard[] = d.board?.tickets || [];
  const known = new Set(cards.map((t) => t.key));
  const queued: TicketCard[] = (d.board?.queue || []).filter((q) => !known.has(q.key)).map((q) => ({
    key: q.key, summary: '', phase: 'queued', column: 'queued', prUrl: null, jiraStatus: null, rubricScore: null,
    updatedAt: null, costUsd: 0, tokens: 0, running: false, manuallyArchived: false, planReady: false, queued: true,
  }));
  return [...cards, ...queued].map((t) => ({ kind: 'ticket', id: t.key, ticket: t, failed: !!d.failed[t.key] }));
}
export const reviewItems = (d: ChannelData): Item[] => d.reviews.map((r) => ({ kind: 'review', id: r.ref, review: r }));
export const inboxItems = (d: ChannelData): Item[] => d.inbox.map((p) => ({ kind: 'inbox', id: p.id, pr: p }));

const isTicket = (i: Item): i is Extract<Item, { kind: 'ticket' }> => i.kind === 'ticket';

export const TICKET_SCOPES: Scope[] = [
  { id: 'active', label: 'Active', match: (i) => isTicket(i) && i.ticket.column !== 'archived' },
  { id: 'merge', label: 'Awaiting merge', match: (i) => isTicket(i) && i.ticket.column === 'ship' },
  { id: 'archived', label: 'Archived', match: (i) => isTicket(i) && i.ticket.column === 'archived' },
  { id: 'all', label: 'All', match: () => true },
];

const isReview = (i: Item): i is Extract<Item, { kind: 'review' }> => i.kind === 'review';

/** Reviews of merged or closed PRs are hidden unless asked for. */
export const REVIEW_SCOPES: Scope[] = [
  { id: 'open', label: 'Open PRs', match: (i) => isReview(i) && !reviewFinished(i.review) },
  { id: 'finished', label: 'Merged or closed', match: (i) => isReview(i) && reviewFinished(i.review) },
  { id: 'all', label: 'All', match: () => true },
];

const LIST_DEFAULTS: QueryDefaults = { sort: '-updated', group: 'none', view: 'list', scope: '' };

export const CHANNELS: ChannelDef[] = [
  {
    id: 'activity', label: 'Activity', section: 'home', layout: 'activity', kinds: [],
    description: 'What just happened, live', select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
  {
    id: 'needs-you', label: 'needs-you', section: 'tickets', layout: 'list', kinds: ['ticket', 'review'],
    description: 'Waiting on a person', badge: 'alert',
    select: (d) => [...ticketItems(d), ...reviewItems(d)].filter((i) => needOf(i) !== null),
    defaults: { ...LIST_DEFAULTS, group: 'need' }, groups: ['need', 'kind', 'none'],
  },
  {
    id: 'running', label: 'running', section: 'tickets', layout: 'list', kinds: ['ticket', 'review'],
    description: 'Runs in progress', badge: 'count',
    select: (d) => [...ticketItems(d), ...reviewItems(d)].filter((i) =>
      (i.kind === 'ticket' && i.ticket.running) || (i.kind === 'review' && i.review.running)),
    defaults: { ...LIST_DEFAULTS, group: 'kind' }, groups: ['kind', 'none'],
  },
  {
    id: 'tickets', label: 'tickets', section: 'tickets', layout: 'list', kinds: ['ticket'],
    description: 'Every ticket Millwright has touched', badge: 'count', board: true,
    select: ticketItems, scopes: TICKET_SCOPES,
    defaults: { ...LIST_DEFAULTS, group: 'stage', scope: 'active' }, groups: ['stage', 'none'],
  },
  {
    id: 'queue', label: 'queue', section: 'tickets', layout: 'queue', kinds: [],
    description: 'Start work and run the automation', badge: 'count',
    select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
  {
    id: 'review-inbox', label: 'review-inbox', section: 'reviews', layout: 'list', kinds: ['inbox'],
    description: 'Open PRs waiting on you, and yours', badge: 'count',
    select: inboxItems,
    defaults: { ...LIST_DEFAULTS, group: 'bucket' }, groups: ['bucket', 'repo', 'none'],
  },
  {
    id: 'reviews', label: 'reviews', section: 'reviews', layout: 'list', kinds: ['review'],
    description: 'Every PR review Millwright ran', badge: 'count',
    select: reviewItems, scopes: REVIEW_SCOPES,
    defaults: { ...LIST_DEFAULTS, scope: 'open' }, groups: ['none', 'owner', 'repo'],
  },
  {
    id: 'code', label: 'code', section: 'code', layout: 'code', kinds: [],
    description: 'Every repo and worktree: changes, branches, runs, and Claude per worktree',
    select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
  {
    id: 'explain', label: 'explain', section: 'insights', layout: 'explain', kinds: [],
    description: 'Plain-language explainers: old ERP and new ERP side by side',
    select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
  {
    id: 'cost', label: 'cost', section: 'insights', layout: 'cost', kinds: [],
    description: 'What tickets and reviews cost', select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
  {
    id: 'starred', label: 'Starred', section: 'home', layout: 'list', kinds: ['ticket', 'review'],
    description: 'What you starred', badge: 'count',
    select: (d) => [...ticketItems(d), ...reviewItems(d)].filter((i) => d.starred.has(i.id)),
    defaults: { ...LIST_DEFAULTS, group: 'kind' }, groups: ['kind', 'none'],
  },
  {
    id: 'settings', label: 'Settings', section: 'home', layout: 'settings', kinds: [],
    description: 'Kill switch and runtime config', select: () => [], defaults: LIST_DEFAULTS, groups: [],
  },
];

export const channelById = (id: string | undefined) => CHANNELS.find((c) => c.id === id);

/** Number shown next to a channel in the sidebar, or null for none. */
export function channelCount(c: ChannelDef, d: ChannelData): number | null {
  if (c.id === 'queue') {
    const tracked = new Set((d.board?.tickets || []).map((t) => t.key));
    const pending = (d.board?.automation?.pending || []).filter((k) => !tracked.has(k)).length;
    return (d.board?.queue?.length || 0) + pending;
  }
  if (!c.badge || c.layout !== 'list') return null;
  const items = c.select(d);
  const scoped = c.scopes ? items.filter(c.scopes.find((s) => s.id === c.defaults.scope)?.match || (() => true)) : items;
  return scoped.length;
}
