#!/usr/bin/env node
// Autopilot FOLLOW-UP tracker (Phase 4) — the "refund follow-up" pattern applied to
// open PRs and open escalations: track how long they've been open, nudge once stale,
// escalate if still stale after that. Pure scheduling logic lives in followup-lib.mjs
// (unit-tested); this file only does IO — it gathers open items from tickets/<KEY>/,
// stamps `nowMs = Date.now()` (the one place in this feature allowed to call Date),
// and prints/emits the resulting worklist.
//
// The actual nudge (PR/Jira comment) or escalation POST is an outward action, gated and
// performed by the orchestrator — this script only decides what's due.
//
// Usage:
//   node scripts/followup.mjs [--tickets tickets] [--config config/config.json]
//
// Gathers, per ticket: each `status.json.prs` entry (kind 'pr'; openedAt from an
// optional `prOpenedAt[url]`/`{url,openedAt}` field, else status.json's file mtime) and
// `escalation.json` when `status:"open"` (kind 'escalation'; openedAt from its
// `raisedAtField` once stamped, else escalation.json's file mtime).
//
// Prints a readable worklist, then a single JSON line: the full `dueFollowups` array.
// Exits 0 always (informational) unless config is invalid or missing its "followup"
// block (1).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { withGuard } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';
import { ConfigSchema } from '../schemas.mjs';
import { dueFollowups } from './followup-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TICKETS_DIR = join(ROOT, arg('tickets', 'tickets'));
const CONFIG_PATH = arg('config', join(ROOT, 'config', 'config.json'));

function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    console.error(`✗ ${CONFIG_PATH} is invalid:`);
    for (const i of res.error.issues) console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.exit(1);
  }
  if (!res.data.followup) {
    console.error(`✗ ${CONFIG_PATH} is missing the "followup" block required by scripts/followup.mjs`);
    process.exit(1);
  }
  return res.data.followup;
}

/** Guarded read + JSON.parse of an optional per-ticket file: `null` if it doesn't
 * exist, `null` (with a logged acknowledgement, never a thrown/halting error) if it
 * exists but is unreadable or malformed — one bad ticket file must never abort the
 * whole sweep across every other ticket. */
async function readJsonOptional(label, path) {
  if (!existsSync(path)) return null;
  const result = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  if (!result.ok) {
    console.error(acknowledgement(result));
    return null;
  }
  try {
    return JSON.parse(result.value);
  } catch (e) {
    console.error(`followup: could not parse ${path}: ${e.message}`);
    return null;
  }
}

/** ISO-ish timestamp -> ms, or `null` if unparseable (e.g. escalation.json's un-stamped
 * `"<ISO placeholder>"` before the orchestrator fills it in). */
function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** One `status.json.prs` entry may be a plain URL string or a richer
 * `{url, openedAt}` object; either way, fall back to the ticket's status.json file
 * mtime when no explicit open date is recorded. */
function prOpenedAtMs(entry, statusPath, statusJson) {
  const url = typeof entry === 'string' ? entry : entry?.url;
  const explicit = typeof entry === 'string' ? statusJson?.prOpenedAt?.[entry] : entry?.openedAt;
  return { url, openedAtMs: toMs(explicit) ?? mtimeMs(statusPath) };
}

/** Walk tickets/<KEY>/ and collect every open PR + open escalation as a followup-lib
 * item. `followup-state.json` (optional, written by the orchestrator after an actual
 * nudge) supplies `lastNudgeAtMs` per item key so the throttle rule has memory. */
async function gatherItems(ticketsDir) {
  let keys = [];
  try {
    keys = readdirSync(ticketsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    console.error(`followup: could not read tickets dir ${ticketsDir}: ${e.message}`);
    return [];
  }

  const items = [];
  for (const key of keys) {
    const dir = join(ticketsDir, key);
    const statusPath = join(dir, 'status.json');
    const escalationPath = join(dir, 'escalation.json');
    const statePath = join(dir, 'followup-state.json');

    const status = await readJsonOptional('followup status.json', statusPath);
    const escalation = await readJsonOptional('followup escalation.json', escalationPath);
    const state = (await readJsonOptional('followup followup-state.json', statePath)) || {};

    for (const entry of Array.isArray(status?.prs) ? status.prs : []) {
      const { url, openedAtMs } = prOpenedAtMs(entry, statusPath, status);
      if (!url || openedAtMs == null) continue;
      const itemKey = `${key}:${url}`;
      items.push({ key: itemKey, kind: 'pr', url, openedAtMs, lastNudgeAtMs: state[itemKey]?.lastNudgeAtMs });
    }

    if (escalation?.status === 'open') {
      const itemKey = `${key}:escalation`;
      const openedAtMs = toMs(escalation.raisedAtField) ?? mtimeMs(escalationPath);
      if (openedAtMs != null) {
        items.push({ key: itemKey, kind: 'escalation', openedAtMs, lastNudgeAtMs: state[itemKey]?.lastNudgeAtMs });
      }
    }
  }
  return items;
}

async function main() {
  const followupCfg = loadConfig();
  const items = await gatherItems(TICKETS_DIR);
  const nowMs = Date.now();
  const due = dueFollowups(items, nowMs, followupCfg);

  const actionable = due.filter((d) => d.action !== 'none');
  console.log(`\nAutopilot follow-up sweep — ${items.length} open item(s), ${actionable.length} due`);
  for (const d of due) {
    const marker = d.action === 'escalate' ? '⛔ escalate' : d.action === 'nudge' ? '⏰ nudge  ' : '   none   ';
    console.log(`  ${marker}  ${d.key} (${d.kind}, ${d.ageDays.toFixed(1)}d) — ${d.reason}`);
  }
  if (actionable.length === 0) console.log('  nothing due.');

  console.log(`\n${JSON.stringify(due)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
