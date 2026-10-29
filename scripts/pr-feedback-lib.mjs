// Pure triage logic for the PR/QA feedback loop, extracted for unit testing. Turns a
// shipped PR from one-shot into an iterating collaborator: when a human/QA leaves
// review comments or files a sub-bug, this decides which of them are ACTIONABLE (need a
// code change), which are QUESTIONS (need a reply, not a fix), and which are just
// INFO/praise/FYI — then merges the actionable ones into a single ordered worklist.
//
// This module never fetches anything and never replies to anyone — see pr-feedback.mjs
// for the IO wrapper and PR-FEEDBACK.md for how the repair loop around it is gated.

const CODE_SUGGESTION_RE = /```suggestion|```diff/i;

// Phrases that signal "this needs a change", wherever they appear in the comment.
const ACTIONABLE_PHRASE_RE =
  /\b(please|should|must|needs? to|need to|could you|can you|make sure|required?|missing|doesn'?t handle|does not handle|not handled|fix this|change this|instead of|rather than|rename|refactor|extract)\b/i;

// Imperative-mood comments that open with a bare instruction ("Add a null check.").
const IMPERATIVE_START_RE =
  /^(please\s+)?(add|remove|rename|update|fix|change|refactor|move|extract|use|avoid|handle|guard|validate|revert|split|inline|simplify|consider|drop)\b/i;

const QUESTION_RE = /\?\s*$/;

/** Classify a single comment body into 'actionable' | 'question' | 'info'. Order
 * matters: a change-request phrase wins even if the sentence also ends in "?" (e.g.
 * "Should this handle nulls?" is a change request, not an open question). */
function classifyComment(body) {
  const text = String(body ?? '').trim();
  if (!text) return 'info';
  if (CODE_SUGGESTION_RE.test(text) || ACTIONABLE_PHRASE_RE.test(text) || IMPERATIVE_START_RE.test(text)) {
    return 'actionable';
  }
  if (QUESTION_RE.test(text)) return 'question';
  return 'info';
}

/** Triage an array of PR review threads/comments
 * `[{path, line, body, author, state, resolved}]` into `{actionable, info, questions}`.
 * Resolved threads are skipped entirely (already addressed). path/line are carried
 * through onto every bucketed item when present on the source thread. */
export function triageThreads(reviewThreads = []) {
  const actionable = [];
  const info = [];
  const questions = [];

  for (const thread of reviewThreads) {
    if (!thread || thread.resolved) continue;
    const body = String(thread.body ?? '').trim();
    if (!body) continue;

    const item = {
      ...(thread.path ? { path: thread.path } : {}),
      ...(thread.line != null ? { line: thread.line } : {}),
      ask: body,
      source: 'pr-review',
      ...(thread.author ? { author: thread.author } : {}),
    };

    const kind = classifyComment(body);
    if (kind === 'actionable') actionable.push(item);
    else if (kind === 'question') questions.push(item);
    else info.push(item);
  }

  return { actionable, info, questions };
}

/** Triage Jira sub-bugs `[{key, summary, description, status}]` (already fetched by the
 * orchestrator — Jira is MCP-only, not reachable from this CLI) into actionable items
 * `[{key, ask, source:'sub-bug'}]`. Anything already Done is skipped. */
export function triageSubBugs(subBugs = []) {
  const actionable = [];

  for (const bug of subBugs) {
    if (!bug) continue;
    const status = String(bug.status ?? '').trim().toLowerCase();
    if (status === 'done') continue;

    const summary = String(bug.summary ?? '').trim();
    const description = String(bug.description ?? '').trim();
    const ask = description && description !== summary ? `${summary} — ${description}` : summary;
    if (!ask) continue;

    actionable.push({ key: bug.key, ask, source: 'sub-bug' });
  }

  return actionable;
}

/** How specific an actionable item's location is — used both to break dedupe ties (keep
 * the more specific copy) and to order the merged worklist most-specific first. */
function specificity(item) {
  if (item.path && item.line != null) return 2;
  if (item.path) return 1;
  return 0;
}

function normalizeAsk(ask) {
  return String(ask ?? '').trim().toLowerCase();
}

/** Two actionable items are "the same feedback" if they anchor to the same path+line,
 * or if their ask text matches once normalized — regardless of source (a QA sub-bug can
 * restate exactly what a PR review comment already said). */
function isSameItem(a, b) {
  if (a.path && b.path && a.line != null && b.line != null && a.path === b.path && a.line === b.line) return true;
  const askA = normalizeAsk(a.ask);
  const askB = normalizeAsk(b.ask);
  return Boolean(askA) && askA === askB;
}

/** Merge the actionable output of `triageThreads` and `triageSubBugs` into a single
 * ordered worklist: dedupe items that describe the same feedback (same path+line, or
 * same ask text), keeping the more specific copy, then order most-specific first
 * (has path+line > has path only > text-only). */
export function mergeWorklist(prTriage, bugTriage) {
  const prActionable = Array.isArray(prTriage) ? prTriage : prTriage?.actionable ?? [];
  const bugActionable = Array.isArray(bugTriage) ? bugTriage : bugTriage?.actionable ?? [];

  const merged = [];
  for (const item of [...prActionable, ...bugActionable]) {
    const dupIndex = merged.findIndex((existing) => isSameItem(existing, item));
    if (dupIndex === -1) {
      merged.push(item);
    } else if (specificity(item) > specificity(merged[dupIndex])) {
      merged[dupIndex] = item;
    }
  }

  return merged
    .map((item, order) => ({ item, order, rank: specificity(item) }))
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .map(({ item }) => item);
}
