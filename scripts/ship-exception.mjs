#!/usr/bin/env node
// Does a human-signed ship exception authorise the tree that is checked out RIGHT NOW?
//
// The orchestrator must not decide this by reading the file and reasoning about it — that is the
// same mistake as trusting a model-written score. The check is mechanical and it fails closed:
//
//   node scripts/ship-exception.mjs PROJ-3109        # exit 0 = authorised, 1 = not
//   node scripts/ship-exception.mjs PROJ-3109 --json
//
// An exception is bound to a commit. The moment the branch moves, it stops applying — so a
// rebase, an extra fix, or an amended commit all revoke it automatically.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateShipException, SHIP_EXCEPTION_FILE } from '../dashboard/ship-gate-lib.mjs';
import { guardExec } from './guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TICKETS = join(ROOT, 'tickets');
const KEY_RE = /^PROJ-\d+$/;

const readTextSafe = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const readJsonSafe = (path) => {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Same resolution the panel uses (dashboard/server.mjs resolveWorktree) — one convention. */
const resolveWorktree = (key) => {
  const status = readJsonSafe(join(TICKETS, key, 'status.json'));
  const repos = (Array.isArray(status?.repos) ? status.repos : []).filter(
    (r) => typeof r === 'string' && /^[a-z0-9-]+$/i.test(r),
  );
  const cfgDir = readJsonSafe(join(ROOT, 'config', 'config.json'))?.worktreeDir;
  const wtRoot = resolve(ROOT, typeof cfgDir === 'string' && cfgDir.trim() ? cfgDir : '../.wt');
  for (const repo of repos) {
    const path = join(wtRoot, `${key}-${repo}`);
    if (existsSync(path)) return { path, exists: true };
  }
  return { path: repos.length ? join(wtRoot, `${key}-${repos[0]}`) : null, exists: false };
};

const headSha = async (worktree) => {
  // retries: 0 — a broken worktree is deterministic, so retrying only delays the answer.
  const r = await guardExec('ship-exception rev-parse', 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {
    source: 'git rev-parse HEAD',
    retries: 0,
    timeoutMs: 10000,
  });
  if (!r.ok) {
    return { sha: null, error: `${r.kind}: ${String(r.message || '').split('\n')[0].slice(0, 200)}` };
  }
  return { sha: String(r.value?.stdout ?? '').trim(), error: null };
};

const key = process.argv[2];
const asJson = process.argv.includes('--json');

const finish = ({ authorised, reason, record = null }) => {
  if (asJson) {
    console.log(JSON.stringify({ key, authorised, reason, record }, null, 2));
  } else {
    console.log(`${authorised ? 'AUTHORISED' : 'NOT AUTHORISED'} — ${reason}`);
    if (authorised && record) {
      console.log(`  accepted failure : ${record.acceptedFailure}`);
      console.log(`  operator reason  : ${record.operatorReason ?? '(none given)'}`);
      console.log(`  granted at       : ${record.at}`);
      console.log('  authorises opening a PR for this commit only — never a merge.');
    }
  }
  process.exit(authorised ? 0 : 1);
};

if (!key || !KEY_RE.test(key)) {
  finish({ authorised: false, reason: 'usage: node scripts/ship-exception.mjs PROJ-1234 [--json]' });
}

const wt = resolveWorktree(key);
if (!wt.exists) {
  // No tree means nothing to authorise. Fail closed rather than trusting the file alone.
  finish({
    authorised: false,
    reason: `no worktree for ${key}${wt.path ? ` at ${wt.path}` : ''}, so no commit to match against`,
  });
}

const head = await headSha(wt.path);
if (!head.sha) {
  finish({ authorised: false, reason: `could not read HEAD in ${wt.path}: ${head.error}` });
}

const verdict = evaluateShipException({
  exceptionText: readTextSafe(join(TICKETS, key, SHIP_EXCEPTION_FILE)),
  key,
  headSha: head.sha,
});

finish({ authorised: verdict.valid, reason: verdict.reason, record: verdict.record });
