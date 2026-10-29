import { describe, expect, it } from 'vitest';

import {
  aggregate,
  budgetRows,
  buildTicket,
  collectAwaitingMerge,
  cronState,
  dedupeLabel,
  parseRunsJsonl,
  priceEvent,
  splitTokens,
  statusOf,
} from '../dashboard/lib.mjs';

const cm = {
  outputRatio: 0.3,
  cacheReadMultiplier: 0.1,
  currency: 'USD',
  models: {
    'claude-opus-4-8': { in: 15, out: 75 },
    'claude-sonnet-5': { in: 3, out: 15 },
    _default: { in: 3, out: 15 },
  },
};

describe('splitTokens', () => {
  it('splits a tokensTotal by outputRatio', () => {
    expect(splitTokens({ tokensTotal: 10000 }, cm)).toEqual({ inTok: 7000, outTok: 3000 });
  });
  it('preserves an explicit in/out breakdown', () => {
    expect(splitTokens({ tokensIn: 1000, tokensOut: 200 }, cm)).toEqual({ inTok: 1000, outTok: 200 });
  });
  it('returns zeros when there is nothing', () => {
    expect(splitTokens({}, cm)).toEqual({ inTok: 0, outTok: 0 });
  });
});

describe('priceEvent', () => {
  it('prices a total at the model rate (opus 10k @ 0.3 out)', () => {
    // in 7000*15/1e6 + out 3000*75/1e6 = 0.105 + 0.225 = 0.33
    expect(priceEvent({ model: 'claude-opus-4-8', tokensTotal: 10000 }, cm)).toBeCloseTo(0.33, 4);
  });
  it('honours an explicit costUsd override', () => {
    expect(priceEvent({ costUsd: 1.23, tokensTotal: 999999 }, cm)).toBe(1.23);
  });
  it('falls back to _default for an unknown model', () => {
    expect(priceEvent({ model: 'mystery', tokensIn: 1e6, tokensOut: 0 }, cm)).toBeCloseTo(3, 4);
  });
});

describe('statusOf', () => {
  it('attention when any stage failed/blocked', () => {
    expect(statusOf([{ stage: 'verify', status: 'fail' }])).toBe('attention');
  });
  it('shipped when the last stage is a successful ship', () => {
    expect(statusOf([{ stage: 'build', status: 'ok' }, { stage: 'ship', status: 'ok' }])).toBe('shipped');
  });
  it('review when a stage is in review', () => {
    expect(statusOf([{ stage: 'preflight', status: 'review' }])).toBe('review');
  });
  it('in-progress otherwise', () => {
    expect(statusOf([{ stage: 'build', status: 'ok' }])).toBe('in-progress');
  });
});

describe('buildTicket + aggregate', () => {
  const events = [
    { stage: 'build', model: 'claude-sonnet-5', status: 'ok', durationSec: 100, tokensTotal: 100000 },
    { stage: 'intake', model: 'claude-opus-4-8', status: 'ok', durationSec: 10, tokensTotal: 10000 },
  ];
  it('sorts stages into pipeline order and sums totals', () => {
    const t = buildTicket('PROJ-1', 'Test', events, cm);
    expect(t.stages.map((s) => s.stage)).toEqual(['intake', 'build']);
    expect(t.tokens).toBe(110000);
    expect(t.durationSec).toBe(110);
    expect(t.costUsd).toBeGreaterThan(0);
  });
  it('aggregates cost by stage across tickets', () => {
    const t = buildTicket('PROJ-1', 'Test', events, cm);
    const data = aggregate([t], '2026-07-30T00:00:00.000Z');
    expect(data.totals.tickets).toBe(1);
    expect(data.costByStage.build).toBeGreaterThan(0);
    expect(data.costByStage.ship).toBe(0);
    expect(data.totals.cost).toBeCloseTo(t.costUsd, 4);
  });
  it('reports cacheHitRate as null when no stage records cache-read tokens', () => {
    const data = aggregate([buildTicket('PROJ-1', 'Test', events, cm)], '2026-07-30T00:00:00.000Z');
    expect(data.totals.cacheHitRate).toBeNull();
    expect(data.totals.cacheReadTokens).toBe(0);
  });
  it('computes cacheHitRate = cacheRead / (cacheRead + input) once cache tokens appear', () => {
    // one stage: tokensTotal 100000 → input = 70000 (outputRatio 0.3); cacheReadTokens 30000.
    const withCache = [{ stage: 'build', model: 'claude-sonnet-5', status: 'ok', tokensTotal: 100000, cacheReadTokens: 30000 }];
    const data = aggregate([buildTicket('PROJ-1', 'Test', withCache, cm)], '2026-07-30T00:00:00.000Z');
    expect(data.totals.inputTokens).toBe(70000);
    expect(data.totals.cacheReadTokens).toBe(30000);
    expect(data.totals.cacheHitRate).toBeCloseTo(30000 / 100000, 3); // 0.3
  });
});

describe('cronState', () => {
  it('treats a missing schedule-state as manual-only', () => {
    expect(cronState(null)).toEqual({
      scheduled: false,
      cadence: null,
      nextRunAt: null,
      label: 'Not scheduled — manual only',
    });
    expect(cronState(undefined)).toEqual(cronState(null));
  });
  it('treats an explicit scheduled:false the same as absent', () => {
    expect(cronState({ scheduled: false }).label).toBe('Not scheduled — manual only');
  });
  it('labels a scheduled cron with its cadence', () => {
    const s = cronState({ scheduled: true, cadence: 'daily 09:00', nextRunAt: '2026-08-04T09:00:00Z' });
    expect(s).toEqual({
      scheduled: true,
      cadence: 'daily 09:00',
      nextRunAt: '2026-08-04T09:00:00Z',
      label: 'Scheduled: daily 09:00',
    });
  });
});

describe('parseRunsJsonl', () => {
  it('parses valid lines, newest first', () => {
    const text = [
      '{"ranAt":"2026-07-30T10:00:00Z","mode":"dry-run","outcomes":[]}',
      '{"ranAt":"2026-07-31T10:00:00Z","mode":"build-verify-notify","outcomes":[]}',
    ].join('\n');
    const runs = parseRunsJsonl(text);
    expect(runs.map((r) => r.ranAt)).toEqual(['2026-07-31T10:00:00Z', '2026-07-30T10:00:00Z']);
  });
  it('is tolerant of blank and malformed lines', () => {
    const text = '\n{"ranAt":"2026-07-31T10:00:00Z"}\n\nnot json\n  \n';
    const runs = parseRunsJsonl(text);
    expect(runs).toHaveLength(1);
    expect(runs[0].ranAt).toBe('2026-07-31T10:00:00Z');
  });
  it('returns an empty array for empty/absent text', () => {
    expect(parseRunsJsonl('')).toEqual([]);
    expect(parseRunsJsonl(undefined)).toEqual([]);
  });
});

describe('collectAwaitingMerge', () => {
  it('flattens every pr across ticket statuses', () => {
    const statuses = [
      { key: 'PROJ-2899', prs: ['https://github.com/x/pr/763'] },
      { key: 'PROJ-2993', prs: ['https://github.com/x/pr/764'] },
      { key: 'PROJ-2954', prs: [] },
    ];
    expect(collectAwaitingMerge(statuses)).toEqual([
      { key: 'PROJ-2899', pr: 'https://github.com/x/pr/763' },
      { key: 'PROJ-2993', pr: 'https://github.com/x/pr/764' },
    ]);
  });
  it('is tolerant of missing prs and empty/absent input', () => {
    expect(collectAwaitingMerge([{ key: 'PROJ-1' }])).toEqual([]);
    expect(collectAwaitingMerge([])).toEqual([]);
    expect(collectAwaitingMerge(undefined)).toEqual([]);
  });
});

describe('budgetRows', () => {
  const tickets = [
    { key: 'PROJ-2899', costUsd: 7.47 },
    { key: 'PROJ-2825', costUsd: 1.2 },
  ];
  it('flags over-cap tickets and computes the spend/cap ratio', () => {
    expect(budgetRows(tickets, 5)).toEqual([
      { key: 'PROJ-2899', spentUsd: 7.47, capUsd: 5, ratio: 7.47 / 5, over: true },
      { key: 'PROJ-2825', spentUsd: 1.2, capUsd: 5, ratio: 1.2 / 5, over: false },
    ]);
  });
  it('returns an empty array when there is no cap configured', () => {
    expect(budgetRows(tickets, null)).toEqual([]);
    expect(budgetRows(tickets, undefined)).toEqual([]);
    expect(budgetRows(tickets, 0)).toEqual([]);
  });
  it('is tolerant of missing/absent tickets and a missing costUsd', () => {
    expect(budgetRows([], 5)).toEqual([]);
    expect(budgetRows(undefined, 5)).toEqual([]);
    expect(budgetRows([{ key: 'PROJ-1' }], 5)).toEqual([
      { key: 'PROJ-1', spentUsd: 0, capUsd: 5, ratio: 0, over: false },
    ]);
  });
});

describe('dedupeLabel', () => {
  it('does not double the key when the summary already starts with it', () => {
    expect(dedupeLabel('PROJ-2825', 'PROJ-2825 — Update Tag Component')).toBe(
      'PROJ-2825 — Update Tag Component',
    );
  });
  it('handles a plain-dash or no-separator prefix the same way', () => {
    expect(dedupeLabel('PROJ-2825', 'PROJ-2825 - Update Tag Component')).toBe(
      'PROJ-2825 — Update Tag Component',
    );
    expect(dedupeLabel('PROJ-2825', 'PROJ-2825 Update Tag Component')).toBe(
      'PROJ-2825 — Update Tag Component',
    );
  });
  it('prepends the key when the summary is a distinct title (e.g. a gh PR title)', () => {
    expect(dedupeLabel('PROJ-2993', 'fix(PROJ-2993): add missing 1px padding')).toBe(
      'PROJ-2993 — fix(PROJ-2993): add missing 1px padding',
    );
  });
  it('falls back to the bare key when there is no summary or it equals the key', () => {
    expect(dedupeLabel('PROJ-1', '')).toBe('PROJ-1');
    expect(dedupeLabel('PROJ-1', null)).toBe('PROJ-1');
    expect(dedupeLabel('PROJ-1', 'PROJ-1')).toBe('PROJ-1');
  });
  it('falls back to the bare key when the summary is only the key plus a separator', () => {
    expect(dedupeLabel('PROJ-1', 'PROJ-1 —')).toBe('PROJ-1');
  });
});
