// Pure per-attempt memory logic for the repair loop — no filesystem, no I/O — so it's
// unit-testable with vitest. Prevents the coder from repeating a fix that already
// failed to reach the rubric target (a repair loop with no memory just re-tries the
// same broken idea every round).

/** Immutable append of one repair-round attempt onto the log. */
export function recordAttempt(log, { round, summary, diffHash, scoreBefore, scoreAfter, failedChecks }) {
  const arr = Array.isArray(log) ? log : [];
  return [...arr, { round, summary, diffHash, scoreBefore, scoreAfter, failedChecks: failedChecks || [] }];
}

function normalizeSummary(summary) {
  return (summary || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True if a prior attempt already tried this exact fix — same diff content (diffHash)
 * or the same normalized summary — so the coder doesn't repeat a known-failed fix. */
export function alreadyTried(log, { summary, diffHash }) {
  const arr = Array.isArray(log) ? log : [];
  const normTarget = normalizeSummary(summary);
  return arr.some(
    (a) => (diffHash && a.diffHash === diffHash) || (normTarget && normalizeSummary(a.summary) === normTarget),
  );
}

/** Compact, coder-prompt-ready rendering of the attempt log. Empty string if there are
 * no prior attempts (nothing to re-inject). */
export function formatAttemptMemory(log) {
  const arr = Array.isArray(log) ? log : [];
  if (arr.length === 0) return '';
  return arr
    .map((a) => {
      const checks = Array.isArray(a.failedChecks) && a.failedChecks.length ? a.failedChecks.join(', ') : 'unknown';
      return `Already tried (did NOT reach target): round ${a.round} — ${a.summary} (score ${a.scoreBefore}→${a.scoreAfter}, still failed: ${checks})`;
    })
    .join('\n');
}
