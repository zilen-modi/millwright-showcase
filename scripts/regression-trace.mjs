#!/usr/bin/env node
// Autopilot escaped-defect trace (Goal A7, contract §6 — docs/INTEGRATION-CONTRACTS.md).
//
// The question: of the tickets Autopilot actually shipped, how many later came back as a
// UI-FIDELITY DEFECT filed against a component an earlier ticket already shipped — and
// does the rubric score that earlier ticket got predict that outcome at all?
//
// Data sources (all local, all read-only against the target repo):
//   - tickets/<KEY>/status.json      — rubricScore, and (only where present) stage/mergedAt
//   - tickets/<KEY>/ticket.md        — the ticket's own account of the defect (type + text)
//   - tickets/<KEY>/route.md,plan.md — fallback component signal when ticket.md is silent
//   - eval/golden-set.json           — curated escapeAgainst ground truth (a first-class
//                                       data source here, not just a validation oracle)
//   - the target repo's real git history — WHAT a ticket actually shipped and WHEN, via
//     `git log --grep=<KEY>` (same technique preflight.mjs already uses), because
//     status.json is not reliably present or accurate: PROJ-2832 has NO status.json at
//     all despite two real merged PRs (#745, #755) against it — GOALS.md's "18 merged
//     PRs" count comes from status.json bookkeeping, not from git, and this script says
//     so explicitly when the two disagree rather than silently picking one.
//
// GUARDRAILS: every git invocation runs through guardExec (scripts/guard.mjs) — no bare
// execFileSync-and-swallow. A failed git probe is recorded and surfaces as an explicit
// "UNVERIFIED" note in both the human report and the JSON, and the affected ticket falls
// back to local-docs-only component detection rather than silently reporting zero.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { guardExec } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';
import {
  componentsFromFilePaths,
  componentsFromTitle,
  extractTicketType,
  extractDescriptionText,
  classifyFidelityDefect,
  traceRegressions,
  correlateRubricEscapes,
} from './regression-trace-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOPILOT = join(HERE, '..');
const WORKSPACE = join(AUTOPILOT, '..');
const TICKETS_DIR = join(AUTOPILOT, 'tickets');
const GOLDEN_PATH = join(AUTOPILOT, 'eval', 'golden-set.json');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const JSON_MODE = process.argv.includes('--json');
const REPO = arg('repo', 'erp-next-ui-monorepo');
const TARGET_REPO = join(WORKSPACE, REPO);

// ---------------------------------------------------------------------------
// Guarded git access — mirrors scripts/preflight.mjs's pattern exactly: local git is
// deterministic so retries:0, and every failure is recorded (never swallowed into a
// confident empty result).
// ---------------------------------------------------------------------------
const globalNotes = [];

async function git(label, args) {
  const r = await guardExec(`regression-trace ${label}`, 'git', ['-C', TARGET_REPO, ...args], {
    source: `git ${args[0]}`, retries: 0, timeoutMs: 30000,
  });
  if (!r.ok) {
    console.error(acknowledgement(r));
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: String(r.value?.stdout ?? '').trim() };
}

/** Resolve everything git knows about one ticket key: every file it ever touched (union
 * across every matching commit, merge or not) and whether/when it landed on origin/dev.
 *
 * For a normal (single-parent) commit, `git show --name-only` is exactly its diff. For a
 * merge commit (two parents — almost always "Merge pull request #N"), the files are
 * `diff(sha^1, sha) --name-only`: a direct TREE comparison of "dev right before this
 * merge landed" vs "dev right after", which is exactly the merge's net effect and needs
 * no history reasoning. An earlier version of this used `diff(mergeBase(p1,p2), p2)`
 * (GitHub's own "files changed" logic) — that broke badly on PROJ-2908, whose branch
 * contains its own internal "Merge origin/dev into autopilot/PROJ-2908" sync commit;
 * merge-base against that sync commit resolved to a stale ancestor, and the diff against
 * it pulled in dozens of unrelated files (Tag, TagGroup, Checkbox, RadioButton — none of
 * which PROJ-2908 touches) purely because they'd changed on dev in the interim. The
 * direct sha^1..sha tree diff doesn't have that failure mode. Commits with >2 parents
 * (octopus) are skipped and noted; none of the 25 tickets here depend on one for their
 * real component signal. */
// A branch that periodically re-syncs with its target ("Merge origin/dev into
// autopilot/PROJ-2908 — resolve conflicts...") produces a merge commit whose sha^1..sha
// diff is genuinely huge — it's pulling in everything the target branch gained since the
// feature branch last synced, which is target-branch history, not this ticket's own work
// (confirmed against PROJ-2908, where this exact commit made Tag/TagGroup/Checkbox/
// RadioButton falsely appear in a Combobox ticket's file list). Skip these on sight.
const SYNC_MERGE_RE = /^merge\b.*\bdev\b.*\binto\b/i;

async function resolveGitInfo(key) {
  const notes = [];
  const log = await git(`grep-${key}`, ['log', '--all', '-i', `--grep=${key}`, '--pretty=format:%H%x09%P%x09%s']);
  if (!log.ok) {
    notes.push(`git log --grep=${key} failed — file/component data for ${key} is UNVERIFIED (treated as none, not zero)`);
    return { ok: false, merged: false, mergedAtIso: null, files: [], notes };
  }

  const files = new Set();
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [sha, parentsStr, subject = ''] = line.split('\t');
    const parents = (parentsStr || '').trim().split(/\s+/).filter(Boolean);
    if (SYNC_MERGE_RE.test(subject)) {
      notes.push(`skipped sync-merge commit ${sha.slice(0, 8)} ("${subject}") for ${key} — brings in target-branch history, not this ticket's own work`);
      continue;
    }
    if (parents.length <= 1) {
      const r = await git(`show-${sha}`, ['show', '--name-only', '--pretty=format:', sha]);
      if (r.ok) r.stdout.split('\n').filter(Boolean).forEach((f) => files.add(f));
    } else if (parents.length === 2) {
      const diff = await git(`diff-${sha}`, ['diff', `${sha}^1`, sha, '--name-only']);
      if (diff.ok) diff.stdout.split('\n').filter(Boolean).forEach((f) => files.add(f));
      else notes.push(`diff ${sha.slice(0, 8)}^1..${sha.slice(0, 8)} for ${key} failed — its files may be missing from the trace`);
    } else {
      notes.push(`commit ${sha.slice(0, 8)} for ${key} has ${parents.length} parents (octopus) — skipped, not cleanly diffable`);
    }
  }

  const dev = await git(`dev-grep-${key}`, ['log', 'origin/dev', '-i', `--grep=${key}`, '--pretty=format:%cI']);
  let merged = false;
  let mergedAtIso = null;
  if (dev.ok) {
    const dates = dev.stdout.split('\n').filter(Boolean).sort();
    if (dates.length) {
      merged = true;
      mergedAtIso = dates[0]; // earliest commit on dev referencing this key
    }
  } else {
    notes.push(`git log origin/dev --grep=${key} failed — merge status for ${key} is UNVERIFIED`);
  }

  return { ok: true, merged, mergedAtIso, files: [...files], notes };
}

// ---------------------------------------------------------------------------
// Local ticket-dir loading (plain fs — no guard needed, this repo's own files).
// ---------------------------------------------------------------------------
function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function loadTicketDir(key) {
  const dir = join(TICKETS_DIR, key);
  let status = null;
  const statusPath = join(dir, 'status.json');
  if (existsSync(statusPath)) {
    try { status = JSON.parse(readFileSync(statusPath, 'utf8')); } catch { status = null; }
  }
  const ticketMd = readIfExists(join(dir, 'ticket.md'));
  const routeMd = readIfExists(join(dir, 'route.md'));
  const planMd = readIfExists(join(dir, 'plan.md'));
  const contextMd = readIfExists(join(dir, 'context.md'));

  let eventsNotes = '';
  const eventsRaw = readIfExists(join(dir, 'events.jsonl'));
  if (eventsRaw) {
    eventsNotes = eventsRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line).notes || ''; } catch { return ''; } })
      .join('\n');
  }

  return { key, status, ticketMd, routeMd, planMd, contextMd, eventsNotes };
}

function firstLine(text) {
  if (!text) return '';
  return text.split('\n').find((l) => l.trim().length) || '';
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Compare the heuristic's own verdict (classifyFidelityDefect as actually applied inside
 * traceRegressions — component-aware and post shipper-suppression, but independent of
 * golden-set ground truth) against every golden-set entry that has a lesson recorded —
 * most of which are deliberately NOT escapes (2996, 2997, 3000, 3016, 3020, 3021, 3026),
 * making them free negative-control fixtures the curator already produced. This is the
 * honest "does the heuristic generalize" check.
 *
 * Uses `consideredDetails` (every (ticket, component) pair traceRegressions actually
 * evaluated) rather than a ticket-text-only classification, because component context
 * matters: e.g. PROJ-2908's own text alone reads as fidelity-flavoured, but in context
 * it's shipping Combobox and only touching Menu/Multiselect as side-effect parity work —
 * `consideredDetails` already knows that; a bare per-ticket flag would not. */
function validateAgainstGolden(consideredDetails, goldenByKey) {
  const heuristicFiredByKey = new Map();
  for (const d of consideredDetails) {
    heuristicFiredByKey.set(d.key, heuristicFiredByKey.get(d.key) || d.heuristicFired);
  }
  const rows = [];
  for (const [key, g] of Object.entries(goldenByKey)) {
    if (!heuristicFiredByKey.has(key)) continue; // never touched an earlier-shipped component — not a candidate at all
    rows.push({
      key,
      escapeAgainst: g.escapeAgainst || null,
      goldenIsEscape: Boolean(g.escapeAgainst),
      heuristicFires: heuristicFiredByKey.get(key),
    });
  }
  const tp = rows.filter((r) => r.goldenIsEscape && r.heuristicFires).length;
  const fn = rows.filter((r) => r.goldenIsEscape && !r.heuristicFires).length;
  const fp = rows.filter((r) => !r.goldenIsEscape && r.heuristicFires).length;
  const tn = rows.filter((r) => !r.goldenIsEscape && !r.heuristicFires).length;
  return {
    rows,
    truePositive: tp,
    falseNegative: fn,
    falsePositive: fp,
    trueNegative: tn,
    precision: tp + fp ? round3(tp / (tp + fp)) : null,
    recall: tp + fn ? round3(tp / (tp + fn)) : null,
    accuracy: rows.length ? round3((tp + tn) / rows.length) : null,
    missedByLexicalHeuristicAlone: rows.filter((r) => r.goldenIsEscape && !r.heuristicFires).map((r) => r.key),
  };
}

async function main() {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const goldenByKey = {};
  for (const g of golden.tickets) goldenByKey[g.key] = g;

  const repoOk = existsSync(join(TARGET_REPO, '.git'));
  if (!repoOk) {
    globalNotes.push(
      `target repo not found at ${TARGET_REPO} — every ticket falls back to local-docs-only component ` +
        `detection and status.json's (unverified) merge claim; git-derived file lists are UNAVAILABLE for this run.`,
    );
  }

  const ticketKeys = readdirSync(TICKETS_DIR).filter((d) => statSync(join(TICKETS_DIR, d)).isDirectory());

  const tickets = [];
  for (const key of ticketKeys) {
    const loaded = loadTicketDir(key);
    const title = firstLine(loaded.ticketMd) || firstLine(loaded.planMd) || key;

    let gitInfo = { ok: false, merged: false, mergedAtIso: null, files: [], notes: [] };
    if (repoOk) {
      gitInfo = await resolveGitInfo(key);
      globalNotes.push(...gitInfo.notes);
    }

    let components = componentsFromFilePaths(gitInfo.files);
    let componentSource = components.length ? 'git-diff' : 'none';
    if (components.length === 0) {
      const localDocsText = [loaded.routeMd, loaded.planMd, loaded.contextMd].filter(Boolean).join('\n');
      const fromDocs = componentsFromFilePaths(localDocsText);
      const fromTitle = componentsFromTitle(title);
      components = [...new Set([...fromDocs, ...fromTitle])];
      if (components.length) componentSource = fromDocs.length ? 'local-docs-fallback' : 'title-fallback';
    }

    // Merge/ship status: git is authoritative when reachable. When it isn't, fall back to
    // status.json's self-reported stage — explicitly marked unverified, never presented
    // as equivalent to the git-checked result.
    let merged = gitInfo.merged;
    let mergedAtIso = gitInfo.mergedAtIso;
    let mergeVerified = repoOk && gitInfo.ok;
    if (!mergeVerified && loaded.status?.stage === 'merged') {
      merged = true;
      mergedAtIso = typeof loaded.status.mergedAt === 'string' ? loaded.status.mergedAt : null;
    }

    const type = extractTicketType(loaded.ticketMd);
    const descriptionSource = loaded.ticketMd || loaded.eventsNotes || '';
    const descriptionText = extractDescriptionText(descriptionSource);
    const heuristic = classifyFidelityDefect({ type, descriptionText });

    tickets.push({
      key,
      title,
      type,
      merged,
      mergedAtIso,
      mergeVerified,
      components,
      componentSource,
      rubricScore: typeof loaded.status?.rubricScore === 'number' ? loaded.status.rubricScore : undefined,
      heuristicFires: heuristic.isFidelityDefect,
      heuristicReasons: heuristic.reasons,
      descriptionText,
      hasTicketMd: Boolean(loaded.ticketMd),
      statusStage: loaded.status?.stage ?? null,
    });
  }

  // Cross-check against status.json's own ("Autopilot-tracked") merged count, since
  // GOALS.md's "18 merged PRs" is exactly that count and PROJ-2832 (2 real merged PRs,
  // confirmed in git) has no status.json at all, so it's invisible to that count.
  const statusTrackedMerged = tickets.filter((t) => t.statusStage === 'merged').length;
  const gitVerifiedMerged = tickets.filter((t) => t.merged).length;
  if (gitVerifiedMerged !== statusTrackedMerged) {
    globalNotes.push(
      `status.json reports ${statusTrackedMerged} tickets at stage="merged" (this is GOALS.md's "18 merged ` +
        `PRs" figure), but git independently verifies ${gitVerifiedMerged} as actually merged into origin/dev. ` +
        `The gap is ${tickets.filter((t) => t.merged && t.statusStage !== 'merged').map((t) => t.key).join(', ') || 'none'} ` +
        `— merged in reality, untracked in status.json. This IS the pipeline-integrity gap Goal A1 targets.`,
    );
  }

  const result = traceRegressions({ tickets, goldenByKey });
  const rubricCorrelation = correlateRubricEscapes({ tickets, byComponent: result.byComponent });
  const heuristicValidation = validateAgainstGolden(result.consideredDetails, goldenByKey);

  const output = {
    shipped: result.shipped,
    escaped: result.escaped,
    escapedDefectRate: result.escapedDefectRate,
    byComponent: result.byComponent,
    escapeDetails: result.escapeDetails,
    rubricCorrelation,
    heuristicValidation,
    notes: globalNotes,
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(tickets, result, rubricCorrelation, heuristicValidation, globalNotes);
}

function printReport(tickets, result, rubricCorrelation, heuristicValidation, notes) {
  const line = (s = '') => console.log(s);
  line(`# Escaped-defect trace (Goal A7)`);
  line();
  line(`Shipped tickets (git-verified merged into origin/dev): ${result.shipped}`);
  line(`Escaped defects (fidelity fixes against an earlier-shipped component): ${result.escaped}`);
  line(`Escaped-defect rate: ${result.escapedDefectRate} (${result.escaped}/${result.shipped})`);
  line();

  if (notes.length) {
    line(`## Data-integrity notes`);
    for (const n of notes) line(`- ${n}`);
    line();
  }

  line(`## By component`);
  for (const c of result.byComponent) {
    line(`- **${c.component}** — shipped by ${c.shippedBy}`);
    if (c.escapes.length) line(`  - escapes: ${c.escapes.join(', ')}`);
    if (c.nonEscapes.length) line(`  - considered, not an escape: ${c.nonEscapes.join(', ')}`);
  }
  line();

  line(`## Escape reasoning (so a human can argue with it)`);
  for (const e of result.escapeDetails) {
    line(`- ${e.key} → ${e.component} (shipped by ${e.shippedBy}) — source: ${e.source}`);
    for (const r of e.reasons) line(`    ${r}`);
  }
  line();

  line(`## Heuristic validation against eval/golden-set.json`);
  line(`- TP=${heuristicValidation.truePositive} FN=${heuristicValidation.falseNegative} FP=${heuristicValidation.falsePositive} TN=${heuristicValidation.trueNegative}`);
  line(`- precision=${heuristicValidation.precision} recall=${heuristicValidation.recall} accuracy=${heuristicValidation.accuracy}`);
  if (heuristicValidation.missedByLexicalHeuristicAlone.length) {
    line(`- missed by the lexical heuristic alone (relied on golden-set ground truth instead): ${heuristicValidation.missedByLexicalHeuristicAlone.join(', ')}`);
  }
  line();

  line(`## Rubric vs escape correlation`);
  line(`- Shipper's own rubricScore for each component that later escaped:`);
  for (const s of rubricCorrelation.shipperScoresForEscapedComponents) {
    line(`    ${s.component} shipped by ${s.shippedBy}: rubricScore=${s.rubricScore ?? 'MISSING — never recorded'}`);
  }
  line(`- Tickets with a recorded rubricScore: ${rubricCorrelation.ticketsWithRubricScore} (missing: ${rubricCorrelation.ticketsMissingRubricScore})`);
  line(`- Escape-fix tickets' own mean rubricScore: ${rubricCorrelation.escapeFixTickets.meanScore ?? 'n/a'} (n=${rubricCorrelation.escapeFixTickets.count})`);
  line(`- Clean tickets' mean rubricScore: ${rubricCorrelation.cleanTickets.meanScore ?? 'n/a'} (n=${rubricCorrelation.cleanTickets.count})`);
  line();

  const allMissing = rubricCorrelation.shipperScoresForEscapedComponents.every((s) => s.rubricScore == null);
  const delta = rubricCorrelation.cleanTickets.meanScore != null && rubricCorrelation.escapeFixTickets.meanScore != null
    ? Math.abs(rubricCorrelation.cleanTickets.meanScore - rubricCorrelation.escapeFixTickets.meanScore)
    : null;
  line(`## Verdict`);
  if (allMissing) {
    line(
      `- Every component that later escaped was shipped by a ticket with NO recorded rubricScore at all — ` +
        `the data needed to test "did a high rubric predict a low escape rate" was never captured for the ` +
        `tickets that actually mattered. That absence is itself the finding.`,
    );
  }
  if (delta != null) {
    line(
      `- Among tickets that DO carry a recorded score, escape-fix tickets (mean ${rubricCorrelation.escapeFixTickets.meanScore}) ` +
        `score ${delta < 0.02 ? 'no differently from' : 'differently from'} clean tickets (mean ${rubricCorrelation.cleanTickets.meanScore}). ` +
        (delta < 0.02
          ? 'The rubric shows no measurable separation — it does not predict escape risk on this data.'
          : 'There is some separation, but n is small; treat this as suggestive, not proof.'),
    );
  }
}

main().catch((e) => {
  console.error(`✗ regression-trace failed: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
