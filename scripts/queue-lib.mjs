// The Jira queue as something to triage, not just a list of keys: what each scanned ticket is,
// which ones the operator skipped or snoozed, the order they want them planned in, and what a
// ticket like this usually costs. Pure; the panel owns queue-runs/triage.json.

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Rows from `jira.mjs search` (old scans have only key/summary/status). */
export function normaliseScanRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && /^PROJ-\d+$/.test(r.key)).map((r) => ({
    key: r.key,
    summary: str(r.summary),
    status: str(r.status),
    priority: str(r.priority) || null,
    type: str(r.type) || null,
    epic: r.epic && r.epic.key ? { key: r.epic.key, summary: str(r.epic.summary) } : null,
    assignee: str(r.assignee) || null,
    labels: Array.isArray(r.labels) ? r.labels.filter((l) => typeof l === 'string') : [],
    updated: str(r.updated) || null,
    created: str(r.created) || null,
  }));
}

/** The first `[UI]` / `[FUNC]` style tag in a summary's leading tags, skipping version tags like
 * `[Ver 1.1.0-qa.33]`. */
export function summaryTag(summary) {
  const lead = str(summary).replace(/^PROJ-\d+\s*[-—:]\s*/i, '').match(/^(\s*\[[^\]]*\])+/);
  if (!lead) return null;
  const tag = [...lead[0].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim()).find((t) => /^[A-Z]{2,10}$/.test(t));
  return tag || null;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/**
 * What a ticket like this usually costs, from tickets that already ran: same summary tag when
 * there are at least 3 of those, else every ticket. null when there is no history at all - an
 * estimate from nothing is a guess dressed as data.
 */
export function estimateCost(summary, history) {
  const done = (Array.isArray(history) ? history : []).filter((t) => typeof t.costUsd === 'number' && t.costUsd > 0);
  if (!done.length) return null;
  const tag = summaryTag(summary);
  const same = tag ? done.filter((t) => summaryTag(t.summary) === tag) : [];
  const basis = same.length >= 3 ? same : done;
  const costs = basis.map((t) => t.costUsd);
  return { median: Math.round(median(costs) * 100) / 100, p75: Math.round(pct(costs, 0.75) * 100) / 100, n: costs.length, basis: basis === same ? tag : 'all tickets' };
}

/** queue-runs/triage.json: {skipped: {KEY: {at, updated}}, snoozed: {KEY: {until}}, order: [KEY]} */
export function normaliseQueueTriage(raw) {
  return {
    skipped: raw?.skipped && typeof raw.skipped === 'object' ? raw.skipped : {},
    snoozed: raw?.snoozed && typeof raw.snoozed === 'object' ? raw.snoozed : {},
    order: Array.isArray(raw?.order) ? raw.order.filter((k) => typeof k === 'string') : [],
  };
}

export const QUEUE_ACTIONS = ['skip', 'snooze', 'restore', 'order'];

/** Apply one triage action to some keys and return the new triage.json content. */
export function setQueueTriage(raw, { keys = [], action, until = null, order = null, items = [] }, now = new Date()) {
  const t = normaliseQueueTriage(raw);
  const byKey = new Map(items.map((i) => [i.key, i]));
  if (!QUEUE_ACTIONS.includes(action)) throw new Error(`action must be one of ${QUEUE_ACTIONS.join(', ')}`);
  if (action === 'order') {
    const next = (order || []).filter((k) => typeof k === 'string');
    return { ...t, order: [...new Set(next)] };
  }
  const skipped = { ...t.skipped };
  const snoozed = { ...t.snoozed };
  for (const k of keys) {
    delete skipped[k];
    delete snoozed[k];
    if (action === 'skip') skipped[k] = { at: now.toISOString(), updated: byKey.get(k)?.updated || null };
    if (action === 'snooze') {
      const u = until ? new Date(until) : null;
      if (!u || Number.isNaN(u.getTime()) || u <= now) throw new Error('snooze needs a future date');
      snoozed[k] = { until: u.toISOString() };
    }
  }
  return { ...t, skipped, snoozed };
}

/**
 * Split scanned items into what to show and what is hidden, in the operator's order. A skip
 * lasts until Jira says the ticket changed; a snooze until its date. Keys already tracked as
 * tickets are left out entirely - they are past the queue.
 */
export function triageView(items, raw, { tracked = new Set(), now = new Date() } = {}) {
  const t = normaliseQueueTriage(raw);
  const visible = [];
  const hidden = [];
  for (const it of items) {
    if (tracked.has(it.key)) continue;
    const skip = t.skipped[it.key];
    const snooze = t.snoozed[it.key];
    if (skip && (!it.updated || !skip.updated || it.updated === skip.updated)) hidden.push({ ...it, hiddenBy: 'skip', since: skip.at });
    else if (snooze && new Date(snooze.until) > now) hidden.push({ ...it, hiddenBy: 'snooze', until: snooze.until });
    else visible.push({ ...it, changedSinceSkip: !!skip });
  }
  const rank = (k) => { const i = t.order.indexOf(k); return i === -1 ? Infinity : i; };
  visible.sort((a, b) => rank(a.key) - rank(b.key) || (b.updated || '').localeCompare(a.updated || ''));
  return { visible, hidden };
}
