// Pure aggregation/pricing logic for the dashboard — no filesystem, no I/O — so it's
// unit-testable with vitest. build-dashboard.mjs does the I/O and calls these.
import { STAGES } from '../schemas.mjs';

export const STAGE_ORDER = STAGES;

/** Resolve in/out tokens; a subagent's single `tokensTotal` is split by the model's output ratio. */
export function splitTokens(ev, cm) {
  let inTok = ev.tokensIn || 0;
  let outTok = ev.tokensOut || 0;
  if (!inTok && !outTok && ev.tokensTotal) {
    const outRatio = cm.outputRatio ?? 0.3;
    outTok = Math.round(ev.tokensTotal * outRatio);
    inTok = ev.tokensTotal - outTok;
  }
  return { inTok, outTok };
}

export function priceEvent(ev, cm, split) {
  if (typeof ev.costUsd === 'number') return ev.costUsd;
  const m = cm.models[ev.model] || cm.models._default;
  const { inTok, outTok } = split ?? splitTokens(ev, cm);
  const cacheTok = ev.cacheReadTokens || 0;
  return (inTok / 1e6) * m.in + (outTok / 1e6) * m.out + (cacheTok / 1e6) * m.in * (cm.cacheReadMultiplier ?? 0.1);
}

export function statusOf(stages) {
  if (stages.some((s) => s.status === 'fail' || s.status === 'blocked')) return 'attention';
  const last = stages[stages.length - 1];
  if (last && last.stage === 'ship' && last.status === 'ok') return 'shipped';
  if (stages.some((s) => s.status === 'review')) return 'review';
  return 'in-progress';
}

/** Build one ticket's aggregate from its validated events. */
export function buildTicket(key, summary, events, cm) {
  const stages = events.map((ev) => {
    const split = splitTokens(ev, cm);
    return {
      stage: ev.stage,
      agent: ev.agent || '',
      model: ev.model || '',
      status: ev.status || 'ok',
      durationSec: ev.durationSec || 0,
      tokensIn: split.inTok,
      tokensOut: split.outTok,
      cacheReadTokens: ev.cacheReadTokens || 0,
      costUsd: +priceEvent(ev, cm, split).toFixed(4),
      notes: ev.notes || '',
    };
  });
  stages.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  return {
    key,
    summary: summary || key,
    status: statusOf(stages),
    costUsd: +stages.reduce((a, s) => a + s.costUsd, 0).toFixed(4),
    tokens: stages.reduce((a, s) => a + s.tokensIn + s.tokensOut, 0),
    tokensIn: stages.reduce((a, s) => a + s.tokensIn, 0),
    cacheReadTokens: stages.reduce((a, s) => a + s.cacheReadTokens, 0),
    durationSec: stages.reduce((a, s) => a + s.durationSec, 0),
    stages,
  };
}

/** Resolve the cron/schedule state into a display-ready shape. `raw` is the parsed
 * schedule-state.json (or null/undefined if the file is absent) — absent/unscheduled
 * both mean "manual only", which is the current default state. */
export function cronState(raw) {
  const scheduled = !!raw?.scheduled;
  const cadence = raw?.cadence ?? null;
  const nextRunAt = raw?.nextRunAt ?? null;
  return {
    scheduled,
    cadence,
    nextRunAt,
    label: scheduled ? `Scheduled: ${cadence}` : 'Not scheduled — manual only',
  };
}

/** Parse a queue-runs runs.jsonl file into an array of run objects, newest first.
 * Tolerant of blank lines and malformed JSON, mirroring parseEventLine's tolerance. */
export function parseRunsJsonl(text) {
  const runs = [];
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object') runs.push(parsed);
  }
  runs.sort((a, b) => new Date(b.ranAt || 0).getTime() - new Date(a.ranAt || 0).getTime());
  return runs;
}

/** Flatten every PR across ticket statuses into one "awaiting merge" list. */
export function collectAwaitingMerge(ticketStatuses) {
  const out = [];
  for (const status of ticketStatuses || []) {
    for (const pr of status?.prs || []) out.push({ key: status.key, pr });
  }
  return out;
}

/** Build a non-repeating "KEY — title" label. `ticket.md`'s first line (or a gh PR
 * title) often already starts with the key, in which case the key shouldn't be
 * prepended again. Falls back to just the key when there's no distinct title. */
export function dedupeLabel(key, summary) {
  const text = (summary || '').trim();
  if (!text || text === key) return key;
  const rest = text.startsWith(key) ? text.slice(key.length).replace(/^[\s—–-]+/, '').trim() : text;
  return rest ? `${key} — ${rest}` : key;
}

/** Build the "budget vs cap" rows for the ops panel, reusing each ticket's
 * already-priced `costUsd` (never re-priced here). `cap` is
 * `config.loop.budgetUsdPerTicket` — a falsy/absent cap means "no budget configured",
 * so this returns `[]` and the panel hides. */
export function budgetRows(tickets, cap) {
  if (!cap) return [];
  return (tickets || []).map((t) => {
    const spentUsd = t.costUsd || 0;
    return { key: t.key, spentUsd, capUsd: cap, ratio: spentUsd / cap, over: spentUsd > cap };
  });
}

/** Aggregate all tickets into the full dashboard data object. */
export function aggregate(tickets, generatedAt, currency = 'USD') {
  const costByStage = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0]));
  const tokByStage = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0]));
  for (const t of tickets)
    for (const s of t.stages) {
      if (s.stage in costByStage) {
        costByStage[s.stage] += s.costUsd;
        tokByStage[s.stage] += s.tokensIn + s.tokensOut;
      }
    }
  const cacheReadTokens = tickets.reduce((a, t) => a + (t.cacheReadTokens || 0), 0);
  const inputTokens = tickets.reduce((a, t) => a + (t.tokensIn || 0), 0);
  return {
    sample: false,
    generatedAt,
    currency,
    stageOrder: STAGE_ORDER,
    totals: {
      tickets: tickets.length,
      cost: +tickets.reduce((a, t) => a + t.costUsd, 0).toFixed(4),
      tokens: tickets.reduce((a, t) => a + t.tokens, 0),
      // Prompt-cache instrumentation: cache-read input tokens vs total input tokens.
      // cacheHitRate is null until any stage records cacheReadTokens, so a stale-data
      // dashboard reads "unknown" rather than a misleading 0%.
      cacheReadTokens,
      inputTokens,
      cacheHitRate: cacheReadTokens > 0 ? +(cacheReadTokens / (cacheReadTokens + inputTokens)).toFixed(3) : null,
      durationSec: tickets.reduce((a, t) => a + t.durationSec, 0),
      shipped: tickets.filter((t) => t.status === 'shipped').length,
    },
    costByStage: Object.fromEntries(Object.entries(costByStage).map(([k, v]) => [k, +v.toFixed(4)])),
    tokByStage,
    tickets,
  };
}
