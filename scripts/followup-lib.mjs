// Pure follow-up scheduling logic — no filesystem, no I/O, no Date — so it's
// unit-testable with vitest. The "refund follow-up" pattern: an open PR or open
// escalation that's gone stale needs a courtesy nudge, and if it's still stale after
// that, an escalation. Deterministic — the caller (followup.mjs, the IO layer) stamps
// `nowMs` once at read time; this module never calls `Date` itself.

/** Age in days between two millisecond timestamps, direction-agnostic. */
export function daysBetween(aMs, bMs) {
  return Math.abs((Number(bMs) || 0) - (Number(aMs) || 0)) / (24 * 60 * 60 * 1000);
}

/** Decide the follow-up action for each item. `items`: [{ key, kind:'pr'|'escalation',
 * url?, openedAtMs, lastNudgeAtMs? }]. `nowMs` is the caller-stamped current time.
 * `{ nudgeAfterDays, escalateAfterDays }` come from config.followup.
 *
 * Rules (checked in order): age >= escalateAfterDays -> escalate; else
 * age >= nudgeAfterDays AND (never nudged OR last nudge >= 1 day ago) -> nudge;
 * else -> none. Returns one `{ key, kind, action, ageDays, reason }` per item. */
export function dueFollowups(items, nowMs, { nudgeAfterDays, escalateAfterDays } = {}) {
  const arr = Array.isArray(items) ? items : [];

  return arr.map((item) => {
    const ageDays = daysBetween(item?.openedAtMs, nowMs);
    const key = item?.key;
    const kind = item?.kind;

    if (ageDays >= escalateAfterDays) {
      return {
        key,
        kind,
        action: 'escalate',
        ageDays,
        reason: `open ${ageDays.toFixed(1)}d >= escalate threshold ${escalateAfterDays}d`,
      };
    }

    if (ageDays >= nudgeAfterDays) {
      const neverNudged = item?.lastNudgeAtMs == null;
      const sinceLastNudgeDays = neverNudged ? Infinity : daysBetween(item.lastNudgeAtMs, nowMs);
      if (neverNudged || sinceLastNudgeDays >= 1) {
        return {
          key,
          kind,
          action: 'nudge',
          ageDays,
          reason: neverNudged
            ? `open ${ageDays.toFixed(1)}d >= nudge threshold ${nudgeAfterDays}d, never nudged`
            : `open ${ageDays.toFixed(1)}d >= nudge threshold ${nudgeAfterDays}d, last nudged ${sinceLastNudgeDays.toFixed(1)}d ago`,
        };
      }
      return {
        key,
        kind,
        action: 'none',
        ageDays,
        reason: `nudged ${sinceLastNudgeDays.toFixed(1)}d ago (< 1d) — throttled`,
      };
    }

    return {
      key,
      kind,
      action: 'none',
      ageDays,
      reason: `open ${ageDays.toFixed(1)}d < nudge threshold ${nudgeAfterDays}d`,
    };
  });
}
