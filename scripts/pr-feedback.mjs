#!/usr/bin/env node
// Autopilot PR/QA FEEDBACK triage — turns a shipped PR from one-shot into an iterating
// collaborator. Reads a PR's review threads/comments (via `gh pr view`) plus, if given,
// Jira sub-bugs the orchestrator already fetched (Jira is MCP-only, not reachable from
// this CLI), triages both into a single ordered worklist, and prints/emits it.
//
// This script only READS + TRIAGES. It does NOT repair code, push, or reply to anyone —
// those are orchestrated + gated by the SKILL for each worklist item: repair via
// coder-agent, VERIFY, push a fix commit, then reply on the PR/Jira. See PR-FEEDBACK.md.
//
// Usage:
//   node scripts/pr-feedback.mjs --pr 123
//   node scripts/pr-feedback.mjs --pr https://github.com/org/repo/pull/123 \
//     --repo-cwd "/path/to/repo" --jira-items sub-bugs.json
//
// sub-bugs.json: [{ key, summary, description, status }]
//
// Prints a readable worklist and emits a JSON summary on the last line. Exits non-zero
// (acknowledged, per guard.mjs) if the `gh pr view` fetch fails; exits 0 with
// "no actionable feedback" when the merged worklist is empty.

import { readFileSync } from 'node:fs';

import { acknowledgeOrThrow, guardExec } from './guard.mjs';
import { mergeWorklist, triageSubBugs, triageThreads } from './pr-feedback-lib.mjs';

const DEFAULT_REPO_CWD = '~/workspace/erp-next-ui-monorepo';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PR = arg('pr');
if (!PR) {
  console.error('pr-feedback: --pr <number|url> is required');
  process.exit(2);
}
const REPO_CWD = arg('repo-cwd', DEFAULT_REPO_CWD);
const JIRA_ITEMS_PATH = arg('jira-items');

/** `gh --json` output backs GraphQL connections, which sometimes serialize as a plain
 * array, sometimes as `{nodes:[...]}`, sometimes as `{edges:[{node}]}` — normalize all
 * three to a plain array. */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.edges)) return value.edges.map((e) => e.node ?? e);
  return [];
}

/** Flatten `gh pr view --json reviewThreads,comments,reviews` into the flat
 * `{path, line, body, author, state, resolved}` shape `triageThreads` expects: one entry
 * per file-anchored review thread (using its most recent comment), plus one entry per
 * general PR conversation comment and per review body (neither has a path/line). */
function normalizeThreads(ghJson) {
  const items = [];

  for (const thread of asList(ghJson.reviewThreads)) {
    const comments = asList(thread.comments);
    const last = comments[comments.length - 1] ?? {};
    items.push({
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? undefined,
      body: last.body ?? thread.body ?? '',
      author: last.author?.login ?? last.author ?? thread.author?.login ?? thread.author,
      resolved: Boolean(thread.isResolved ?? thread.resolved),
    });
  }

  for (const comment of asList(ghJson.comments)) {
    items.push({
      body: comment.body,
      author: comment.author?.login ?? comment.author,
      resolved: false,
    });
  }

  for (const review of asList(ghJson.reviews)) {
    if (!review.body) continue; // approvals/requests-changes with no written comment
    items.push({
      body: review.body,
      author: review.author?.login ?? review.author,
      state: review.state,
      resolved: false,
    });
  }

  return items;
}

function loadJiraItems(path) {
  if (!path) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) {
      console.error(`pr-feedback: --jira-items ${path} must contain a JSON array`);
      process.exit(2);
    }
    return raw;
  } catch (e) {
    console.error(`pr-feedback: could not read --jira-items ${path}: ${e.message}`);
    process.exit(2);
  }
}

async function main() {
  const fetched = await guardExec(
    'pr-feedback',
    'gh',
    ['pr', 'view', PR, '--json', 'reviews,comments,reviewThreads,state'],
    { cwd: REPO_CWD },
  );
  const proc = acknowledgeOrThrow(fetched); // BLOCKED + exit non-zero on a failed gh fetch

  let ghJson;
  try {
    ghJson = JSON.parse(proc.stdout);
  } catch (e) {
    console.error(`pr-feedback: could not parse \`gh pr view\` output as JSON: ${e.message}`);
    process.exit(2);
  }

  const jiraSubBugs = loadJiraItems(JIRA_ITEMS_PATH);

  const prTriage = triageThreads(normalizeThreads(ghJson));
  const bugTriage = triageSubBugs(jiraSubBugs);
  const worklist = mergeWorklist(prTriage, bugTriage);

  const report = {
    pr: PR,
    prState: ghJson.state,
    counts: {
      actionable: worklist.length,
      prActionable: prTriage.actionable.length,
      subBugActionable: bugTriage.length,
      questions: prTriage.questions.length,
      info: prTriage.info.length,
    },
    worklist,
    questions: prTriage.questions,
  };

  if (worklist.length === 0) {
    console.log(`pr-feedback: no actionable feedback on PR ${PR} — nothing to repair.`);
    console.log('\n' + JSON.stringify(report));
    return;
  }

  console.log(`PR feedback worklist — ${PR} (${worklist.length} actionable item(s)):\n`);
  worklist.forEach((item, i) => {
    const where = item.path ? `${item.path}${item.line != null ? `:${item.line}` : ''}` : item.key ?? '(general)';
    console.log(`${i + 1}. [${item.source}] ${where}`);
    console.log(`   ${item.ask}`);
  });

  if (prTriage.questions.length) {
    console.log(`\n${prTriage.questions.length} open question(s) — reply, don't just fix:`);
    prTriage.questions.forEach((q) => console.log(`  - ${q.path ? `${q.path}: ` : ''}${q.ask}`));
  }

  console.log('\n' + JSON.stringify(report));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
