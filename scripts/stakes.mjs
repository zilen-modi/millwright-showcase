#!/usr/bin/env node
// Autopilot STAKES gate — deterministic "does this need a human before it ships?" check.
// Run after ROUTE/PLAN (files known) and again on the built diff. Pure classification
// logic lives in stakes-lib.mjs (unit-tested); this file only does IO: reads a patch or
// file list, prints the verdict, and exits non-zero when it requires escalation so the
// caller (SKILL/orchestrator) halts instead of shipping past it.
//
// Usage:
//   node scripts/stakes.mjs --diff <patch-file>
//   node scripts/stakes.mjs --files "a/b/Foo.tsx,a/b/Foo.module.scss"
//
// Prints the verdict + reasons and a JSON result on the last line. Exits 1 when
// requiresEscalation is true, 0 otherwise (2 on bad usage).
import { readFileSync } from 'node:fs';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { classifyStakes, summarizeStakes } from './stakes-lib.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** Parse a unix `git diff` patch into `{files, addedLines}` — just enough for the
 * classifier: which files changed, and the content of every `+` line (headers excluded). */
function parseDiffForStakes(patchText) {
  const files = [];
  const addedLines = [];
  const addFile = (f) => {
    if (f && f !== '/dev/null' && !files.includes(f)) files.push(f);
  };
  for (const line of (patchText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) addFile(m[2]);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      addFile(path.startsWith('b/') ? path.slice(2) : path);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) addedLines.push(line.slice(1));
  }
  return { files, addedLines };
}

async function main() {
  const DIFF_PATH = arg('diff');
  const FILES_ARG = arg('files');

  if (!DIFF_PATH && !FILES_ARG) {
    console.error('stakes: one of --diff <patch-file> or --files a,b,c is required');
    process.exit(2);
  }

  let input;
  if (DIFF_PATH) {
    const result = await withGuard('stakes diff read', () => readFileSync(DIFF_PATH, 'utf8'), {
      source: DIFF_PATH,
      retries: 0,
      timeoutMs: 5000,
    });
    const patch = acknowledgeOrThrow(result);
    input = parseDiffForStakes(patch);
  } else {
    input = { files: FILES_ARG.split(',').map((s) => s.trim()).filter(Boolean), addedLines: [] };
  }

  const verdict = classifyStakes(input);

  console.log(`\nStakes — ${summarizeStakes(verdict)}`);
  if (verdict.reasons.length) {
    for (const r of verdict.reasons) console.log(`  - [${r.code}] ${r.detail}`);
  } else {
    console.log('  - no risk signals');
  }
  console.log(
    verdict.requiresEscalation
      ? '\n⛔ HIGH STAKES — do not auto-ship. Escalate for human sign-off (see scripts/escalation-lib.mjs).'
      : '\n✓ clear to proceed.',
  );
  console.log(JSON.stringify(verdict));
  process.exit(verdict.requiresEscalation ? 1 : 0);
}

main();
