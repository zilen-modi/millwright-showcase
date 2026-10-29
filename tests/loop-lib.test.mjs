import { describe, expect, it } from 'vitest';

import {
  budgetState,
  stallDetector,
  loopDecision,
  pinnedDimensions,
  reachableScore,
  restateGoal,
  designEnumeratesVariants,
  worktreeCandidates,
  rubricLine,
  statusRubricPatch,
  mergeStatus,
} from '../scripts/loop-lib.mjs';

describe('budgetState', () => {
  it('reports remaining budget and not exhausted when under cap', () => {
    const b = budgetState(2, 5);
    expect(b).toEqual({ spentUsd: 2, capUsd: 5, remaining: 3, exhausted: false });
  });

  it('is exhausted exactly at the cap', () => {
    const b = budgetState(5, 5);
    expect(b.exhausted).toBe(true);
    expect(b.remaining).toBe(0);
  });

  it('is exhausted when over the cap', () => {
    const b = budgetState(7, 5);
    expect(b.exhausted).toBe(true);
    expect(b.remaining).toBe(-2);
  });

  // The whole point of unsetting the cap is that work keeps running. The old
  // `Number(capUsd) || 0` made "no cap" mean "cap of zero", which is exhausted on the first
  // cent - so an operator turning the cap off would have stopped every ticket instead.
  it.each([null, undefined, 0, -1, NaN, 'nonsense'])('treats %p as no cap, never as a zero cap', (cap) => {
    const b = budgetState(9999, cap);
    expect(b.exhausted).toBe(false);
    expect(b.capUsd).toBeNull();
    expect(b.remaining).toBeNull();
    expect(b.spentUsd).toBe(9999);
  });
});

// PROJ-3645's real numbers: a deferred product thumbnail held visualDiff at 0 for three
// rounds at weight 0.30, so the 0.9 target was unreachable from round 1 and the loop spent
// $23 climbing at it.
const W = { visualDiff: 0.3, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 };
const R3645 = [
  { visualDiff: 0, acCoverage: 0.5, conventions: 1, a11y: 0, codeQuality: 0.72 },
  { visualDiff: 0, acCoverage: 0.81, conventions: 1, a11y: 0, codeQuality: 0.78 },
  { visualDiff: 0, acCoverage: 0.92, conventions: 1, a11y: 0, codeQuality: 0.86 },
];

describe('pinnedDimensions', () => {
  it('names the dimensions that never improved across the window', () => {
    expect(pinnedDimensions(R3645, 3).sort()).toEqual(['a11y', 'visualDiff']);
  });

  it('never pins a dimension that is already perfect', () => {
    // conventions sits at 1.0 in all three rounds: finished, not stuck. Dropping its weight
    // would quietly delete a dimension the ticket actually passed.
    expect(pinnedDimensions(R3645, 3)).not.toContain('conventions');
  });

  it('does not pin a dimension that improved, even slightly', () => {
    expect(pinnedDimensions(R3645, 3)).not.toContain('acCoverage');
    expect(pinnedDimensions(R3645, 3)).not.toContain('codeQuality');
  });

  it('needs real history and refuses to fire early', () => {
    expect(pinnedDimensions(R3645.slice(0, 2), 3)).toEqual([]);
    expect(pinnedDimensions([R3645[0]], 3)).toEqual([]);
    expect(pinnedDimensions([], 3)).toEqual([]);
    expect(pinnedDimensions(undefined, 3)).toEqual([]);
  });

  it('pins a dimension that regressed as well as one that flatlined', () => {
    const history = [{ a: 0.6 }, { a: 0.4 }, { a: 0.3 }];
    expect(pinnedDimensions(history, 3)).toEqual(['a']);
  });
});

describe('reachableScore', () => {
  it('renormalizes over the surviving weights', () => {
    const r = reachableScore({ breakdown: R3645[2], weights: W, pinned: ['visualDiff'] });
    // (0.92*0.25 + 1*0.17 + 0*0.13 + 0.86*0.15) / 0.70
    expect(r.score).toBeCloseTo(0.7557, 4);
    expect(r.droppedWeight).toBeCloseTo(0.3, 10);
  });

  it('is null when nothing is pinned, so the raw score stands', () => {
    expect(reachableScore({ breakdown: R3645[2], weights: W, pinned: [] })).toBeNull();
    expect(reachableScore({ breakdown: R3645[2], weights: W })).toBeNull();
  });

  it('is null when everything is pinned rather than dividing by zero', () => {
    expect(reachableScore({ breakdown: { a: 0 }, weights: { a: 1 }, pinned: ['a'] })).toBeNull();
  });
});

describe('loopDecision against a deferred dimension', () => {
  const D13 = [{ dimension: 'visualDiff', id: 'D13', reason: 'product thumbnail', approvedBy: 'operator' }];
  const base = {
    target: 0.9, round: 3, maxRounds: 4, spentUsd: 23.24, budgetUsd: null,
    stallRounds: 3, weights: W, deferrals: D13,
  };

  // The guard that keeps this from becoming a bypass. a11y sat at 0 for all three rounds
  // exactly as visualDiff did, but nobody ruled it deferred - it was simply unfixed. Only
  // the declared one may be dropped, so 0.529/0.70 = 0.76 and the loop keeps going.
  it('does NOT pass PROJ-3645 while its 4 undeclared a11y failures stand', () => {
    const d = loopDecision({
      ...base, score: 0.529, scoreHistory: [0.403, 0.49, 0.529],
      breakdown: R3645[2], breakdownHistory: R3645,
    });
    expect(d.action).not.toBe('done');
    expect(d.action).toBe('continue');
  });

  it('passes once a11y is fixed, and says the raw score stays below target', () => {
    const fixed = { ...R3645[2], a11y: 1 };
    const d = loopDecision({
      ...base, score: 0.659, scoreHistory: [0.403, 0.49, 0.659],
      breakdown: fixed, breakdownHistory: [...R3645, fixed],
    });
    expect(d.action).toBe('done');
    expect(d.pinned).toEqual(['visualDiff']);
    expect(d.belowRawTarget).toBe(true);
    expect(d.reachableScore).toBeCloseTo(0.9414, 4);
    expect(d.reason).toContain('0.66');
    expect(d.reason).toContain('always will');
  });

  // Both halves are required: a declaration is not a self-issued discount, and flatlining
  // is not a reason.
  it('ignores a deferral for a dimension that is still moving', () => {
    const moving = [{ dimension: 'acCoverage', id: 'X', reason: 'meh', approvedBy: 'operator' }];
    const fixed = { ...R3645[2], a11y: 1 };
    const d = loopDecision({
      ...base, deferrals: moving, score: 0.659, scoreHistory: [0.403, 0.49, 0.659],
      breakdown: fixed, breakdownHistory: [...R3645, fixed],
    });
    expect(d.action).toBe('continue');
  });

  it('ignores a deferral with no approver', () => {
    const unsigned = [{ dimension: 'visualDiff', id: 'D13', reason: 'product thumbnail' }];
    const fixed = { ...R3645[2], a11y: 1 };
    const d = loopDecision({
      ...base, deferrals: unsigned, score: 0.659, scoreHistory: [0.403, 0.49, 0.659],
      breakdown: fixed, breakdownHistory: [...R3645, fixed],
    });
    expect(d.action).toBe('continue');
  });

  it('keeps repairing on an early round, before anything can be called pinned', () => {
    const d = loopDecision({
      ...base, round: 1, score: 0.403, scoreHistory: [0.403],
      breakdown: R3645[0], breakdownHistory: [R3645[0]],
    });
    expect(d.action).toBe('continue');
  });

  it('still refuses to pass when a dimension could not be measured', () => {
    const fixed = { ...R3645[2], a11y: 1 };
    const d = loopDecision({
      ...base, score: 0.659, scoreHistory: [0.403, 0.49, 0.659],
      breakdown: fixed, breakdownHistory: [...R3645, fixed], unmeasured: ['conventions'],
    });
    expect(d.action).toBe('stop-unverified');
  });

  it('is unchanged when no breakdown history or deferrals are supplied', () => {
    const d = loopDecision({
      ...base, deferrals: undefined, score: 0.529, scoreHistory: [0.403, 0.49, 0.529],
    });
    expect(d.action).toBe('continue');
  });
});

describe('loopDecision with no budget cap', () => {
  const uncapped = {
    target: 0.9, round: 1, maxRounds: 4, budgetUsd: null,
    scoreHistory: [0.5], stallRounds: 3, spentUsd: 500,
  };

  it('keeps going on any spend once the cap is unset', () => {
    const d = loopDecision({ ...uncapped, score: 0.5 });
    expect(d.action).toBe('continue');
  });

  it('still stops on rounds when uncapped', () => {
    const d = loopDecision({ ...uncapped, score: 0.5, round: 4 });
    expect(d.action).toBe('stop-rounds');
  });

  it('still stops on stall when uncapped', () => {
    const d = loopDecision({ ...uncapped, score: 0.5, round: 2, scoreHistory: [0.6, 0.5, 0.5, 0.5] });
    expect(d.action).toBe('stop-stall');
  });

  it('still reaches done when uncapped', () => {
    expect(loopDecision({ ...uncapped, score: 0.95 }).action).toBe('done');
  });
});

describe('stallDetector', () => {
  it('is not stalled with an empty or short history', () => {
    expect(stallDetector([], 3).stalled).toBe(false);
    expect(stallDetector([0.5], 3).stalled).toBe(false);
  });

  it('is not stalled while scores keep strictly improving', () => {
    const r = stallDetector([0.4, 0.5, 0.6, 0.7], 3);
    expect(r.stalled).toBe(false);
    expect(r.roundsWithoutImprovement).toBe(0);
  });

  it('is stalled when the last stallRounds show no strict improvement over the best-so-far before them', () => {
    const r = stallDetector([0.4, 0.7, 0.7, 0.7, 0.6], 3);
    expect(r.stalled).toBe(true);
    expect(r.roundsWithoutImprovement).toBe(3);
  });

  it('treats a tie as no improvement (does not reset the streak)', () => {
    const r = stallDetector([0.5, 0.5], 1);
    expect(r.stalled).toBe(true);
    expect(r.roundsWithoutImprovement).toBe(1);
  });

  it('resets the streak on a strict improvement partway through', () => {
    const r = stallDetector([0.4, 0.4, 0.6, 0.6], 3);
    // best resets to 0.6 at index 2, then index 3 ties -> 1 round without improvement
    expect(r.roundsWithoutImprovement).toBe(1);
    expect(r.stalled).toBe(false);
  });
});

describe('loopDecision', () => {
  const base = { target: 0.9, round: 2, maxRounds: 4, spentUsd: 1, budgetUsd: 5, scoreHistory: [0.5, 0.6], stallRounds: 3 };

  it('done when score meets or exceeds target', () => {
    const d = loopDecision({ ...base, score: 0.9 });
    expect(d.action).toBe('done');
  });

  it('stop-budget takes precedence when budget is exhausted (even if rounds/stall would also fire)', () => {
    const d = loopDecision({ ...base, score: 0.5, spentUsd: 5, budgetUsd: 5, round: 4, maxRounds: 4 });
    expect(d.action).toBe('stop-budget');
    expect(d.reason).toMatch(/ESCALATION/);
  });

  it('stop-rounds when max rounds reached and budget is fine', () => {
    const d = loopDecision({ ...base, score: 0.5, round: 4, maxRounds: 4 });
    expect(d.action).toBe('stop-rounds');
  });

  it('stop-stall when stalled and rounds/budget are fine', () => {
    const d = loopDecision({
      ...base,
      score: 0.5,
      round: 3,
      maxRounds: 10,
      scoreHistory: [0.5, 0.5, 0.5, 0.5],
      stallRounds: 3,
    });
    expect(d.action).toBe('stop-stall');
  });

  it('continue when none of the stop conditions apply', () => {
    const d = loopDecision({ ...base, score: 0.5, round: 1, maxRounds: 4, scoreHistory: [0.3, 0.5], stallRounds: 3 });
    expect(d.action).toBe('continue');
  });
});

describe('restateGoal', () => {
  it('lists the still-failing dimensions', () => {
    const s = restateGoal('PROJ-1', 0.9, ['visualDiff', 'conventions']);
    expect(s).toBe('GOAL: PROJ-1 rubric >= 0.9. Still failing: visualDiff, conventions. Fix ONLY these.');
  });

  it('says "none" when nothing is failing', () => {
    const s = restateGoal('PROJ-1', 0.9, []);
    expect(s).toContain('Still failing: none.');
  });
});

describe('designEnumeratesVariants', () => {
  it('trusts design-links.json when it lists node ids', () => {
    const r = designEnumeratesVariants({
      designLinks: {
        links: [
          { label: 'Error Stack', nodeId: '2194-101658' },
          { label: 'Wizard Tooltip', nodeId: '2182-101225' },
        ],
      },
    });
    expect(r.enumerated).toBe(true);
    expect(r.source).toBe('design-links.json');
    expect(r.nodeIds).toEqual(['2194-101658', '2182-101225']);
  });

  it('falls back to backticked node ids in design.md', () => {
    const md = 'The Error Stack panel (node `2194-101658`) and the tooltip (`2182:101225`).';
    const r = designEnumeratesVariants({ designMd: md });
    expect(r.enumerated).toBe(true);
    expect(r.source).toBe('design.md');
    expect(r.nodeIds).toEqual(['2194-101658', '2182-101225']);
  });

  it('reads node ids out of figma URLs', () => {
    const md = 'https://www.figma.com/design/AbC/Guide?node-id=4785-14944';
    expect(designEnumeratesVariants({ designMd: md })).toMatchObject({ enumerated: true, nodeIds: ['4785-14944'] });
  });

  it('normalizes the colon and dash spellings of the same node into one id', () => {
    const md = 'see `201:5007` and again `201-5007`';
    expect(designEnumeratesVariants({ designMd: md }).nodeIds).toEqual(['201-5007']);
  });

  it('does not mistake an ISO date for a node id', () => {
    const md = 'Written 2026-08-09, revised 2026-08-10. No Figma nodes were provided for this ticket.';
    expect(designEnumeratesVariants({ designMd: md })).toMatchObject({ enumerated: false, nodeIds: [], source: null });
  });

  it('does not count a bare number pair in prose — only backticks or a node-id= param', () => {
    const md = 'The spec covers rows 1234-5678 of the table.';
    expect(designEnumeratesVariants({ designMd: md }).enumerated).toBe(false);
  });

  it('is false for a missing/empty design folder rather than throwing', () => {
    expect(designEnumeratesVariants().enumerated).toBe(false);
    expect(designEnumeratesVariants({ designMd: null, designLinks: null }).enumerated).toBe(false);
    expect(designEnumeratesVariants({ designLinks: { links: [] }, designMd: '' }).enumerated).toBe(false);
  });

  it('ignores link entries with no nodeId and falls through to design.md', () => {
    const r = designEnumeratesVariants({
      designLinks: { links: [{ label: 'Confluence page', url: 'https://x' }] },
      designMd: 'node `4716-302906`',
    });
    expect(r).toMatchObject({ enumerated: true, source: 'design.md', nodeIds: ['4716-302906'] });
  });

  // PROJ-3749: design.md's "Nodes examined" table is a RULED-OUT list - four of its five
  // backticked ids annotated wrong modal/screen - and the prose scan read all five as variants
  // to diff, refusing a skip that was true. A ticket cannot say "no" in prose, so it says it in
  // design-links.json instead. These are the two-way cases.
  it('takes an empty variantNodes as a real "no", overriding ruled-out ids in design.md', () => {
    const r = designEnumeratesVariants({
      designLinks: { variantNodes: [] },
      designMd: '| `33:546` | target modal | no `required` axis |\n| `3783:231758` | Wrong modal. |',
    });
    expect(r).toMatchObject({ enumerated: false, nodeIds: [], source: 'design-links.json' });
  });

  it('takes enumerationBlocked with a reason as a "no", and reports the reason', () => {
    const r = designEnumeratesVariants({
      designLinks: { enumerationBlocked: true, blockedReason: 'get_metadata denied headless' },
      designMd: 'ruled out: `33:546`',
    });
    expect(r).toMatchObject({ enumerated: false, source: 'design-links.json' });
    expect(r.blockedReason).toBe('get_metadata denied headless');
  });

  // The gate has to stay closed to the easy dodges: a bare blocked flag, and a deleted file.
  it('refuses a blocked claim with no reason and falls back to the prose scan', () => {
    const r = designEnumeratesVariants({
      designLinks: { enumerationBlocked: true },
      designMd: 'ruled out: `33:546`',
    });
    expect(r).toMatchObject({ enumerated: true, source: 'design.md' });
  });

  it('still reads design.md when design-links.json is malformed or gives no verdict', () => {
    for (const designLinks of [{}, { variantNodes: 'nope' }, { enumerationBlocked: 'yes' }, 'nonsense']) {
      expect(designEnumeratesVariants({ designLinks, designMd: '`33:546`' })).toMatchObject({
        enumerated: true,
        source: 'design.md',
      });
    }
  });

  it('reads variantNodes given as objects, and normalizes their spelling', () => {
    const r = designEnumeratesVariants({
      designLinks: { variantNodes: [{ nodeId: '201:5007' }, '201-5007', { nodeId: '46-4647' }] },
    });
    expect(r).toMatchObject({ enumerated: true, source: 'design-links.json' });
    expect(r.nodeIds).toEqual(['201-5007', '46-4647']);
  });
});

describe('worktreeCandidates', () => {
  it('names <KEY>-<repoId> per repo in status.json, in order', () => {
    expect(worktreeCandidates('PROJ-2910', { repos: ['erp-next-ui-monorepo', 'erp-next-web'] })).toEqual([
      'PROJ-2910-erp-next-ui-monorepo',
      'PROJ-2910-erp-next-web',
    ]);
  });

  it('is empty when status.json is missing or names no repos', () => {
    expect(worktreeCandidates('PROJ-1', null)).toEqual([]);
    expect(worktreeCandidates('PROJ-1', {})).toEqual([]);
    expect(worktreeCandidates('PROJ-1', { repos: [] })).toEqual([]);
    expect(worktreeCandidates('PROJ-1', { repos: [null, '  '] })).toEqual([]);
  });
});

describe('rubricLine', () => {
  const base = {
    key: 'PROJ-3027',
    round: 1,
    score: 0.93,
    breakdown: { visualDiff: 1, acCoverage: 1, conventions: 1, a11y: 1, codeQuality: 0.9 },
    weights: { visualDiff: 0.3, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 },
    action: 'done',
    reason: 'score 0.930 >= target 0.900',
    sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    shaSource: 'worktree',
    visualDiff: { source: 'report', rate: 1, reason: null, excluded: false },
    spentUsd: 3.02,
    budgetUsd: 5,
    scoredAt: '2026-08-09T12:00:00.000Z',
  };

  it('emits exactly the contract §1 shape', () => {
    const line = rubricLine(base);
    expect(Object.keys(line)).toEqual([
      'key',
      'round',
      'score',
      'breakdown',
      'weights',
      'excluded',
      'unmeasured',
      'pinned',
      'reachableScore',
      'action',
      'reason',
      'sha',
      'shaSource',
      'visualDiff',
      'spentUsd',
      'budgetUsd',
      'scoredAt',
    ]);
    expect(line.sha).toBe(base.sha);
    expect(line.shaSource).toBe('worktree');
    expect(line.visualDiff).toEqual({ source: 'report', rate: 1, reason: null, excluded: false });
  });

  it('forces shaSource to "unavailable" whenever there is no sha — never a claimed source', () => {
    expect(rubricLine({ ...base, sha: null, shaSource: 'worktree' })).toMatchObject({
      sha: null,
      shaSource: 'unavailable',
    });
    expect(rubricLine({ ...base, sha: '' })).toMatchObject({ sha: null, shaSource: 'unavailable' });
  });

  it('carries the exclusion list and the excluded visualDiff verdict', () => {
    const line = rubricLine({
      ...base,
      excluded: ['visualDiff'],
      breakdown: { acCoverage: 1, conventions: 1, a11y: 1, codeQuality: 1 },
      visualDiff: { source: 'skip', rate: null, reason: 'no browser in headless', excluded: true },
    });
    expect(line.excluded).toEqual(['visualDiff']);
    expect(line.breakdown).not.toHaveProperty('visualDiff');
    expect(line.visualDiff).toEqual({ source: 'skip', rate: null, reason: 'no browser in headless', excluded: true });
  });

  it('defaults a missing visualDiff verdict to a null-rate "none" rather than inventing one', () => {
    const line = rubricLine({ ...base, visualDiff: undefined });
    expect(line.visualDiff).toEqual({ source: 'none', rate: null, reason: null, excluded: false });
  });

  it('round-trips through JSON as a single line', () => {
    const line = rubricLine(base);
    const text = JSON.stringify(line);
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(line);
  });
});

describe('statusRubricPatch / mergeStatus', () => {
  it('patches exactly the four fields loop.mjs owns', () => {
    const patch = statusRubricPatch({ score: 0.93, sha: 'abc123', round: 2, scoredAt: '2026-08-09T12:00:00.000Z' });
    expect(patch).toEqual({
      rubricScore: 0.93,
      rubricSha: 'abc123',
      rubricRound: 2,
      rubricScoredAt: '2026-08-09T12:00:00.000Z',
    });
  });

  it('records a null sha rather than omitting the field', () => {
    expect(statusRubricPatch({ score: 1, round: 1, scoredAt: 'now' }).rubricSha).toBeNull();
  });

  it('never clobbers unrelated status fields', () => {
    const current = {
      key: 'PROJ-3027',
      stage: 'merged',
      repos: ['erp-next-ui-monorepo'],
      prs: ['https://github.com/x/y/pull/792'],
      mergeCommit: '74a1b64',
      rubricScore: 1,
    };
    const merged = mergeStatus(current, statusRubricPatch({ score: 0.71, sha: 'deadbee', round: 1, scoredAt: 'now' }));
    expect(merged.prs).toEqual(current.prs);
    expect(merged.mergeCommit).toBe('74a1b64');
    expect(merged.stage).toBe('merged');
    expect(merged.rubricScore).toBe(0.71); // the one field it does own is overwritten
    expect(merged.rubricSha).toBe('deadbee');
  });

  it('does not mutate the object it was given', () => {
    const current = { key: 'PROJ-1', rubricScore: 1 };
    mergeStatus(current, { rubricScore: 0.5 });
    expect(current.rubricScore).toBe(1);
  });

  it('tolerates a missing/garbage status.json object', () => {
    expect(mergeStatus(null, { rubricScore: 0.5 })).toEqual({ rubricScore: 0.5 });
    expect(mergeStatus('not an object', { rubricScore: 0.5 })).toEqual({ rubricScore: 0.5 });
  });
});

describe('loopDecision — unmeasured dimensions', () => {
  const base = { score: 1, target: 0.9, round: 1, maxRounds: 4, spentUsd: 1, budgetUsd: 5, scoreHistory: [1], stallRounds: 3 };

  it('refuses "done" and escalates when a check could not run', () => {
    const d = loopDecision({ ...base, unmeasured: ['conventions'] });
    expect(d.action).toBe('stop-unverified');
    expect(d.reason).toMatch(/could not be measured/i);
    expect(d.reason).toMatch(/conventions/);
  });

  it('returns done when nothing is unmeasured', () => {
    expect(loopDecision({ ...base, unmeasured: [] }).action).toBe('done');
    expect(loopDecision(base).action).toBe('done');
  });

  // An unverifiable verdict is not a verdict, so it outranks the budget/round caps —
  // spending more rounds cannot fix a check that never executed.
  it('outranks stop-budget', () => {
    const d = loopDecision({ ...base, score: 0.4, spentUsd: 99, unmeasured: ['visualDiff'] });
    expect(d.action).toBe('stop-unverified');
  });
});
