// Search, filters, sorting and grouping for every v2 list. Pure on purpose: a channel is just
// a set of items plus a ListQuery, and tests/v2-query.test.mjs checks every facet without React.
// Relative imports only, so the tests can load this file directly.

import { STAGE_ORDER } from '../lib/phase';
import { blocker } from '../lib/prInbox';
import type { ColumnKey, PrInboxRow, PrReviewCard, TicketCard } from '../lib/types';

export type Item =
  | { kind: 'ticket'; id: string; ticket: TicketCard; failed?: boolean }
  | { kind: 'review'; id: string; review: PrReviewCard }
  | { kind: 'inbox'; id: string; pr: PrInboxRow };

export type ItemKind = Item['kind'];

export interface ListQuery {
  q: string;
  /** facet id -> selected values. Values within a facet are OR-ed, facets are AND-ed. */
  filters: Record<string, string[]>;
  /** Sort id, `-` prefix for descending. */
  sort: string;
  group: string;
  view: 'list' | 'board';
  /** A channel's quick filter (e.g. #tickets: active | merge | archived | all). */
  scope: string;
}

export const COLUMN_ORDER: ColumnKey[] = ['queued', 'intake', 'route', 'plan', 'build', 'verify', 'review', 'ship', 'archived'];

const ts = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);

/** owner/repo from a PR url, or the repo part of a review ref (`owner-repo-123`). */
export function repoOf(item: Item): string {
  if (item.kind === 'inbox') return item.pr.repo;
  if (item.kind === 'review') {
    const m = item.review.prUrl?.match(/github\.com\/[^/]+\/([^/]+)\/pull\//);
    if (m) return m[1];
    return item.review.ref.replace(/^[^-]+-/, '').replace(/-\d+$/, '');
  }
  return '';
}

export function updatedAt(item: Item): number {
  if (item.kind === 'ticket') return ts(item.ticket.updatedAt);
  if (item.kind === 'review') return Math.max(ts(item.review.updatedAt), ts(item.review.startedAt), ts(item.review.reconciledAt));
  return ts(item.pr.updatedAt);
}

export function titleOf(item: Item): string {
  if (item.kind === 'ticket') return item.ticket.summary || item.ticket.key;
  if (item.kind === 'review') return item.review.title || item.review.ref;
  return item.pr.title;
}

/** Why a ticket is waiting on a person, most urgent first; null when it is not. */
export function ticketNeed(t: TicketCard, failed = false): string | null {
  if (t.column === 'archived' || t.queued) return null;
  if (t.running) return null;
  if (t.blocked) return 'blocked';
  if (failed) return 'failed';
  if (t.planReady) return 'plan-ready';
  if (t.canContinue) return 'resumable';
  if (t.shipReady && !t.prUrl && t.column !== 'ship') return 'ship-ready';
  return null;
}

/** The PR merged or closed: its review is history, not something to act on or list by default. */
export const reviewFinished = (r: PrReviewCard) => r.prState === 'MERGED' || r.prState === 'CLOSED';

export function reviewNeed(r: PrReviewCard): string | null {
  if (r.running || reviewFinished(r)) return null;
  if (r.result === 'needs-input') return 'review-input';
  if (r.triage && !r.triage.stale && (r.triage.undecided > 0 || r.triage.toPost > 0)) return 'review-triage';
  return null;
}

export const NEED_LABEL: Record<string, string> = {
  blocked: 'Blocked',
  failed: 'Run failed',
  'review-input': 'Review asked a question',
  'plan-ready': 'Plan ready',
  resumable: 'Can continue',
  'ship-ready': 'Ready to ship',
  'review-triage': 'Findings to decide',
};
const NEED_ORDER = ['blocked', 'failed', 'review-input', 'plan-ready', 'resumable', 'ship-ready', 'review-triage'];

export function needOf(item: Item): string | null {
  if (item.kind === 'ticket') return ticketNeed(item.ticket, item.failed);
  if (item.kind === 'review') return reviewNeed(item.review);
  return null;
}

// ---- facets ----

export interface Facet {
  id: string;
  label: string;
  kinds: ItemKind[];
  values: (item: Item) => string[];
  labelFor?: (value: string) => string;
  /** Option order; default is by count. */
  order?: string[];
}

const costBucket = (n: number) => (n < 1 ? '<$1' : n < 5 ? '$1-5' : n < 20 ? '$5-20' : '>$20');

export const FACETS: Facet[] = [
  {
    id: 'stage', label: 'Stage', kinds: ['ticket'],
    values: (i) => (i.kind === 'ticket' ? [i.ticket.column] : []),
    order: COLUMN_ORDER,
  },
  {
    id: 'status', label: 'Status', kinds: ['ticket'],
    values: (i) => {
      if (i.kind !== 'ticket') return [];
      const t = i.ticket;
      const out: string[] = [];
      if (t.running) out.push('running');
      if (t.blocked) out.push('blocked');
      if (t.planReady) out.push('plan ready');
      if (i.failed) out.push('failed');
      if (t.stale) out.push('stale');
      if (t.prUrl) out.push('has PR');
      if (t.shipReady) out.push('ship ready');
      if (!out.length) out.push('idle');
      return out;
    },
  },
  {
    id: 'jira', label: 'Jira status', kinds: ['ticket'],
    values: (i) => (i.kind === 'ticket' && i.ticket.jiraStatus ? [i.ticket.jiraStatus] : []),
  },
  {
    id: 'rubric', label: 'Rubric', kinds: ['ticket'],
    values: (i) => {
      if (i.kind !== 'ticket') return [];
      if (i.ticket.rubricScore != null) return [i.ticket.rubricScore >= 0.9 ? 'passing' : 'below target'];
      return [i.ticket.rubricUnverified != null ? 'unverified' : 'none'];
    },
  },
  {
    id: 'cost', label: 'Cost', kinds: ['ticket', 'review'],
    values: (i) => (i.kind === 'ticket' ? [costBucket(i.ticket.costUsd)] : i.kind === 'review' ? [costBucket(i.review.costUsd)] : []),
    order: ['<$1', '$1-5', '$5-20', '>$20'],
  },
  {
    id: 'owner', label: 'Owner', kinds: ['review'],
    values: (i) => (i.kind === 'review' ? [i.review.isOwn === true ? 'mine' : i.review.isOwn === false ? 'others' : 'unknown'] : []),
  },
  {
    id: 'prstate', label: 'PR', kinds: ['review'],
    values: (i) => (i.kind === 'review' ? [i.review.prState ? i.review.prState.toLowerCase() : 'unknown'] : []),
  },
  {
    id: 'result', label: 'Result', kinds: ['review'],
    values: (i) => (i.kind === 'review' ? [i.review.running ? 'running' : i.review.result || 'none'] : []),
  },
  {
    id: 'triage', label: 'Findings', kinds: ['review'],
    values: (i) => {
      if (i.kind !== 'review') return [];
      const f = i.review.triage;
      if (!f) return ['no findings file'];
      const out: string[] = [];
      if (f.undecided) out.push('to decide');
      if (f.toPost) out.push('to post');
      if (f.posted) out.push('posted');
      if (!out.length) out.push('all decided');
      return out;
    },
  },
  {
    id: 'repo', label: 'Repo', kinds: ['review', 'inbox'],
    values: (i) => (i.kind === 'ticket' ? [] : [repoOf(i)]),
  },
  {
    id: 'bucket', label: 'Inbox', kinds: ['inbox'],
    values: (i) => (i.kind === 'inbox' ? [i.pr.bucket] : []),
    labelFor: (v) => (v === 'requested' ? 'Needs review' : v === 'mine' ? 'Mine' : v),
    order: ['requested', 'mine'],
  },
  {
    id: 'author', label: 'Author', kinds: ['inbox'],
    values: (i) => (i.kind === 'inbox' ? [i.pr.author] : []),
  },
  {
    id: 'blocker', label: 'Blocker', kinds: ['inbox'],
    values: (i) => {
      if (i.kind !== 'inbox') return [];
      if (i.pr.isDraft) return ['draft'];
      return [blocker(i.pr)?.label || 'ready to merge'];
    },
  },
  {
    id: 'reviewed', label: 'My review', kinds: ['inbox'],
    values: (i) => (i.kind === 'inbox' ? [i.pr.reviewStatus] : []),
    labelFor: (v) => ({ never: 'not reviewed', running: 'running', failed: 'failed', done: 'reviewed', 'done-stale': 'branch moved since' }[v] || v),
  },
];

export const facetById = (id: string) => FACETS.find((f) => f.id === id);

export interface FacetOption { value: string; label: string; count: number }

/** The options a facet offers over these items, with how many items carry each. */
export function facetOptions(facet: Facet, items: Item[]): FacetOption[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!facet.kinds.includes(it.kind)) continue;
    for (const v of facet.values(it)) counts.set(v, (counts.get(v) || 0) + 1);
  }
  const opts = [...counts].map(([value, count]) => ({ value, count, label: facet.labelFor?.(value) || value }));
  if (facet.order) {
    const rank = (v: string) => { const i = facet.order!.indexOf(v); return i === -1 ? 999 : i; };
    return opts.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
  }
  return opts.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---- search ----

export function haystack(item: Item): string {
  if (item.kind === 'ticket') {
    const t = item.ticket;
    return [t.key, t.summary, t.jiraStatus, t.phase, t.column, t.blockedReason].filter(Boolean).join(' ');
  }
  if (item.kind === 'review') {
    const r = item.review;
    return [r.ref, r.title, r.result, repoOf(item), r.prUrl?.match(/\/pull\/(\d+)/)?.[1]].filter(Boolean).join(' ');
  }
  const p = item.pr;
  return [`${p.repo}#${p.number}`, p.repoSlug, p.title, p.author, p.headRefName].filter(Boolean).join(' ');
}

export function matchesText(item: Item, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = haystack(item).toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ---- sort ----

export interface SortDef { id: string; label: string; kinds: ItemKind[]; value: (item: Item) => number | string }

export const SORTS: SortDef[] = [
  { id: 'updated', label: 'Updated', kinds: ['ticket', 'review', 'inbox'], value: updatedAt },
  { id: 'cost', label: 'Cost', kinds: ['ticket', 'review'], value: (i) => (i.kind === 'ticket' ? i.ticket.costUsd : i.kind === 'review' ? i.review.costUsd : 0) },
  { id: 'tokens', label: 'Tokens', kinds: ['ticket', 'review'], value: (i) => (i.kind === 'ticket' ? i.ticket.tokens : i.kind === 'review' ? i.review.tokens : 0) },
  {
    id: 'stage', label: 'Stage', kinds: ['ticket'],
    value: (i) => (i.kind === 'ticket' ? COLUMN_ORDER.indexOf(i.ticket.column) * 100 + Math.max(0, (STAGE_ORDER as readonly string[]).indexOf(i.ticket.phase)) : 0),
  },
  { id: 'rubric', label: 'Rubric', kinds: ['ticket'], value: (i) => (i.kind === 'ticket' ? i.ticket.rubricScore ?? i.ticket.rubricUnverified ?? -1 : -1) },
  { id: 'key', label: 'Key', kinds: ['ticket', 'review', 'inbox'], value: (i) => (i.kind === 'ticket' ? Number(i.ticket.key.split('-')[1]) || 0 : i.kind === 'inbox' ? i.pr.number : i.id) },
  { id: 'title', label: 'Title', kinds: ['ticket', 'review', 'inbox'], value: (i) => titleOf(i).toLowerCase() },
  { id: 'created', label: 'Created', kinds: ['inbox'], value: (i) => (i.kind === 'inbox' ? ts(i.pr.createdAt) : 0) },
  { id: 'undecided', label: 'Findings to decide', kinds: ['review'], value: (i) => (i.kind === 'review' ? i.review.triage?.undecided ?? -1 : -1) },
];

export function sortItems(items: Item[], sort: string): Item[] {
  const desc = sort.startsWith('-');
  const def = SORTS.find((s) => s.id === sort.replace(/^-/, '')) || SORTS[0];
  return [...items].sort((a, b) => {
    const va = def.value(a);
    const vb = def.value(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return (desc ? -c : c) || updatedAt(b) - updatedAt(a);
  });
}

// ---- group ----

export interface Group { id: string; label: string; items: Item[] }

const COLUMN_LABEL: Record<string, string> = {
  queued: 'Queued', intake: 'Intake', route: 'Route', plan: 'Plan', build: 'Build', verify: 'Verify',
  review: 'Review', ship: 'Awaiting merge', archived: 'Archived',
};

export function groupItems(items: Item[], group: string): Group[] {
  if (!group || group === 'none') return [{ id: 'all', label: '', items }];
  const key = (i: Item): [string, string, number] => {
    if (group === 'stage' && i.kind === 'ticket') return [i.ticket.column, COLUMN_LABEL[i.ticket.column] || i.ticket.column, COLUMN_ORDER.indexOf(i.ticket.column)];
    if (group === 'need') { const n = needOf(i) || 'other'; return [n, NEED_LABEL[n] || 'Other', NEED_ORDER.includes(n) ? NEED_ORDER.indexOf(n) : 99]; }
    if (group === 'repo') { const r = repoOf(i) || 'tickets'; return [r, r, 0]; }
    if (group === 'kind') return [i.kind, i.kind === 'ticket' ? 'Tickets' : i.kind === 'review' ? 'Reviews' : 'Inbox PRs', ['ticket', 'review', 'inbox'].indexOf(i.kind)];
    if (group === 'owner' && i.kind === 'review') { const o = i.review.isOwn === true ? 'Mine' : 'Others'; return [o, o, o === 'Mine' ? 0 : 1]; }
    if (group === 'bucket' && i.kind === 'inbox') return [i.pr.bucket, i.pr.bucket === 'requested' ? 'Needs review' : 'Mine', i.pr.bucket === 'requested' ? 0 : 1];
    return ['other', 'Other', 99];
  };
  const groups = new Map<string, Group & { rank: number }>();
  for (const it of items) {
    const [id, label, rank] = key(it);
    if (!groups.has(id)) groups.set(id, { id, label, rank, items: [] });
    groups.get(id)!.items.push(it);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).map(({ rank: _r, ...g }) => g);
}

// ---- the whole pipeline ----

export function applyQuery(items: Item[], query: ListQuery, scopeMatch?: (item: Item) => boolean): Item[] {
  return sortItems(items.filter((it) => {
    if (scopeMatch && !scopeMatch(it)) return false;
    if (!matchesText(it, query.q)) return false;
    for (const [id, wanted] of Object.entries(query.filters)) {
      if (!wanted.length) continue;
      const facet = facetById(id);
      if (!facet || !facet.kinds.includes(it.kind)) continue;
      const have = facet.values(it);
      if (!wanted.some((w) => have.includes(w))) return false;
    }
    return true;
  }), query.sort);
}

// ---- URL state ----

export type QueryDefaults = Pick<ListQuery, 'sort' | 'group' | 'view' | 'scope'>;

export function parseQuery(params: URLSearchParams, defaults: QueryDefaults): ListQuery {
  const filters: Record<string, string[]> = {};
  for (const [k, v] of params) {
    if (k.startsWith('f.') && v) filters[k.slice(2)] = v.split(',').filter(Boolean);
  }
  const view = params.get('view');
  return {
    q: params.get('q') || '',
    filters,
    sort: params.get('sort') || defaults.sort,
    group: params.get('group') || defaults.group,
    view: view === 'board' || view === 'list' ? view : defaults.view,
    scope: params.get('scope') || defaults.scope,
  };
}

/** Write a query back into URL params, leaving out defaults and keeping unrelated params
 * (the open thread, for one). */
export function writeQuery(base: URLSearchParams, query: ListQuery, defaults: QueryDefaults): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of base) {
    if (!['q', 'sort', 'group', 'view', 'scope'].includes(k) && !k.startsWith('f.')) out.set(k, v);
  }
  if (query.q) out.set('q', query.q);
  for (const [id, vals] of Object.entries(query.filters)) if (vals.length) out.set(`f.${id}`, vals.join(','));
  if (query.sort !== defaults.sort) out.set('sort', query.sort);
  if (query.group !== defaults.group) out.set('group', query.group);
  if (query.view !== defaults.view) out.set('view', query.view);
  if (query.scope !== defaults.scope) out.set('scope', query.scope);
  return out;
}

export function activeFilterCount(query: ListQuery): number {
  return Object.values(query.filters).reduce((n, v) => n + v.length, 0) + (query.q ? 1 : 0);
}
