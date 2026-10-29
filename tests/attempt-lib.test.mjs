import { describe, expect, it } from 'vitest';

import { recordAttempt, alreadyTried, formatAttemptMemory } from '../scripts/attempt-lib.mjs';

describe('recordAttempt', () => {
  it('immutably appends to the log', () => {
    const log = [];
    const next = recordAttempt(log, {
      round: 1,
      summary: 'fixed focus token',
      diffHash: 'abc123',
      scoreBefore: 0.5,
      scoreAfter: 0.7,
      failedChecks: ['a11y'],
    });
    expect(log).toEqual([]); // original untouched
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ round: 1, summary: 'fixed focus token', scoreBefore: 0.5, scoreAfter: 0.7 });
  });

  it('defaults failedChecks to an empty array', () => {
    const next = recordAttempt([], { round: 1, summary: 'x', diffHash: 'h', scoreBefore: 0, scoreAfter: 0 });
    expect(next[0].failedChecks).toEqual([]);
  });
});

describe('alreadyTried', () => {
  const log = [
    { round: 1, summary: '  Fix Focus Token  ', diffHash: 'hash-a', scoreBefore: 0.5, scoreAfter: 0.6, failedChecks: ['a11y'] },
  ];

  it('matches on identical diffHash', () => {
    expect(alreadyTried(log, { summary: 'unrelated', diffHash: 'hash-a' })).toBe(true);
  });

  it('matches on normalized (trimmed/case-insensitive/whitespace-collapsed) summary', () => {
    expect(alreadyTried(log, { summary: 'fix   focus token', diffHash: 'different' })).toBe(true);
  });

  it('returns false when neither summary nor diffHash match', () => {
    expect(alreadyTried(log, { summary: 'something else entirely', diffHash: 'hash-z' })).toBe(false);
  });

  it('returns false against an empty log', () => {
    expect(alreadyTried([], { summary: 'anything', diffHash: 'x' })).toBe(false);
  });
});

describe('formatAttemptMemory', () => {
  it('returns an empty string for no attempts', () => {
    expect(formatAttemptMemory([])).toBe('');
    expect(formatAttemptMemory(undefined)).toBe('');
  });

  it('formats a single attempt', () => {
    const log = [{ round: 2, summary: 'tightened border token', scoreBefore: 0.6, scoreAfter: 0.75, failedChecks: ['a11y', 'conventions'] }];
    expect(formatAttemptMemory(log)).toBe(
      'Already tried (did NOT reach target): round 2 — tightened border token (score 0.6→0.75, still failed: a11y, conventions)',
    );
  });

  it('formats multiple attempts, one per line', () => {
    const log = [
      { round: 1, summary: 'a', scoreBefore: 0.4, scoreAfter: 0.5, failedChecks: ['a11y'] },
      { round: 2, summary: 'b', scoreBefore: 0.5, scoreAfter: 0.6, failedChecks: ['conventions'] },
    ];
    const out = formatAttemptMemory(log);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('round 1 — a');
    expect(out).toContain('round 2 — b');
  });
});
