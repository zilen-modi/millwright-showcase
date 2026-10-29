import { describe, expect, it } from 'vitest';

import {
  buildInboxRow,
  inboxBucket,
  mergeBlocker,
  mergeSnapshots,
  myReview,
  requestedVia,
  reviewWentStale,
  sortInbox,
} from '../scripts/pr-inbox-lib.mjs';

describe('requestedVia', () => {
  it('matches a User node on my login (case-insensitively)', () => {
    const reviewRequests = {
      nodes: [{ requestedReviewer: { __typename: 'User', login: 'Zilen-Modi' } }],
    };
    expect(requestedVia(reviewRequests, 'zilen-modi', [])).toEqual({ kind: 'user', label: 'Zilen-Modi' });
  });

  it('matches a Team node carrying only a slug (no login) when I am a member', () => {
    // Real GraphQL shape: requestedReviewer is a union. A Team node has NO `login` field
    // at all, so a naive `?.login` check would silently miss this request entirely.
    const teamNode = { requestedReviewer: { __typename: 'Team', slug: 'platform-team' } };
    const reviewRequests = { nodes: [teamNode] };
    expect(teamNode.requestedReviewer.login).toBeUndefined();

    expect(requestedVia(reviewRequests, 'zilen-modi', ['platform-team'])).toEqual({
      kind: 'team',
      label: 'platform-team',
    });
  });

  it('does not match the same Team node when I am not a member', () => {
    const reviewRequests = {
      nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'platform-team' } }],
    };
    expect(requestedVia(reviewRequests, 'zilen-modi', ['design-team'])).toBeNull();
  });

  it('matches a team slug given as org/slug against a bare-slug member list', () => {
    const reviewRequests = {
      nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'acme-it-erp/platform-team' } }],
    };
    expect(requestedVia(reviewRequests, 'zilen-modi', ['platform-team'])).toEqual({
      kind: 'team',
      label: 'acme-it-erp/platform-team',
    });
  });

  it('ignores a Bot requested reviewer', () => {
    const reviewRequests = {
      nodes: [{ requestedReviewer: { __typename: 'Bot', login: 'dependabot' } }],
    };
    expect(requestedVia(reviewRequests, 'dependabot', [])).toBeNull();
  });

  it('returns null when reviewRequests is empty or myLogin is missing', () => {
    expect(requestedVia({ nodes: [] }, 'zilen-modi', [])).toBeNull();
    expect(requestedVia({ nodes: [{ requestedReviewer: { __typename: 'User', login: 'zilen-modi' } }] }, '', [])).toBeNull();
  });
});

describe('myReview', () => {
  it('returns my latest review state and timestamp', () => {
    const latestReviews = {
      nodes: [
        { author: { login: 'someone-else' }, state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
        { author: { login: 'Zilen-Modi' }, state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z' },
      ],
    };
    expect(myReview(latestReviews, 'zilen-modi')).toEqual({ state: 'COMMENTED', at: '2026-01-02T00:00:00Z' });
  });

  it('returns null when I have never reviewed this PR', () => {
    const latestReviews = { nodes: [{ author: { login: 'someone-else' }, state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }] };
    expect(myReview(latestReviews, 'zilen-modi')).toBeNull();
  });
});

describe('reviewWentStale', () => {
  it('is true when the head commit is newer than my review', () => {
    expect(reviewWentStale('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toBe(true);
  });

  it('is false when the timestamps are equal', () => {
    expect(reviewWentStale('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(reviewWentStale(null, '2026-01-02T00:00:00Z')).toBe(false);
    expect(reviewWentStale('2026-01-01T00:00:00Z', undefined)).toBe(false);
    expect(reviewWentStale(null, null)).toBe(false);
  });
});

function basePr(overrides = {}) {
  return {
    number: 1043,
    url: 'https://github.com/acme-it-erp/erp-next-ui-monorepo/pull/1043',
    title: 'Fix combobox commit',
    author: { login: 'someone-else' },
    isDraft: false,
    state: 'OPEN',
    reviewDecision: null,
    updatedAt: '2026-01-05T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    headRefName: 'fix/combobox',
    baseRefName: 'main',
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    ...overrides,
  };
}

describe('buildInboxRow / inboxBucket', () => {
  it('buckets a COMMENTED review as requested when the request already dropped and the branch moved on (#1043 regression)', () => {
    // reviewRequests is empty (GitHub drops it on any submitted review), and the real
    // GraphQL commits shape (last node is the head commit) proves the branch moved on.
    const pr = basePr({
      latestReviews: { nodes: [{ author: { login: 'zilen-modi' }, state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z' }] },
      commits: { nodes: [{ commit: { committedDate: '2026-01-03T00:00:00Z' } }] },
    });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });

    expect(row.requestedVia).toBeNull();
    expect(row.myReviewState).toBe('COMMENTED');
    expect(row.myReviewStale).toBe(true);
    expect(inboxBucket(row, 'zilen-modi')).toBe('requested');
  });

  it('does not bucket a COMMENTED review as requested when the branch has not moved since (not stale)', () => {
    const pr = basePr({
      latestReviews: { nodes: [{ author: { login: 'zilen-modi' }, state: 'COMMENTED', submittedAt: '2026-01-03T00:00:00Z' }] },
      commits: { nodes: [{ commit: { committedDate: '2026-01-03T00:00:00Z' } }] },
    });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });

    expect(row.myReviewStale).toBe(false);
    expect(inboxBucket(row, 'zilen-modi')).toBeNull();
  });

  it('builds the row id as prRefId so it joins to a pr-reviews/<ref> directory name', () => {
    const row = buildInboxRow({ pr: basePr(), owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });
    expect(row.id).toBe('acme-it-erp-erp-next-ui-monorepo-1043');
  });

  it('a draft PR with a live request still buckets requested (isDraft is never a filter)', () => {
    const pr = basePr({
      isDraft: true,
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'zilen-modi' } }] },
    });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });

    expect(row.isDraft).toBe(true);
    expect(inboxBucket(row, 'zilen-modi')).toBe('requested');
  });

  it('reviewDecision APPROVED does not drop a row I am still requested on', () => {
    const pr = basePr({
      reviewDecision: 'APPROVED',
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'zilen-modi' } }] },
    });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });

    expect(row.reviewDecision).toBe('APPROVED');
    expect(inboxBucket(row, 'zilen-modi')).toBe('requested');
  });

  it('normalizes an empty-string reviewDecision to null', () => {
    const pr = basePr({ reviewDecision: '' });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });
    expect(row.reviewDecision).toBeNull();
  });

  it('buckets my own PR as mine even when it carries a request for me', () => {
    const pr = basePr({
      author: { login: 'zilen-modi' },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'zilen-modi' } }] },
    });
    const row = buildInboxRow({ pr, owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });

    expect(inboxBucket(row, 'zilen-modi')).toBe('mine');
  });

  it('a PR with no request and no review of mine is not in the inbox', () => {
    const row = buildInboxRow({ pr: basePr(), owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', myLogin: 'zilen-modi' });
    expect(inboxBucket(row, 'zilen-modi')).toBeNull();
  });
});

describe('mergeSnapshots', () => {
  it('dedupes the same PR seen from both a repo scan and a search, keeping the repo-scan row', () => {
    const perRepo = {
      'acme-it-erp/erp-next-ui-monorepo': {
        rows: [{ id: 'acme-it-erp-erp-next-ui-monorepo-1043', source: 'repo-scan', title: 'From the repo scan' }],
      },
    };
    const searchRows = [{ id: 'acme-it-erp-erp-next-ui-monorepo-1043', source: 'search', title: 'From the search' }];

    const merged = mergeSnapshots(perRepo, searchRows);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('repo-scan');
    expect(merged[0].title).toBe('From the repo scan');
  });

  it('keeps rows that only appear in one source', () => {
    const perRepo = { 'acme-it-erp/repo-a': { rows: [{ id: 'a-1', source: 'repo-scan' }] } };
    const searchRows = [{ id: 'b-2', source: 'search' }];

    const merged = mergeSnapshots(perRepo, searchRows);
    expect(merged.map((row) => row.id).sort()).toEqual(['a-1', 'b-2']);
  });

  it('is safe against missing input', () => {
    expect(mergeSnapshots({}, [])).toEqual([]);
    expect(mergeSnapshots(undefined, undefined)).toEqual([]);
  });
});

describe('sortInbox', () => {
  it('sorts requested before mine, then updatedAt newest first', () => {
    const rows = [
      { id: 'a', bucket: 'mine', updatedAt: '2026-01-10T00:00:00Z' },
      { id: 'b', bucket: 'requested', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'c', bucket: 'requested', updatedAt: '2026-01-05T00:00:00Z' },
      { id: 'd', bucket: 'mine', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    expect(sortInbox(rows).map((row) => row.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('tolerates a null updatedAt, sorting it after rows with a real timestamp in the same bucket', () => {
    const rows = [
      { id: 'a', bucket: 'requested', updatedAt: null },
      { id: 'b', bucket: 'requested', updatedAt: '2026-01-05T00:00:00Z' },
    ];
    expect(sortInbox(rows).map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const rows = [
      { id: 'a', bucket: 'mine', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', bucket: 'requested', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    const original = [...rows];
    sortInbox(rows);
    expect(rows).toEqual(original);
  });
});

describe('mergeBlocker', () => {
  const row = (over) => ({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    checksState: 'SUCCESS', reviewDecision: 'APPROVED', ...over,
  });

  it('is null when nothing stands in the way', () => {
    expect(mergeBlocker(row())).toBeNull();
  });

  // The three real shapes seen on the live repo when this was written.
  it('reports conflicts (PR 1056: CONFLICTING/DIRTY)', () => {
    expect(mergeBlocker(row({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))).toBe('conflicts');
  });

  it('reports failing checks (PR 1091: UNSTABLE + FAILURE)', () => {
    expect(mergeBlocker(row({ mergeStateStatus: 'UNSTABLE', checksState: 'FAILURE' }))).toBe('checks failing');
  });

  it('reports a missing approval (PR 1076/1088: BLOCKED + REVIEW_REQUIRED)', () => {
    expect(mergeBlocker(row({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })))
      .toBe('needs approval');
  });

  it('puts conflicts ahead of a missing approval - the author must act first', () => {
    expect(mergeBlocker(row({
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED',
    }))).toBe('conflicts');
  });

  it('puts failing checks ahead of a missing approval', () => {
    expect(mergeBlocker(row({
      checksState: 'FAILURE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    }))).toBe('checks failing');
  });

  it('calls out changes-requested rather than a bare missing approval', () => {
    expect(mergeBlocker(row({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' })))
      .toBe('changes requested');
  });

  it('reports a draft before anything else', () => {
    expect(mergeBlocker(row({ isDraft: true, mergeable: 'CONFLICTING' }))).toBe('draft');
  });

  it('reports pending checks distinctly from failing ones', () => {
    expect(mergeBlocker(row({ checksState: 'PENDING' }))).toBe('checks running');
  });

  it('reports a branch behind its base', () => {
    expect(mergeBlocker(row({ mergeStateStatus: 'BEHIND' }))).toBe('behind base');
  });

  it('says nothing about a closed or merged PR', () => {
    expect(mergeBlocker(row({ state: 'MERGED' }))).toBeNull();
    expect(mergeBlocker(row({ state: 'CLOSED', mergeable: 'CONFLICTING' }))).toBeNull();
  });

  it('tolerates a row with none of the fields (an older cached sweep)', () => {
    expect(mergeBlocker({ state: 'OPEN', isDraft: false })).toBeNull();
    expect(mergeBlocker(null)).toBeNull();
  });
});
