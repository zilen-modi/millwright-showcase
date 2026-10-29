import { describe, expect, it } from 'vitest';

import {
  buildE2eReport,
  failureSummary,
  passRateFromE2eReport,
  specWrites,
  stepUrl,
  validateFlow,
  validateSpec,
} from '../scripts/e2e-lib.mjs';

const okFlow = (over = {}) => ({
  name: 'open the ship screen',
  steps: [
    { action: 'goto', route: '/distribution/transfer/123/ship' },
    { action: 'expectVisible', selector: '[role="grid"]' },
  ],
  ...over,
});

describe('validateFlow', () => {
  it('accepts a well-formed read-only flow', () => {
    expect(validateFlow(okFlow())).toEqual([]);
  });

  it('reports every problem at once, not just the first', () => {
    const errors = validateFlow({ name: '', steps: [{ action: 'nope' }, { action: 'click' }] });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.join(' ')).toMatch(/non-empty "name"/);
    expect(errors.join(' ')).toMatch(/unknown action "nope"/);
    expect(errors.join(' ')).toMatch(/"click" needs a "selector"/);
  });

  it.each([
    [{ action: 'goto' }, /"goto" needs a "route"/],
    [{ action: 'fill', selector: '#a' }, /"fill" needs a string "value"/],
    [{ action: 'expectText', selector: '#a' }, /"expectText" needs "text"/],
    [{ action: 'expectVisible' }, /needs a "selector"/],
  ])('rejects %j', (step, want) => {
    expect(validateFlow({ name: 'f', steps: [step] }).join(' ')).toMatch(want);
  });

  // The backend is real and the test account's actions are real. Writing is opt-in, per flow.
  it('refuses a write step unless the flow opts in', () => {
    const flow = { name: 'f', steps: [{ action: 'submit', selector: '#save' }] };
    expect(validateFlow(flow).join(' ')).toMatch(/writes to the backend - set "writes": true/);
    expect(validateFlow({ ...flow, writes: true })).toEqual([]);
  });

  it.each([null, 'nope', 42])('rejects a non-object flow: %j', (f) => {
    expect(validateFlow(f).join(' ')).toMatch(/not an object/);
  });

  it('requires at least one step', () => {
    expect(validateFlow({ name: 'f', steps: [] }).join(' ')).toMatch(/at least one step/);
  });
});

describe('validateSpec', () => {
  it('accepts both the bare array and the { flows } wrapper', () => {
    expect(validateSpec([okFlow()]).ok).toBe(true);
    expect(validateSpec({ flows: [okFlow()] }).ok).toBe(true);
  });

  // Names key the report, so a duplicate would silently overwrite a verdict.
  it('rejects duplicate flow names', () => {
    const r = validateSpec([okFlow(), okFlow()]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/duplicate flow name/);
  });

  it('returns no flows when anything failed, so a broken spec cannot half-run', () => {
    const r = validateSpec([okFlow(), { name: 'bad', steps: [] }]);
    expect(r.ok).toBe(false);
    expect(r.flows).toEqual([]);
  });

  it.each([null, {}, [], 'nope', { flows: [] }])('rejects an empty or malformed spec: %j', (s) => {
    expect(validateSpec(s).ok).toBe(false);
  });
});

describe('specWrites', () => {
  it('is true only when a flow opts in', () => {
    expect(specWrites([okFlow()])).toBe(false);
    expect(specWrites([okFlow(), okFlow({ name: 'w', writes: true })])).toBe(true);
    expect(specWrites(null)).toBe(false);
  });
});

describe('stepUrl', () => {
  it.each([
    ['http://localhost:3000', '/a', 'http://localhost:3000/a'],
    ['http://localhost:3000/', '/a', 'http://localhost:3000/a'],
    ['http://localhost:3000', 'a', 'http://localhost:3000/a'],
  ])('joins %s + %s', (base, route, want) => {
    expect(stepUrl(base, route)).toBe(want);
  });
});

describe('passRateFromE2eReport', () => {
  const report = (...statuses) =>
    buildE2eReport({ key: 'K', appBase: 'http://x', results: statuses.map((s, i) => ({ name: `f${i}`, status: s })) });

  it('recomputes from the per-flow verdicts', () => {
    expect(passRateFromE2eReport(report('PASS', 'PASS', 'FAIL', 'FAIL'))).toBe(0.5);
    expect(passRateFromE2eReport(report('PASS'))).toBe(1);
    expect(passRateFromE2eReport(report('FAIL'))).toBe(0);
  });

  // The trap visual-diff already hit: a run that compared nothing must not read as a zero the
  // loop then tries to "repair" by changing code that was never exercised.
  it.each([
    [report(), 'no flows'],
    [report('BLOCKED', 'BLOCKED'), 'all blocked'],
    [{}, 'no report'],
    [null, 'null'],
  ])('is null when nothing ran (%s)', (r) => {
    expect(passRateFromE2eReport(r)).toBeNull();
  });

  it('ignores BLOCKED flows rather than counting them as failures', () => {
    expect(passRateFromE2eReport(report('PASS', 'BLOCKED'))).toBe(1);
  });

  it('ignores a tampered summary and trusts only the verdicts', () => {
    const r = { ...report('FAIL', 'FAIL'), pass: true };
    expect(passRateFromE2eReport(r)).toBe(0);
  });
});

describe('buildE2eReport', () => {
  it('summarises pass only when every flow passed', () => {
    expect(buildE2eReport({ key: 'K', results: [{ name: 'a', status: 'PASS' }] }).pass).toBe(true);
    expect(buildE2eReport({ key: 'K', results: [{ name: 'a', status: 'FAIL' }] }).pass).toBe(false);
    expect(buildE2eReport({ key: 'K', results: [] }).pass).toBe(false);
  });
});

describe('failureSummary', () => {
  it('names the flow, the step and the error', () => {
    const r = buildE2eReport({
      key: 'K',
      results: [
        { name: 'ok', status: 'PASS' },
        { name: 'broken', status: 'FAIL', failedStep: 2, error: 'selector not found' },
        { name: 'never ran', status: 'BLOCKED', error: 'no session' },
      ],
    });
    expect(failureSummary(r)).toEqual([
      'broken: FAIL at step 2 - selector not found',
      'never ran: BLOCKED - no session',
    ]);
  });

  it('is empty when everything passed', () => {
    expect(failureSummary(buildE2eReport({ key: 'K', results: [{ name: 'a', status: 'PASS' }] }))).toEqual([]);
  });
});
