import { describe, expect, it } from 'vitest';

import { splitCases, aggregateScores, promotionDecision, recordPromotion } from '../scripts/champion-lib.mjs';

/** 40 synthetic cases with keys shuffled on input so splitCases's own deterministic
 * `key` ordering (not input order) is what's under test. */
function synthetic40() {
  const cases = [];
  for (let i = 1; i <= 40; i++) {
    cases.push({ key: `C${String(i).padStart(3, '0')}`, score: i / 40 });
  }
  // Shuffle deterministically (reverse + rotate) — no Math.random.
  return [...cases.slice(20), ...cases.slice(0, 20)].reverse();
}

describe('splitCases', () => {
  it('splits a 40-case bank into 25 improve / 15 holdout with no overlap, ordered by key', () => {
    const { improve, holdout, insufficient } = splitCases(synthetic40(), { improveSetSize: 25, holdoutSetSize: 15 });

    expect(improve).toHaveLength(25);
    expect(holdout).toHaveLength(15);
    expect(insufficient).toBe(false);

    const improveKeys = improve.map((c) => c.key);
    const holdoutKeys = holdout.map((c) => c.key);
    expect(new Set([...improveKeys, ...holdoutKeys]).size).toBe(40); // no overlap
    expect(improveKeys).toEqual([...improveKeys].sort()); // deterministic key order
    expect(holdoutKeys).toEqual([...holdoutKeys].sort());
    expect(improveKeys[0]).toBe('C001');
    expect(improveKeys.at(-1)).toBe('C025');
    expect(holdoutKeys[0]).toBe('C026');
    expect(holdoutKeys.at(-1)).toBe('C040');
  });

  it('flags insufficient when the case bank is too small to fill both sets', () => {
    const cases = [{ key: 'A', score: 1 }, { key: 'B', score: 1 }];
    const { improve, holdout, insufficient } = splitCases(cases, { improveSetSize: 25, holdoutSetSize: 15 });
    expect(improve).toHaveLength(2);
    expect(holdout).toHaveLength(0);
    expect(insufficient).toBe(true);
  });

  it('flags insufficient when the bank is exactly full but a caller-provided minimum exceeds holdoutSetSize', () => {
    // Bank is exactly big enough (40 cases for 25 improve + 15 holdout), so the
    // total-size check alone would pass — this exercises the separate
    // holdout.length < min check on its own.
    const { holdout, insufficient } = splitCases(synthetic40(), {
      improveSetSize: 25,
      holdoutSetSize: 15,
      minHoldoutCases: 20,
    });
    expect(holdout).toHaveLength(15);
    expect(insufficient).toBe(true);
  });

  it('is sufficient when the bank fully fills both sets and no stricter minimum is given', () => {
    const { insufficient } = splitCases(synthetic40(), { improveSetSize: 25, holdoutSetSize: 15 });
    expect(insufficient).toBe(false);
  });
});

describe('aggregateScores', () => {
  it('computes mean/min/count/byKey', () => {
    const r = aggregateScores([{ key: 'A', score: 0.8 }, { key: 'B', score: 0.6 }, { key: 'C', score: 1 }]);
    expect(r.count).toBe(3);
    expect(r.min).toBe(0.6);
    expect(r.mean).toBeCloseTo(0.8, 5);
    expect(r.byKey).toEqual({ A: 0.8, B: 0.6, C: 1 });
  });

  it('handles an empty result set', () => {
    expect(aggregateScores([])).toEqual({ mean: 0, min: 0, count: 0, byKey: {} });
  });
});

describe('promotionDecision', () => {
  const holdoutKeys = Array.from({ length: 12 }, (_, i) => `H${i + 1}`);

  it('PROMOTE — challenger beats champion by more than margin on 12 holdout cases, no regression', () => {
    const champion = holdoutKeys.map((key) => ({ key, score: 0.75 }));
    const challenger = holdoutKeys.map((key) => ({ key, score: 0.9 })); // +0.15, well over a 0.03 margin
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys,
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    expect(decision.promote).toBe(true);
    expect(decision.championMean).toBeCloseTo(0.75, 5);
    expect(decision.challengerMean).toBeCloseTo(0.9, 5);
    expect(decision.delta).toBeCloseTo(0.15, 5);
    expect(decision.reason).toMatch(/beats champion/);
  });

  it('HOLD — insufficient holdout (only 2 cases, below minHoldoutCases) refuses with an overfit-risk reason', () => {
    const champion = [{ key: 'H1', score: 0.7 }, { key: 'H2', score: 0.7 }];
    const challenger = [{ key: 'H1', score: 0.95 }, { key: 'H2', score: 0.95 }];
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys: ['H1', 'H2'],
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/insufficient holdout \(2 < 10\)/);
    expect(decision.reason).toMatch(/overfit/);
  });

  it('HOLD — higher mean but a regression on one holdout case (below floor AND more than margin under champion)', () => {
    // 11 cases where challenger comfortably beats champion, plus one case that
    // pulls the mean up further but tanks below the regression floor.
    const champion = [
      ...holdoutKeys.slice(0, 11).map((key) => ({ key, score: 0.75 })),
      { key: 'H12', score: 0.9 },
    ];
    const challenger = [
      ...holdoutKeys.slice(0, 11).map((key) => ({ key, score: 0.95 })), // +0.2 each
      { key: 'H12', score: 0.5 }, // regression: below floor 0.8, and 0.4 below champion's 0.9
    ];
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys,
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    // Sanity: challenger's mean is still higher than champion's despite the regression.
    expect(decision.challengerMean).toBeGreaterThan(decision.championMean);
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/regresses 1 holdout case/);
    expect(decision.reason).toContain('H12');
  });

  it('HOLD — challenger does not clear the margin even with no regression', () => {
    const champion = holdoutKeys.map((key) => ({ key, score: 0.8 }));
    const challenger = holdoutKeys.map((key) => ({ key, score: 0.81 })); // +0.01 < 0.03 margin
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys,
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/does not beat champion/);
  });

  it('treats an explicitly empty holdoutKeys as zero evaluated cases (does not fall back to unrestricted)', () => {
    const champion = [{ key: 'IMPROVE-1', score: 0.5 }];
    const challenger = [{ key: 'IMPROVE-1', score: 0.99 }];
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys: [],
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/insufficient holdout \(0 < 10\)/);
  });

  it('restricts scoring to holdoutKeys, ignoring any extra (e.g. improve-set) cases passed in', () => {
    const champion = [...holdoutKeys.map((key) => ({ key, score: 0.75 })), { key: 'IMPROVE-1', score: 0 }];
    const challenger = [...holdoutKeys.map((key) => ({ key, score: 0.9 })), { key: 'IMPROVE-1', score: 1 }];
    const decision = promotionDecision({
      champion,
      challenger,
      holdoutKeys,
      margin: 0.03,
      minHoldoutCases: 10,
      regressionFloor: 0.8,
    });
    expect(decision.promote).toBe(true);
    expect(decision.challengerMean).toBeCloseTo(0.9, 5); // unaffected by IMPROVE-1's score of 1
  });
});

describe('recordPromotion', () => {
  it('appends a promotionLog entry and bumps the champion version, without mutating the input registry', () => {
    const registry = {
      champions: { 'coder-agent': { version: 1, ref: '.claude/agents/coder-agent.md', promotedAt: null } },
      promotionLog: [],
    };
    const next = recordPromotion(registry, {
      agent: 'coder-agent',
      fromVersion: 1,
      toVersion: 2,
      delta: 0.12,
      holdoutN: 12,
      promotedAt: '2026-08-03T00:00:00.000Z',
    });

    expect(next.champions['coder-agent'].version).toBe(2);
    expect(next.champions['coder-agent'].ref).toBe('.claude/agents/coder-agent.md');
    expect(next.promotionLog).toHaveLength(1);
    expect(next.promotionLog[0]).toEqual({
      agent: 'coder-agent',
      fromVersion: 1,
      toVersion: 2,
      delta: 0.12,
      holdoutN: 12,
      promotedAt: '2026-08-03T00:00:00.000Z',
    });

    // Original registry untouched.
    expect(registry.champions['coder-agent'].version).toBe(1);
    expect(registry.promotionLog).toHaveLength(0);
  });

  it('defaults promotedAt to null when not supplied', () => {
    const next = recordPromotion({ champions: {}, promotionLog: [] }, {
      agent: 'router-agent',
      fromVersion: 1,
      toVersion: 2,
      delta: 0.05,
      holdoutN: 10,
    });
    expect(next.champions['router-agent'].promotedAt).toBeNull();
    expect(next.promotionLog[0].promotedAt).toBeNull();
  });
});
