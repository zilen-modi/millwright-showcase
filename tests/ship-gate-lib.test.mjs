import { describe, expect, it } from 'vitest';

import {
  evaluateShipException,
  evaluateShipGate,
  overrideEvent,
  parseRubricReceipt,
  shipExceptionRecord,
  requiresShipGate,
  RECEIPT_PRODUCING_MODES,
  PR_CAPABLE_MODES,
  OVERRIDABLE_MODES,
} from '../dashboard/ship-gate-lib.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '9876543210fedcba9876543210fedcba98765432';

const line = (over = {}) => JSON.stringify({
  key: 'PROJ-3027',
  round: 2,
  score: 0.93,
  breakdown: { acCoverage: 1, conventions: 1, a11y: 1, codeQuality: 0.9 },
  weights: { acCoverage: 0.36, conventions: 0.24, a11y: 0.19, codeQuality: 0.21 },
  action: 'done',
  reason: 'score 0.930 >= target 0.900',
  sha: SHA,
  shaSource: 'worktree',
  spentUsd: 3.02,
  budgetUsd: 5,
  scoredAt: '2026-08-09T12:00:00.000Z',
  ...over,
});

/** A ticket in the good state: receipt says done, sha matches a live worktree HEAD. */
const passing = (over = {}) => ({
  mode: 'ship',
  key: 'PROJ-3027',
  rubricText: `${line({ round: 1, action: 'continue', score: 0.7 })}\n${line()}\n`,
  worktreePath: '/ws/.wt/PROJ-3027-erp-next-ui-monorepo',
  worktreeExists: true,
  headSha: SHA,
  headShaError: null,
  override: false,
  ...over,
});

describe('parseRubricReceipt', () => {
  it('returns the LAST non-blank line, not the first', () => {
    const text = `${line({ round: 1, action: 'continue' })}\n\n${line({ round: 2 })}\n\n`;
    const r = parseRubricReceipt(text);
    expect(r.ok).toBe(true);
    expect(r.receipt.round).toBe(2);
    expect(r.receipt.action).toBe('done');
    expect(r.lineCount).toBe(2);
  });

  it('reports missing / empty / unparseable / non-object bodies distinctly', () => {
    expect(parseRubricReceipt(null)).toEqual({ ok: false, error: 'missing' });
    expect(parseRubricReceipt('   \n\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseRubricReceipt('{not json')).toEqual({ ok: false, error: 'unparseable' });
    expect(parseRubricReceipt('[1,2,3]')).toEqual({ ok: false, error: 'not-an-object' });
    expect(parseRubricReceipt('"done"')).toEqual({ ok: false, error: 'not-an-object' });
  });

  it('never throws on a truncated final line', () => {
    const text = `${line()}\n{"key":"PROJ-1","round":3,"acti`;
    expect(parseRubricReceipt(text)).toEqual({ ok: false, error: 'unparseable' });
  });
});

describe('requiresShipGate', () => {
  it('gates every mode that can open a PR', () => {
    for (const mode of ['ship']) {
      expect(requiresShipGate(mode)).toBe(true);
      expect(PR_CAPABLE_MODES.has(mode)).toBe(true);
    }
  });

  it('does not gate the plan-only modes', () => {
    for (const mode of ['plan', 'replan', undefined, 'nonsense']) {
      expect(requiresShipGate(mode)).toBe(false);
    }
  });

  it('allows an override only on the manual ship mode', () => {
    expect([...OVERRIDABLE_MODES]).toEqual(['ship']);
  });
});

describe('evaluateShipGate — pass', () => {
  it('allows a run whose last receipt is done and sha-matched', () => {
    const d = evaluateShipGate(passing());
    expect(d.allowed).toBe(true);
    expect(d.gated).toBe(true);
    expect(d.overridden).toBe(false);
    expect(d.failure).toBeNull();
    expect(d.sha).toBe(SHA);
    expect(d.headSha).toBe(SHA);
    expect(d.reason).toContain('0.930');
    expect(d.reason).toContain('a1b2c3d');
  });

  it('tolerates a trailing newline / whitespace around the HEAD sha', () => {
    const d = evaluateShipGate(passing({ headSha: `${SHA}\n` }));
    expect(d.allowed).toBe(true);
  });

  it('passes ungated modes through untouched', () => {
    for (const mode of ['plan', 'replan']) {
      const d = evaluateShipGate(passing({ mode, rubricText: null }));
      expect(d).toMatchObject({ gated: false, allowed: true, reason: null, failure: null });
    }
  });

  it('gates all four PR-capable modes with the same rule', () => {
    for (const mode of ['ship']) {
      expect(evaluateShipGate(passing({ mode })).allowed).toBe(true);
      expect(evaluateShipGate(passing({ mode, rubricText: null })).allowed).toBe(false);
    }
  });
});

describe('evaluateShipGate — fail closed', () => {
  const rejects = (input, failure) => {
    const d = evaluateShipGate(input);
    expect(d.allowed).toBe(false);
    expect(d.gated).toBe(true);
    expect(d.failure).toBe(failure);
    // the reason must be a sentence an operator can act on, not a code
    expect(d.reason.length).toBeGreaterThan(40);
    expect(d.reason).toContain(input.key);
    return d;
  };

  it('rejects a ticket with no rubric.jsonl at all', () => {
    const d = rejects(passing({ rubricText: null }), 'no-receipt');
    expect(d.reason).toContain('tickets/PROJ-3027/rubric.jsonl');
  });

  it('rejects an empty rubric.jsonl', () => {
    rejects(passing({ rubricText: '\n  \n' }), 'bad-receipt');
  });

  it('rejects an unparseable last line', () => {
    const d = rejects(passing({ rubricText: `${line()}\n{"round":3,` }), 'bad-receipt');
    expect(d.reason).toContain('not valid JSON');
  });

  it('rejects a JSON last line that is not an object', () => {
    rejects(passing({ rubricText: '[{"action":"done"}]' }), 'bad-receipt');
  });

  it('rejects when the last round is not done (continue)', () => {
    const d = rejects(passing({ rubricText: line({ action: 'continue', score: 0.71 }) }), 'not-done');
    expect(d.reason).toContain('"continue"');
    expect(d.reason).toContain('0.710');
  });

  it('rejects every non-done terminal action too', () => {
    for (const action of ['stop-budget', 'stop-rounds', 'stop-stall']) {
      const d = evaluateShipGate(passing({ rubricText: line({ action }) }));
      expect(d.allowed).toBe(false);
      expect(d.failure).toBe('not-done');
      expect(d.reason).toContain(action);
    }
  });

  it('rejects a receipt with no action field', () => {
    rejects(passing({ rubricText: line({ action: undefined }) }), 'not-done');
  });

  it('rejects sha: null (score not bound to a tree)', () => {
    const d = rejects(passing({ rubricText: line({ sha: null, shaSource: 'unavailable' }) }), 'null-sha');
    expect(d.reason).toContain('unavailable');
  });

  it('rejects a blank/absent sha the same way', () => {
    expect(evaluateShipGate(passing({ rubricText: line({ sha: '   ' }) })).failure).toBe('null-sha');
    expect(evaluateShipGate(passing({ rubricText: line({ sha: undefined }) })).failure).toBe('null-sha');
    expect(evaluateShipGate(passing({ rubricText: line({ sha: 12345 }) })).failure).toBe('null-sha');
  });

  it('rejects when no worktree path could be resolved', () => {
    rejects(passing({ worktreePath: null, worktreeExists: false }), 'no-worktree-path');
  });

  it('rejects when the worktree directory is gone', () => {
    const d = rejects(passing({ worktreeExists: false }), 'missing-worktree');
    expect(d.reason).toContain('/ws/.wt/PROJ-3027-erp-next-ui-monorepo');
  });

  it('rejects an errored rev-parse as UNVERIFIED, never "assume fine"', () => {
    const d = rejects(passing({ headSha: null, headShaError: 'not a git repository' }), 'rev-parse-failed');
    expect(d.reason).toContain('UNVERIFIED');
    expect(d.reason).toContain('not a git repository');
  });

  it('rejects an empty rev-parse result', () => {
    rejects(passing({ headSha: '   ' }), 'rev-parse-empty');
  });

  it('rejects a stale score (sha mismatch)', () => {
    const d = rejects(passing({ headSha: OTHER_SHA }), 'sha-mismatch');
    expect(d.reason).toContain('a1b2c3d');
    expect(d.reason).toContain('9876543');
  });

  it('checks action BEFORE sha, so a not-done receipt reports the real problem', () => {
    const d = evaluateShipGate(passing({ rubricText: line({ action: 'continue', sha: null }) }));
    expect(d.failure).toBe('not-done');
  });
});

describe('evaluateShipGate — the override escape hatch', () => {
  it('lets a manual ship through, but records what was unverified', () => {
    const d = evaluateShipGate(passing({
      mode: 'ship', rubricText: null, override: true, overrideReason: 'hotfix, scored by hand',
    }));
    expect(d.allowed).toBe(true);
    expect(d.overridden).toBe(true);
    expect(d.failure).toBe('no-receipt');
    expect(d.reason).toContain('has no scoring receipt');
    expect(d.overrideReason).toBe('hotfix, scored by hand');
  });

  it('overrides every failure kind, always keeping the failure label for the audit line', () => {
    const cases = [
      [{ rubricText: null }, 'no-receipt'],
      [{ rubricText: 'junk' }, 'bad-receipt'],
      [{ rubricText: line({ action: 'continue' }) }, 'not-done'],
      [{ rubricText: line({ sha: null }) }, 'null-sha'],
      [{ worktreeExists: false }, 'missing-worktree'],
      [{ headSha: null, headShaError: 'boom' }, 'rev-parse-failed'],
      [{ headSha: OTHER_SHA }, 'sha-mismatch'],
    ];
    for (const [over, failure] of cases) {
      const d = evaluateShipGate(passing({ mode: 'ship', override: true, ...over }));
      expect(d.allowed).toBe(true);
      expect(d.overridden).toBe(true);
      expect(d.failure).toBe(failure);
    }
  });

  // Automated paths are no longer gated at spawn (they produce the receipt), so an override
  // is not merely refused there — it is meaningless. What must stay true is that no automated
  // path can ever be marked `overridden`, i.e. an override cannot be laundered through one.
  it('NEVER marks an automated path as overridden', () => {
    for (const mode of ['build', 'review', 'continue']) {
      const d = evaluateShipGate(passing({ mode, rubricText: null, override: true }));
      expect(d.overridden, mode).toBe(false);
    }
  });

  it('only honours a literal true, not a truthy value', () => {
    for (const override of ['true', 1, {}, 'yes']) {
      const d = evaluateShipGate(passing({ mode: 'ship', rubricText: null, override }));
      expect(d.allowed).toBe(false);
    }
  });

  it('does not mark a passing run as overridden just because override was sent', () => {
    const d = evaluateShipGate(passing({ mode: 'ship', override: true }));
    expect(d.allowed).toBe(true);
    expect(d.overridden).toBe(false);
    expect(d.failure).toBeNull();
  });
});

describe('overrideEvent', () => {
  it('builds an audit line that is not a stage_end (so pricing ignores it)', () => {
    const decision = evaluateShipGate(passing({ mode: 'ship', rubricText: null, override: true }));
    const ev = overrideEvent({
      key: 'PROJ-3027', mode: 'ship', decision, at: '2026-08-09T12:00:00.000Z', operatorReason: 'manual QA done',
    });
    expect(ev.event).toBe('ship_gate_override');
    expect(ev.event).not.toBe('stage_end');
    expect(ev).toMatchObject({ key: 'PROJ-3027', mode: 'ship', failure: 'no-receipt', operatorReason: 'manual QA done' });
    expect(ev.reason).toContain('no scoring receipt');
    expect(() => JSON.parse(JSON.stringify(ev))).not.toThrow();
  });

  it('truncates a long operator reason and normalises a blank one to null', () => {
    const long = overrideEvent({ key: 'K', mode: 'ship', decision: null, operatorReason: 'x'.repeat(900) });
    expect(long.operatorReason.length).toBe(500);
    expect(overrideEvent({ key: 'K', mode: 'ship', decision: null, operatorReason: '   ' }).operatorReason).toBeNull();
    expect(overrideEvent({ key: 'K', mode: 'ship', decision: null }).operatorReason).toBeNull();
  });
});

// The gate once covered build/review/continue too, which deadlocked the panel: those modes
// RUN the review stage and so write the receipt via loop.mjs, and refusing to spawn them for
// lacking that receipt meant a ticket could never earn its first one. The rejection even told
// the operator to "run the review stage" — exactly the button they had just pressed.
describe('receipt-producing modes are never gated at spawn', () => {
  it('lets a review/build/continue run start without a receipt', () => {
    for (const mode of ['build', 'review', 'continue']) {
      const d = evaluateShipGate({ key: 'PROJ-2910', mode, rubricText: null, headSha: null, worktreePath: null });
      expect(d.gated, `${mode} must not be gated`).toBe(false);
      expect(d.allowed, `${mode} must be allowed to run`).toBe(true);
    }
  });

  it('still gates the manual ship, which consumes a receipt it never produces', () => {
    const d = evaluateShipGate({ key: 'PROJ-2910', mode: 'ship', rubricText: null, headSha: 'abc1234', worktreePath: '/wt' });
    expect(d.gated).toBe(true);
    expect(d.allowed).toBe(false);
  });

  it('keeps the two mode sets disjoint — a mode cannot both produce and be gated on a receipt', () => {
    for (const m of RECEIPT_PRODUCING_MODES) expect(PR_CAPABLE_MODES.has(m), m).toBe(false);
  });
});

describe('ship exception — the one thing a human can grant', () => {
  const sha = '9568e84159a5ec70cd5072624c177f54f07a2233';
  const decision = { headSha: sha, sha, failure: 'not-done', reason: 'score 0.395 < 0.90' };
  const signed = (over = {}) =>
    JSON.stringify({
      ...shipExceptionRecord({ key: 'PROJ-3109', mode: 'ship', decision, operatorReason: 'accepted' }),
      ...over,
    });

  it('binds the exception to the tree the operator was looking at', () => {
    const rec = shipExceptionRecord({ key: 'PROJ-3109', mode: 'ship', decision });
    expect(rec.kind).toBe('ship-exception');
    expect(rec.headSha).toBe(sha);
    expect(rec.acceptedFailure).toBe('not-done');
  });

  it('authorises the commit it was signed for', () => {
    const v = evaluateShipException({ exceptionText: signed(), key: 'PROJ-3109', headSha: sha });
    expect(v.valid).toBe(true);
  });

  // The whole point of binding to a sha: any new work revokes it automatically.
  it('stops applying once the branch moves on', () => {
    const v = evaluateShipException({ exceptionText: signed(), key: 'PROJ-3109', headSha: 'b'.repeat(40) });
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/tree moved/);
  });

  it('cannot be borrowed by another ticket', () => {
    const v = evaluateShipException({ exceptionText: signed(), key: 'PROJ-9999', headSha: sha });
    expect(v.valid).toBe(false);
  });

  it('refuses an exception that names no commit', () => {
    const v = evaluateShipException({ exceptionText: signed({ headSha: null }), key: 'PROJ-3109', headSha: sha });
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/authorises no tree/);
  });

  it('refuses when HEAD cannot be read, rather than assuming a match', () => {
    const v = evaluateShipException({ exceptionText: signed(), key: 'PROJ-3109', headSha: null });
    expect(v.valid).toBe(false);
  });

  it('refuses a file of the wrong kind, so no other artifact can pose as one', () => {
    const v = evaluateShipException({ exceptionText: signed({ kind: 'rubric' }), key: 'PROJ-3109', headSha: sha });
    expect(v.valid).toBe(false);
  });

  it.each([
    ['absent', null],
    ['not JSON', 'nope'],
    ['an array', '[]'],
  ])('refuses when the file is %s', (_label, text) => {
    expect(evaluateShipException({ exceptionText: text, key: 'PROJ-3109', headSha: sha }).valid).toBe(false);
  });
});
