import { describe, expect, it } from 'vitest';

import {
  CHANNELS, channelById, channelCount, ticketItems,
} from '../dashboard/ui/src/v2/channels.ts';
import {
  parseComposer, resolve, reviewCommands, reviewPostBlocked, suggest, ticketCommands,
} from '../dashboard/ui/src/v2/commands.ts';
import {
  applyQuery, facetById, facetOptions, groupItems, matchesText, needOf, parseQuery, repoOf, sortItems, writeQuery,
} from '../dashboard/ui/src/v2/query.ts';

const card = (o) => ({
  key: 'PROJ-1', summary: '', phase: 'plan', column: 'plan', prUrl: null, jiraStatus: null, rubricScore: null,
  updatedAt: '2026-10-01T00:00:00Z', costUsd: 0, tokens: 0, running: false, manuallyArchived: false, planReady: false,
  ...o,
});
const review = (o) => ({
  ref: 'acme-it-erp-erp-next-backend-1', prUrl: 'https://github.com/acme-it-erp/erp-next-backend/pull/1', title: '',
  isOwn: false, result: 'report-only', costUsd: 0, tokens: 0, updatedAt: '2026-10-01T00:00:00Z', running: false,
  failure: null, retryable: false, triage: null, ...o,
});
const pr = (o) => ({
  id: 'acme-it-erp-erp-next-ui-monorepo-9', owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', repoSlug: 'acme-it-erp/erp-next-ui-monorepo',
  number: 9, url: '', title: 'Doc labels', author: 'sam', bucket: 'requested', isDraft: false, state: 'OPEN',
  reviewDecision: null, updatedAt: '2026-10-02T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', headRefName: 'feat/labels',
  baseRefName: 'dev', requestedVia: null, myReviewState: null, myReviewAt: null, headCommittedAt: null, myReviewStale: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checksState: 'SUCCESS', inManifest: true, source: null,
  fromStaleSnapshot: false, snapshotAt: null, review: null, reviewStatus: 'never', ...o,
});

const TICKETS = [
  card({ key: 'PROJ-10', summary: 'Branch transfer modal', column: 'verify', blocked: true, blockedStage: 'verify', costUsd: 18, updatedAt: '2026-10-05T00:00:00Z' }),
  card({ key: 'PROJ-11', summary: 'Ship screen', column: 'plan', planReady: true, costUsd: 3, updatedAt: '2026-10-04T00:00:00Z' }),
  card({ key: 'PROJ-12', summary: 'Kit inquiry', column: 'build', running: true, runMode: 'build', costUsd: 9, updatedAt: '2026-10-06T00:00:00Z' }),
  card({ key: 'PROJ-13', summary: 'Error stack', column: 'ship', prUrl: 'https://x/pr/1', costUsd: 1.5, rubricScore: 0.95 }),
  card({ key: 'PROJ-14', summary: 'Old one', column: 'archived', costUsd: 0.2 }),
  card({ key: 'PROJ-15', summary: 'Killed mid build', column: 'build', canContinue: true, costUsd: 2 }),
];
const data = (o = {}) => ({
  board: { tickets: TICKETS, queue: [{ key: 'PROJ-99' }], running: ['PROJ-12'], columns: [], automation: { pending: ['PROJ-98', 'PROJ-10'] } },
  reviews: [
    review({ ref: 'r-a', title: 'Labels', triage: { total: 3, undecided: 2, accept: 0, toPost: 0, posted: 0, folded: 1, round: 1, stale: false } }),
    review({ ref: 'r-b', title: 'Asked', result: 'needs-input' }),
    review({ ref: 'r-c', title: 'Running one', running: true, isOwn: true }),
  ],
  inbox: [pr({}), pr({ id: 'p2', repo: 'erp-next-backend', number: 4, bucket: 'mine', checksState: 'FAILURE', author: 'me', title: 'Serials', headRefName: 'fix/serials' })],
  failed: { 'PROJ-11': { mode: 'build' } },
  starred: new Set(['PROJ-13']),
  ...o,
});

describe('channels', () => {
  const d = data();
  const ids = (c) => channelById(c).select(d).map((i) => i.id).sort();

  it('needs-you holds what waits on a person, never a running ticket', () => {
    expect(ids('needs-you')).toEqual(['PROJ-10', 'PROJ-11', 'PROJ-15', 'r-a', 'r-b']);
  });

  it('a blocked ticket outranks a failed run and a ready plan', () => {
    const [blocked, failed] = ticketItems(d).filter((i) => ['PROJ-10', 'PROJ-11'].includes(i.id));
    expect(needOf(blocked)).toBe('blocked');
    expect(needOf(failed)).toBe('failed');
  });

  it('running mixes tickets and reviews', () => {
    expect(ids('running')).toEqual(['PROJ-12', 'r-c']);
  });

  it('#tickets hides archived by default and offers it as a scope', () => {
    const c = channelById('tickets');
    expect(channelCount(c, d)).toBe(6); // 5 live tickets + PROJ-99 queued
    const archived = c.scopes.find((s) => s.id === 'archived');
    expect(c.select(d).filter(archived.match).map((i) => i.id)).toEqual(['PROJ-14']);
  });

  it('#queue counts queued plus scanned-but-untracked keys', () => {
    expect(channelCount(channelById('queue'), d)).toBe(2); // PROJ-99 queued, PROJ-98 pending (PROJ-10 is tracked)
  });

  it('starred and every channel id are unique', () => {
    expect(ids('starred')).toEqual(['PROJ-13']);
    expect(new Set(CHANNELS.map((c) => c.id)).size).toBe(CHANNELS.length);
  });
});

describe('query', () => {
  const items = ticketItems(data());
  const q = (o) => ({ q: '', filters: {}, sort: '-updated', group: 'none', view: 'list', scope: '', ...o });

  it('searches every word across key, summary and status', () => {
    expect(applyQuery(items, q({ q: 'transfer 10' })).map((i) => i.id)).toEqual(['PROJ-10']);
    expect(matchesText(items[0], 'VERIFY')).toBe(true);
  });

  it('ORs values within a facet and ANDs facets', () => {
    const r = applyQuery(items, q({ filters: { stage: ['build', 'verify'], status: ['running'] } }));
    expect(r.map((i) => i.id)).toEqual(['PROJ-12']);
    expect(applyQuery(items, q({ filters: { stage: ['build', 'verify'] } })).length).toBe(3);
  });

  it('offers facet options with counts, in stage order', () => {
    const opts = facetOptions(facetById('stage'), items);
    expect(opts.map((o) => o.value)).toEqual(['queued', 'plan', 'build', 'verify', 'ship', 'archived']);
    expect(opts.find((o) => o.value === 'build').count).toBe(2);
    const status = facetOptions(facetById('status'), items).map((o) => o.value);
    expect(status).toEqual(expect.arrayContaining(['blocked', 'plan ready', 'failed', 'running', 'has PR']));
  });

  it('sorts by cost both ways and by stage', () => {
    expect(sortItems(items, '-cost')[0].id).toBe('PROJ-10');
    expect(sortItems(items, 'cost').map((i) => i.id).slice(0, 2)).toEqual(['PROJ-99', 'PROJ-14']); // queued card costs nothing
    expect(sortItems(items, 'stage').map((i) => i.id).slice(0, 2)).toEqual(['PROJ-99', 'PROJ-11']);
  });

  it('groups by stage in pipeline order and by need with the most urgent first', () => {
    expect(groupItems(items, 'stage').map((g) => g.id)).toEqual(['queued', 'plan', 'build', 'verify', 'ship', 'archived']);
    const needs = channelById('needs-you').select(data());
    expect(groupItems(needs, 'need').map((g) => g.id)).toEqual(['blocked', 'failed', 'review-input', 'resumable', 'review-triage']);
  });

  it('filters reviews by findings and inbox PRs by blocker', () => {
    const d = data();
    const revs = channelById('reviews').select(d);
    expect(applyQuery(revs, q({ filters: { triage: ['to decide'] } })).map((i) => i.id)).toEqual(['r-a']);
    const inbox = channelById('review-inbox').select(d);
    expect(applyQuery(inbox, q({ filters: { blocker: ['checks failing'] } })).map((i) => i.id)).toEqual(['p2']);
    expect(repoOf(revs[0])).toBe('erp-next-backend');
    expect(applyQuery(inbox, q({ q: 'feat/labels' })).length).toBe(1);
  });

  it('round-trips through the URL, keeps other params and drops defaults', () => {
    const defaults = { sort: '-updated', group: 'stage', view: 'list', scope: 'active' };
    const query = q({ q: 'modal', filters: { stage: ['build', 'verify'] }, sort: '-cost', group: 'stage', view: 'board', scope: 'archived' });
    const params = writeQuery(new URLSearchParams('t=PROJ-10'), query, defaults);
    expect(params.get('t')).toBe('PROJ-10');
    expect(params.has('group')).toBe(false);
    expect(parseQuery(params, defaults)).toEqual(query);
  });
});

describe('commands', () => {
  it('offers what the buttons offer, with refusals explained', () => {
    const blocked = ticketCommands(card({ blocked: true, canContinue: true, column: 'verify', shipReady: false }));
    const names = blocked.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['continue', 'plan', 'replan', 'build', 'review', 'ship', 'archive', 'ask', 'explain']));
    expect(blocked.find((c) => c.name === 'ship').disabledReason).toMatch(/rubric/);
    expect(blocked.find((c) => c.name === 'continue').takesNotes).toBe(true);
  });

  it('a running ticket can only be cancelled (or explained)', () => {
    expect(ticketCommands(card({ running: true })).map((c) => c.name)).toEqual(['cancel', 'ask', 'explain']);
    expect(ticketCommands(card({ column: 'archived' })).map((c) => c.name)).toEqual(['unarchive', 'ask', 'explain']);
    expect(ticketCommands(card({ queued: true, column: 'queued' })).map((c) => c.name)).toEqual(['plan', 'review']);
    expect(ticketCommands(card({ column: 'ship' })).map((c) => c.name)).toContain('check-merge');
  });

  it('parses, suggests and resolves', () => {
    const cmds = ticketCommands(card({ blocked: true, canContinue: true, column: 'verify' }));
    expect(parseComposer('/continue  the type is stale')).toEqual({ name: 'continue', args: 'the type is stale' });
    expect(suggest('/re', cmds).map((c) => c.name)).toEqual(['replan', 'review']);
    expect(suggest('/continue now', cmds)).toEqual([]);
    expect(resolve('why did verify fail?', cmds)).toMatchObject({ command: { name: 'ask' }, args: 'why did verify fail?' });
    expect(resolve('/continue just fix the import', cmds)).toMatchObject({ command: { name: 'continue' }, args: 'just fix the import' });
    expect(resolve('/ask', cmds)).toEqual({ error: 'Type the question after /ask.' });
    const noAsk = cmds.filter((c) => c.name !== 'ask');
    expect(resolve('just fix the import', noAsk)).toMatchObject({ command: { name: 'continue' } }); // review threads etc.
    expect(resolve('/review now please', cmds)).toEqual({ error: '/review does not take notes.' });
    expect(resolve('/merge', cmds).error).toMatch(/not available/);
  });

  it('gates /post exactly like the drawer', () => {
    const base = { ...review({ isOwn: false }), artifacts: { review: '## Findings', quality: null, log: null }, findings: null };
    expect(reviewPostBlocked(base)).toBeNull();
    expect(reviewPostBlocked({ ...base, running: true })).toMatch(/still running/);
    const withFindings = { ...base, findings: { rows: [], counts: { toPost: 0, posted: 1, accept: 1 } } };
    expect(reviewPostBlocked(withFindings)).toMatch(/already on the PR/);
    expect(reviewCommands(withFindings).find((c) => c.name === 'post').disabledReason).toMatch(/already on the PR/);
  });
});

describe('activity', async () => {
  const { diff, snapshot } = await import('../dashboard/ui/src/v2/activity.ts');
  const t = (o) => card({ key: 'PROJ-1', summary: 'S', ...o });

  it('says nothing on the first snapshot of a session', () => {
    expect(diff(null, snapshot([t({ running: true })], []), 1)).toEqual([]);
  });

  it('reports starts, moves, blocks, ready plans, merges and review outcomes', () => {
    const before = snapshot([t({ phase: 'build', column: 'build' }), t({ key: 'PROJ-2', column: 'ship', phase: 'ship' })], [review({ ref: 'r', running: true })]);
    const after = snapshot(
      [t({ phase: 'verify', column: 'verify', running: true, runMode: 'build', blocked: true }), t({ key: 'PROJ-2', column: 'archived', phase: 'ship' }), t({ key: 'PROJ-3', planReady: true })],
      [review({ ref: 'r', running: false, result: 'report-only', triage: { posted: 2 } })],
    );
    const text = diff(before, after, 5).map((e) => `${e.ref} ${e.text}`);
    expect(text).toEqual([
      'PROJ-1 build started', 'PROJ-1 moved to verify', 'PROJ-1 blocked at verify',
      'PROJ-2 PR merged', 'PROJ-3 appeared on the board',
      'r review finished: report-only', 'r 2 finding(s) posted to the PR',
    ]);
  });

  it('tells a manual archive from a merge', () => {
    const before = snapshot([t({ column: 'ship' })], []);
    const after = snapshot([t({ column: 'archived', manuallyArchived: true })], []);
    expect(diff(before, after, 1).map((e) => e.text)).toEqual(['archived']);
  });
});

describe('merged PRs stay out of the way', async () => {
  const { channelById: ch } = await import('../dashboard/ui/src/v2/channels.ts');
  const d = {
    board: { tickets: [], queue: [], running: [], columns: [], automation: { pending: [] } },
    reviews: [
      review({ ref: 'open-1', prState: 'OPEN', result: 'needs-input' }),
      review({ ref: 'merged-1', prState: 'MERGED', result: 'needs-input', triage: { total: 2, undecided: 2, accept: 0, toPost: 0, posted: 0, folded: 0, round: 1, stale: false } }),
      review({ ref: 'closed-1', prState: 'CLOSED' }),
      review({ ref: 'unknown-1', prState: null }),
    ],
    inbox: [], failed: {}, starred: new Set(),
  };

  it('#reviews shows open PRs by default, finished ones on request', () => {
    const c = ch('reviews');
    const scope = (id) => c.select(d).filter(c.scopes.find((s) => s.id === id).match).map((i) => i.id).sort();
    expect(c.defaults.scope).toBe('open');
    expect(scope('open')).toEqual(['open-1', 'unknown-1']); // unknown state is never hidden
    expect(scope('finished')).toEqual(['closed-1', 'merged-1']);
  });

  it('a merged PR never waits on you', () => {
    expect(ch('needs-you').select(d).map((i) => i.id)).toEqual(['open-1']);
  });
});
