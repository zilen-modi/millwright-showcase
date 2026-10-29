#!/usr/bin/env node
// Autopilot worktree lifecycle via simple-git (programmatic, cross-platform, testable).
// The network fetch is routed through withGuard (guard.mjs) so a fetch failure is
// classified and acknowledged with a structured message instead of a silent fallback —
// the retry/backoff behavior that used to live here directly is now folded into
// withGuard. Isolates each repo's BUILD so primary checkouts are never touched and
// parallel repos never collide. Replaces the old worktree.sh.
//
//   node scripts/worktree.mjs create   <KEY> <repoId> [baseBranch] [branchName]
//   node scripts/worktree.mjs remove   <KEY> <repoId>
//   node scripts/worktree.mjs list     <repoId>
//   node scripts/worktree.mjs checkout <repoId> <prNumber>
//
// Worktrees live under acme/.wt/<KEY>-<repoId> (ticket-shaped) or
// acme/.wt/pr-<repoId>-<prNumber> (ad-hoc PR review — no ticket KEY applies, hence the
// different, irregular positional signature for `checkout`; don't force a uniform shape
// across a ticket-shaped and a PR-shaped operation). The branch name should follow the
// team convention `{type}/PROJ-{number}-{short-desc}` (e.g. fix/PROJ-2996-tag-iconleft-control)
// and be passed as the 5th arg; if omitted it falls back to the bare `<KEY>` (never `millwright/…`).
// Get the name right at creation — renaming a branch that already has an open PR closes the PR.
//
// `checkout` is intentionally NON-destructive, unlike `create`'s `-B` (force-create/reset a
// branch from base): it detaches onto HEAD, then `gh pr checkout <n>` inside the new
// worktree fetches and tracks the PR's actual head branch (transparently handling forks)
// without touching its tip. `create`'s `-B` would blow away an existing PR's real commits
// if pointed at an already-open PR's branch — that's why /review-pr uses this instead.
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { simpleGit } from 'simple-git';

import { withGuard, guardExec, acknowledgeOrThrow } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // acme/
const [cmd, a2, a3, base = 'dev', branchArg] = process.argv.slice(2);

const usage = () => {
  console.error(
    'usage: worktree.mjs create <KEY> <repoId> [baseBranch] [branchName]\n' +
      '       worktree.mjs remove <KEY> <repoId>\n' +
      '       worktree.mjs list <repoId>\n' +
      '       worktree.mjs checkout <repoId> <prNumber>',
  );
  process.exit(1);
};

async function main() {
  if (cmd === 'list') {
    if (!a2) usage();
    const out = await simpleGit(join(WORKSPACE, a2)).raw('worktree', 'list');
    process.stdout.write(out);
    return;
  }
  if (cmd === 'checkout') {
    if (!a2 || !a3) usage();
    const repo = a2;
    const prNumber = a3;
    const repoPath = join(WORKSPACE, repo);
    if (!existsSync(join(repoPath, '.git'))) {
      console.error(`not a git repo: ${repoPath}`);
      process.exit(1);
    }
    const wtDir = join(WORKSPACE, '.wt', `pr-${repo}-${prNumber}`);
    mkdirSync(join(WORKSPACE, '.wt'), { recursive: true });
    await simpleGit(repoPath).raw('worktree', 'add', '--detach', wtDir, 'HEAD');
    const co = await guardExec('worktree gh pr checkout', 'gh', ['pr', 'checkout', String(prNumber)], {
      cwd: wtDir,
    });
    acknowledgeOrThrow(co);
    console.log(`worktree ready: ${wtDir}  (PR #${prNumber} checked out via gh)`);
    return;
  }
  if (!a2 || !a3) usage();
  const key = a2;
  const repo = a3;
  const repoPath = join(WORKSPACE, repo);
  const wtDir = join(WORKSPACE, '.wt', `${key}-${repo}`);
  // Prefer the caller-supplied conventional name `{type}/PROJ-{n}-{desc}`;
  // fall back to the bare `<KEY>` only if none is given (never an `millwright/…` prefix — it
  // must not appear in the PR's source branch; prefer the explicit `{type}/<KEY>-<desc>` name).
  const branch = branchArg || key;
  if (!existsSync(join(repoPath, '.git'))) {
    console.error(`not a git repo: ${repoPath}`);
    process.exit(1);
  }
  const git = simpleGit(repoPath);

  if (cmd === 'create') {
    // network op → guarded fetch (timeout + retry only for retryable kinds, per
    // guard-lib's classification). Same degrade-and-continue behavior as before: a
    // failed fetch is acknowledged (structured, classified message) rather than
    // silently swallowed, but we still fall back to the local base so worktree
    // creation isn't blocked on network flakiness.
    const fetchResult = await withGuard('worktree fetch', () => git.fetch('origin', base), {
      source: `git fetch origin ${base}`,
      retries: 3,
    });
    if (!fetchResult.ok) {
      console.warn(acknowledgement(fetchResult));
      console.warn('fetch failed; using local base');
    }

    mkdirSync(join(WORKSPACE, '.wt'), { recursive: true });
    const branches = await git.branch(['-a']);
    const hasRemote = branches.all.includes(`remotes/origin/${base}`);
    await git.raw('worktree', 'add', '-B', branch, wtDir, hasRemote ? `origin/${base}` : base);
    console.log(`worktree ready: ${wtDir}  (branch: ${branch}, base: ${base})`);
  } else if (cmd === 'remove') {
    await git.raw('worktree', 'remove', '--force', wtDir);
    console.log(`removed ${wtDir} (branch kept)`);
  } else {
    usage();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
