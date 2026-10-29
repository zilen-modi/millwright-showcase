#!/usr/bin/env node
// Autopilot repair-loop control plane (Phase 1). Turns a raw rubric-inputs snapshot +
// the ticket's priced spend-so-far into a single stop/continue verdict: a numeric
// rubric goal, a budget cap, and a stall detector. Pure logic lives in rubric-lib.mjs
// and loop-lib.mjs (unit-tested); this file only does IO (reads, git, CLI, reporting,
// and the two files it owns).
//
// Usage:
//   node scripts/loop.mjs --key PROJ-2825 --rubric tickets/PROJ-2825/rubric-inputs.json
//   node scripts/loop.mjs --key PROJ-2825 --rubric ... --dry-run   # score + print, write nothing
//
// rubric-inputs.json shape (written by the verify/review stages each repair round):
//   {
//     "visualDiffPassRate": 0.8, "acCoveredRatio": 0.9,
//     "a11yFailures": 0, "codeQualityScore": 0.95,
//     "round": 2, "scoreHistory": [0.55, 0.72],
//     "visualDiffEvidence": "visual-diff-report.json"
//   }
// `round`/`scoreHistory` describe rounds BEFORE this one; this run appends the score
// it computes to build the history the stall detector sees.
//
// THIS FILE IS THE ONLY WRITER OF THE SCORE (Goal A1, contract §1). After scoring it
// appends one receipt line to tickets/<KEY>/rubric.jsonl and patches
// tickets/<KEY>/status.json with rubricScore / rubricSha / rubricRound /
// rubricScoredAt. Nothing else — not the orchestrator, not an agent, not a human with
// an editor — may write `rubricScore`; a model-written number displayed as if computed
// is the exact failure this closes. The receipt is stamped with `sha`, the HEAD of the
// worktree branch that was scored (`git -C <worktree> rev-parse HEAD`, worktree resolved
// from status.json's repos via scripts/worktree.mjs's `<KEY>-<repoId>` naming). That sha
// is what binds a number to a tree. When no worktree can be resolved the receipt carries
// `sha: null` + `shaSource: "unavailable"` — never a guess, and never a failed scoring
// run: the ship gate in dashboard/server.mjs is what fails closed on a null sha.
//
// Three things are NEVER taken on faith:
//
//   visualDiffPassRate — `visualDiffEvidence` must name a real visual-diff.mjs report
//     (path relative to this rubric file) and the rate is recomputed from its per-variant
//     verdicts. Failing that, `visualDiffSkipReason` EXCLUDES the dimension — its weight
//     is removed and the rest renormalized (contract §2). A skip is not a pass: it used
//     to score a flat 1.0, handing out 0.30 of the rubric for a sentence. And a skip is
//     REFUSED outright when the ticket's design-links.json enumerated variant nodes,
//     because then a diff was possible and "couldn't diff" isn't true. That file is the
//     authority and answers both ways: `variantNodes: []` or `enumerationBlocked` is a real
//     "no" and the skip stands. Absent it, design.md prose is scanned for node ids, which can
//     only ever say yes - it cannot tell a variant from a ruled-out one (PROJ-3749). A nonzero
//     rate with neither receipts nor a reason is unverified and halts the loop
//     (PROJ-2998 postmortem: a hand-typed 1.0 with zero captured screenshots passed the
//     loop unchallenged; PROJ-2910 then scored 0.993 off a skip sentence).
//
//   conventionViolations — recomputed here by running lintSources from
//     conventions-lint-lib.mjs over the branch diff; any value supplied in
//     rubric-inputs.json is IGNORED (contract §4). If the lint lib or the worktree is
//     unavailable the count is null and the dimension is UNMEASURED — dropped from the
//     arithmetic like an exclusion, but it also blocks a `done` verdict outright. "Not
//     applicable" and "the check could not run" are different claims, and only the first
//     may end in a pass (PROJ-3016 scored a clean 1.000 on three of five dimensions
//     because the two that were dropped counted as legitimately absent).
//
//   the score itself — see above; it is written here or not at all.
//
// Prints a readable verdict, then a single JSON line:
//   { score, action, reason, spentUsd, budgetUsd, round, sha, shaSource, excluded, dryRun }
// Exits 0 on 'done'/'continue'; non-zero on any 'stop-*' (an ESCALATION to a human) and
// on a refused/unverified visual-diff claim.
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { withGuard, guardExec, acknowledgeOrThrow } from './guard.mjs';
import { ConfigSchema, CostModelSchema, parseEventLine } from '../schemas.mjs';
import { splitTokens, priceEvent } from '../dashboard/lib.mjs';
import { scoreRubric, failingDimensions, resolveE2e, resolveVisualDiff } from './rubric-lib.mjs';
import {
  loopDecision,
  restateGoal,
  designEnumeratesVariants,
  worktreeCandidates,
  rubricLine,
  statusRubricPatch,
  mergeStatus,
} from './loop-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/
const TICKETS = join(ROOT, 'tickets');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const KEY = arg('key');
const RUBRIC_PATH = arg('rubric');
const DRY_RUN = flag('dry-run');
if (!KEY || !RUBRIC_PATH) {
  console.error('loop: --key <KEY> and --rubric <inputs.json> are required');
  process.exit(2);
}

/** Guarded read of a text file — a missing/unreadable events log or rubric-inputs file
 * halts the run with an acknowledged BLOCKED reason instead of a raw stack trace. */
async function readGuarded(label, path) {
  const result = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  return acknowledgeOrThrow(result);
}

/** Read a file that is allowed to be absent (status.json, design.md, a source file in
 * the diff). Returns null rather than halting — its absence is information, not an error. */
function readOptional(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function readOptionalJson(path) {
  const text = readOptional(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadConfig() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'));
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    console.error('✗ config/config.json is invalid:');
    for (const i of res.error.issues) console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.exit(1);
  }
  if (!res.data.loop) {
    console.error('✗ config/config.json is missing the "loop" block required by scripts/loop.mjs');
    process.exit(1);
  }
  return res.data;
}

function loadCostModel() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'cost-model.json'), 'utf8'));
  const res = CostModelSchema.safeParse(raw);
  if (!res.success) {
    console.error('✗ config/cost-model.json is invalid:');
    for (const i of res.error.issues) console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    process.exit(1);
  }
  return res.data;
}

/** Sum every priced stage_end event in the ticket's events.jsonl into a total spend,
 * reusing the dashboard's own pricing (never reimplemented here). Malformed lines are
 * skipped, mirroring build-dashboard.mjs's tolerance. */
function priceTicketSpend(eventsText, cm) {
  let spentUsd = 0;
  for (const line of eventsText.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parsed = parseEventLine(line);
    if (!parsed.ok) continue;
    const split = splitTokens(parsed.event, cm);
    spentUsd += priceEvent(parsed.event, cm, split);
  }
  return spentUsd;
}

/** Locate the git worktree whose HEAD this score is about. status.json records the
 * repos that were built; scripts/worktree.mjs puts each at `<workspace>/.wt/<KEY>-<repoId>`
 * (config.worktreeDir, default `../.wt`, is relative to millwright/). Returns null when
 * nothing on disk matches — the caller then stamps `shaSource: "unavailable"`. */
function resolveWorktree(cfg, status) {
  const base = resolve(ROOT, cfg.worktreeDir || '../.wt');
  for (const name of worktreeCandidates(KEY, status)) {
    const dir = join(base, name);
    if (existsSync(join(dir, '.git'))) return { dir, repo: name.slice(KEY.length + 1) };
  }
  return null;
}

/** `git -C <worktree> rev-parse HEAD` — the sha that makes the score unforgeable. Any
 * failure yields null; scoring never dies for want of a sha (the ship gate is what fails
 * closed on one), but a sha is never invented either. */
async function resolveSha(worktree) {
  if (!worktree) return { sha: null, shaSource: 'unavailable', note: 'no worktree found for this ticket' };
  const res = await guardExec('loop git rev-parse', 'git', ['-C', worktree.dir, 'rev-parse', 'HEAD'], {
    retries: 0,
    timeoutMs: 10000,
  });
  if (!res.ok) return { sha: null, shaSource: 'unavailable', note: `rev-parse failed: ${res.message}` };
  const sha = String(res.value.stdout || '').trim();
  return /^[0-9a-f]{7,40}$/.test(sha)
    ? { sha, shaSource: 'worktree', note: null }
    : { sha: null, shaSource: 'unavailable', note: 'rev-parse returned no usable sha' };
}

const SKIP_LINT_EXT = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip|lock)$/i;
const MAX_LINT_BYTES = 512 * 1024;
const MAX_LINT_FILES = 500;

/** The branch diff as `[{ path, text }]`, ready for lintSources. Compared against the
 * merge-base with the base branch (`origin/<base>` first, local `<base>` as a fallback)
 * so only this ticket's own work is linted.
 *
 * Contents come from `git show HEAD:<path>`, NOT from the filesystem: the receipt is
 * stamped with HEAD's sha, so the lint has to be of the tree that sha names. Reading the
 * working tree instead would let uncommitted edits — or a half-reset worktree like
 * PROJ-2910's `blocked-worktree-mismatch`, where 35 of 36 changed files are deleted on
 * disk — quietly change the number attributed to a commit. */
async function changedSources(worktree, baseBranch, sourcesFromUnixDiff) {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    // The ADDED LINES, not the files they live in. Linting whole files charged a diff for
    // violations it never introduced: PROJ-3109 scored conventions 0 — costing 0.17 and a
    // repair round it could not win — over a Figma-ref comment written days earlier by
    // someone else, in a test file the change happened to touch.
    const res = await guardExec('loop git diff', 'git', ['-C', worktree.dir, 'diff', `${ref}...HEAD`], {
      retries: 0,
      timeoutMs: 20000,
    });
    if (!res.ok) continue;
    const patch = String(res.value.stdout || '');
    if (!patch.trim()) return [];
    let sources;
    try {
      sources = sourcesFromUnixDiff(patch);
    } catch {
      continue;
    }
    return sources
      .filter((src) => !SKIP_LINT_EXT.test(src.path))
      .filter((src) => (src.text || '').length <= MAX_LINT_BYTES)
      .slice(0, MAX_LINT_FILES);
  }
  return null;
}

/** conventionViolations, computed here and nowhere else (contract §4). Any value in
 * rubric-inputs.json is ignored outright — it is a self-report, and self-reports are what
 * Goal A5 exists to delete. conventions-lint-lib.mjs is being built alongside this, so it
 * is imported LAZILY: if it isn't there yet (or the worktree isn't), the count is null,
 * a warning is printed, and the dimension is excluded rather than the run crashing or —
 * far worse — silently scoring 1. */
async function computeConventionViolations(worktree, cfg, status) {
  let lintSources, sourcesFromUnixDiff;
  try {
    ({ lintSources, sourcesFromUnixDiff } = await import('./conventions-lint-lib.mjs'));
  } catch {
    return { count: null, source: 'unavailable', note: 'scripts/conventions-lint-lib.mjs not present (Goal A5 not landed yet)' };
  }
  if (typeof lintSources !== 'function') {
    return { count: null, source: 'unavailable', note: 'conventions-lint-lib.mjs does not export lintSources()' };
  }
  if (!worktree) {
    return { count: null, source: 'unavailable', note: 'no worktree to diff — nothing to lint' };
  }

  const sources = await changedSources(worktree, cfg.baseBranch || 'dev', sourcesFromUnixDiff);
  if (!sources) {
    return { count: null, source: 'unavailable', note: `could not diff against ${cfg.baseBranch || 'dev'} in ${worktree.dir}` };
  }
  const branch = Array.isArray(status?.branches) ? status.branches[0] : undefined;
  try {
    const result = lintSources(sources, { branch, repoRoot: worktree.dir });
    const count = Number(result?.count);
    if (!Number.isFinite(count)) {
      return { count: null, source: 'unavailable', note: 'lintSources() returned no numeric count' };
    }
    return { count, source: 'lint', note: null, violations: result?.violations ?? [] };
  } catch (e) {
    return { count: null, source: 'unavailable', note: `lintSources() threw: ${e?.message || e}` };
  }
}

/** Every prior round's `breakdown`, oldest first, read back from this ticket's own receipts.
 * Tolerant of a truncated or hand-edited line: a receipt that will not parse, or carries no
 * breakdown object, is skipped rather than throwing — a missing round can only make
 * `pinnedDimensions` more conservative, never less. */
function priorBreakdowns(ticketDir) {
  const path = join(ticketDir, 'rubric.jsonl');
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const b = JSON.parse(line)?.breakdown;
      if (b && typeof b === 'object') out.push(b);
    } catch {
      // Unreadable receipt — skip it, don't abort the round.
    }
  }
  return out;
}

/** Append the receipt and patch status.json — read/merge/write via a temp file + rename,
 * so a crash mid-write can't leave a truncated status.json behind, and every unrelated
 * field survives verbatim. */
function writeReceipt(ticketDir, line, patch) {
  appendFileSync(join(ticketDir, 'rubric.jsonl'), `${JSON.stringify(line)}\n`, 'utf8');

  const statusPath = join(ticketDir, 'status.json');
  const current = readOptionalJson(statusPath) || { key: KEY };
  const merged = mergeStatus(current, patch);
  const tmp = `${statusPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  renameSync(tmp, statusPath);
}

async function main() {
  const cfg = loadConfig();
  const loopCfg = cfg.loop;
  const cm = loadCostModel();
  const ticketDir = join(TICKETS, KEY);

  const eventsText = await readGuarded('loop events.jsonl', join(ticketDir, 'events.jsonl'));
  const spentUsd = priceTicketSpend(eventsText, cm);

  const rubricRaw = await readGuarded('loop rubric-inputs', RUBRIC_PATH);
  const rubricInputs = JSON.parse(rubricRaw);
  const round = Number(rubricInputs.round) || 1;
  const priorHistory = Array.isArray(rubricInputs.scoreHistory) ? rubricInputs.scoreHistory : [];

  const status = readOptionalJson(join(ticketDir, 'status.json'));
  const worktree = resolveWorktree(cfg, status);

  let evidenceReport = null;
  if (rubricInputs.visualDiffEvidence) {
    const evidencePath = isAbsolute(rubricInputs.visualDiffEvidence)
      ? rubricInputs.visualDiffEvidence
      : join(dirname(RUBRIC_PATH), rubricInputs.visualDiffEvidence);
    const evidenceRaw = await readGuarded('loop visual-diff evidence', evidencePath);
    evidenceReport = JSON.parse(evidenceRaw);
  }

  // The functional browser gate. `e2e-flows.json` in the ticket folder is what makes the
  // dimension applicable at all: no flows means nothing to drive, so the dimension is EXCLUDED
  // and the ticket scores exactly as it did before this gate existed. The report is read from
  // disk rather than trusted from rubric-inputs, same rule as the visual diff.
  const flowsPath = join(ticketDir, 'e2e-flows.json');
  const hasFlows = existsSync(flowsPath);
  let e2eReport = null;
  if (hasFlows) {
    const e2ePath = rubricInputs.e2eEvidence
      ? (isAbsolute(rubricInputs.e2eEvidence)
        ? rubricInputs.e2eEvidence
        : join(dirname(RUBRIC_PATH), rubricInputs.e2eEvidence))
      : join(ticketDir, 'e2e-report.json');
    e2eReport = readOptionalJson(e2ePath);
  }
  const e2e = resolveE2e(rubricInputs, e2eReport, { hasFlows });
  if (e2e.unmeasured) {
    console.warn(`⚠ e2e UNMEASURED — ${e2e.reason}`);
    console.warn('  The app was never exercised, so this is not a failing test suite. Start the stack and');
    console.warn('  run: node scripts/session.mjs && node scripts/e2e.mjs --key <KEY> --flows <spec>');
  } else if (!e2e.verified) {
    console.error(`✗ REVIEW's e2e claim cannot be accepted: ${e2e.reason}`);
    process.exit(1);
  }

  // The ticket folder already holds the proof of whether a visual diff was possible.
  const design = designEnumeratesVariants({
    designMd: readOptional(join(ticketDir, 'design.md')),
    designLinks: readOptionalJson(join(ticketDir, 'design-links.json')),
  });

  const visualDiff = resolveVisualDiff(rubricInputs, evidenceReport, {
    designEnumeratedVariants: design.enumerated,
  });
  // A report that compared nothing is UNMEASURED, not a rejected claim: there is no bad
  // assertion to send back, so record that and escalate rather than exiting here.
  if (visualDiff.unmeasured) {
    console.warn(`⚠ visualDiff UNMEASURED — ${visualDiff.reason}.`);
    console.warn('  Nothing was compared, so this round cannot be declared done. Fix the capture (or the');
    console.warn('  story, if it does not reproduce the reference state) and re-run the diff.');
  } else if (!visualDiff.verified) {
    console.error(`✗ REVIEW's visualDiff claim cannot be accepted: ${visualDiff.reason}`);
    if (visualDiff.source === 'skip') {
      console.error(
        `  design.md/design-links.json enumerate ${design.nodeIds.length} node id(s) (${design.source}): ` +
          `${design.nodeIds.slice(0, 6).join(', ')}${design.nodeIds.length > 6 ? ', …' : ''}`,
      );
      console.error('  Fix: capture those nodes and run scripts/visual-diff.mjs, then point "visualDiffEvidence"');
      console.error('  at its report. A skip is only legitimate when there was nothing enumerated to diff.');
      if (design.source === 'design.md') {
        // The prose scan cannot tell a variant node from one a ruled-out table names only to
        // dismiss it (PROJ-3749), so say where the count came from rather than asserting a
        // diff was possible. design-links.json is how CONTEXT answers "no".
        console.error('  Those ids came from scanning design.md prose, which cannot tell a variant node from one');
        console.error('  a ruled-out table names only to dismiss it. If that is what happened here, have CONTEXT');
        console.error('  write design-links.json with "variantNodes": [] (or "enumerationBlocked" plus a');
        console.error('  "blockedReason") - it is the authority, and unlike prose it can say no.');
      }
    } else {
      console.error('  Fix: run scripts/visual-diff.mjs and set "visualDiffEvidence" to its report path in');
      console.error('  rubric-inputs.json, or set "visualDiffSkipReason" if this ticket genuinely has no');
      console.error('  Figma variants to visually diff. Never hand-type visualDiffPassRate.');
    }
    process.exit(1);
  }

  const conventions = await computeConventionViolations(worktree, cfg, status);
  if (conventions.count === null) {
    console.warn(`⚠ conventionViolations UNMEASURED — ${conventions.note}.`);
    console.warn('  The conventions check could not RUN, which is an infrastructure failure, not a clean');
    console.warn('  diff — this round cannot be declared done until it can be measured.');
  }

  // "Not applicable" vs "could not run" are different verdicts (see rubric-lib's
  // failure-mode #4). A legitimately skipped visual diff is excluded; a check that could
  // not execute is unmeasured and blocks `done` outright.
  const excluded = [
    ...(visualDiff.excluded ? ['visualDiff'] : []),
    ...(e2e.excluded ? ['e2e'] : []),
  ];
  const unmeasured = [
    ...(conventions.count === null ? ['conventions'] : []),
    ...(visualDiff.unmeasured ? ['visualDiff'] : []),
    ...(e2e.unmeasured ? ['e2e'] : []),
  ];

  // Whatever rubric-inputs.json says about conventionViolations is discarded here.
  const effectiveInputs = {
    ...rubricInputs,
    visualDiffPassRate: visualDiff.rate ?? 0,
    e2ePassRate: e2e.rate ?? 0,
    conventionViolations: conventions.count ?? 0,
    excludedDimensions: excluded,
    unmeasuredDimensions: unmeasured,
  };

  const { score, breakdown, weights, pass } = scoreRubric(effectiveInputs, loopCfg.rubricWeights, loopCfg.rubricTarget);
  const scoreHistory = [...priorHistory, score];
  // Per-round sub-scores come from the receipts this script wrote, not from rubric-inputs -
  // REVIEW supplies the inputs, so letting it supply the history too would let it declare a
  // dimension pinned. `breakdownHistory` is therefore read only from rubric.jsonl.
  const breakdownHistory = [...priorBreakdowns(ticketDir), breakdown];

  const decision = loopDecision({
    score,
    target: loopCfg.rubricTarget,
    round,
    maxRounds: loopCfg.maxRepairRounds,
    spentUsd,
    budgetUsd: loopCfg.budgetUsdPerTicket,
    scoreHistory,
    stallRounds: loopCfg.stallRounds,
    unmeasured,
    breakdown,
    weights,
    breakdownHistory,
    deferrals: readOptionalJson(join(ticketDir, 'deferrals.json'))?.deferrals,
  });

  const failing = failingDimensions(breakdown);
  const goal = restateGoal(KEY, loopCfg.rubricTarget, failing);
  const { sha, shaSource, note: shaNote } = await resolveSha(worktree);
  const scoredAt = new Date().toISOString();

  console.log(`\nAutopilot repair-loop — ${KEY} (round ${round})`);
  console.log(`  score:      ${score.toFixed(3)} (target ${loopCfg.rubricTarget}${pass ? ', met' : ', not met'})`);
  console.log(`  breakdown:  ${Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  weights:    ${Object.entries(weights).map(([k, v]) => `${k}=${v.toFixed(4)}`).join(', ')}`);
  console.log(`  excluded:   ${excluded.length ? excluded.join(', ') : '(none)'}`);
  console.log(`  unmeasured: ${unmeasured.length ? `${unmeasured.join(', ')}  ← blocks "done"` : '(none)'}`);
  console.log(`  visualDiff: ${visualDiff.source}${visualDiff.excluded ? ' (EXCLUDED, not passed)' : ''}${visualDiff.reason ? ` — ${visualDiff.reason}` : ''}`);
  console.log(`  conventions:${conventions.count === null ? ' unmeasured' : ` ${conventions.count} violation(s) via ${conventions.source}`}`);
  console.log(`  sha:        ${sha || 'null'} (${shaSource}${shaNote ? ` — ${shaNote}` : ''})`);
  const capUsd = Number(loopCfg.budgetUsdPerTicket);
  const capLabel = Number.isFinite(capUsd) && capUsd > 0 ? `$${capUsd.toFixed(2)} cap` : 'no cap';
  console.log(`  spend:      $${spentUsd.toFixed(4)} / ${capLabel}`);
  console.log(`  action:     ${decision.action}`);
  console.log(`  reason:     ${decision.reason}`);
  if (failing.length) console.log(`  goal:       ${goal}`);

  const line = rubricLine({
    key: KEY,
    round,
    score,
    breakdown,
    weights,
    excluded,
    unmeasured,
    action: decision.action,
    reason: decision.reason,
    sha,
    shaSource,
    visualDiff,
    spentUsd,
    budgetUsd: loopCfg.budgetUsdPerTicket,
    scoredAt,
    pinned: decision.pinned ?? [],
    reachableScore: decision.reachableScore ?? null,
  });

  if (DRY_RUN) {
    console.log('\n  --dry-run: nothing written. Receipt that WOULD be appended to rubric.jsonl:');
    console.log(`  ${JSON.stringify(line)}`);
  } else {
    writeReceipt(ticketDir, line, statusRubricPatch({ score, sha, round, scoredAt }));
    console.log(`\n  wrote:      ${join(ticketDir, 'rubric.jsonl')} (+1 line) and status.json rubricScore/rubricSha`);
  }

  const out = {
    score,
    action: decision.action,
    reason: decision.reason,
    spentUsd,
    budgetUsd: loopCfg.budgetUsdPerTicket,
    round,
    sha,
    shaSource,
    excluded,
    dryRun: DRY_RUN,
  };
  console.log(`\n${JSON.stringify(out)}`);

  process.exit(decision.action === 'done' || decision.action === 'continue' ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
