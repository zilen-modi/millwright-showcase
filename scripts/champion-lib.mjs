// Pure champion/challenger logic for Phase 3 self-improvement — deterministic
// improve/holdout split, score aggregation, and the promotion decision (no
// filesystem/network, no Math.random, no Date). Determinism matters here: the same
// case bank + the same two score sets must always produce the same verdict, so a
// promotion can be reproduced and audited later. champion.mjs is the IO wrapper.

/** Sort cases deterministically by `key` (ascending, stable) — the split's ordering
 * must never depend on input order or wall-clock time. */
function byKeyAsc(cases) {
  return [...cases].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Split a case bank into a tune set ("improve") and a never-touched-during-tuning
 * set ("holdout"), ordered deterministically by `key`. The first `improveSetSize`
 * cases are improve, the NEXT `holdoutSetSize` are holdout — the two ranges never
 * overlap by construction, so a promotion can never be validated against a case the
 * challenger was tuned on. `insufficient` is true (a signal to refuse promotion
 * upstream) when the case bank doesn't even have enough cases to fill both sets, or
 * when the holdout actually produced is smaller than the caller-provided minimum
 * (defaults to `holdoutSetSize` itself). */
export function splitCases(cases, { improveSetSize, holdoutSetSize, minHoldoutCases } = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const sorted = byKeyAsc(list);

  const improve = sorted.slice(0, improveSetSize);
  const holdout = sorted.slice(improveSetSize, improveSetSize + holdoutSetSize);

  const min = minHoldoutCases ?? holdoutSetSize;
  const insufficient = sorted.length < improveSetSize + holdoutSetSize || holdout.length < min;

  return { improve, holdout, insufficient };
}

/** Roll a set of `{key, score}` results into `{ mean, min, count, byKey }`. Used to
 * summarize a champion or challenger's performance over a case set for reporting. */
export function aggregateScores(perCaseResults) {
  const list = Array.isArray(perCaseResults) ? perCaseResults : [];
  const byKey = {};
  for (const r of list) byKey[r.key] = r.score;

  const scores = list.map((r) => r.score);
  const count = scores.length;
  const mean = count ? scores.reduce((a, b) => a + b, 0) / count : 0;
  const min = count ? Math.min(...scores) : 0;

  return { mean, min, count, byKey };
}

function meanOf(scores) {
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/** Restrict a `[{key, score}]` list to a Map keyed by `key`. When `holdoutSet` is
 * given (even an explicitly empty one — a legitimately empty holdout split must
 * still restrict to nothing, not silently fall back to "everything"), only keys in
 * it are kept; `null` means no restriction was requested at all. */
function scoreMap(list, holdoutSet) {
  const map = new Map();
  for (const { key, score } of Array.isArray(list) ? list : []) {
    if (holdoutSet && !holdoutSet.has(key)) continue;
    map.set(key, score);
  }
  return map;
}

/** The promotion gate: decide whether a challenger prompt should replace the current
 * champion, using ONLY holdout scores (cases neither prompt was tuned against).
 * `champion`/`challenger` are `[{key, score}]`; `holdoutKeys` restricts both to the
 * same case set (pass the holdout split's keys). Promotes only if ALL hold:
 *   (i)   evaluated holdout cases (present in both score sets) >= minHoldoutCases —
 *         otherwise REFUSES with a clear overfit-risk reason;
 *   (ii)  challenger holdout-mean >= champion holdout-mean + margin;
 *   (iii) no holdout case regresses — i.e. no case where the challenger scores BOTH
 *         below `regressionFloor` AND more than `margin` below the champion's score
 *         on that same case.
 * Any single failure returns `{ promote: false, reason }`; only when every gate
 * passes does it return `{ promote: true, reason }`. Always includes
 * `{ championMean, challengerMean, delta }` for reporting (0 when not computable). */
export function promotionDecision({ champion, challenger, holdoutKeys, margin, minHoldoutCases, regressionFloor }) {
  const holdoutSet = Array.isArray(holdoutKeys) ? new Set(holdoutKeys) : null;
  const champByKey = scoreMap(champion, holdoutSet);
  const challByKey = scoreMap(challenger, holdoutSet);

  const evaluatedKeys = [...champByKey.keys()].filter((k) => challByKey.has(k));
  const evaluatedCount = evaluatedKeys.length;

  if (evaluatedCount < minHoldoutCases) {
    return {
      promote: false,
      reason: `insufficient holdout (${evaluatedCount} < ${minHoldoutCases}) — cannot promote without risking overfit`,
      championMean: 0,
      challengerMean: 0,
      delta: 0,
    };
  }

  const champScores = evaluatedKeys.map((k) => champByKey.get(k));
  const challScores = evaluatedKeys.map((k) => challByKey.get(k));
  const championMean = meanOf(champScores);
  const challengerMean = meanOf(challScores);
  const delta = challengerMean - championMean;

  if (delta < margin) {
    return {
      promote: false,
      reason: `challenger holdout-mean ${challengerMean.toFixed(3)} does not beat champion ${championMean.toFixed(3)} by margin ${margin} (delta ${delta.toFixed(3)})`,
      championMean,
      challengerMean,
      delta,
    };
  }

  const regressed = evaluatedKeys.filter((k) => {
    const c = challByKey.get(k);
    const ch = champByKey.get(k);
    return c < regressionFloor && ch - c > margin;
  });

  if (regressed.length) {
    return {
      promote: false,
      reason: `challenger regresses ${regressed.length} holdout case(s) below regressionFloor ${regressionFloor} and more than margin ${margin} under champion: ${regressed.join(', ')}`,
      championMean,
      challengerMean,
      delta,
    };
  }

  return {
    promote: true,
    reason: `challenger holdout-mean ${challengerMean.toFixed(3)} beats champion ${championMean.toFixed(3)} by ${delta.toFixed(3)} (>= margin ${margin}) with no regression across ${evaluatedCount} holdout case(s)`,
    championMean,
    challengerMean,
    delta,
  };
}

/** Append a promotion to the registry's log and bump the champion's version —
 * immutably (never mutates the input registry). `promotedAt` is left to the caller
 * (an IO script may pass an ISO timestamp; this pure module never generates one). */
export function recordPromotion(registry, { agent, fromVersion, toVersion, delta, holdoutN, promotedAt = null }) {
  const reg = registry || {};
  const prevChampions = reg.champions || {};
  const prevEntry = prevChampions[agent] || {};

  const champions = {
    ...prevChampions,
    [agent]: { ...prevEntry, version: toVersion, promotedAt },
  };

  const promotionLog = [...(reg.promotionLog || []), { agent, fromVersion, toVersion, delta, holdoutN, promotedAt }];

  return { ...reg, champions, promotionLog };
}
