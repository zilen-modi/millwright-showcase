#!/usr/bin/env node
// Duplication scan feeding quality-agent's reusability/DRY judgment (Autopilot REVIEW
// stage + ad-hoc /review-pr). Wraps `jscpd`, scoped to the PR/ticket's changed files
// only — never a full-repo scan, both for speed and so the report is actually about
// this change, not pre-existing duplication elsewhere in the repo. This script only
// produces the report; quality-agent.md judges genuine-extraction-opportunity vs.
// coincidental similarity — jscpd flags mechanical similarity, it doesn't decide if
// it matters.
//
// Usage:
//   node scripts/dup-scan.mjs --files <path/to/changed-files.txt|-> --repo-cwd <path>
//     [--out report.json] [--min-lines 5] [--min-tokens 30]
//
// --files points to a newline-separated list of changed file paths (relative to
// --repo-cwd), or "-" to read that list from stdin. Writes a normalized JSON report
// `{ duplicates: [...] }` and exits non-zero only on a guarded jscpd failure (an empty
// `duplicates` array is a normal, successful "nothing flagged" result, not a failure).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { guardExec, acknowledgeOrThrow } from './guard.mjs';
import { normalizeJscpdReport, filterByChangedFiles } from './dup-scan-lib.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const FILES_PATH = arg('files');
const REPO_CWD = arg('repo-cwd');
if (!FILES_PATH || !REPO_CWD) {
  console.error('dup-scan: --files <list.txt|-> and --repo-cwd <path> are required');
  process.exit(2);
}
const MIN_LINES = arg('min-lines', '5');
const MIN_TOKENS = arg('min-tokens', '30');
const OUT = arg('out', join(process.cwd(), 'dup-scan-report.json'));

function readChangedFiles() {
  const raw = FILES_PATH === '-' ? readFileSync(0, 'utf8') : readFileSync(FILES_PATH, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function writeEmptyReport(reason) {
  console.log(`dup-scan: ${reason} — nothing to scan.`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ duplicates: [] }, null, 2));
}

async function main() {
  const changedFiles = readChangedFiles();
  if (changedFiles.length === 0) return writeEmptyReport('no changed files given');

  const existing = changedFiles.filter((f) => existsSync(join(REPO_CWD, f)));
  if (existing.length === 0) return writeEmptyReport('none of the given changed files exist on disk');

  const jscpdOutDir = join(REPO_CWD, '.dup-scan-tmp');
  // `reject: false` — jscpd exits non-zero when it FINDS duplicates (its own CI-gate
  // default), which is a normal result here, not a guard failure. A genuine spawn
  // failure (npx/jscpd missing, network) still throws and gets classified below.
  // Pinned to the `4.x` line explicitly: the bare `jscpd` package name was rewritten
  // in Rust for v5 (a different, unrelated tool at jscpd.dev) and its JSON reporter
  // omits file names entirely — `4.x` is the mature TS tool this wrapper is built for.
  const result = await guardExec(
    'dup-scan jscpd',
    'npx',
    [
      '--yes',
      'jscpd@4',
      ...existing,
      '--reporters',
      'json',
      '--output',
      jscpdOutDir,
      '--min-lines',
      String(MIN_LINES),
      '--min-tokens',
      String(MIN_TOKENS),
      '--silent',
    ],
    { cwd: REPO_CWD, timeoutMs: 60000, reject: false },
  );
  if (!result.ok) acknowledgeOrThrow(result);

  const reportPath = join(jscpdOutDir, 'jscpd-report.json');
  if (!existsSync(reportPath)) return writeEmptyReport('jscpd produced no report (likely zero duplicates found)');

  const raw = JSON.parse(readFileSync(reportPath, 'utf8'));
  const normalized = normalizeJscpdReport(raw);
  const scoped = filterByChangedFiles(normalized.duplicates, existing);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ duplicates: scoped }, null, 2));

  console.log(`dup-scan: ${scoped.length} duplicate fragment(s) touching the changeset (report: ${OUT}).`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
