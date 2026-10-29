import { describe, expect, it } from 'vitest';

import { ConfigSchema, CostModelSchema, CriticSchema, FollowupSchema, QueueSchema, UxSchema, parseEventLine } from '../schemas.mjs';

describe('parseEventLine', () => {
  it('accepts a valid stage_end event', () => {
    const r = parseEventLine('{"event":"stage_end","stage":"build","status":"ok","tokensTotal":1000}');
    expect(r.ok).toBe(true);
    expect(r.event.stage).toBe('build');
  });
  it('rejects invalid JSON', () => {
    expect(parseEventLine('{not json')).toMatchObject({ ok: false, reason: 'invalid JSON' });
  });
  it('ignores non stage_end events', () => {
    expect(parseEventLine('{"event":"other"}')).toMatchObject({ ok: false, reason: 'not a stage_end' });
  });
  it('rejects an unknown stage with a reason', () => {
    const r = parseEventLine('{"event":"stage_end","stage":"deploy"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('stage');
  });
});

describe('CostModelSchema', () => {
  it('requires a _default rate', () => {
    const r = CostModelSchema.safeParse({ version: 1, models: { opus: { in: 15, out: 75 } } });
    expect(r.success).toBe(false);
  });
  it('accepts a valid model + extra comment keys', () => {
    const r = CostModelSchema.safeParse({ version: 1, _comment: 'x', models: { _default: { in: 3, out: 15 } } });
    expect(r.success).toBe(true);
  });
});

describe('QueueSchema', () => {
  it('rejects an unknown mode', () => {
    const r = QueueSchema.safeParse({ version: 1, jql: 'x', maxPerRun: 2, mode: 'yolo' });
    expect(r.success).toBe(false);
  });
  it('accepts a valid queue config', () => {
    const r = QueueSchema.safeParse({ version: 1, jql: 'labels = autopilot', maxPerRun: 2, mode: 'dry-run' });
    expect(r.success).toBe(true);
  });
});

describe('ConfigSchema.loop', () => {
  const validLoop = {
    rubricTarget: 0.9,
    budgetUsdPerTicket: 5.0,
    maxRepairRounds: 4,
    stallRounds: 3,
    rubricWeights: { visualDiff: 0.3, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 },
  };

  it('accepts a config with a valid loop block', () => {
    const r = ConfigSchema.safeParse({ version: 1, loop: validLoop });
    expect(r.success).toBe(true);
  });

  it('is optional (absent loop still validates)', () => {
    const r = ConfigSchema.safeParse({ version: 1 });
    expect(r.success).toBe(true);
  });

  it('rejects rubricWeights that do not sum to ~1', () => {
    const r = ConfigSchema.safeParse({
      version: 1,
      loop: {
        ...validLoop,
        rubricWeights: { visualDiff: 0.5, acCoverage: 0.5, conventions: 0.5, a11y: 0.5, codeQuality: 0.5 },
      },
    });
    expect(r.success).toBe(false);
  });

  it('tolerates tiny floating-point drift in the weights sum', () => {
    const r = ConfigSchema.safeParse({
      version: 1,
      loop: {
        ...validLoop,
        rubricWeights: { visualDiff: 0.301, acCoverage: 0.25, conventions: 0.17, a11y: 0.13, codeQuality: 0.15 },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a rubricTarget outside 0..1', () => {
    const r = ConfigSchema.safeParse({ version: 1, loop: { ...validLoop, rubricTarget: 1.5 } });
    expect(r.success).toBe(false);
  });

  it('rejects a non-positive budget', () => {
    const r = ConfigSchema.safeParse({ version: 1, loop: { ...validLoop, budgetUsdPerTicket: 0 } });
    expect(r.success).toBe(false);
  });

  // null is how the cap is turned off; 0 above stays a typo, not a second way to say it.
  it.each([null, undefined])('accepts %p as "no per-ticket cap"', (budgetUsdPerTicket) => {
    const r = ConfigSchema.safeParse({ version: 1, loop: { ...validLoop, budgetUsdPerTicket } });
    expect(r.success).toBe(true);
  });
});

describe('ConfigSchema.escalation', () => {
  const validEscalation = { confidenceThreshold: 0.7, highStakesRequiresHuman: true, channels: ['jira', 'notify'] };

  it('accepts a config with a valid escalation block', () => {
    const r = ConfigSchema.safeParse({ version: 1, escalation: validEscalation });
    expect(r.success).toBe(true);
  });

  it('is optional (absent escalation still validates)', () => {
    const r = ConfigSchema.safeParse({ version: 1 });
    expect(r.success).toBe(true);
  });

  it('rejects a confidenceThreshold outside 0..1', () => {
    const r = ConfigSchema.safeParse({ version: 1, escalation: { ...validEscalation, confidenceThreshold: 1.5 } });
    expect(r.success).toBe(false);
  });

  it('is passthrough-tolerant of extra keys (e.g. _comment)', () => {
    const r = ConfigSchema.safeParse({ version: 1, escalation: { ...validEscalation, _comment: 'x' } });
    expect(r.success).toBe(true);
  });
});

describe('ConfigSchema.selfImprovement', () => {
  const validSelfImprovement = {
    improveSetSize: 25,
    holdoutSetSize: 15,
    promotionMargin: 0.03,
    minHoldoutCases: 10,
    regressionFloor: 0.8,
  };

  it('accepts a config with a valid selfImprovement block', () => {
    const r = ConfigSchema.safeParse({ version: 1, selfImprovement: validSelfImprovement });
    expect(r.success).toBe(true);
  });

  it('is optional (absent selfImprovement still validates)', () => {
    const r = ConfigSchema.safeParse({ version: 1 });
    expect(r.success).toBe(true);
  });

  it('rejects a non-positive improveSetSize', () => {
    const r = ConfigSchema.safeParse({ version: 1, selfImprovement: { ...validSelfImprovement, improveSetSize: 0 } });
    expect(r.success).toBe(false);
  });

  it('rejects a promotionMargin outside 0..1', () => {
    const r = ConfigSchema.safeParse({ version: 1, selfImprovement: { ...validSelfImprovement, promotionMargin: 1.5 } });
    expect(r.success).toBe(false);
  });

  it('rejects a regressionFloor outside 0..1', () => {
    const r = ConfigSchema.safeParse({ version: 1, selfImprovement: { ...validSelfImprovement, regressionFloor: -0.1 } });
    expect(r.success).toBe(false);
  });

  it('is passthrough-tolerant of extra keys (e.g. _comment)', () => {
    const r = ConfigSchema.safeParse({ version: 1, selfImprovement: { ...validSelfImprovement, _comment: 'x' } });
    expect(r.success).toBe(true);
  });
});

describe('ConfigSchema.critic', () => {
  it('accepts a config with a valid critic block', () => {
    const r = ConfigSchema.safeParse({ version: 1, critic: { maxRounds: 3 } });
    expect(r.success).toBe(true);
  });

  it('is optional (absent critic still validates)', () => {
    expect(ConfigSchema.safeParse({ version: 1 }).success).toBe(true);
  });

  it('rejects a non-positive maxRounds', () => {
    const r = CriticSchema.safeParse({ maxRounds: 0 });
    expect(r.success).toBe(false);
  });

  it('is passthrough-tolerant of extra keys (e.g. _comment)', () => {
    const r = CriticSchema.safeParse({ maxRounds: 3, _comment: 'x' });
    expect(r.success).toBe(true);
  });
});

describe('ConfigSchema.ux', () => {
  const validUx = { requiredChecks: ['keyboard-operable', 'focus-visible'], target: 0.9 };

  it('accepts a config with a valid ux block', () => {
    const r = ConfigSchema.safeParse({ version: 1, ux: validUx });
    expect(r.success).toBe(true);
  });

  it('is optional (absent ux still validates)', () => {
    expect(ConfigSchema.safeParse({ version: 1 }).success).toBe(true);
  });

  it('rejects an empty requiredChecks list', () => {
    const r = UxSchema.safeParse({ ...validUx, requiredChecks: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a target outside 0..1', () => {
    const r = UxSchema.safeParse({ ...validUx, target: 1.5 });
    expect(r.success).toBe(false);
  });
});

describe('ConfigSchema.followup', () => {
  const validFollowup = { nudgeAfterDays: 2, escalateAfterDays: 5 };

  it('accepts a config with a valid followup block', () => {
    const r = ConfigSchema.safeParse({ version: 1, followup: validFollowup });
    expect(r.success).toBe(true);
  });

  it('is optional (absent followup still validates)', () => {
    expect(ConfigSchema.safeParse({ version: 1 }).success).toBe(true);
  });

  it('rejects a non-positive nudgeAfterDays', () => {
    const r = FollowupSchema.safeParse({ ...validFollowup, nudgeAfterDays: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects escalateAfterDays being less than nudgeAfterDays', () => {
    const r = FollowupSchema.safeParse({ nudgeAfterDays: 5, escalateAfterDays: 2 });
    expect(r.success).toBe(false);
  });

  it('is passthrough-tolerant of extra keys (e.g. _comment)', () => {
    const r = FollowupSchema.safeParse({ ...validFollowup, _comment: 'x' });
    expect(r.success).toBe(true);
  });
});
