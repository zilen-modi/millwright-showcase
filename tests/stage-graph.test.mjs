import { describe, expect, it } from 'vitest';

import {
  STAGES,
  TERMINAL_STAGES,
  ALL_STATES,
  STAGE_EDGES,
  nextStages,
  isLegalTransition,
  validateStagePath,
  RESUMABLE_STAGES,
  COLUMN_KEYS,
  STAGE_COLUMN_FOLD,
  stageColumn,
} from '../stage-graph.mjs';

describe('graph integrity', () => {
  it('every edge references states that exist', () => {
    for (const e of STAGE_EDGES) {
      expect(ALL_STATES, `edge from "${e.from}"`).toContain(e.from);
      expect(ALL_STATES, `edge to "${e.to}"`).toContain(e.to);
    }
  });

  it('every edge explains when it is taken', () => {
    for (const e of STAGE_EDGES) expect(e.when, `${e.from} → ${e.to}`).toBeTruthy();
  });

  // A stage nothing can reach is dead code in the pipeline; a stage nothing leaves is a
  // silent trap. Both are the kind of drift an edge set exists to make visible.
  it('every work stage is reachable and has an exit', () => {
    for (const s of STAGES) {
      if (s !== 'intake') {
        expect(STAGE_EDGES.some((e) => e.to === s), `nothing reaches "${s}"`).toBe(true);
      }
      expect(STAGE_EDGES.some((e) => e.from === s), `nothing leaves "${s}"`).toBe(true);
    }
  });

  it('the happy path is walkable end to end', () => {
    const happy = ['intake', 'route', 'preflight', 'context', 'plan', 'build', 'verify', 'review', 'ship'];
    expect(validateStagePath(happy).ok).toBe(true);
  });

  it('terminal states are not work stages', () => {
    for (const t of TERMINAL_STAGES) expect(STAGES).not.toContain(t);
  });
});

describe('isLegalTransition', () => {
  it('accepts the declared happy-path hops', () => {
    expect(isLegalTransition('intake', 'route')).toBe(true);
    expect(isLegalTransition('review', 'ship')).toBe(true);
  });

  it('accepts the repair cycle — this is what makes it a graph, not a list', () => {
    expect(isLegalTransition('review', 'build')).toBe(true);
    expect(isLegalTransition('verify', 'build')).toBe(true);
  });

  it('accepts the preflight early exit', () => {
    expect(isLegalTransition('preflight', 'done')).toBe(true);
  });

  it("accepts SHIP's self-review flowing back into build/verify", () => {
    expect(isLegalTransition('ship', 'build')).toBe(true);
    expect(isLegalTransition('ship', 'verify')).toBe(true);
  });

  it('treats a stage re-running in place as legal', () => {
    expect(isLegalTransition('build', 'build')).toBe(true);
  });

  // The whole point: these are the hops that used to validate as cleanly as a full walk.
  it('rejects skipping REVIEW', () => {
    expect(isLegalTransition('verify', 'ship')).toBe(false);
  });

  it('rejects skipping VERIFY', () => {
    expect(isLegalTransition('build', 'review')).toBe(false);
  });

  it('rejects skipping CONTEXT', () => {
    expect(isLegalTransition('preflight', 'plan')).toBe(false);
  });

  it('lets an external merge confirmation arrive from any stage', () => {
    for (const s of STAGES) expect(isLegalTransition(s, 'merged'), s).toBe(true);
  });

  it('lets a guardrail escalate from any stage, and resume back into it', () => {
    for (const s of STAGES) {
      expect(isLegalTransition(s, 'escalated'), s).toBe(true);
      expect(isLegalTransition('escalated', s), s).toBe(true);
    }
  });
});

describe('validateStagePath', () => {
  it('names the offending hop and the legal alternatives', () => {
    const { ok, violations } = validateStagePath(['plan', 'build', 'verify', 'ship']);
    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ from: 'verify', to: 'ship', index: 3 });
    expect(violations[0].allowed).toContain('review');
  });

  it('reports an unknown state as drift rather than silently passing it', () => {
    const { ok, violations } = validateStagePath(['intake', 'notify']);
    expect(ok).toBe(false);
    expect(violations[0].reason).toMatch(/unknown state/);
  });

  it('accepts a real repair-loop path', () => {
    expect(validateStagePath([
      'intake', 'route', 'preflight', 'context', 'plan',
      'build', 'verify', 'review', 'build', 'verify', 'review', 'ship', 'merged',
    ]).ok).toBe(true);
  });

  it('handles empty and single-element paths', () => {
    expect(validateStagePath([]).ok).toBe(true);
    expect(validateStagePath(['intake']).ok).toBe(true);
    expect(validateStagePath(undefined).ok).toBe(true);
  });
});

describe('derived projections', () => {
  it('every work stage is resumable — the SKILL used to document a shorter list', () => {
    expect(RESUMABLE_STAGES).toEqual(STAGES);
    expect(RESUMABLE_STAGES).toContain('preflight');
    expect(RESUMABLE_STAGES).toContain('context');
  });

  it('columns are the stage set minus the folded ones, plus queued/archived', () => {
    expect(COLUMN_KEYS[0]).toBe('queued');
    expect(COLUMN_KEYS[COLUMN_KEYS.length - 1]).toBe('archived');
    for (const folded of Object.keys(STAGE_COLUMN_FOLD)) {
      expect(COLUMN_KEYS, `${folded} should have no lane`).not.toContain(folded);
    }
    for (const s of STAGES) {
      if (!(s in STAGE_COLUMN_FOLD)) expect(COLUMN_KEYS, s).toContain(s);
    }
  });

  it('folds preflight and context onto a lane that exists', () => {
    expect(stageColumn('preflight')).toBe('route');
    expect(stageColumn('context')).toBe('plan');
    for (const s of STAGES) expect(COLUMN_KEYS, `${s} folds nowhere`).toContain(stageColumn(s));
  });

  it('passes through a stage that has its own lane', () => {
    expect(stageColumn('build')).toBe('build');
  });
});
