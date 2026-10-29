// Pure devil's-advocate triage + stop logic — no filesystem, no I/O — so it's
// unit-testable with vitest. A Builder proposes/revises a solution; a Critic (a
// delegated agent, wired in the SKILL) pokes holes at it as a list of objections. This
// module decides which objections actually block progress and when the back-and-forth
// should stop — the Critic agent itself is not part of this module.

const BLOCKING_SEVERITIES = new Set(['blocking', 'major']);

/** Split objections into the ones that still block progress (`open`: unresolved
 * blocking/major) and the ones that don't (`minor`: unresolved minor), plus a count of
 * how many have already been resolved. */
export function triageObjections(objections) {
  const arr = Array.isArray(objections) ? objections : [];
  const open = arr.filter((o) => !o?.resolved && BLOCKING_SEVERITIES.has(o?.severity));
  const minor = arr.filter((o) => !o?.resolved && o?.severity === 'minor');
  const resolvedCount = arr.filter((o) => o?.resolved).length;
  return { open, minor, resolvedCount };
}

function normalize(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable string fingerprint of the currently-open (unresolved blocking/major)
 * objections, normalized so whitespace/case drift doesn't mask an exact repeat. Used to
 * detect a critic that keeps raising the same objections round after round. */
export function objectionsFingerprint(objections) {
  const { open } = triageObjections(objections);
  return open
    .map((o) => `${o?.id ?? ''}:${normalize(o?.text)}`)
    .sort()
    .join('|');
}

/** The Builder/Critic loop's single stop/continue decision. Precedence: resolved (no
 * open blocking/major objections) > critic repeating (this round's open-objection
 * fingerprint matches the previous round's) > max rounds reached > continue. */
export function criticStop({ round, maxRounds, current, previousFingerprint }) {
  const { open } = triageObjections(current);
  if (open.length === 0) {
    return { stop: true, reason: 'resolved' };
  }

  const fingerprint = objectionsFingerprint(current);
  if (previousFingerprint && fingerprint === previousFingerprint) {
    return { stop: true, reason: 'critic repeating' };
  }

  if (round >= maxRounds) {
    return { stop: true, reason: 'max critic rounds' };
  }

  return { stop: false, reason: 'continue' };
}
