import { describe, expect, it } from 'vitest';

import {
  scoreRubric,
  failingDimensions,
  passRateFromReport,
  resolveE2e,
  resolveVisualDiff,
  RUBRIC_DIMENSIONS,
} from '../scripts/rubric-lib.mjs';

const weights = { visualDiff: 0.3, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 };

describe('scoreRubric', () => {
  it('scores a perfect attempt as 1 and passes', () => {
    const { score, breakdown, pass } = scoreRubric(
      { visualDiffPassRate: 1, e2ePassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 1 },
      weights,
      0.9,
    );
    expect(score).toBeCloseTo(1, 5);
    expect(breakdown).toEqual({ visualDiff: 1, e2e: 1, acCoverage: 1, conventions: 1, a11y: 1, codeQuality: 1 });
    expect(pass).toBe(true);
  });

  it('returns the weights it actually used, and an empty exclusion list by default', () => {
    const r = scoreRubric({ visualDiffPassRate: 1, e2ePassRate: 1, acCoveredRatio: 1 }, weights, 0.9);
    expect(r.excluded).toEqual([]);
    // `weights` carries no e2e key, so that dimension's weight is 0 and the renormalized set
    // matches the input exactly - which is what keeps a ticket defining no flows scoring as it
    // always did.
    expect(r.weights).toEqual({ ...weights, e2e: 0 });
  });

  it('binary-gates conventions: any violation zeroes that sub-score regardless of count', () => {
    const one = scoreRubric({ visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 1, a11yFailures: 0 }, weights, 0.9);
    const many = scoreRubric({ visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 50, a11yFailures: 0 }, weights, 0.9);
    expect(one.breakdown.conventions).toBe(0);
    expect(many.breakdown.conventions).toBe(0);
    expect(one.score).toBeCloseTo(many.score, 5);
  });

  it('binary-gates a11y: any failure zeroes that sub-score', () => {
    const { breakdown, score, pass } = scoreRubric(
      { visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 3, codeQualityScore: 1 },
      weights,
      0.9,
    );
    expect(breakdown.a11y).toBe(0);
    expect(score).toBeCloseTo(0.87, 5); // 1 - a11y weight (0.13)
    expect(pass).toBe(false);
  });

  it('keeps the binary gates working while another dimension is excluded', () => {
    const { breakdown, score, pass } = scoreRubric(
      {
        acCoveredRatio: 1,
        conventionViolations: 2,
        a11yFailures: 0,
        codeQualityScore: 1,
        excludedDimensions: ['visualDiff'],
      },
      weights,
      0.9,
    );
    expect(breakdown.conventions).toBe(0);
    // conventions weight renormalized to 0.17/0.7 ≈ 0.2429 — still a real, unforgiving loss.
    expect(score).toBeCloseTo(1 - 0.17 / 0.7, 5);
    expect(pass).toBe(false);
  });

  it('codeQuality is a fuzzy ratio, not binary-gated, and defaults to 1 (no penalty) when absent', () => {
    const withScore = scoreRubric(
      { visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 0.5 },
      weights,
      0.9,
    );
    expect(withScore.breakdown.codeQuality).toBe(0.5);

    const omitted = scoreRubric(
      { visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0 },
      weights,
      0.9,
    );
    expect(omitted.breakdown.codeQuality).toBe(1);
  });

  it('visualDiff and acCoverage are fuzzy ratios, not binary-gated', () => {
    const { breakdown } = scoreRubric(
      { visualDiffPassRate: 0.5, acCoveredRatio: 0.8, conventionViolations: 0, a11yFailures: 0 },
      weights,
      0.9,
    );
    expect(breakdown.visualDiff).toBe(0.5);
    expect(breakdown.acCoverage).toBe(0.8);
  });

  it('clamps out-of-range ratios into 0..1', () => {
    const { breakdown } = scoreRubric(
      { visualDiffPassRate: 1.5, acCoveredRatio: -0.2, conventionViolations: 0, a11yFailures: 0 },
      weights,
      0.9,
    );
    expect(breakdown.visualDiff).toBe(1);
    expect(breakdown.acCoverage).toBe(0);
  });

  it('fails when score is below target even with a high raw score', () => {
    const { pass } = scoreRubric(
      { visualDiffPassRate: 0.9, acCoveredRatio: 0.9, conventionViolations: 0, a11yFailures: 0 },
      weights,
      0.99,
    );
    expect(pass).toBe(false);
  });
});

describe('scoreRubric — dimension exclusion (contract §2)', () => {
  it('omits an excluded dimension from the breakdown entirely — it is absent, not 1', () => {
    const { breakdown, excluded } = scoreRubric(
      { acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 1, excludedDimensions: ['visualDiff'] },
      weights,
      0.9,
    );
    expect(breakdown).not.toHaveProperty('visualDiff');
    expect(Object.keys(breakdown)).toEqual(['e2e', 'acCoverage', 'conventions', 'a11y', 'codeQuality']);
    expect(excluded).toEqual(['visualDiff']);
  });

  it('renormalizes the remaining weights to sum to exactly 1', () => {
    const { weights: used } = scoreRubric({ excludedDimensions: ['visualDiff'] }, weights, 0.9);
    const sum = Object.values(used).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(used.acCoverage).toBeCloseTo(0.25 / 0.7, 10);
    expect(used.codeQuality).toBeCloseTo(0.15 / 0.7, 10);
    expect(used).not.toHaveProperty('visualDiff');
  });

  it('an excluded visualDiff neither rewards nor punishes: a perfect rest still scores 1', () => {
    const { score } = scoreRubric(
      { acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 1, excludedDimensions: ['visualDiff'] },
      weights,
      0.9,
    );
    expect(score).toBeCloseTo(1, 10);
  });

  it('an excluded visualDiff is NOT a free 0.30 — an otherwise-imperfect ticket still loses', () => {
    // The PROJ-2910 shape: everything else strong, visual diff never actually run.
    const excludedRun = scoreRubric(
      { acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 0.5, excludedDimensions: ['visualDiff'] },
      weights,
      0.9,
    );
    // Under the OLD free-1.0 behaviour this same ticket would have scored:
    const freePass = scoreRubric(
      { visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 0.5 },
      weights,
      0.9,
    );
    expect(excludedRun.score).toBeLessThan(freePass.score);
    expect(excludedRun.score).toBeCloseTo(1 - (0.15 * 0.5) / 0.7, 10);
  });

  it('a zero-scoring dimension weighs MORE once another is excluded (weight is redistributed)', () => {
    const before = scoreRubric({ visualDiffPassRate: 1, acCoveredRatio: 0, conventionViolations: 0, a11yFailures: 0 }, weights, 0.9);
    const after = scoreRubric(
      { acCoveredRatio: 0, conventionViolations: 0, a11yFailures: 0, excludedDimensions: ['visualDiff'] },
      weights,
      0.9,
    );
    expect(before.score).toBeCloseTo(0.75, 10); // 1 - 0.25
    expect(after.score).toBeCloseTo(1 - 0.25 / 0.7, 10); // ≈ 0.643 — a harsher, correct number
    expect(after.score).toBeLessThan(before.score);
  });

  it('supports excluding several dimensions at once', () => {
    const { breakdown, weights: used, excluded } = scoreRubric(
      { acCoveredRatio: 1, a11yFailures: 0, codeQualityScore: 1, excludedDimensions: ['visualDiff', 'conventions'] },
      weights,
      0.9,
    );
    expect(excluded).toEqual(['visualDiff', 'conventions']);
    expect(Object.keys(breakdown)).toEqual(['e2e', 'acCoverage', 'a11y', 'codeQuality']);
    expect(Object.values(used).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('accepts exclusions via opts.exclude as well as inputs, merged and de-duplicated', () => {
    const { excluded } = scoreRubric({ excludedDimensions: ['visualDiff'] }, weights, 0.9, {
      exclude: ['visualDiff', 'conventions'],
    });
    expect(excluded).toEqual(['visualDiff', 'conventions']);
  });

  it('reports exclusions in canonical rubric order regardless of input order', () => {
    const { excluded } = scoreRubric({ excludedDimensions: ['codeQuality', 'visualDiff'] }, weights, 0.9);
    expect(excluded).toEqual(['visualDiff', 'codeQuality']);
  });

  it('ignores an unknown dimension name rather than silently widening the exclusion', () => {
    const { excluded, breakdown } = scoreRubric({ excludedDimensions: ['notADimension'] }, weights, 0.9);
    expect(excluded).toEqual([]);
    expect(Object.keys(breakdown)).toEqual(RUBRIC_DIMENSIONS);
  });

  it('throws when EVERY dimension is excluded — an unscored round is not a perfect one', () => {
    expect(() => scoreRubric({ excludedDimensions: RUBRIC_DIMENSIONS }, weights, 0.9)).toThrow(
      /every rubric dimension was excluded/i,
    );
  });

  it('throws when the surviving dimensions carry no weight at all', () => {
    const lopsided = { visualDiff: 1, acCoverage: 0, conventions: 0, a11y: 0, codeQuality: 0 };
    expect(() => scoreRubric({ excludedDimensions: ['visualDiff'] }, lopsided, 0.9)).toThrow(/zero total weight/i);
  });
});

describe('passRateFromReport', () => {
  it('is the fraction of PASS among the variants actually COMPARED', () => {
    const report = { variants: [{ status: 'PASS' }, { status: 'PASS' }, { status: 'FAIL' }, { status: 'BLOCKED' }] };
    // BLOCKED means a PNG could not be read. Counting it as a failure charged the diff for an
    // infrastructure fault and made 2-of-3 read as 0.5 — a score no code change could repair.
    expect(passRateFromReport(report)).toBe(2 / 3);
  });

  it('excludes variants that could not be compared rather than failing them', () => {
    // INCOMPARABLE is the PROJ-3109 case: a filled reference diffed against an empty story.
    expect(passRateFromReport({ variants: [{ status: 'PASS' }, { status: 'INCOMPARABLE' }] })).toBe(1);
  });

  it('is null when nothing was comparable, so the caller can call it unmeasured not zero', () => {
    expect(passRateFromReport({ variants: [{ status: 'BLOCKED' }] })).toBe(null);
    expect(passRateFromReport({ variants: [] })).toBe(null);
    expect(passRateFromReport({})).toBe(null);
    expect(passRateFromReport(null)).toBe(null);
  });
});

describe('resolveVisualDiff', () => {
  it('recomputes the rate from a real report, ignoring whatever was claimed', () => {
    const report = { variants: [{ status: 'PASS' }, { status: 'FAIL' }] };
    const result = resolveVisualDiff({ visualDiffPassRate: 1 }, report);
    expect(result).toMatchObject({ rate: 0.5, verified: true, source: 'report', excluded: false });
  });

  it('a report wins over a skip reason — receipts beat prose', () => {
    const report = { variants: [{ status: 'PASS' }] };
    const result = resolveVisualDiff({ visualDiffSkipReason: 'no browser available' }, report);
    expect(result).toMatchObject({ rate: 1, source: 'report', excluded: false });
  });

  it('EXCLUDES the dimension on a skip reason — never rate 1 (the A3 hole)', () => {
    const result = resolveVisualDiff({ visualDiffSkipReason: 'logic-only change, no Figma variants' }, null);
    expect(result).toMatchObject({ verified: true, source: 'skip', excluded: true });
    expect(result.rate).not.toBe(1);
    expect(result.rate).toBeNull();
    expect(result.reason).toBe('logic-only change, no Figma variants');
  });

  it('REFUSES the skip when design.md enumerated variant nodes — a diff was possible', () => {
    const result = resolveVisualDiff(
      { visualDiffSkipReason: 'no browser/Playwright/Storybook in headless' },
      null,
      { designEnumeratedVariants: true },
    );
    expect(result.verified).toBe(false);
    expect(result.excluded).toBe(false);
    expect(result.rate).not.toBe(1);
    expect(result.reason).toMatch(/design\.md enumerated variant nodes/i);
    expect(result.reason).toMatch(/no browser\/Playwright\/Storybook in headless/);
  });

  it('only refuses on an explicit true — an unknown/absent design signal still excludes', () => {
    for (const opts of [undefined, {}, { designEnumeratedVariants: false }, { designEnumeratedVariants: 'yes' }]) {
      const result = resolveVisualDiff({ visualDiffSkipReason: 'nothing to diff' }, null, opts);
      expect(result).toMatchObject({ verified: true, source: 'skip', excluded: true });
    }
  });

  it('a whitespace-only skip reason is no reason at all', () => {
    const result = resolveVisualDiff({ visualDiffSkipReason: '   ', visualDiffPassRate: 1 }, null);
    expect(result).toMatchObject({ verified: false, source: 'unverified', excluded: false });
  });

  it('rejects a nonzero claim with neither a report nor a skip reason (the PROJ-2998 case)', () => {
    const result = resolveVisualDiff({ visualDiffPassRate: 1 }, null);
    expect(result.verified).toBe(false);
    expect(result.rate).toBe(0);
    expect(result.excluded).toBe(false);
    expect(result.reason).toMatch(/no evidence report/);
  });

  it('still rejects an unbacked claim when design.md enumerated variants', () => {
    const result = resolveVisualDiff({ visualDiffPassRate: 1 }, null, { designEnumeratedVariants: true });
    expect(result.verified).toBe(false);
    expect(result.source).toBe('unverified');
  });

  it('a zero claim with no report/skip reason is fine — nothing was asserted', () => {
    const result = resolveVisualDiff({}, null);
    expect(result).toMatchObject({ rate: 0, verified: true, source: 'none', excluded: false });
  });

  it('always returns the full shape so callers never branch on a missing key', () => {
    for (const result of [
      resolveVisualDiff({}, { variants: [{ status: 'PASS' }] }),
      resolveVisualDiff({ visualDiffSkipReason: 'x' }, null),
      resolveVisualDiff({ visualDiffPassRate: 1 }, null),
      resolveVisualDiff({}, null),
    ]) {
      expect(Object.keys(result).sort()).toEqual(['excluded', 'rate', 'reason', 'source', 'verified']);
    }
  });
});

describe('failingDimensions', () => {
  it('returns an empty array when everything is perfect', () => {
    expect(failingDimensions({ visualDiff: 1, acCoverage: 1, conventions: 1, a11y: 1 })).toEqual([]);
  });

  it('lists only the sub-scores below 1', () => {
    expect(failingDimensions({ visualDiff: 0.6, acCoverage: 1, conventions: 0, a11y: 1 })).toEqual([
      'visualDiff',
      'conventions',
    ]);
  });

  it('never lists an excluded dimension — it is absent from the breakdown, not failing', () => {
    const { breakdown } = scoreRubric(
      {
        acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 1,
        excludedDimensions: ['visualDiff', 'e2e'],
      },
      weights,
      0.9,
    );
    expect(failingDimensions(breakdown)).toEqual([]);
  });
});

// Failure-mode #4: exclusion became its own loophole. "Not applicable" and "the check
// could not run" both drop a dimension from the arithmetic, but only the first may end
// in a pass — PROJ-3016 scored a clean 1.000 on three of five dimensions because the
// two that were dropped were treated as legitimately absent.
describe('unmeasured vs excluded', () => {
  const W = { visualDiff: 0.3, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 };
  const perfect = { visualDiffPassRate: 1, acCoveredRatio: 1, conventionViolations: 0, a11yFailures: 0, codeQualityScore: 1 };

  it('reports unmeasured dimensions separately from excluded ones', () => {
    const r = scoreRubric(perfect, W, 0.9, { exclude: ['visualDiff'], unmeasured: ['conventions'] });
    expect(r.excluded).toEqual(['visualDiff']);
    expect(r.unmeasured).toEqual(['conventions']);
    expect(r.breakdown).not.toHaveProperty('visualDiff');
    expect(r.breakdown).not.toHaveProperty('conventions');
  });

  it('refuses to pass while a dimension is unmeasured, even at a perfect score', () => {
    const r = scoreRubric(perfect, W, 0.9, { unmeasured: ['conventions'] });
    expect(r.score).toBe(1);
    expect(r.pass).toBe(false);
  });

  it('still passes when the only dropped dimension is a legitimate exclusion', () => {
    const r = scoreRubric(perfect, W, 0.9, { exclude: ['visualDiff'] });
    expect(r.pass).toBe(true);
  });

  // Otherwise a caller could launder an infrastructure failure into a clean exclusion by
  // naming the same dimension in both lists.
  it('lets unmeasured win when a dimension is named in both lists', () => {
    const r = scoreRubric(perfect, W, 0.9, { exclude: ['conventions'], unmeasured: ['conventions'] });
    expect(r.excluded).toEqual([]);
    expect(r.unmeasured).toEqual(['conventions']);
    expect(r.pass).toBe(false);
  });

  it('throws when every dimension is dropped across both lists', () => {
    expect(() =>
      scoreRubric(perfect, W, 0.9, { exclude: ['visualDiff', 'e2e', 'acCoverage'], unmeasured: ['conventions', 'a11y', 'codeQuality'] }),
    ).toThrow(/nothing left/i);
  });
});

describe('resolveE2e', () => {
  const report = (...statuses) => ({ flows: statuses.map((st, i) => ({ name: `f${i}`, status: st })) });

  it('recomputes the rate from the per-flow verdicts', () => {
    const r = resolveE2e({}, report('PASS', 'PASS', 'FAIL', 'FAIL'));
    expect(r).toMatchObject({ rate: 0.5, verified: true, source: 'report', excluded: false });
  });

  it('ignores a claimed rate when a report is present', () => {
    expect(resolveE2e({ e2ePassRate: 1 }, report('FAIL')).rate).toBe(0);
  });

  // The distinction the whole dimension turns on. A ticket that defines no flows is NOT
  // applicable; a ticket whose flows never ran is NOT measured. Only the first may pass.
  it('EXCLUDES a ticket with no flows, so it scores exactly as it did before e2e existed', () => {
    const r = resolveE2e({}, null, { hasFlows: false });
    expect(r).toMatchObject({ excluded: true, verified: true, source: 'absent', rate: null });
    expect(r.unmeasured).toBeUndefined();
  });

  // Adding a flows file must never, on its own, score the ticket 0. The gate not having run is
  // an infrastructure fact, not a verdict on the app.
  it('reports UNMEASURED when flows exist but no report has been produced yet', () => {
    const r = resolveE2e({}, null, { hasFlows: true });
    expect(r.unmeasured).toBe(true);
    expect(r.rate).toBeNull();
    expect(r.excluded).toBe(false);
    expect(r.reason).toMatch(/has not run/);
  });

  it('reports UNMEASURED when flows exist but every one was BLOCKED', () => {
    const r = resolveE2e({}, report('BLOCKED', 'BLOCKED'));
    expect(r.unmeasured).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.excluded).toBe(false);
    expect(r.rate).toBeNull();
    expect(r.reason).toMatch(/did not run in full/);
  });

  // The most dangerous shape, and the one PROJ-3907 actually produced: four flows blocked by
  // a gated route plus one that passed only because the page was empty. Scoring the survivors
  // reads as a flawless 1.000 on almost no evidence.
  it('treats a PARTIALLY blocked suite as unmeasured, not as a perfect subset', () => {
    const r = resolveE2e({}, report('PASS', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED'));
    expect(r.rate).toBeNull();
    expect(r.unmeasured).toBe(true);
  });

  it('scores a suite that ran in full, failures and all', () => {
    expect(resolveE2e({}, report('PASS', 'FAIL')).rate).toBe(0.5);
  });

  it('refuses a rate claimed with no report', () => {
    const r = resolveE2e({ e2ePassRate: 0.9 }, null);
    expect(r).toMatchObject({ verified: false, source: 'unverified', rate: 0 });
    expect(r.reason).toMatch(/scripts\/e2e\.mjs/);
  });

  it('scores 0 honestly when nothing was asserted at all', () => {
    expect(resolveE2e({}, null)).toMatchObject({ rate: 0, verified: true, source: 'none' });
  });
});
