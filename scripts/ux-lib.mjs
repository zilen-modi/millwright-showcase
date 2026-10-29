// Pure UX-flow scoring logic — no filesystem, no I/O, no browser — so it's
// unit-testable with vitest. The orchestrator (via MCP) drives a real browser through
// the flow and collects `{ [checkName]: boolean }`; this module only scores what it's
// given. Failure-mode parity with rubric-lib.mjs: every required check is BINARY
// (pass/fail), and a check that was never run is a fail, not a free pass — a flow can't
// be claimed to work on the strength of checks nobody actually performed.

/** Score one collected UX-flow result against the configured required checks.
 * `checkResults`: { [checkName]: boolean } — collected by driving the flow.
 * `requiredChecks`: string[] — every check that must have been recorded.
 * `target`: the pass-rate bar (e.g. config.ux.target).
 * Returns { score, pass, failing }. `score` is passed/total over `requiredChecks`;
 * `pass` requires BOTH the score to clear `target` AND zero failing required checks —
 * one hard-failing (or untested) required check fails the flow outright, however high
 * the score. */
export function scoreFlow(checkResults, requiredChecks, target) {
  const required = Array.isArray(requiredChecks) ? requiredChecks : [];
  const results = checkResults && typeof checkResults === 'object' ? checkResults : {};

  const failing = required.filter((name) => results[name] !== true);
  const total = required.length;
  const passedCount = total - failing.length;
  const score = total > 0 ? passedCount / total : 0;

  return { score, pass: score >= (Number(target) || 0) && failing.length === 0, failing };
}

/** One-line human summary of a `scoreFlow` result, for logs/CLI output. */
export function flowSummary({ score, pass, failing } = {}) {
  const pct = (Number(score) || 0).toFixed(2);
  const status = pass ? 'PASS' : 'FAIL';
  const tail = failing && failing.length ? ` — failing: ${failing.join(', ')}` : '';
  return `UX flow ${status} (score ${pct})${tail}`;
}
