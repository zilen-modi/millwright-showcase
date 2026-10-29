// Pure classification rules for the operator's PR inbox - no filesystem, no `gh`, no
// network, no implicit `Date.now()` (every timestamp is an argument). See each export's
// JSDoc for the GitHub quirks this encodes (dropped requests, the Team/User union, etc).

import { isOwnPr, prRefId, prUrlFromRef } from './pr-ref-lib.mjs';

function normalizeLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

/** The final `/`-segment of a team slug, lowercased, so `org/slug` and bare `slug` compare
 * equal regardless of which form either side supplies. */
function finalSegment(slug) {
  const text = String(slug ?? '').trim().toLowerCase();
  const index = text.lastIndexOf('/');
  return index === -1 ? text : text.slice(index + 1);
}

/** Accept either a raw array of nodes or a GraphQL `{nodes: [...]}` connection - callers
 * may hand either shape through, and this module never cares which. */
function nodesOf(connection) {
  if (Array.isArray(connection)) return connection;
  if (Array.isArray(connection?.nodes)) return connection.nodes;
  return [];
}

/**
 * A requested reviewer is a User login matching `myLogin`, OR a Team slug `myTeamSlugs`
 * includes. Team slugs on either side may be given as a bare `slug` or as `org/slug`;
 * comparison is case-insensitive and keys on the final segment only. A `Bot` requested
 * reviewer is never a match. Returns the first matching request, or null.
 */
export function requestedVia(reviewRequests, myLogin, myTeamSlugs = []) {
  const me = normalizeLogin(myLogin);
  if (!me) return null;

  const myTeams = new Set(
    (Array.isArray(myTeamSlugs) ? myTeamSlugs : []).map(finalSegment).filter(Boolean),
  );

  for (const node of nodesOf(reviewRequests)) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) continue;

    if (reviewer.__typename === 'User') {
      if (normalizeLogin(reviewer.login) === me) {
        return { kind: 'user', label: reviewer.login };
      }
    } else if (reviewer.__typename === 'Team') {
      const teamSlug = finalSegment(reviewer.slug);
      if (teamSlug && myTeams.has(teamSlug)) {
        return { kind: 'team', label: reviewer.slug };
      }
    }
    // A Bot requested reviewer (or any other typename) is never mine - ignored.
  }

  return null;
}

/**
 * My most recent review on this PR, or null. This is the ONLY way to tell "never looked
 * at it" apart from "looked at it and GitHub already dropped the request" - see the
 * module header. `latestReviews` is expected to already carry at most one entry per
 * author (GraphQL's `latestReviews` connection), so the first match wins.
 */
export function myReview(latestReviews, myLogin) {
  const me = normalizeLogin(myLogin);
  if (!me) return null;

  for (const node of nodesOf(latestReviews)) {
    if (normalizeLogin(node?.author?.login) === me) {
      return { state: node.state, at: node.submittedAt ?? null };
    }
  }

  return null;
}

/**
 * True only when the head commit is strictly newer than my last review. Missing/invalid
 * timestamps on either side, and equal timestamps, are both false - never guess stale.
 */
export function reviewWentStale(myReviewAt, headCommittedAt) {
  if (!myReviewAt || !headCommittedAt) return false;
  const reviewTime = Date.parse(myReviewAt);
  const headTime = Date.parse(headCommittedAt);
  if (Number.isNaN(reviewTime) || Number.isNaN(headTime)) return false;
  return headTime > reviewTime;
}

/** The head commit's `committedDate`, accepting either a plain `pr.headCommittedAt`
 * shorthand or the real GraphQL shape `pr.commits.nodes[].commit.committedDate` (the
 * last node in that connection is the head commit). Not push time - see module header. */
function headCommittedAtOf(pr) {
  if (pr?.headCommittedAt) return pr.headCommittedAt;
  const nodes = pr?.commits?.nodes;
  if (Array.isArray(nodes) && nodes.length) {
    const head = nodes[nodes.length - 1];
    return head?.commit?.committedDate ?? head?.committedDate ?? null;
  }
  return null;
}

function normalizeReviewDecision(value) {
  return value === '' || value == null ? null : value;
}

/**
 * Build one flat `PrInboxRow` from a raw GraphQL PR node plus the identity context
 * needed to classify it. `id` is `prRefId({owner, repo, number})` so it joins to a
 * `pr-reviews/<ref>` directory name by plain string equality.
 */
export function buildInboxRow({ pr, owner, repo, myLogin, myTeamSlugs = [], inManifest = false, source = null }) {
  const number = pr?.number;
  const review = myReview(pr?.latestReviews, myLogin);
  const myReviewAt = review?.at ?? null;
  const headCommittedAt = headCommittedAtOf(pr);

  return {
    id: prRefId({ owner, repo, number }),
    owner,
    repo,
    repoSlug: `${owner}/${repo}`,
    number,
    url: pr?.url ?? prUrlFromRef({ owner, repo, number }),
    title: pr?.title ?? '',
    author: pr?.author?.login ?? '',
    isDraft: Boolean(pr?.isDraft),
    state: pr?.state ?? null,
    reviewDecision: normalizeReviewDecision(pr?.reviewDecision),
    updatedAt: pr?.updatedAt ?? null,
    createdAt: pr?.createdAt ?? null,
    headRefName: pr?.headRefName ?? null,
    baseRefName: pr?.baseRefName ?? null,
    requestedVia: requestedVia(pr?.reviewRequests, myLogin, myTeamSlugs),
    myReviewState: review?.state ?? null,
    myReviewAt,
    headCommittedAt,
    myReviewStale: reviewWentStale(myReviewAt, headCommittedAt),
    // Whether the PR can actually land, which is the question a row is usually being read to
    // answer. `mergeable` is only about conflicts; `mergeStateStatus` is why GitHub is
    // refusing (BLOCKED = wants a review, UNSTABLE = a check is red, DIRTY = conflicts).
    mergeable: pr?.mergeable ?? null,
    mergeStateStatus: pr?.mergeStateStatus ?? null,
    checksState: pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    inManifest: Boolean(inManifest),
    source,
  };
}

/**
 * One short phrase for why a PR cannot land, or null when nothing is standing in the way.
 * Ordered by what the operator would have to do about it: conflicts and red checks are the
 * author's to fix, a missing approval is a person's to give.
 */
export function mergeBlocker(row) {
  if (!row || row.state !== 'OPEN') return null;
  if (row.isDraft) return 'draft';
  if (row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY') return 'conflicts';
  if (row.checksState === 'FAILURE' || row.checksState === 'ERROR') return 'checks failing';
  if (row.checksState === 'PENDING' || row.mergeStateStatus === 'UNSTABLE') return 'checks running';
  if (row.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (row.mergeStateStatus === 'BLOCKED' || row.reviewDecision === 'REVIEW_REQUIRED') return 'needs approval';
  if (row.mergeStateStatus === 'BEHIND') return 'behind base';
  return null;
}

/**
 * 'requested' = a live request (user or team) OR my own review that no longer reflects
 * the branch, or that asked for changes. 'mine' = I authored it - checked first, so an
 * author's own request-for-self never lands in 'requested'. Everything else is null (not
 * in the inbox). A draft is still requested - `isDraft` is never a filter here, and
 * `reviewDecision` is never used to drop a row (an already-APPROVED PR I'm still
 * requested on is still 'requested').
 */
export function inboxBucket(row, myLogin) {
  if (isOwnPr(myLogin, row?.author)) return 'mine';
  if (row?.requestedVia) return 'requested';
  if (row?.myReviewState === 'CHANGES_REQUESTED') return 'requested';
  if (row?.myReviewStale) return 'requested';
  return null;
}

const BUCKET_RANK = { requested: 0, mine: 1 };

/**
 * Sort rows requested-before-mine, then `updatedAt` descending within each bucket.
 * Expects each row to already carry a `bucket` field (from `inboxBucket`) - rows with an
 * unrecognised/missing bucket sort last. Missing/invalid `updatedAt` sorts after any row
 * that has a real timestamp, within the same bucket. Does not mutate its input.
 */
export function sortInbox(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const rankA = BUCKET_RANK[a?.bucket] ?? 2;
    const rankB = BUCKET_RANK[b?.bucket] ?? 2;
    if (rankA !== rankB) return rankA - rankB;

    const atA = a?.updatedAt ? Date.parse(a.updatedAt) : NaN;
    const atB = b?.updatedAt ? Date.parse(b.updatedAt) : NaN;
    const validA = !Number.isNaN(atA);
    const validB = !Number.isNaN(atB);
    if (validA && validB) return atB - atA;
    if (validA) return -1;
    if (validB) return 1;
    return 0;
  });
}

/**
 * Dedupe rows from a per-repo scan and a cross-repo search by `id`. A repo-scan row
 * always wins over a search row for the same PR - the repo scan is the more complete
 * fetch, so its `source` (and every other field) is kept.
 */
export function mergeSnapshots(perRepo, searchRows = []) {
  const byId = new Map();

  for (const key of Object.keys(perRepo ?? {})) {
    for (const row of perRepo[key]?.rows ?? []) {
      if (!row?.id) continue;
      byId.set(row.id, row);
    }
  }

  for (const row of Array.isArray(searchRows) ? searchRows : []) {
    if (!row?.id || byId.has(row.id)) continue;
    byId.set(row.id, row);
  }

  return [...byId.values()];
}
