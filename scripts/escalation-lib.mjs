// Pure escalation/handoff formatting — no filesystem, no I/O, no Jira/network calls —
// so it's unit-testable with vitest. One channel-agnostic protocol for every reason
// Autopilot hands a ticket back to a human: a Phase 1 loop stop (budget/rounds/stall), a
// Phase 2 high-stakes verdict, low route confidence, or an ambiguous AC/design conflict.
// The orchestrator does the actual gated Jira post (`addCommentToJiraIssue`) and
// notification; this module only builds the question + the artifacts around it.

const SEVERITY_BY_KIND = {
  budget: 'high',
  rounds: 'high',
  stall: 'elevated',
  stakes: 'high',
  'low-confidence': 'elevated',
  'ambiguous-ac': 'elevated',
  'design-conflict': 'high',
};

const VALID_KINDS = new Set(Object.keys(SEVERITY_BY_KIND));

/** Turn a fragment into a crisp sentence: trim, and ensure exactly one trailing
 * terminator so callers can pass reasons with or without one. */
function asSentence(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Build the crisp, answerable question for a handoff — never a data dump. With
 * `options` (2-4 concrete choices), the question ends in "opt1 / opt2 / opt3?"; without
 * them it falls back to a generic decision prompt. */
function buildQuestion({ key, reason, options }) {
  const body = [key ? `${key}:` : null, asSentence(reason)].filter(Boolean).join(' ').trim();
  if (Array.isArray(options) && options.length) {
    return `${body} ${options.join(' / ')}?`;
  }
  return body ? `${body} How should Autopilot proceed?` : 'How should Autopilot proceed?';
}

/** Build one escalation handoff: `{severity, blocking:true, question}`. `kind` selects
 * the default severity (a stakes/design-conflict/budget/rounds handoff is always
 * `high`; stall/low-confidence/ambiguous-ac default to `elevated`) — every escalation is
 * `blocking:true` because the ticket PAUSES until a human answers. */
export function buildEscalation({ key, kind, reason, options } = {}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`buildEscalation: unknown kind "${kind}" (expected one of ${[...VALID_KINDS].join(', ')})`);
  }
  return {
    severity: SEVERITY_BY_KIND[kind],
    blocking: true,
    question: buildQuestion({ key, reason, options }),
  };
}

/** Render an escalation as an ADF comment doc ready for `addCommentToJiraIssue`
 * (`contentFormat:"adf"`): one paragraph with the question text followed by an
 * @-mention of the accountable owner, so they're tagged/notified. */
export function escalationCommentAdf({ escalation, ownerAccountId }) {
  const question = escalation?.question ?? '';
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `${question} ` },
          { type: 'mention', attrs: { id: ownerAccountId, text: '@owner' } },
        ],
      },
    ],
  };
}

/** Build the persisted record for `tickets/<KEY>/escalation.json`. `raisedAtField` is
 * left as an ISO-timestamp placeholder — this module never calls `Date`; the
 * orchestrator stamps the real value when it actually raises the escalation. */
export function escalationRecord({ key, kind, reason, question }) {
  return {
    key,
    kind,
    reason,
    question,
    status: 'open',
    raisedAtField: '<ISO placeholder>',
  };
}
