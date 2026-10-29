#!/usr/bin/env node
// Autopilot dashboard data generator. Scans millwright/tickets/<KEY>/events.jsonl,
// validates cost-model + each event with Zod, prices tokens, aggregates, and writes
// millwright/dashboard/data.js. Pure logic lives in ./lib.mjs (unit-tested).
//
// Usage:  node millwright/dashboard/build-dashboard.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CostModelSchema, ConfigSchema, parseEventLine } from '../schemas.mjs';
import { guardExec } from '../scripts/guard.mjs';
import { classifyError } from '../scripts/guard-lib.mjs';
import { buildTicket, aggregate, budgetRows, collectAwaitingMerge, cronState, dedupeLabel, parseRunsJsonl } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/
const TICKETS = join(ROOT, 'tickets');
const OUT = join(HERE, 'data.js');
// Fallback cwd for the `gh` best-effort PR-state check — a real checkout gives `gh`
// a git remote to resolve against if the PR URL alone isn't enough in some setups.
const REPO_CHECKOUT_HINT = join(ROOT, '..', 'erp-next-ui-monorepo');

function loadCostModel() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'cost-model.json'), 'utf8'));
  const res = CostModelSchema.safeParse(raw);
  if (!res.success) {
    console.error('✗ config/cost-model.json is invalid:');
    for (const i of res.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
    process.exit(1);
  }
  return res.data;
}

/** Best-effort `config/config.json` load for the `loop` block (budget cap). Absent or
 * invalid config degrades to `null` rather than failing the whole dashboard build —
 * the budget panel just hides when there's no cap to compare against. */
function loadConfig() {
  const raw = readJsonSafe(join(ROOT, 'config', 'config.json'));
  if (!raw) return null;
  const res = ConfigSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/** Last line's `score` from `tickets/<KEY>/rubric.jsonl` (the repair loop's rubric
 * history), or `null` if the file is absent/empty/malformed. Guarded: never throws. */
function lastRubricScore(key) {
  const path = join(TICKETS, key, 'rubric.jsonl');
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last?.score === 'number' ? last.score : null;
  } catch {
    return null;
  }
}

function firstLine(path, fallback) {
  try {
    return readFileSync(path, 'utf8').split('\n')[0].replace(/^#\s*/, '').trim() || fallback;
  } catch {
    return fallback;
  }
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Best-effort `gh pr view <url>`, guarded (guard.mjs) — returns { state, title, number }
 * on success, or `null` alongside a classified `kind` (auth/network/etc, via
 * classifyError) when `gh` is unavailable/unauthenticated/errors. Never throws: callers
 * treat null as "couldn't verify" and keep the PR listed rather than silently dropping
 * it, but now surface *why* it's degraded instead of a bare boolean. */
async function ghPrState(prUrl) {
  const cwd = existsSync(REPO_CHECKOUT_HINT) ? REPO_CHECKOUT_HINT : undefined;
  const result = await guardExec('dashboard gh pr view', 'gh', ['pr', 'view', prUrl, '--json', 'state,title,number'], {
    source: `gh pr view ${prUrl}`,
    cwd,
    retries: 1,
    timeoutMs: 10_000,
  });
  if (!result.ok) return { data: null, kind: result.kind };
  try {
    return { data: JSON.parse(result.value.stdout), kind: null };
  } catch (e) {
    return { data: null, kind: classifyError(e) };
  }
}

/** Ops data (cron state, queue-run history, awaiting-merge, per-ticket status) — all
 * optional; every source degrades to an empty/absent shape when the file is missing. */
async function loadOps() {
  const cron = cronState(readJsonSafe(join(ROOT, 'config', 'schedule-state.json')));

  const runsPath = join(ROOT, 'queue-runs', 'runs.jsonl');
  const runs = existsSync(runsPath) ? parseRunsJsonl(readFileSync(runsPath, 'utf8')) : [];

  const ticketKeys = existsSync(TICKETS) ? readdirSync(TICKETS) : [];
  const tickets = ticketKeys
    .map((key) => {
      const status = readJsonSafe(join(TICKETS, key, 'status.json'));
      if (!status) return null;
      const prs = Array.isArray(status.prs) ? status.prs : status.pr ? [status.pr] : [];
      const branches = Array.isArray(status.branches) ? status.branches : status.branch ? [status.branch] : [];
      return { key, stage: status.stage || status.lastCompleted || '', prs, branches };
    })
    .filter(Boolean);

  let degraded = false;
  let degradedReason = null; // classified kind (auth/network/...) of the first degrade, if any
  const awaitingMerge = [];
  for (const { key, pr } of collectAwaitingMerge(tickets)) {
    const ticketSummary = firstLine(join(TICKETS, key, 'ticket.md'), key);
    const { data: ghState, kind } = await ghPrState(pr);
    if (ghState === null) {
      // gh unavailable/errored — best-effort only: keep the PR listed, but flag that
      // its merge state couldn't be independently confirmed, and *why* (auth vs
      // network vs other) so a human can tell "log back into gh" from "network blip".
      degraded = true;
      degradedReason = degradedReason || kind;
      awaitingMerge.push({ key, pr, summary: dedupeLabel(key, ticketSummary) });
      continue;
    }
    if (ghState.state !== 'OPEN') continue; // MERGED/CLOSED — no longer awaiting merge
    awaitingMerge.push({ key, pr, summary: dedupeLabel(key, ghState.title || ticketSummary) });
  }

  return {
    cron,
    runs,
    awaitingMerge,
    awaitingMergeDegraded: degraded,
    awaitingMergeDegradedReason: degradedReason,
    tickets,
  };
}

async function build() {
  const cm = loadCostModel();
  const keys = existsSync(TICKETS)
    ? readdirSync(TICKETS).filter((d) => existsSync(join(TICKETS, d, 'events.jsonl')))
    : [];
  if (keys.length === 0) return null; // keep the seeded sample data.js

  let dropped = 0;
  const tickets = keys.map((key) => {
    const lines = readFileSync(join(TICKETS, key, 'events.jsonl'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const events = [];
    for (const line of lines) {
      const parsed = parseEventLine(line);
      if (parsed.ok) events.push(parsed.event);
      else if (parsed.reason !== 'not a stage_end') {
        dropped++;
        console.warn(`  ! ${key}: skipped an invalid event line (${parsed.reason})`);
      }
    }
    return buildTicket(key, firstLine(join(TICKETS, key, 'ticket.md'), key), events, cm);
  });

  const data = aggregate(tickets, new Date().toISOString(), cm.currency);
  data.ops = await loadOps();

  const cap = loadConfig()?.loop?.budgetUsdPerTicket ?? null;
  data.ops.budget = {
    capPerTicket: cap,
    tickets: budgetRows(data.tickets, cap).map((row) => ({ ...row, rubricScore: lastRubricScore(row.key) })),
  };

  writeFileSync(OUT, `window.AUTOPILOT_DATA = ${JSON.stringify(data, null, 2)};\n`);
  return { data, dropped };
}

const result = await build();
if (result) {
  const { data, dropped } = result;
  console.log(
    `✓ Wrote ${OUT} — ${data.totals.tickets} ticket(s), $${data.totals.cost} total` +
      (dropped ? ` (${dropped} invalid event line(s) skipped)` : '') +
      '.',
  );
} else {
  console.log('No events.jsonl found under millwright/tickets/*. Keeping the seeded sample data.js.');
}
