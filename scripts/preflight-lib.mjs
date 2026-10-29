// Pure pre-flight verdict logic, extracted for unit testing. Given the counts of
// reference commits/branches and entry-file-touching commits, decide whether existing
// work likely covers the ticket.
export function preflightVerdict({ refCommits = [], refBranches = [], fileCommits = [], keys = [] }) {
  const signals = [];
  if (refCommits.length) signals.push(`${refCommits.length} commit(s) reference ${keys.filter(Boolean).join('/')}`);
  if (refBranches.length) signals.push(`${refBranches.length} branch(es) reference the ticket/parent`);
  if (fileCommits.length) signals.push(`entry files changed by ${fileCommits.length} recent commit(s)`);
  const likelyExisting = refCommits.length > 0 || refBranches.length > 0 || fileCommits.length > 0;
  return {
    verdict: likelyExisting ? 'REVIEW-BEFORE-BUILD' : 'CLEAR-TO-BUILD',
    likelyExisting,
    signals,
  };
}
