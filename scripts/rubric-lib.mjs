// Pure rubric-scoring logic for the repair loop's numeric goal — no filesystem, no I/O
// — so it's unit-testable with vitest. Failure-mode #2 (no fuzzy scores on hard
// checks): conventions and a11y are BINARY-GATED — any violation zeroes that
// sub-score outright rather than letting a "mostly clean" diff average its way to a
// passing rubric. `codeQuality` (reusability/DRY, from quality-agent) is deliberately
// FUZZY, not binary-gated — it's an explicit judgment call, not a hard violation, and
// conflating it with `conventions`' binary gate would let a noisy DRY dispute zero out
// a dimension meant for well-defined lesson violations.
//
// Failure-mode #3 (Goal A3, contract §2): a dimension nobody actually measured must be
// EXCLUDED, never scored. Excluding drops that dimension's weight and renormalizes the
// rest to sum to 1, so an unmeasured dimension neither rewards nor punishes. The old
// `visualDiffSkipReason` handling paid out a free `rate: 1` — 0.30 of the whole rubric —
// for any non-empty sentence, which is how PROJ-2910 scored 0.993 with zero captured
// screenshots. A skip now excludes; and when the ticket's design.md enumerated variant
// nodes (so a diff was genuinely possible) the skip is REFUSED outright rather than
// excused.
//
// Failure-mode #4: exclusion itself became a loophole. "Not applicable" and "we could
// not run the check" are NOT the same thing, and collapsing them lets infrastructure
// failure buy a perfect score — PROJ-3016 scored a clean 1.000 with BOTH visualDiff
// (skipped) and conventions (no worktree to lint) dropped, i.e. three of five dimensions
// carrying the whole verdict. So:
//   - `excluded`   — genuinely not applicable (no variants enumerated; logic-only diff).
//                    Legitimate: renormalize and carry on.
//   - `unmeasured` — the check could not run (no worktree, no linter, no browser).
//                    An infrastructure failure, not a property of the change. Still
//                    removed from the arithmetic, but it POISONS the verdict: loopDecision
//                    refuses to return `done` while anything is unmeasured.
// Both drop out of the score; only one is allowed to end in a pass.

export const RUBRIC_DIMENSIONS = ['visualDiff', 'e2e', 'acCoverage', 'conventions', 'a11y', 'codeQuality'];

/** Score one attempt against the repair-loop rubric.
 * `inputs`: { visualDiffPassRate:0..1, acCoveredRatio:0..1, conventionViolations:int,
 *   a11yFailures:int, codeQualityScore:0..1, excludedDimensions:string[] }
 * `weights`: { visualDiff, acCoverage, conventions, a11y, codeQuality } (should sum to ~1)
 * `target`: the rubric score to reach (e.g. config.loop.rubricTarget)
 * `opts.exclude`: extra dimensions to exclude (not applicable), merged with
 *   `inputs.excludedDimensions`.
 * `opts.unmeasured`: dimensions whose check COULD NOT RUN, merged with
 *   `inputs.unmeasuredDimensions`. Removed from the arithmetic like an exclusion, but
 *   reported separately so `loopDecision` can refuse to pass the round.
 *
 * Returns { score, breakdown, weights, excluded, unmeasured, pass } where `breakdown`
 * OMITS every dropped dimension (absent, not 1) and `weights` is the renormalized set
 * actually used — so a caller can persist the pair and the number is self-explaining.
 * `pass` additionally requires nothing to be unmeasured. Throws when every dimension is
 * dropped, or when those left carry no weight: scoring nothing is an error, not a
 * perfect score. */
export function scoreRubric(inputs, weights, target, opts = {}) {
  const {
    visualDiffPassRate = 0,
    e2ePassRate = 0,
    acCoveredRatio = 0,
    conventionViolations = 0,
    a11yFailures = 0,
    codeQualityScore = 1, // default 1: a ticket with zero quality-agent findings isn't penalized
  } = inputs || {};

  const unmeasured = normalizeExcluded([
    ...toArray(inputs?.unmeasuredDimensions),
    ...toArray(opts?.unmeasured),
  ]);
  // A dimension that could not be measured is never also "not applicable" — unmeasured
  // wins, so a caller cannot launder an infrastructure failure into a clean exclusion.
  const excluded = normalizeExcluded([
    ...toArray(inputs?.excludedDimensions),
    ...toArray(opts?.exclude),
  ]).filter((d) => !unmeasured.includes(d));

  const dropped = [...excluded, ...unmeasured];
  const included = RUBRIC_DIMENSIONS.filter((d) => !dropped.includes(d));
  if (included.length === 0) {
    throw new Error(
      'scoreRubric: every rubric dimension was excluded or unmeasured — there is nothing left ' +
        'to score. An unscored round is not a passing one.',
    );
  }

  const all = {
    visualDiff: clamp01(visualDiffPassRate),
    e2e: clamp01(e2ePassRate),
    acCoverage: clamp01(acCoveredRatio),
    conventions: conventionViolations === 0 ? 1 : 0,
    a11y: a11yFailures === 0 ? 1 : 0,
    codeQuality: clamp01(codeQualityScore),
  };

  const rawWeights = Object.fromEntries(included.map((d) => [d, Math.max(0, Number(weights?.[d]) || 0)]));
  const total = Object.values(rawWeights).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new Error(
      `scoreRubric: the dimensions left after exclusion (${included.join(', ')}) carry zero total weight — cannot score.`,
    );
  }

  const breakdown = Object.fromEntries(included.map((d) => [d, all[d]]));
  const normalized = Object.fromEntries(included.map((d) => [d, rawWeights[d] / total]));
  const score = included.reduce((sum, d) => sum + breakdown[d] * normalized[d], 0);

  return {
    score,
    breakdown,
    weights: normalized,
    excluded,
    unmeasured,
    pass: score >= target && unmeasured.length === 0,
  };
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** Keep only real dimension names, de-duplicated and in canonical rubric order — so a
 * typo'd exclusion silently widens nothing and the persisted list is stable. */
function normalizeExcluded(names) {
  const set = new Set(names.filter((n) => RUBRIC_DIMENSIONS.includes(n)));
  return RUBRIC_DIMENSIONS.filter((d) => set.has(d));
}

function clamp01(n) {
  const v = Number(n) || 0;
  return Math.min(1, Math.max(0, v));
}

/** Independently recompute a visual-diff pass rate from a real `visual-diff.mjs`
 * report's per-variant verdicts — never trust a hand-typed `visualDiffPassRate`.
 * (Postmortem: PROJ-2998's rubric-inputs.json claimed 1.0 with zero captured
 * screenshots or a report anywhere in the ticket folder — a self-reported number
 * with no receipts sailed straight through the loop.) */
/** Statuses that mean "this pair was actually compared". Anything else was not measured, and
 *  counting it as a failure is a false negative: BLOCKED means a PNG could not even be read,
 *  and INCOMPARABLE means the two images do not depict the same state (PROJ-3109 diffed a
 *  filled reference against an empty story — no colour fix could ever have passed it).
 *  Returns null when nothing was comparable, so the caller can treat the dimension as
 *  UNMEASURED rather than as an honest zero. */
export const COMPARED_STATUSES = new Set(['PASS', 'FAIL']);

export function passRateFromReport(report) {
  const variants = Array.isArray(report?.variants) ? report.variants : [];
  const compared = variants.filter((v) => COMPARED_STATUSES.has(v?.status));
  if (compared.length === 0) return null;
  const passed = compared.filter((v) => v.status === 'PASS').length;
  return passed / compared.length;
}

/** Decide what the visualDiff dimension is worth this round. Four outcomes, and only
 * one of them can score above zero:
 *
 *   report      — a real visual-diff.mjs report; the rate is RECOMPUTED from its
 *                 per-variant verdicts, never read off the claim.
 *   skip        — an explicit `visualDiffSkipReason`. The dimension is EXCLUDED
 *                 (`rate: null`, weight renormalized away) — it is emphatically not a
 *                 pass. And when `opts.designEnumeratedVariants === true` the skip is
 *                 REFUSED (`verified: false`): the ticket enumerated the variant nodes, so a
 *                 diff was possible and "couldn't diff" is not true. `designEnumeratesVariants`
 *                 in loop-lib decides that - see it for which artefact is authoritative.
 *   unverified  — a nonzero claim with neither receipts nor a reason. Blocks the loop.
 *   none        — nothing was asserted; scores 0 honestly.
 *
 * `report` is the already-parsed JSON from the evidence file — reading it is loop.mjs's
 * job, not this pure module's. Returns { rate, verified, source, reason, excluded }. */
export function resolveVisualDiff(inputs, report, opts = {}) {
  const claimed = clamp01(inputs?.visualDiffPassRate);
  if (report) {
    const rate = passRateFromReport(report);
    if (rate === null) {
      // The report exists but nothing in it was actually compared. That is an infrastructure
      // or framing failure, not a score — it must block rather than read as a zero the loop
      // would try (and fail) to repair.
      return {
        rate: null,
        verified: false,
        source: 'report',
        reason:
          'visual-diff report contains no comparable variants (all BLOCKED or INCOMPARABLE) — '
          + 'the comparison never ran, so the dimension is unmeasured rather than failed',
        excluded: false,
        unmeasured: true,
      };
    }
    return { rate, verified: true, source: 'report', reason: null, excluded: false };
  }

  const skipReason = inputs?.visualDiffSkipReason;
  if (typeof skipReason === 'string' && skipReason.trim()) {
    if (opts?.designEnumeratedVariants === true) {
      return {
        rate: null,
        verified: false,
        source: 'skip',
        reason:
          'visualDiffSkipReason refused: design.md enumerated variant nodes for this ticket, so a per-node ' +
          `visual diff was possible and cannot be skipped. Claimed reason: "${skipReason.trim()}"`,
        excluded: false,
      };
    }
    return { rate: null, verified: true, source: 'skip', reason: skipReason.trim(), excluded: true };
  }

  if (claimed > 0) {
    return {
      rate: 0,
      verified: false,
      source: 'unverified',
      reason: `visualDiffPassRate=${claimed} claimed with no evidence report ("visualDiffEvidence") and no "visualDiffSkipReason"`,
      excluded: false,
    };
  }
  return { rate: 0, verified: true, source: 'none', reason: null, excluded: false };
}

/**
 * Decide what the `e2e` dimension is worth. Same discipline as `resolveVisualDiff`: the rate is
 * RECOMPUTED from the report's per-flow verdicts and never read off a claim.
 *
 * Four outcomes, and the distinction that matters most is the last two:
 *
 *   report      — a real e2e.mjs report; rate recomputed from its flows.
 *   absent      — the ticket defines no flows. EXCLUDED, weight renormalized away. This is the
 *                 backward-compatible default: a ticket with nothing to drive scores exactly as
 *                 it did before this dimension existed.
 *   unmeasured  — flows exist but none ran (no session, app down, every flow BLOCKED). NOT a
 *                 zero: the app was never exercised, so "the tests failed" would be a lie and
 *                 the repair loop would try to fix code that was never run.
 *   none        — a rate was claimed with no report. Scores 0 and blocks.
 *
 * `report` is the already-parsed JSON; reading the file is the caller's job, not this module's.
 */
export function resolveE2e(inputs, report, opts = {}) {
  const claimed = clamp01(inputs?.e2ePassRate);

  if (report) {
    const rate = e2eRateFrom(report);
    if (rate === null) {
      return {
        rate: null,
        verified: false,
        unmeasured: true,
        source: 'report',
        reason:
          'the e2e suite did not run in full - at least one flow is BLOCKED, so it never reached ' +
          'what it was meant to exercise (no session, the app is not up, the route is gated, or ' +
          'the server is on the wrong branch). Infrastructure, not a failing application. Any ' +
          'flows that did pass are too partial a sample to score.',
        excluded: false,
      };
    }
    return { rate, verified: true, source: 'report', reason: null, excluded: false };
  }

  // No flows defined for this ticket: not applicable, not a failure.
  if (opts?.hasFlows === false) {
    return {
      rate: null,
      verified: true,
      source: 'absent',
      reason: 'no e2e flows are defined for this ticket',
      excluded: true,
    };
  }

  // Flows exist but produced no report: the gate never ran. That is UNMEASURED, not a zero.
  // Scoring it 0 would read as "the app failed its own tests" the moment someone adds a flows
  // file, and send the repair loop off to fix code that was never exercised.
  if (opts?.hasFlows === true) {
    return {
      rate: null,
      verified: false,
      unmeasured: true,
      source: 'absent',
      reason:
        'e2e flows are defined but no report exists - the gate has not run. Start the stack, then ' +
        'node scripts/session.mjs && node scripts/e2e.mjs --key <KEY> --flows tickets/<KEY>/e2e-flows.json',
      excluded: false,
    };
  }

  if (claimed > 0) {
    return {
      rate: 0,
      verified: false,
      source: 'unverified',
      reason: `e2ePassRate=${claimed} claimed with no report. Run scripts/e2e.mjs and point "e2eEvidence" at its output.`,
      excluded: false,
    };
  }
  return { rate: 0, verified: true, source: 'none', reason: null, excluded: false };
}

/** The e2e rate, recomputed. Kept here (rather than imported from e2e-lib) so rubric-lib stays
 *  the single place that decides what a dimension is worth, with no dependency on the runner. */
function e2eRateFrom(report) {
  const flows = Array.isArray(report?.flows) ? report.flows : [];
  if (flows.length === 0) return null;
  // ANY blocked flow makes the whole suite unmeasured, not just that flow. Excluding blocked
  // flows from the denominator and scoring the rest looks reasonable and is not: PROJ-3907 had
  // four flows blocked by a gated route and one that passed only because the page was empty,
  // which came out as a flawless 1.000. A suite that did not run in full has not measured the
  // thing it was asked to measure, and a partial pass is the most flattering possible reading
  // of it.
  if (flows.some((f) => f?.status === 'BLOCKED')) return null;
  const ran = flows.filter((f) => f?.status === 'PASS' || f?.status === 'FAIL');
  if (ran.length === 0) return null;
  return ran.filter((f) => f.status === 'PASS').length / ran.length;
}

/** Which rubric dimensions are below a perfect 1 — used to build the "still failing"
 * restatement re-injected into each repair round. Excluded dimensions are absent from
 * `breakdown` and so are never listed: there is nothing for the coder to fix there. */
export function failingDimensions(breakdown) {
  return Object.entries(breakdown || {})
    .filter(([, v]) => v < 1)
    .map(([k]) => k);
}
