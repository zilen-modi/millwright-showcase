// Pure decision logic for the SHIP GATE (GOALS.md A2 / docs/INTEGRATION-CONTRACTS.md §3) —
// no filesystem, no child processes, no HTTP — so it is unit-testable on its own
// (tests/ship-gate-lib.test.mjs), exactly as dashboard/lib.mjs splits the pricing logic out
// of dashboard/server.mjs.
//
// The problem it solves: until now the panel would happily spawn a PR-opening run for a
// ticket whose `rubricScore` was written into status.json by the model that was being
// scored. `tickets/<KEY>/rubric.jsonl` (written ONLY by scripts/loop.mjs, contract §1) is
// the receipt that binds a score to a tree, via the branch HEAD sha it scored. This module
// decides whether that receipt is good enough to let a PR be opened.
//
// FAIL CLOSED is the whole point: a missing file, an unparseable line, `sha: null`, a
// missing worktree or a failed `git rev-parse` are all *unverified*, and unverified is a
// rejection — never "assume fine".

/** Modes that RUN the review stage, and therefore WRITE the receipt via scripts/loop.mjs.
 * Gating these at spawn time is a deadlock: the run is refused for lacking the very artifact
 * it exists to produce, so a ticket could never earn its first receipt through the panel —
 * and the rejection told the operator to "run the review stage", which is exactly what they
 * had just clicked. Their shipping decision is made afterwards, by the orchestrator's
 * `--auto-ship` gate reading the receipt loop.mjs has by then written. */
export const RECEIPT_PRODUCING_MODES = new Set(['build', 'review', 'continue']);

/** Modes that jump straight to opening a PR without passing through REVIEW. `ship` is
 * `--from ship --yes`: it consumes a receipt it never produces, so it is the one path where
 * a spawn-time check is both meaningful and non-circular. `plan`/`replan` stop at the plan
 * gate and can never open a PR. */
export const PR_CAPABLE_MODES = new Set(['ship']);

/** The single, deliberately narrow escape hatch: only a manual `ship` may be overridden.
 * Every automated path (`build`/`review`/`continue`) ignores `override` entirely. */
export const OVERRIDABLE_MODES = new Set(['ship']);

export const requiresShipGate = (mode) => PR_CAPABLE_MODES.has(mode);

const short = (sha) => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : String(sha));

/** Parse the LAST non-blank line of a `rubric.jsonl` body (contract §1).
 * Returns `{ ok:true, receipt, lineCount }` or `{ ok:false, error }` — never throws. */
export function parseRubricReceipt(text) {
  if (typeof text !== 'string') return { ok: false, error: 'missing' };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'empty' };
  let receipt;
  try {
    receipt = JSON.parse(lines[lines.length - 1]);
  } catch {
    return { ok: false, error: 'unparseable' };
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, error: 'not-an-object' };
  }
  return { ok: true, receipt, lineCount: lines.length };
}

/**
 * Decide whether a run may be spawned. Pure: every input is already read by the caller.
 *
 * @param {object} input
 * @param {string} input.mode           run mode from POST /api/run
 * @param {string} input.key            ticket key (already KEY_RE-validated by the caller)
 * @param {string|null} input.rubricText  raw `tickets/<KEY>/rubric.jsonl` body; `null` = no file
 * @param {string|null} input.worktreePath  resolved worktree dir, or `null` if unresolvable
 * @param {boolean} input.worktreeExists    whether that dir exists
 * @param {string|null} input.headSha    stdout of `git -C <worktree> rev-parse HEAD`
 * @param {string|null} input.headShaError  why rev-parse failed (guard.mjs message); null = ok
 * @param {boolean} input.override      `override:true` from the POST body
 * @param {string|null} input.overrideReason  operator's free-text justification (never argv)
 * @returns {{gated:boolean, allowed:boolean, overridden:boolean, overrideIgnored:boolean,
 *           reason:string|null, failure:string|null, receipt:object|null, sha:string|null,
 *           headSha:string|null}}
 */
export function evaluateShipGate({
  mode,
  key,
  rubricText = null,
  worktreePath = null,
  worktreeExists = false,
  headSha = null,
  headShaError = null,
  override = false,
  overrideReason = null,
} = {}) {
  const k = key || '<unknown ticket>';
  const rubricPath = `tickets/${k}/rubric.jsonl`;

  if (!requiresShipGate(mode)) {
    return {
      gated: false, allowed: true, overridden: false, overrideIgnored: false,
      reason: null, failure: null, receipt: null, sha: null, headSha: null,
    };
  }

  // An override is only ever honoured for a manual `ship`. On any other mode it is
  // ignored (recorded, never obeyed) — an automated path can never grant itself one.
  const wantsOverride = override === true;
  const overrideHonoured = wantsOverride && OVERRIDABLE_MODES.has(mode);
  const overrideIgnored = wantsOverride && !overrideHonoured;

  const parsed = parseRubricReceipt(rubricText);
  const receipt = parsed.ok ? parsed.receipt : null;
  const sha = typeof receipt?.sha === 'string' && receipt.sha.trim() ? receipt.sha.trim() : null;

  const deny = (failure, reason) => ({
    gated: true,
    allowed: overrideHonoured,
    overridden: overrideHonoured,
    overrideIgnored,
    reason,
    failure,
    receipt,
    sha,
    headSha: typeof headSha === 'string' && headSha.trim() ? headSha.trim() : null,
    overrideReason: overrideHonoured ? (overrideReason || null) : null,
  });

  // 1 — the receipt must exist and parse.
  if (rubricText === null || rubricText === undefined) {
    return deny('no-receipt', `${k} has no scoring receipt: ${rubricPath} does not exist. `
      + `Only scripts/loop.mjs writes it, so this ticket has never been scored — run the review stage `
      + `(or re-run with mode "review") before any PR can be opened.`);
  }
  if (!parsed.ok) {
    const why = parsed.error === 'empty'
      ? 'the file is empty'
      : parsed.error === 'unparseable'
        ? 'its last line is not valid JSON'
        : 'its last line is not a JSON object';
    return deny('bad-receipt', `${k}'s scoring receipt is unreadable: ${why} (${rubricPath}). `
      + `Delete the corrupt line and re-run scoring — an unreadable receipt is treated as no receipt.`);
  }

  // 2 — the last round must have concluded `done`.
  if (receipt.action !== 'done') {
    const action = typeof receipt.action === 'string' && receipt.action ? receipt.action : '(absent)';
    const score = typeof receipt.score === 'number' ? receipt.score.toFixed(3) : 'unknown';
    return deny('not-done', `${k}'s last rubric round (round ${receipt.round ?? '?'}) ended with `
      + `action "${action}", not "done" — score ${score}. The ticket did not reach its rubric target, `
      + `so no PR may be opened; fix the findings and re-run review.`);
  }

  // 3 — the score must be bound to a tree.
  if (!sha) {
    const src = typeof receipt.shaSource === 'string' ? receipt.shaSource : 'unavailable';
    return deny('null-sha', `${k}'s rubric receipt carries no commit sha (shaSource "${src}"), so the `
      + `score is not bound to any tree and cannot be verified. Re-run scoring with the ticket's `
      + `worktree present so loop.mjs can resolve HEAD.`);
  }
  if (!worktreePath) {
    return deny('no-worktree-path', `${k} has no resolvable worktree (status.json lists no usable repo), `
      + `so the scored commit ${short(sha)} cannot be checked against a real HEAD. `
      + `Restore the worktree (scripts/worktree.mjs create) and re-run review.`);
  }
  if (!worktreeExists) {
    return deny('missing-worktree', `${k}'s worktree is missing at ${worktreePath}, so the scored commit `
      + `${short(sha)} cannot be verified against HEAD. Recreate it with `
      + `scripts/worktree.mjs create ${k} <repo> and re-run review before shipping.`);
  }
  if (headShaError) {
    return deny('rev-parse-failed', `${k}'s HEAD could not be read: git rev-parse HEAD failed in `
      + `${worktreePath} (${headShaError}). The scored commit ${short(sha)} is therefore UNVERIFIED, `
      + `which the ship gate treats as a failure — fix the worktree and retry.`);
  }
  const head = typeof headSha === 'string' ? headSha.trim() : '';
  if (!head) {
    return deny('rev-parse-empty', `${k}'s HEAD could not be read: git rev-parse HEAD returned nothing in `
      + `${worktreePath}. The scored commit ${short(sha)} is UNVERIFIED — fix the worktree and retry.`);
  }
  if (head !== sha) {
    return deny('sha-mismatch', `${k}'s score is stale: the rubric receipt scored commit ${short(sha)} but `
      + `${worktreePath} is now at ${short(head)}. Commits landed after scoring, so re-run review to score `
      + `the current HEAD before opening a PR.`);
  }

  const score = typeof receipt.score === 'number' ? receipt.score.toFixed(3) : 'unknown';
  return {
    gated: true,
    allowed: true,
    overridden: false,
    overrideIgnored,
    reason: `rubric round ${receipt.round ?? '?'} scored ${score} on ${short(sha)}, matching worktree HEAD.`,
    failure: null,
    receipt,
    sha,
    headSha: head,
    overrideReason: null,
  };
}

/** The `ship_gate_override` line appended to `tickets/<KEY>/events.jsonl` on every honoured
 * override (contract §3). `event` is deliberately NOT `stage_end`, so schemas.parseEventLine
 * skips it and the cost aggregate is untouched — this is an audit record, not a priced stage. */
export function overrideEvent({ key, mode, decision, at = new Date().toISOString(), operatorReason = null }) {
  return {
    event: 'ship_gate_override',
    key,
    mode,
    at,
    failure: decision?.failure || 'unknown',
    reason: decision?.reason || 'ship gate bypassed',
    operatorReason: typeof operatorReason === 'string' && operatorReason.trim()
      ? operatorReason.trim().slice(0, 500)
      : null,
    rubricSha: decision?.sha || null,
    headSha: decision?.headSha || null,
  };
}

// ---- human-signed ship exception -------------------------------------------------------
// Why this exists: `override` only lifts the PANEL's spawn-time check. The orchestrator
// applies the same rule again from the other side (SKILL.md: `done` is the only state that
// authorises SHIP), so an overridden run used to start, refuse, and exit "successfully" —
// the operator clicked a button called "override ship" and watched nothing ship.
//
// An override now leaves evidence the orchestrator can verify: a human accepted THESE
// findings on THIS tree. It is not a way to pretend the score passed. The receipt still
// says what it said; the exception says a person read it and took responsibility.

/** File the panel writes (and only the panel writes) beside the receipt. */
export const SHIP_EXCEPTION_FILE = 'ship-exception.json';

/**
 * Build the exception record for an honoured override. Bound to the worktree HEAD sha, so it
 * authorises exactly the tree the operator was looking at and expires the moment work moves on.
 */
export function shipExceptionRecord({
  key,
  mode,
  decision,
  operatorReason = null,
  at = new Date().toISOString(),
}) {
  return {
    kind: 'ship-exception',
    key,
    mode,
    at,
    // The tree this authorises. No sha → the exception is unusable, which is correct:
    // an exception that names no tree could authorise anything later.
    headSha: decision?.headSha || null,
    rubricSha: decision?.sha || null,
    acceptedFailure: decision?.failure || 'unknown',
    gateReason: decision?.reason || null,
    operatorReason: typeof operatorReason === 'string' && operatorReason.trim()
      ? operatorReason.trim().slice(0, 500)
      : null,
  };
}

/**
 * Decide whether an exception authorises shipping the tree currently checked out. Pure, and
 * fails closed on every ambiguity: unreadable, wrong kind, wrong ticket, no sha, or a sha that
 * does not match HEAD. A stale exception must never carry over to later commits.
 *
 * @returns {{valid:boolean, reason:string, record:object|null}}
 */
export function evaluateShipException({ exceptionText = null, key = null, headSha = null } = {}) {
  const no = (reason) => ({ valid: false, reason, record: null });
  if (exceptionText === null || exceptionText === undefined) return no('no exception on file');

  let record;
  try {
    record = JSON.parse(exceptionText);
  } catch {
    return no('exception file is not valid JSON');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return no('exception file is not a JSON object');
  }
  if (record.kind !== 'ship-exception') return no(`unexpected kind "${record.kind}"`);
  if (key && record.key !== key) return no(`exception names ${record.key}, not ${key}`);

  const signed = typeof record.headSha === 'string' ? record.headSha.trim() : '';
  const head = typeof headSha === 'string' ? headSha.trim() : '';
  if (!signed) return no('exception names no commit, so it authorises no tree');
  if (!head) return no('current HEAD is unknown, so the exception cannot be matched to it');
  if (signed !== head) {
    return no(`exception was signed for ${short(signed)} but HEAD is ${short(head)} — `
      + 'the tree moved since it was granted, so it no longer applies');
  }
  return { valid: true, reason: `human-signed for ${short(head)}`, record };
}

// ---- budget gate --------------------------------------------------------------------------
// `config.loop.budgetUsdPerTicket` was only ever consulted inside the repair loop, at the
// moment REVIEW scored — so it could stop the loop from spending more, but nothing stopped a
// fresh run from starting on a ticket that had already blown its cap. PROJ-3107 reached
// $11.39 against a $5 cap that way, one operator click at a time.
//
// This is deliberately an ACKNOWLEDGEMENT, not a refusal: the operator may well have a good
// reason to keep going, and the system must not strand work it has already paid for. What it
// must not do is spend silently.

/** Modes worth checking. `ship` opens a PR on work already done and is cheap by comparison. */
const BUDGETED_MODES = new Set(['plan', 'replan', 'build', 'review', 'continue']);

export const requiresBudgetCheck = (mode) => BUDGETED_MODES.has(mode);

/**
 * Should this run be held for acknowledgement on cost?
 *
 * @param {object} input
 * @param {string} input.mode
 * @param {string} input.key
 * @param {number|null} input.spentUsd  the ticket's accumulated spend
 * @param {number|null} input.capUsd    `loop.budgetUsdPerTicket`, or null when unset
 * @param {boolean} input.acknowledged  operator has seen the number and wants to proceed
 * @returns {{gated:boolean, allowed:boolean, over:boolean, reason:string|null,
 *            spentUsd:number|null, capUsd:number|null, ratio:number|null}}
 */
export function evaluateBudgetGate({
  mode,
  key,
  spentUsd = null,
  capUsd = null,
  acknowledged = false,
} = {}) {
  const pass = (over = false, reason = null, ratio = null) => ({
    gated: false, allowed: true, over, reason, spentUsd, capUsd, ratio,
  });

  if (!requiresBudgetCheck(mode)) return pass();
  // No cap configured, or nothing spent yet — nothing to say.
  if (!capUsd || capUsd <= 0) return pass();
  if (typeof spentUsd !== 'number' || !Number.isFinite(spentUsd)) return pass();

  const ratio = spentUsd / capUsd;
  if (spentUsd < capUsd) return pass(false, null, ratio);

  const reason =
    `${key} has already spent $${spentUsd.toFixed(2)} against its $${capUsd.toFixed(2)} cap `
    + `(${Math.round(ratio * 100)}%). Each run adds to that. Re-send with acknowledgeBudget:true `
    + 'to continue anyway, or fix the findings by hand.';

  return acknowledged
    ? { gated: true, allowed: true, over: true, reason, spentUsd, capUsd, ratio }
    : { gated: true, allowed: false, over: true, reason, spentUsd, capUsd, ratio };
}
