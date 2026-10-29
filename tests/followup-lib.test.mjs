import { describe, expect, it } from 'vitest';

import { daysBetween, dueFollowups } from '../scripts/followup-lib.mjs';

const DAY = 24 * 60 * 60 * 1000;
const CFG = { nudgeAfterDays: 2, escalateAfterDays: 5 };
const NOW = Date.UTC(2026, 7, 3); // 2026-08-03, arbitrary fixed instant

describe('daysBetween', () => {
  it('is direction-agnostic and in days', () => {
    expect(daysBetween(NOW - 3 * DAY, NOW)).toBeCloseTo(3);
    expect(daysBetween(NOW, NOW - 3 * DAY)).toBeCloseTo(3);
  });
});

describe('dueFollowups', () => {
  it('none-yet: a fresh 1-day-old PR needs no action', () => {
    const items = [{ key: 'PROJ-1:pr', kind: 'pr', openedAtMs: NOW - 1 * DAY }];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('none');
    expect(r.ageDays).toBeCloseTo(1);
  });

  it('nudge-window: a 3-day-old, never-nudged PR gets nudged', () => {
    const items = [{ key: 'PROJ-2:pr', kind: 'pr', openedAtMs: NOW - 3 * DAY }];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('nudge');
    expect(r.reason).toMatch(/never nudged/);
  });

  it('re-nudge-throttle: nudged today (within 1 day) yields none even past the nudge window', () => {
    const items = [
      { key: 'PROJ-3:pr', kind: 'pr', openedAtMs: NOW - 3 * DAY, lastNudgeAtMs: NOW - 2 * 60 * 60 * 1000 },
    ];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('none');
    expect(r.reason).toMatch(/throttled/);
  });

  it('nudges again once the last nudge is itself >= 1 day old', () => {
    const items = [
      { key: 'PROJ-4:pr', kind: 'pr', openedAtMs: NOW - 4 * DAY, lastNudgeAtMs: NOW - 1.5 * DAY },
    ];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('nudge');
  });

  it('escalate-window: a 6-day-old open escalation escalates (takes precedence over nudge)', () => {
    const items = [{ key: 'PROJ-5:escalation', kind: 'escalation', openedAtMs: NOW - 6 * DAY }];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('escalate');
    expect(r.ageDays).toBeCloseTo(6);
  });

  it('escalates even if it was nudged recently', () => {
    const items = [
      { key: 'PROJ-6:pr', kind: 'pr', openedAtMs: NOW - 6 * DAY, lastNudgeAtMs: NOW - 1 * 60 * 60 * 1000 },
    ];
    const [r] = dueFollowups(items, NOW, CFG);
    expect(r.action).toBe('escalate');
  });

  it('is empty-safe and preserves order across many items', () => {
    const items = [
      { key: 'a', kind: 'pr', openedAtMs: NOW - 1 * DAY },
      { key: 'b', kind: 'pr', openedAtMs: NOW - 3 * DAY },
      { key: 'c', kind: 'escalation', openedAtMs: NOW - 6 * DAY },
    ];
    const r = dueFollowups(items, NOW, CFG);
    expect(r.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(r.map((x) => x.action)).toEqual(['none', 'nudge', 'escalate']);
    expect(dueFollowups([], NOW, CFG)).toEqual([]);
  });
});
