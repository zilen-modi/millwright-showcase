#!/usr/bin/env node
// Champion/challenger promotion verdict (Phase 3). Compares two PRE-COMPUTED score
// sets — one per prompt version — over the golden-set's deterministic holdout split,
// and prints PROMOTE/HOLD. Pure split + decision logic lives in champion-lib.mjs
// (unit-tested); this file only does IO (reads, CLI, reporting).
//
// The actual per-case pipeline runs that PRODUCE these scores are expensive (a full
// BUILD/VERIFY/REVIEW per case) and are orchestrated separately — this mirrors
// eval.mjs's cheap `--mode diff`: it compares scores that were already computed by
// running each case's diff through eval-lib.mjs's scoreDiff.
//
// Usage:
//   node scripts/champion.mjs --agent coder-agent \
//     --champion path/to/champion-scores.json \
//     --challenger path/to/challenger-scores.json \
//     [--golden eval/golden-set.json] [--config config/config.json]
//
// Each scores file is a JSON array of `{ key, score }`, one entry per golden-set case
// that prompt version was run against (improve-set entries are fine to include — this
// script restricts both sets down to the holdout split before deciding).
//
// Prints a readable verdict, then a single JSON line. Exits 0 on PROMOTE, 1 on HOLD
// (2 on bad usage / invalid config) — a human still approves any actual promotion by
// running scripts/champion-lib.mjs's recordPromotion against champion/registry.json
// (see champion/README.md); this script only produces the verdict.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { ConfigSchema } from '../schemas.mjs';
import { splitCases, promotionDecision } from './champion-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const AGENT = arg('agent');
const CHAMPION_PATH = arg('champion');
const CHALLENGER_PATH = arg('challenger');
const GOLDEN_PATH = arg('golden', join(ROOT, 'eval', 'golden-set.json'));
const CONFIG_PATH = arg('config', join(ROOT, 'config', 'config.json'));

if (!AGENT || !CHAMPION_PATH || !CHALLENGER_PATH) {
  console.error('champion: --agent <name>, --champion <scores.json> and --challenger <scores.json> are required');
  process.exit(2);
}

/** Guarded read of a text file — a missing/unreadable scores/golden/config file halts
 * the run with an acknowledged BLOCKED reason instead of a raw stack trace. */
async function readGuarded(label, path) {
  const result = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  return acknowledgeOrThrow(result);
}

function loadConfig(raw) {
  const res = ConfigSchema.safeParse(JSON.parse(raw));
  if (!res.success) {
    console.error('✗ config is invalid:');
    for (const i of res.error.issues) console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.exit(1);
  }
  if (!res.data.selfImprovement) {
    console.error('✗ config is missing the "selfImprovement" block required by scripts/champion.mjs');
    process.exit(1);
  }
  return res.data.selfImprovement;
}

/** Load eval/golden-set.json — either the plain `[...]` array shape or the
 * `{ _comment, tickets: [...] }` wrapper — and normalize each entry down to `{ key }`,
 * the only field the split needs. */
function toCases(golden) {
  const tickets = Array.isArray(golden) ? golden : golden.tickets || [];
  return tickets.map((t) => ({ key: t.key }));
}

/** Parse a scores file — a JSON array of `{ key, score }`. */
function parseScores(raw, label) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`champion: ${label} must be a JSON array of {key, score}`);
  return parsed;
}

async function main() {
  const configRaw = await readGuarded('champion config', CONFIG_PATH);
  const selfImprovement = loadConfig(configRaw);

  const goldenRaw = await readGuarded('champion golden-set', GOLDEN_PATH);
  const cases = toCases(JSON.parse(goldenRaw));

  const { holdout, insufficient } = splitCases(cases, {
    improveSetSize: selfImprovement.improveSetSize,
    holdoutSetSize: selfImprovement.holdoutSetSize,
    minHoldoutCases: selfImprovement.minHoldoutCases,
  });
  const holdoutKeys = holdout.map((c) => c.key);

  const championRaw = await readGuarded('champion scores', CHAMPION_PATH);
  const challengerRaw = await readGuarded('challenger scores', CHALLENGER_PATH);
  const championScores = parseScores(championRaw, '--champion');
  const challengerScores = parseScores(challengerRaw, '--challenger');

  const decision = promotionDecision({
    champion: championScores,
    challenger: challengerScores,
    holdoutKeys,
    margin: selfImprovement.promotionMargin,
    minHoldoutCases: selfImprovement.minHoldoutCases,
    regressionFloor: selfImprovement.regressionFloor,
  });

  console.log(`\nChampion/challenger — ${AGENT}`);
  console.log(`  case bank:   ${cases.length} golden-set case(s) (${holdoutKeys.length} in holdout${insufficient ? ', bank too small for a full split' : ''})`);
  console.log(`  holdout:     ${holdoutKeys.join(', ') || '(none)'}`);
  console.log(`  champion:    mean ${decision.championMean.toFixed(3)}`);
  console.log(`  challenger:  mean ${decision.challengerMean.toFixed(3)} (delta ${decision.delta >= 0 ? '+' : ''}${decision.delta.toFixed(3)})`);
  console.log(`  verdict:     ${decision.promote ? 'PROMOTE' : 'HOLD'}`);
  console.log(`  reason:      ${decision.reason}`);
  if (decision.promote) {
    console.log(`\n  Verdict is advisory only — a human still approves the actual promotion (see champion/README.md).`);
  }

  const out = {
    agent: AGENT,
    promote: decision.promote,
    reason: decision.reason,
    championMean: decision.championMean,
    challengerMean: decision.challengerMean,
    delta: decision.delta,
    holdoutKeys,
    insufficientSplit: insufficient,
  };
  console.log(`\n${JSON.stringify(out)}`);

  process.exit(decision.promote ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
