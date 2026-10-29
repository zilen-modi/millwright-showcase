// Pure parsing/identity logic for the ad-hoc /review-pr flow — no filesystem, no I/O,
// unit-testable with vitest. This is the ONLY thing that ever reaches a spawned
// command's argv (mirrors dashboard/server.mjs's KEY_RE strictness for ticket keys) —
// a strict, anchored match, never a loose substring extraction.

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;

/** Parse a GitHub PR URL into `{ owner, repo, number }`, or `null` if it doesn't match
 * the strict anchored shape. Deliberately rejects anything beyond the canonical PR
 * URL — a trailing `/files`, a `?diff=split` query, a non-github host, a non-numeric
 * PR number — rather than silently stripping/coercing it into something that matches. */
export function parsePrRef(input) {
  const match = PR_URL_RE.exec(String(input ?? '').trim());
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { owner, repo, number: Number(number) };
}

/** The `pr-reviews/<id>` directory name for a parsed ref. NOT reversible: owner and repo
 * may both contain `-`, so `acme-it-erp-erp-next-ui-monorepo-806` cannot be split back into
 * its parts. Anything needing the PR URL later (a retry) must persist the URL itself. */
export function prRefId({ owner, repo, number }) {
  return `${owner}-${repo}-${number}`;
}

/** The canonical PR URL rebuilt from parsed parts, so what reaches a spawned command's argv
 * is always this normalized form rather than the caller's raw string (trailing slash, stray
 * whitespace, or any other accepted-but-noncanonical input). */
export function prUrlFromRef({ owner, repo, number }) {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

/**
 * Recover the PR URL for a `pr-reviews/<ref>` directory that has no persisted `prUrl` —
 * i.e. a review from before the URL was written at spawn time, whose run died before the
 * skill wrote any status.
 *
 * `prRefId` is not reversible on its own, but it becomes decidable given candidate
 * `{owner, repo}` pairs (harvested from the reviews that DO have a URL): a pair matches only
 * when `<owner>-<repo>-` is an exact prefix and the remainder is all digits. Returns null on
 * no match, or when two different pairs both match — never a guess.
 */
export function recoverPrUrlFromRef(ref, knownPairs = []) {
  if (!Array.isArray(knownPairs)) return null; // guards `.map(fn)` handing us the element index
  const id = String(ref ?? '');
  const seen = new Map();
  for (const pair of knownPairs) {
    const owner = String(pair?.owner ?? '');
    const repo = String(pair?.repo ?? '');
    if (!owner || !repo) continue;
    const prefix = `${owner}-${repo}-`;
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    seen.set(`${owner}/${repo}/${rest}`, { owner, repo, number: Number(rest) });
  }
  if (seen.size !== 1) return null; // unknown, or ambiguous between two repos
  return prUrlFromRef([...seen.values()][0]);
}

/** The only results that mean the review actually finished its job (the shape pinned in
 * review-pr/SKILL.md). An ALLOWLIST rather than a denylist of failures, because `status.json`
 * is written by an LLM improvising from prose and its vocabulary drifts — an unrecognised
 * result must fall on the "offer a retry" side, never be mistaken for a completed review. */
const COMPLETED_RESULTS = new Set(['pushed-fix', 'report-only']);

/** Whether a PR review can be retried.
 *
 * Two cases matter beyond the obvious `failed`/`cancelled`/`blocked`:
 *  - no `result` at all — the run died before writing any status;
 *  - `result: "in-progress"` while nothing is running — a ZOMBIE. The skill stamps
 *    "in-progress" up front, so a run killed mid-flight leaves that behind permanently and
 *    the panel would show it as live forever with no way to act on it.
 *
 * `/review-pr` keeps no stage checkpoints, so a retry always restarts from scratch — there is
 * deliberately no "continue" counterpart to offer. */
export function isRetryableReview({ running, result } = {}) {
  if (running) return false;
  if (!result) return true;
  return !COMPLETED_RESULTS.has(String(result).trim().toLowerCase());
}

/** Case-insensitive comparison of a PR's author login against the authenticated
 * GitHub user's login (GitHub logins are case-insensitive for identity purposes).
 * Either side missing/empty is never "own" — an unresolved identity must never be
 * treated as a match by default. */
export function isOwnPr(myLogin, authorLogin) {
  const mine = String(myLogin ?? '').trim().toLowerCase();
  const theirs = String(authorLogin ?? '').trim().toLowerCase();
  if (!mine || !theirs) return false;
  return mine === theirs;
}
