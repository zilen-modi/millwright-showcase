import { describe, expect, it } from 'vitest';

import { criticStop, objectionsFingerprint, triageObjections } from '../scripts/critic-lib.mjs';

describe('triageObjections', () => {
  it('splits open blocking/major from minor and counts resolved', () => {
    const objections = [
      { id: '1', text: 'Missing error state', severity: 'blocking' },
      { id: '2', text: 'Focus ring too faint', severity: 'major' },
      { id: '3', text: 'Naming nit', severity: 'minor' },
      { id: '4', text: 'Already fixed', severity: 'blocking', resolved: true },
    ];
    const r = triageObjections(objections);
    expect(r.open.map((o) => o.id)).toEqual(['1', '2']);
    expect(r.minor.map((o) => o.id)).toEqual(['3']);
    expect(r.resolvedCount).toBe(1);
  });

  it('is empty-safe', () => {
    expect(triageObjections([])).toEqual({ open: [], minor: [], resolvedCount: 0 });
    expect(triageObjections(undefined)).toEqual({ open: [], minor: [], resolvedCount: 0 });
  });

  it('resolved objections never count as open, regardless of severity', () => {
    const r = triageObjections([{ id: '1', text: 'x', severity: 'blocking', resolved: true }]);
    expect(r.open).toEqual([]);
    expect(r.resolvedCount).toBe(1);
  });
});

describe('objectionsFingerprint', () => {
  it('is stable across reordering and whitespace/case drift', () => {
    const a = [
      { id: '1', text: 'Missing error state', severity: 'blocking' },
      { id: '2', text: '  Focus Ring too faint ', severity: 'major' },
    ];
    const b = [
      { id: '2', text: 'focus ring   too faint', severity: 'major' },
      { id: '1', text: 'missing error state', severity: 'blocking' },
    ];
    expect(objectionsFingerprint(a)).toBe(objectionsFingerprint(b));
  });

  it('ignores minor and resolved objections', () => {
    const withMinor = [
      { id: '1', text: 'Missing error state', severity: 'blocking' },
      { id: '2', text: 'Naming nit', severity: 'minor' },
    ];
    const withoutMinor = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    expect(objectionsFingerprint(withMinor)).toBe(objectionsFingerprint(withoutMinor));
  });

  it('changes when the open objection set changes', () => {
    const round1 = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    const round2 = [{ id: '1', text: 'Missing error state', severity: 'blocking', resolved: true }];
    expect(objectionsFingerprint(round1)).not.toBe(objectionsFingerprint(round2));
  });
});

describe('criticStop', () => {
  it('resolve-path: stops once no open blocking/major objections remain', () => {
    const current = [
      { id: '1', text: 'Missing error state', severity: 'blocking', resolved: true },
      { id: '2', text: 'Naming nit', severity: 'minor' },
    ];
    const d = criticStop({ round: 2, maxRounds: 3, current, previousFingerprint: 'x' });
    expect(d).toEqual({ stop: true, reason: 'resolved' });
  });

  it('minor-only-stops: an objection list with only minor issues stops as resolved', () => {
    const current = [{ id: '1', text: 'Naming nit', severity: 'minor' }];
    const d = criticStop({ round: 1, maxRounds: 3, current, previousFingerprint: undefined });
    expect(d).toEqual({ stop: true, reason: 'resolved' });
  });

  it('repeat-path: stops when the critic repeats the same open objections', () => {
    const current = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    const previousFingerprint = objectionsFingerprint(current);
    const d = criticStop({ round: 2, maxRounds: 5, current, previousFingerprint });
    expect(d).toEqual({ stop: true, reason: 'critic repeating' });
  });

  it('max-rounds-path: stops at the round cap even with fresh objections', () => {
    const current = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    const d = criticStop({ round: 3, maxRounds: 3, current, previousFingerprint: 'something-else' });
    expect(d).toEqual({ stop: true, reason: 'max critic rounds' });
  });

  it('continues when objections are open, not repeating, and rounds remain', () => {
    const current = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    const d = criticStop({ round: 1, maxRounds: 3, current, previousFingerprint: 'something-else' });
    expect(d).toEqual({ stop: false, reason: 'continue' });
  });

  it('does not mistake "no previous round" for a repeat', () => {
    const current = [{ id: '1', text: 'Missing error state', severity: 'blocking' }];
    const d = criticStop({ round: 1, maxRounds: 3, current, previousFingerprint: undefined });
    expect(d.stop).toBe(false);
  });
});
