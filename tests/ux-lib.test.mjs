import { describe, expect, it } from 'vitest';

import { flowSummary, scoreFlow } from '../scripts/ux-lib.mjs';

const REQUIRED = ['keyboard-operable', 'focus-visible', 'escape-closes', 'roles-correct', 'no-dead-ends', 'error-recoverable'];

describe('scoreFlow', () => {
  it('all-pass scores 1.0 and passes', () => {
    const results = Object.fromEntries(REQUIRED.map((c) => [c, true]));
    const r = scoreFlow(results, REQUIRED, 0.9);
    expect(r).toEqual({ score: 1, pass: true, failing: [] });
  });

  it('one required fail drops below target and fails', () => {
    const results = Object.fromEntries(REQUIRED.map((c) => [c, true]));
    results['escape-closes'] = false;
    const r = scoreFlow(results, REQUIRED, 0.9);
    expect(r.pass).toBe(false);
    expect(r.failing).toEqual(['escape-closes']);
    expect(r.score).toBeLessThan(1);
  });

  it('a missing (untested) required check counts as a fail, not a free pass', () => {
    const results = Object.fromEntries(REQUIRED.filter((c) => c !== 'roles-correct').map((c) => [c, true]));
    const r = scoreFlow(results, REQUIRED, 0.9);
    expect(r.pass).toBe(false);
    expect(r.failing).toEqual(['roles-correct']);
  });

  it('fails outright on any hard-failing required check even if the score alone would clear target', () => {
    const many = Array.from({ length: 20 }, (_, i) => `check-${i}`);
    const results = Object.fromEntries(many.map((c) => [c, true]));
    results['check-0'] = false; // 19/20 = 0.95, above a 0.9 target
    const r = scoreFlow(results, many, 0.9);
    expect(r.score).toBeCloseTo(0.95);
    expect(r.pass).toBe(false);
    expect(r.failing).toEqual(['check-0']);
  });

  it('is empty-safe', () => {
    const r = scoreFlow({}, [], 0.9);
    expect(r).toEqual({ score: 0, pass: false, failing: [] });
  });
});

describe('flowSummary', () => {
  it('summarizes a pass', () => {
    expect(flowSummary({ score: 1, pass: true, failing: [] })).toBe('UX flow PASS (score 1.00)');
  });

  it('summarizes a fail with the failing checks named', () => {
    const s = flowSummary({ score: 0.83, pass: false, failing: ['escape-closes'] });
    expect(s).toContain('FAIL');
    expect(s).toContain('escape-closes');
  });
});
