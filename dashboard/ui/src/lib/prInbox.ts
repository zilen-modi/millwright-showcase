import type { PrInboxRow } from './types';

/** Why this PR cannot land, in the order the operator would act on it. Mirrors
 *  `mergeBlocker` in scripts/pr-inbox-lib.mjs - conflicts and red checks are the author's to
 *  fix, an approval is a person's to give. */
export function blocker(row: PrInboxRow): { label: string; tone: 'critical' | 'warning' | 'phase'; why: string } | null {
  if (row.state !== 'OPEN' || row.isDraft) return null;
  if (row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY') {
    return { label: 'conflicts', tone: 'critical', why: 'The branch conflicts with its base - the author has to resolve it.' };
  }
  if (row.checksState === 'FAILURE' || row.checksState === 'ERROR') {
    return { label: 'checks failing', tone: 'critical', why: 'At least one required check is red on the head commit.' };
  }
  if (row.checksState === 'PENDING' || row.mergeStateStatus === 'UNSTABLE') {
    return { label: 'checks running', tone: 'warning', why: 'Checks have not settled on the head commit yet.' };
  }
  if (row.reviewDecision === 'CHANGES_REQUESTED') {
    return { label: 'changes requested', tone: 'warning', why: 'A reviewer asked for changes; that has to be resolved before it can land.' };
  }
  if (row.mergeStateStatus === 'BLOCKED' || row.reviewDecision === 'REVIEW_REQUIRED') {
    return { label: 'needs approval', tone: 'phase', why: 'Everything else is green - branch protection is waiting on an approving review.' };
  }
  if (row.mergeStateStatus === 'BEHIND') {
    return { label: 'behind base', tone: 'warning', why: 'The branch is behind its base and has to be updated first.' };
  }
  return null;
}
