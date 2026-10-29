#!/usr/bin/env node
// Audit every ticket's recorded history against the pipeline's declared edge set.
//
// The node set has always been schema-enforced (`stage: z.enum(STAGES)`), so a bogus stage
// name could never enter events.jsonl. The ORDER never was: until stage-graph.mjs there was
// no transition relation anywhere in the system, so a ticket recording `ship` straight after
// `plan` — never verified, never reviewed — validated exactly as cleanly as one that walked
// the whole pipeline. This is the check that closes that gap, and it runs over history, so
// it answers "did this ticket actually pass through verify?" retroactively.
//
// Usage:
//   node scripts/validate-graph.mjs            # audit every ticket
//   node scripts/validate-graph.mjs --key K    # one ticket
//   node scripts/validate-graph.mjs --json
//
// Exits non-zero when any ticket has an illegal transition, so it can gate CI.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEventLine } from '../schemas.mjs';
import { validateStagePath, STAGE_EDGES, STAGES, TERMINAL_STAGES } from '../stage-graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TICKETS = join(ROOT, 'tickets');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const JSON_OUT = process.argv.includes('--json');
const ONLY = arg('key');

/** The stage sequence a ticket actually walked, from its own event log. Consecutive repeats
 * are kept: a repair round genuinely re-runs BUILD, and self-transitions are legal edges. */
function stagePath(key) {
  const p = join(TICKETS, key, 'events.jsonl');
  if (!existsSync(p)) return null;
  const path = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseEventLine(line);
    if (!parsed.ok) continue;
    path.push(parsed.event.stage);
  }
  return path;
}

/** The resting state recorded in status.json, appended to the walked path so a ticket that
 * jumped straight to `merged` without ever shipping is caught too. */
function restingState(key) {
  const p = join(TICKETS, key, 'status.json');
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return s?.stage || null;
  } catch {
    return null;
  }
}

const keys = (ONLY ? [ONLY] : readdirSync(TICKETS).filter((k) => /^PROJ-\d+$/.test(k))).sort();
const results = [];

for (const key of keys) {
  const path = stagePath(key);
  if (!path || path.length === 0) {
    results.push({ key, skipped: 'no priced events', violations: [] });
    continue;
  }
  const resting = restingState(key);
  // status.json's resting state is the last hop, but only when it's a genuinely new state —
  // a ticket resting at the stage it last ran is a self-transition, which is legal anyway.
  const full = resting && resting !== path[path.length - 1] ? [...path, resting] : path;
  const { ok, violations } = validateStagePath(full);
  results.push({ key, ok, path: full, violations });
}

const audited = results.filter((r) => !r.skipped);
const bad = audited.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({
    edges: STAGE_EDGES.length,
    stages: STAGES.length,
    terminals: TERMINAL_STAGES.length,
    audited: audited.length,
    skipped: results.length - audited.length,
    illegal: bad.length,
    results,
  }, null, 2));
} else {
  console.log('\n# Pipeline graph audit');
  console.log(`\n${STAGES.length} stages + ${TERMINAL_STAGES.length} terminal states, ${STAGE_EDGES.length} declared edges.`);
  console.log(`Audited ${audited.length} ticket(s); ${results.length - audited.length} skipped (no events).\n`);
  for (const r of bad) {
    console.log(`  ✗ ${r.key}`);
    console.log(`      walked: ${r.path.join(' → ')}`);
    for (const v of r.violations) {
      console.log(`      ${v.reason}${v.allowed.length ? ` — legal from "${v.from}": ${v.allowed.join(', ')}` : ''}`);
    }
  }
  console.log(bad.length ? `\n${bad.length} ticket(s) walked an undeclared transition.` : '\n✓ every audited ticket walked a legal path.');
}

process.exit(bad.length ? 1 : 0);
