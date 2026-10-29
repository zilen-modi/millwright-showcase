#!/usr/bin/env node
// CLI + IO wrapper for the conventions linter (Goal A5, GOALS.md). All rule logic is
// pure in conventions-lint-lib.mjs (unit-tested); this file only reads the diff/files
// off disk (or stdin) and prints the shape scripts/loop.mjs and scripts/eval.mjs both
// depend on (docs/INTEGRATION-CONTRACTS.md §4).
//
// Usage:
//   node scripts/conventions-lint.mjs --diff <patch|-> [--json]
//   node scripts/conventions-lint.mjs --files a.scss,b.tsx [--repo-root <dir>] [--json]
//   node scripts/conventions-lint.mjs --branch <name> [--json]   (branch-name-shape only)
//   (--branch may be combined with --diff/--files to also check the branch name)
//
// --json prints exactly `{ count, violations: [{ rule, file, line, detail }] }`.
// Exit 0 when count === 0, 1 otherwise (2 on a usage error).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { lintSources, sourcesFromUnixDiff } from './conventions-lint-lib.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const DIFF_PATH = arg('diff');
const FILES_ARG = arg('files');
const REPO_ROOT = resolve(arg('repo-root', process.cwd()));
const BRANCH = arg('branch');
const JSON_OUT = flag('json');

/** `--diff` sources are diff-extracted ADDED lines only (no reliable per-file line
 * numbers), so this also flags `addedLinesOnly: true` for lintSources/report readers. */
function readDiffSources(diffPath) {
  const raw = diffPath === '-' ? readFileSync(0, 'utf8') : readFileSync(diffPath, 'utf8');
  return { sources: sourcesFromUnixDiff(raw), addedLinesOnly: true };
}

/** `--files` sources are whole real files off disk, resolved against `--repo-root` —
 * real, trustworthy line numbers. Missing files are skipped with a warning rather than
 * halting the whole lint run over one stale path. */
function readFileSources(filesArg, repoRoot) {
  const paths = filesArg
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const sources = [];
  // A DIRECTORY is a normal thing to be handed here — `git status --porcelain` reports an
  // untracked folder as a single entry, so any caller piping git output in hits this. Walk
  // it rather than crashing on EISDIR, which is what a bare readFileSync did.
  const pushFile = (rel, full) => {
    sources.push({ path: rel, text: readFileSync(full, 'utf8') });
  };
  const walk = (rel, full) => {
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childRel = `${rel.replace(/\/+$/, '')}/${entry.name}`;
      const childFull = join(full, entry.name);
      if (entry.isDirectory()) walk(childRel, childFull);
      else pushFile(childRel, childFull);
    }
  };
  for (const p of paths) {
    const full = join(repoRoot, p);
    if (!existsSync(full)) {
      console.warn(`conventions-lint: skipping missing file ${p}`);
      continue;
    }
    if (statSync(full).isDirectory()) walk(p, full);
    else pushFile(p, full);
  }
  return { sources, addedLinesOnly: false };
}

function printReadable(result) {
  if (result.count === 0) {
    console.log('conventions-lint: no violations found.');
    return;
  }
  console.log(`conventions-lint: ${result.count} violation(s):\n`);
  for (const v of result.violations) {
    const where = v.line ? `${v.file}:${v.line}` : v.file;
    console.log(`  [${v.rule}] ${where} — ${v.detail}`);
  }
}

function main() {
  if (!DIFF_PATH && !FILES_ARG && !BRANCH) {
    console.error('conventions-lint: one of --diff <patch>, --files a,b,c, or --branch <name> is required');
    process.exit(2);
    return;
  }

  let sources = [];
  let addedLinesOnly = false;
  if (DIFF_PATH) {
    ({ sources, addedLinesOnly } = readDiffSources(DIFF_PATH));
  } else if (FILES_ARG) {
    ({ sources } = readFileSources(FILES_ARG, REPO_ROOT));
  }

  const result = lintSources(sources, { branch: BRANCH, repoRoot: REPO_ROOT, addedLinesOnly });

  if (JSON_OUT) {
    console.log(JSON.stringify(result));
  } else {
    printReadable(result);
  }
  process.exit(result.count === 0 ? 0 : 1);
}

main();
