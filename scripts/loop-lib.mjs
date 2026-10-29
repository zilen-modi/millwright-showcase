// Pure control-plane logic for the repair loop — budget tracking, stall detection, the
// stop/continue decision, and (Goal A1) the shape of the scoring receipt loop.mjs writes
// — no filesystem, no I/O, unit-testable with vitest. loop.mjs does the IO (reading
// events/rubric-inputs/design.md, resolving the worktree sha, appending rubric.jsonl,
// patching status.json) and calls these.

/** Budget bookkeeping for one ticket's repair loop.
 *
 * A missing, null or non-positive cap means NO CAP - matching how the rest of the system
 * already reads `loop.budgetUsdPerTicket` (`evaluateBudgetGate`, `dashboard/lib.mjs`). This
 * used to coerce with `Number(capUsd) || 0`, which turned "no cap" into a cap of zero and
 * made `spent >= cap` true on the first cent: unsetting the cap would have stopped every
 * ticket instantly instead of letting them run. */
export function budgetState(spentUsd, capUsd) {
  const spent = Number(spentUsd) || 0;
  const cap = Number(capUsd);
  const capped = Number.isFinite(cap) && cap > 0;
  return {
    spentUsd: spent,
    capUsd: capped ? cap : null,
    remaining: capped ? cap - spent : null,
    exhausted: capped ? spent >= cap : false,
  };
}

/** Detect a stalled repair loop: `roundsWithoutImprovement` is the trailing streak of
 * rounds that failed to beat the best score seen so far (strict improvement only —
 * a tie does not reset the streak). Stalled once that streak reaches `stallRounds`,
 * i.e. the last `stallRounds` scores showed no strict improvement over the best-so-far
 * before them. */
export function stallDetector(scoreHistory, stallRounds) {
  const history = Array.isArray(scoreHistory) ? scoreHistory : [];
  let bestSoFar = -Infinity;
  let roundsWithoutImprovement = 0;
  for (const s of history) {
    if (s > bestSoFar) {
      bestSoFar = s;
      roundsWithoutImprovement = 0;
    } else {
      roundsWithoutImprovement++;
    }
  }
  return { stalled: roundsWithoutImprovement >= stallRounds, roundsWithoutImprovement };
}

/** Dimensions that have provably stopped moving: present in the last `stallRounds`
 * breakdowns and never once improved across them. Needs real history, so it cannot fire on
 * an early round, and it reads the scores the pipeline actually recorded - a dimension
 * cannot fake having improved.
 *
 * This is a PRECONDITION for setting a dimension aside, never a licence on its own. "Has
 * not moved" and "cannot move" are different claims, and only the second earns a drop: on
 * PROJ-3645 both visualDiff and a11y had sat at 0 for three rounds, but the thumbnail was
 * a ruled deferral while the 4 a11y failures were simply unfixed. Dropping a dimension for
 * flatlining would have forgiven exactly the one that most needed the work.
 *
 * `breakdownHistory` is one `{dim: sub}` object per scored round, oldest first. */
export function pinnedDimensions(breakdownHistory, stallRounds) {
  const rounds = Array.isArray(breakdownHistory) ? breakdownHistory.filter((b) => b && typeof b === 'object') : [];
  const need = Math.max(2, Number(stallRounds) || 0);
  if (rounds.length < need) return [];

  const window = rounds.slice(-need);
  const names = Object.keys(window[0]).filter((d) => window.every((b) => typeof b[d] === 'number'));
  // Pinned = never improved AND still imperfect. A dimension sitting at 1.0 is finished,
  // not stuck, and must never be dropped from the arithmetic.
  return names.filter((d) => {
    const subs = window.map((b) => b[d]);
    return subs[subs.length - 1] < 1 && subs.every((v) => v <= subs[0]);
  });
}

/** What the ticket scores once the pinned dimensions are set aside - their weight dropped
 * and the rest renormalized, exactly as an exclusion is handled.
 *
 * This is the honest way to ask "is this as good as this ticket can get?". The raw score
 * keeps the pinned dimension's zero, so it can sit permanently below target with no amount
 * of repair moving it - PROJ-3645 held visualDiff at 0 across three rounds on a deferred
 * product thumbnail, and at weight 0.30 that put the 0.9 target out of reach from round 1.
 * The loop spent $23 climbing at a bar arithmetic had already ruled out.
 *
 * Returns null when nothing is pinned, or when the pinned set is everything. */
export function reachableScore({ breakdown, weights, pinned }) {
  const subs = breakdown && typeof breakdown === 'object' ? breakdown : null;
  const w = weights && typeof weights === 'object' ? weights : null;
  const drop = new Set(Array.isArray(pinned) ? pinned : []);
  if (!subs || !w || drop.size === 0) return null;

  const kept = Object.keys(subs).filter((d) => !drop.has(d) && Number.isFinite(Number(w[d])));
  const total = kept.reduce((sum, d) => sum + Number(w[d]), 0);
  if (!kept.length || total <= 0) return null;

  const score = kept.reduce((sum, d) => sum + (Number(subs[d]) || 0) * Number(w[d]), 0) / total;
  return { score, kept, dropped: [...drop], droppedWeight: 1 - total };
}

/** The repair loop's single stop/continue decision. Precedence: done (target reached)
 * > stop-budget > stop-rounds > stop-stall > continue. Every stop-* is an ESCALATION —
 * the orchestrator hands the ticket back to a human — so `reason` is always a clear,
 * human-readable sentence. */
export function loopDecision({
  score, target, round, maxRounds, spentUsd, budgetUsd, scoreHistory, stallRounds, unmeasured,
  breakdown, weights, breakdownHistory, deferrals,
}) {
  // An unmeasured dimension means a check could not RUN (no worktree, no linter, no
  // browser) — an infrastructure failure, not a property of the diff. It is removed from
  // the arithmetic, so leaving it here would let the surviving dimensions carry a whole
  // ticket to a clean pass: PROJ-3016 scored 1.000 on three of five. A verdict built on
  // checks that never executed is not a verdict, so this outranks even the budget and
  // round caps — fix the infrastructure, then score.
  const missing = Array.isArray(unmeasured) ? unmeasured.filter(Boolean) : [];
  if (missing.length > 0) {
    return {
      action: 'stop-unverified',
      reason:
        `ESCALATION: ${missing.length} rubric dimension(s) could not be measured (${missing.join(', ')}) — ` +
        `score ${score.toFixed(2)} rests only on the checks that did run. Restore the missing check(s) and re-score; ` +
        'an unmeasured dimension cannot be passed, only fixed. Needs a human.',
    };
  }

  if (score >= target) {
    return { action: 'done', reason: `Rubric target reached: score ${score.toFixed(2)} >= target ${target}.` };
  }

  // A dimension can be set aside only when BOTH are true: a human ruled it deferred for this
  // ticket (`deferrals`), and it demonstrably never moved (`pinnedDimensions`). The
  // declaration supplies the reason the score cannot improve; the history stops a deferral
  // being claimed over a dimension that is still in play. Neither half is sufficient - a
  // declaration alone is a self-issued discount, and flatlining alone forgives work nobody
  // did. Everything left in the arithmetic is still held to the full target.
  const deferred = new Set(
    (Array.isArray(deferrals) ? deferrals : [])
      .filter((d) => d && typeof d.dimension === 'string' && String(d.approvedBy || '').trim())
      .map((d) => d.dimension),
  );
  const pinned = pinnedDimensions(breakdownHistory, stallRounds).filter((d) => deferred.has(d));
  const reachable = reachableScore({ breakdown, weights, pinned });
  if (reachable && reachable.score >= target) {
    return {
      action: 'done',
      pinned: reachable.dropped,
      reachableScore: reachable.score,
      belowRawTarget: true,
      reason:
        `Target reached on every dimension that can still move: ${reachable.score.toFixed(2)} >= ${target} ` +
        `excluding ${reachable.dropped.join(', ')}, ruled a deferral for this ticket and flat across ` +
        `${stallRounds} round(s), carrying ${(reachable.droppedWeight * 100).toFixed(0)}% of the weight. Raw ` +
        `score ${score.toFixed(2)} stays below ${target} and always will - say so wherever this ships.`,
    };
  }

  // Only fires when a cap is actually set; `budgetState` reports no-cap as never exhausted,
  // so rounds and stall stay the bounds on an uncapped loop.
  const budget = budgetState(spentUsd, budgetUsd);
  if (budget.exhausted) {
    return {
      action: 'stop-budget',
      reason: `ESCALATION: budget exhausted — spent $${budget.spentUsd.toFixed(2)} >= cap $${budget.capUsd.toFixed(2)} with score ${score.toFixed(2)} still below target ${target}. Needs a human.`,
    };
  }

  if (round >= maxRounds) {
    return {
      action: 'stop-rounds',
      reason: `ESCALATION: max repair rounds reached (${round}/${maxRounds}) without hitting target — score ${score.toFixed(2)} < ${target}. Needs a human.`,
    };
  }

  const stall = stallDetector(scoreHistory, stallRounds);
  if (stall.stalled) {
    return {
      action: 'stop-stall',
      reason: `ESCALATION: stalled — ${stall.roundsWithoutImprovement} round(s) without improvement (threshold ${stallRounds}), score ${score.toFixed(2)} < ${target}. Needs a human.`,
    };
  }

  return { action: 'continue', reason: `Round ${round}: score ${score.toFixed(2)} < target ${target}; continuing repair.` };
}

/** Short restatement re-injected into each repair round's coder prompt, fixing Drift
 * (the coder wandering off the rubric gap) by re-stating the goal + exactly what's
 * still failing every round. */
export function restateGoal(ticketKey, rubricTarget, failingDims) {
  const dims = failingDims && failingDims.length ? failingDims.join(', ') : 'none';
  return `GOAL: ${ticketKey} rubric >= ${rubricTarget}. Still failing: ${dims}. Fix ONLY these.`;
}

// --- Goal A1 / A3 support -------------------------------------------------------
// The three pure pieces loop.mjs needs to become the sole writer of the score: deciding
// whether the ticket folder already proves a visual diff was possible, naming the
// worktree the sha must come from, and building the receipt line + status patch.

// A Figma node id as it appears in design.md / design-links.json: `4785-14944`,
// `1346:2928`, `201:5007`. Only counted in a context that can't be anything else — a
// `node-id=` URL parameter or a backticked literal — so an ISO date (2026-08-09) or a
// version range in prose never masquerades as an enumerated variant.
const NODE_ID_IN_URL = /node-id=(\d{1,6}[:-]\d{3,6})/g;
const NODE_ID_IN_BACKTICKS = /`(\d{1,6}[:-]\d{3,6})`/g;

/** Did this ticket's design artefacts enumerate variant nodes? If they did, a per-node
 * screenshot diff was genuinely possible and `visualDiffSkipReason` is not a legitimate
 * out (contract §2 — the skip is refused, not merely excluded).
 *
 * `designLinks` is the parsed design-links.json, written by CONTEXT. When it is WELL-FORMED
 * it is the only authority, and it answers in BOTH directions: an empty `variantNodes`, or
 * `enumerationBlocked`, means no diff was possible and the skip stands. That two-way answer
 * is the whole point of the file. `designMd` prose is only a fallback for tickets that ran
 * before CONTEXT wrote one, and it can only ever answer YES — see `enumeratedFromProse`.
 *
 * Returns { enumerated, nodeIds, source, blockedReason }. */
export function designEnumeratesVariants({ designMd, designLinks } = {}) {
  const fromFile = enumeratedFromLinks(designLinks);
  if (fromFile) return fromFile;

  const text = typeof designMd === 'string' ? designMd : '';
  const found = [
    ...[...text.matchAll(NODE_ID_IN_URL)].map((m) => m[1]),
    ...[...text.matchAll(NODE_ID_IN_BACKTICKS)].map((m) => m[1]),
  ];
  const nodeIds = dedupeNodeIds(found);
  return {
    enumerated: nodeIds.length > 0,
    nodeIds,
    source: nodeIds.length ? 'design.md' : null,
    blockedReason: null,
  };
}

/** Read design-links.json's verdict, or null when the file cannot give one.
 *
 * `variantNodes` is the field CONTEXT writes: the nodes a per-variant diff could actually
 * use. Present-and-empty is a real answer (CONTEXT walked the component set and there were
 * no variants), which is why the emptiness test is on presence of the key, not on length.
 * `enumerationBlocked` covers the other honest outcome - the walk could not run at all,
 * e.g. the Figma tools were denied - and needs a `blockedReason` to be believed, so that a
 * bare `{"enumerationBlocked":true}` cannot unlock a skip on its own.
 *
 * Anything else - no file, a malformed one, a blocked claim with no reason - returns null so
 * the caller falls back to the strict prose scan. Absence must never be permissive: an
 * unwritable or hand-deleted file would otherwise be the easiest way to dodge the gate.
 *
 * `links[].nodeId` is the older hand-written shape, still honoured, but only positively. */
function enumeratedFromLinks(designLinks) {
  if (!designLinks || typeof designLinks !== 'object') return null;

  if (Array.isArray(designLinks.variantNodes)) {
    const nodeIds = dedupeNodeIds(
      designLinks.variantNodes
        .map((n) => (typeof n === 'string' ? n : n?.nodeId))
        .filter((id) => typeof id === 'string' && id.trim()),
    );
    return { enumerated: nodeIds.length > 0, nodeIds, source: 'design-links.json', blockedReason: null };
  }

  const reason = typeof designLinks.blockedReason === 'string' ? designLinks.blockedReason.trim() : '';
  if (designLinks.enumerationBlocked === true && reason) {
    return { enumerated: false, nodeIds: [], source: 'design-links.json', blockedReason: reason };
  }

  const legacy = Array.isArray(designLinks.links)
    ? designLinks.links.map((l) => l?.nodeId).filter((id) => typeof id === 'string' && id.trim())
    : [];
  if (legacy.length) {
    return { enumerated: true, nodeIds: dedupeNodeIds(legacy), source: 'design-links.json', blockedReason: null };
  }

  return null;
}

/** Figma writes the same node as `4785-14944` and `4785:14944`; normalize to the dash
 * form so a design.md that mixes both doesn't inflate the count. */
function dedupeNodeIds(ids) {
  return [...new Set(ids.map((id) => id.trim().replace(':', '-')))];
}

/** The worktree directory names a ticket's branch could live in, most-likely first.
 * scripts/worktree.mjs names ticket worktrees `<KEY>-<repoId>` under the workspace's
 * `.wt/`, and status.json records the repos that were built — so the pair is enough to
 * find the tree whose HEAD the score must be stamped with. Returns [] when status.json
 * names no repos, which is the caller's cue to write `shaSource: "unavailable"`. */
export function worktreeCandidates(key, status) {
  const repos = Array.isArray(status?.repos) ? status.repos : [];
  return repos.filter((r) => typeof r === 'string' && r.trim()).map((repo) => `${key}-${repo.trim()}`);
}

/** Build the one rubric.jsonl line for a scored round, in exactly the contract §1 shape.
 * `breakdown`/`weights` are the POST-renormalization pair from scoreRubric, and
 * `excluded` names the dimensions missing from `breakdown` — without it a reader can't
 * tell an excluded dimension from a forgotten one. `sha` is the HEAD of the scored
 * branch, or null with `shaSource: "unavailable"` — never invented. */
export function rubricLine({
  key,
  round,
  score,
  breakdown,
  weights,
  excluded = [],
  unmeasured = [],
  action,
  reason,
  sha = null,
  shaSource = 'unavailable',
  visualDiff,
  spentUsd,
  budgetUsd,
  scoredAt,
  pinned = [],
  reachableScore: reachable = null,
}) {
  return {
    key,
    round,
    score,
    breakdown,
    weights,
    excluded,
    unmeasured,
    // Dimensions that stopped moving, and what the ticket scores without them. Present only
    // on a round that judged against the reachable score, so a `done` at a raw score below
    // target always carries the reason it was allowed, on the receipt itself.
    pinned,
    reachableScore: reachable,
    action,
    reason,
    sha: sha || null,
    shaSource: sha ? shaSource : 'unavailable',
    visualDiff: {
      source: visualDiff?.source ?? 'none',
      rate: visualDiff?.rate ?? null,
      reason: visualDiff?.reason ?? null,
      excluded: Boolean(visualDiff?.excluded),
    },
    spentUsd,
    budgetUsd,
    scoredAt,
  };
}

/** The four fields loop.mjs owns in status.json. Nothing else may write `rubricScore`,
 * so they always move together — a score without the sha it was computed against is
 * exactly the unverifiable number Goal A1 exists to kill. */
export function statusRubricPatch({ score, sha = null, round, scoredAt }) {
  return { rubricScore: score, rubricSha: sha || null, rubricRound: round, rubricScoredAt: scoredAt };
}

/** Merge a patch into an existing status.json object without touching anything else —
 * every unrelated field (prs, branches, mergeCommit, escalation…) survives verbatim. */
export function mergeStatus(current, patch) {
  return { ...(current && typeof current === 'object' ? current : {}), ...patch };
}
