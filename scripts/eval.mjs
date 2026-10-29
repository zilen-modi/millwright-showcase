#!/usr/bin/env node
// Golden-set regression harness. A set of already-merged tickets (eval/golden-set.json)
// is ground truth; this scores a PRODUCED diff against the expected merged outcome so
// changes to the SKILL/agents get tested instead of shipping blind. Scoring is pure
// logic in eval-lib.mjs (unit-tested); this file only does IO (reads, CLI, reporting).
//
// Usage (cheap/default — no pipeline re-run, deterministic, CI-friendly):
//   node scripts/eval.mjs --mode diff --diff <patch-or-json> --key PROJ-2825
//     [--golden eval/golden-set.json] [--out eval/eval-report.json]
//
// --diff accepts either:
//   - a `git diff` unix patch file — parsed into the produced shape (files changed,
//     +/- counts, per-file added lines), or
//   - a JSON file already in the produced shape:
//       { filesChanged, additions, deletions, containsByFile, testCountDelta }
//
// If --key is omitted, every golden-set entry is scored against the same produced
// diff (useful for smoke-testing the harness itself). Exits non-zero if any evaluated
// ticket fails.
//
// --mode rerun (heavier): re-run the pipeline through BUILD for a golden ticket in a
// throwaway worktree pinned to the parent of its merged commit, capture the resulting
// git diff, then score it the same way --mode diff does. `--until build` stops before
// VERIFY/REVIEW/SHIP so a rerun NEVER opens a PR, comments on Jira, or merges. It spends
// real tokens (a full BUILD per ticket) and needs a configured headless claude, so use
// `--dry-run` first to print the plan (repo / base commit / worktree / command) without
// spawning anything. See eval/README.md.
//
//   node scripts/eval.mjs --mode rerun --key PROJ-2825 [--dry-run] [--keep]
//     [--capture-only] [--golden …] [--out …] [--manifest …]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { execa } from 'execa';
import { simpleGit } from 'simple-git';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';
import { scoreDiff, summarizeEval, parseUnixDiff } from './eval-lib.mjs';
import { rerunPlan, rerunCacheKey } from './eval-rerun-lib.mjs';

/** The conventions linter, injected into scoreDiff so eval-lib stays pure. Loaded
 * lazily because it is a sibling module that may not exist in an older checkout —
 * absent, the `conventions` check fails closed (see eval-lib's conventionsScore), which
 * is the correct direction for a gate that cannot run. */
let lintSources = null;
try {
  ({ lintSources } = await import('./conventions-lint-lib.mjs'));
} catch {
  console.warn('⚠ scripts/conventions-lint-lib.mjs not found — the `conventions` check will fail closed.');
}
const SCORE_OPTS = { lintSources };

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, '..', 'eval');
const AUTOPILOT = join(HERE, '..'); // millwright/
const WORKSPACE = join(AUTOPILOT, '..'); // acme/ — repos + .wt/ live here

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const MODE = arg('mode', 'diff');
if (MODE !== 'diff' && MODE !== 'rerun') {
  console.error(`eval: unknown --mode "${MODE}" (expected "diff" or "rerun")`);
  process.exit(2);
}

// Shared across both modes.
const KEY = arg('key');
const GOLDEN_PATH = arg('golden', join(EVAL_DIR, 'golden-set.json'));
const OUT = arg('out', join(EVAL_DIR, 'eval-report.json'));
const MANIFEST_PATH = arg('manifest', join(AUTOPILOT, 'config', 'repo-manifest.json'));
const CONFIG_PATH = arg('config', join(AUTOPILOT, 'config', 'config.json'));

/** Guarded read of a text file — a missing/unreadable golden set or diff halts the run
 * with an acknowledged BLOCKED reason instead of a raw stack trace. */
async function readGuarded(label, path) {
  const result = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  return acknowledgeOrThrow(result);
}

/** Load eval/golden-set.json — either the plain `[...]` array shape or the
 * `{ _comment, tickets: [...] }` wrapper. */
async function loadGolden() {
  const raw = await readGuarded('eval golden-set', GOLDEN_PATH);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.tickets || [];
}

/** Load the produced diff: a `.json` file (or any file whose contents parse as a JSON
 * object) is used directly as the produced shape; otherwise it's treated as a unix
 * `git diff` patch and parsed via parseUnixDiff. */
async function loadProduced(diffPath) {
  const raw = await readGuarded('eval produced diff', diffPath);
  if (diffPath.endsWith('.json')) return JSON.parse(raw);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON — fall through to diff parsing
  }
  return parseUnixDiff(raw);
}

/** JSON read via the same guard as text reads. */
async function loadJsonGuarded(label, path) {
  return JSON.parse(await readGuarded(label, path));
}

/** The golden entries to evaluate — one when `--key` is given, else all. Exits with a
 * clear message when the key is unknown or the set is empty. */
function selectEntries(golden) {
  const entries = KEY ? golden.filter((g) => g.key === KEY) : golden;
  if (KEY && entries.length === 0) {
    console.error(`eval: no golden-set entry found for --key ${KEY}`);
    process.exit(2);
  }
  if (entries.length === 0) {
    console.error('eval: golden-set is empty — nothing to score against');
    process.exit(2);
  }
  return entries;
}

function printReport(entryResults) {
  console.log(`\nEval — golden-set regression (${entryResults.length} ticket(s)):`);
  for (const r of entryResults) {
    console.log(`\n  ${r.key} — ${r.pass ? 'PASS' : 'FAIL'} (score ${r.score})`);
    for (const c of r.checks) {
      console.log(`    ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    }
  }
}

function writeReport(extra, results, summary) {
  const report = { generatedAt: new Date().toISOString(), golden: GOLDEN_PATH, ...extra, results, summary };
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nSummary: ${summary.passed}/${summary.total} passed${summary.failed ? `, worst: ${summary.worst.join(', ')}` : ''}`);
  console.log(`\nReport written to ${OUT}`);
  console.log(`\n${JSON.stringify(summary)}`);
}

// ---- --mode diff (default, cheap, deterministic) ----
async function main() {
  const DIFF_PATH = arg('diff');
  if (!DIFF_PATH) {
    console.error('eval: --diff <patch-or-json> is required for --mode diff');
    process.exit(2);
  }

  const golden = await loadGolden();
  const produced = await loadProduced(DIFF_PATH);
  const entries = selectEntries(golden);

  const results = entries.map((entry) => {
    const { score, pass, checks } = scoreDiff(produced, entry.expect, SCORE_OPTS);
    return { key: entry.key, pr: entry.pr, score, pass, checks };
  });

  const summary = summarizeEval(results);
  printReport(results);
  writeReport({ mode: 'diff', diff: DIFF_PATH }, results, summary);

  if (summary.failed > 0) process.exit(1);
}

// ---- --mode rerun (heavy: real BUILD in a throwaway worktree, then score its diff) ----
const DRY_RUN = flag('dry-run');
const KEEP = flag('keep');          // leave the worktree in place for inspection
const CAPTURE_ONLY = flag('capture-only'); // skip BUILD; score the diff already in the worktree
const NO_CACHE = flag('no-cache');  // force a rebuild even if a cached score exists
const CACHE_PATH = arg('cache', join(EVAL_DIR, 'rerun-cache.json'));

// Files whose contents drive a BUILD's output — the champion/challenger prompts plus the
// SKILL, conventions, manifest, and config. If none of these changed (and the base commit
// didn't), a rerun would reproduce the same build, so its cached score is reused. Prompt
// refs come from champion/registry.json (the source of truth for versioned prompts).
function buildAffectingFiles() {
  const files = [
    join(AUTOPILOT, '.claude', 'skills', 'resolve-ticket', 'SKILL.md'),
    join(AUTOPILOT, 'conventions.md'),
    MANIFEST_PATH,
    CONFIG_PATH,
  ];
  try {
    const reg = JSON.parse(readFileSync(join(AUTOPILOT, 'champion', 'registry.json'), 'utf8'));
    for (const c of Object.values(reg.champions || {})) {
      if (c && c.ref && c.ref !== 'builtin') files.push(resolve(AUTOPILOT, c.ref));
    }
  } catch { /* no registry — just hash the core files */ }
  return files;
}

/** Deterministic fingerprint of the build-affecting files. Each file contributes
 * `path\0sha256(content)` (or `path\0MISSING`), so a file appearing/disappearing also
 * changes the hash. Returns the first 12 hex chars of the combined digest. */
function promptFingerprint() {
  const parts = [];
  for (const f of buildAffectingFiles().sort()) {
    let mark = 'MISSING';
    try { mark = createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { /* missing */ }
    parts.push(`${f}\0${mark}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/** Resolve a base ref to a concrete commit sha so the cache key pins the exact tree; on
 * failure (commit not present locally, no git) fall back to the literal ref string. */
async function resolveBaseSha(repoPath, baseRef) {
  try {
    const out = await simpleGit(repoPath).revparse([baseRef]);
    return out.trim() || baseRef;
  } catch { return baseRef; }
}

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
  catch { return { version: 1, _comment: 'eval --mode rerun score cache — keyed by goldenKey::baseSha::promptHash. Delete to force full rebuilds; --no-cache bypasses for one run.', entries: {} }; }
}
function saveCache(cache) {
  mkdirSync(dirname(resolve(CACHE_PATH)), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Add a git worktree for `repo` at `baseRef`, checking out branch `branch` at `wtDir`.
 * Guards a fetch first (so a commit ref that only exists on the remote is reachable) but
 * degrades to the local object DB on fetch failure, like scripts/worktree.mjs. */
async function createEvalWorktree(repoPath, wtDir, branch, baseRef) {
  const git = simpleGit(repoPath);
  const fetchResult = await withGuard('eval worktree fetch', () => git.fetch(), { source: 'git fetch', retries: 2 });
  if (!fetchResult.ok) console.warn(acknowledgement(fetchResult) + '\nfetch failed; using local objects');
  // Clean any stale eval worktree/branch from a previous run so -B doesn't collide.
  try { await git.raw('worktree', 'remove', '--force', wtDir); } catch { /* none */ }
  await git.raw('worktree', 'add', '-B', branch, wtDir, baseRef);
}

async function removeEvalWorktree(repoPath, wtDir) {
  try { await simpleGit(repoPath).raw('worktree', 'remove', '--force', wtDir); }
  catch (e) { console.warn(`eval: could not remove worktree ${wtDir}: ${e.message || e}`); }
}

/** The full diff a BUILD produced vs the base commit — stage everything (so new,
 * untracked files are included) then diff the index against the base ref. */
async function captureDiff(wtDir, baseRef) {
  const git = simpleGit(wtDir);
  await git.add(['-A']);
  return git.diff(['--cached', baseRef]);
}

async function rerunOne(entry, manifest, opts, cache) {
  const plan = rerunPlan(entry, manifest, opts);
  const repoPath = join(WORKSPACE, plan.repo);
  const wtDir = join(WORKSPACE, '.wt', plan.worktree);

  console.log(`\n${plan.key} — rerun plan`);
  console.log(`  repo:     ${plan.repo}  (${repoPath})`);
  console.log(`  base:     ${plan.base.ref}  [${plan.base.kind}] — ${plan.base.note}`);
  console.log(`  worktree: ${wtDir}  (branch ${plan.branch})`);
  console.log(`  build:    ${plan.build.cmd} ${plan.build.args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);

  if (DRY_RUN) return { key: entry.key, pr: entry.pr, skipped: 'dry-run', plan: { repo: plan.repo, base: plan.base, worktree: plan.worktree } };

  if (!existsSync(join(repoPath, '.git'))) {
    return { key: entry.key, error: `repo not found: ${repoPath}`, score: 0, pass: false, checks: [] };
  }

  // Cache lookup — skip the whole BUILD when the ticket, base tree, and prompts are
  // unchanged. `--capture-only` (score an existing worktree) and `--no-cache` bypass it.
  let cacheKey = null, baseSha = null;
  if (cache && !CAPTURE_ONLY) {
    baseSha = await resolveBaseSha(repoPath, plan.base.ref);
    cacheKey = rerunCacheKey(entry.key, baseSha, opts.promptHash);
    const hit = cache.entries[cacheKey];
    if (hit) {
      console.log(`  ✓ cache hit (${cacheKey}) — reusing score ${hit.score}, no build.`);
      return { ...hit, key: entry.key, pr: entry.pr, cached: true };
    }
  }

  try {
    if (!CAPTURE_ONLY) {
      await createEvalWorktree(repoPath, wtDir, plan.branch, plan.base.ref);
      console.log(`  → building (this spends tokens)…`);
      const res = await withGuard('eval build', () => execa(plan.build.cmd, plan.build.args, { cwd: wtDir, reject: false, timeout: 30 * 60 * 1000 }), { source: 'eval build', retries: 0 });
      if (!res.ok) return { key: entry.key, error: acknowledgement(res), score: 0, pass: false, checks: [] };
      if (res.value?.exitCode) console.warn(`  build exited ${res.value.exitCode} — scoring whatever diff it produced`);
    }
    const patch = await captureDiff(wtDir, plan.base.ref);
    const produced = parseUnixDiff(patch);
    const { score, pass, checks } = scoreDiff(produced, entry.expect, SCORE_OPTS);
    const result = { key: entry.key, pr: entry.pr, repo: plan.repo, base: plan.base.ref, score, pass, checks, filesChanged: produced.filesChanged };
    // Store to cache (never cache a --capture-only score — no known base tree/prompt hash).
    if (cache && cacheKey) {
      cache.entries[cacheKey] = { score, pass, checks, repo: plan.repo, base: plan.base.ref, baseSha, filesChanged: produced.filesChanged, at: new Date().toISOString() };
      saveCache(cache);
    }
    return result;
  } finally {
    if (!KEEP && !CAPTURE_ONLY) await removeEvalWorktree(repoPath, wtDir);
  }
}

async function rerunMain() {
  const golden = await loadGolden();
  const manifest = await loadJsonGuarded('repo-manifest', MANIFEST_PATH);
  let baseBranch = 'dev';
  try { baseBranch = (await loadJsonGuarded('config', CONFIG_PATH)).baseBranch || 'dev'; } catch { /* default */ }
  const entries = selectEntries(golden);

  const promptHash = promptFingerprint();
  const opts = {
    baseBranch,
    promptHash,
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    settingsPath: process.env.EVAL_CLAUDE_SETTINGS || null,
    buildCmdTemplate: process.env.EVAL_BUILD_CMD || null,
  };

  const cache = DRY_RUN || NO_CACHE ? null : loadCache();
  if (DRY_RUN) console.log('eval rerun --dry-run: printing plans only, spawning nothing.');
  else console.log(`eval rerun: ${entries.length} ticket(s) · promptHash ${promptHash}${NO_CACHE ? ' · cache OFF (--no-cache)' : ` · cache ${CACHE_PATH}`} — a MISS runs a real BUILD (tokens + configured headless claude).`);

  const results = [];
  for (const entry of entries) results.push(await rerunOne(entry, manifest, opts, cache));

  if (DRY_RUN) {
    console.log(`\nDry run complete — ${results.length} plan(s) printed. Re-run without --dry-run to build & score.`);
    return;
  }

  const scored = results.filter((r) => r.checks);
  const nCached = results.filter((r) => r.cached).length;
  printReport(scored);
  const summary = { ...summarizeEval(scored), cached: nCached, built: scored.length - nCached };
  writeReport({ mode: 'rerun', promptHash }, results, summary);
  console.log(`(${nCached} cache hit(s), ${summary.built} real build(s))`);
  if (summary.failed > 0 || results.some((r) => r.error)) process.exit(1);
}

if (MODE === 'diff') {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
} else {
  rerunMain().catch((e) => { console.error(e.message || e); process.exit(1); });
}
