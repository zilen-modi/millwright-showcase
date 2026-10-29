/**
 * Did a panel-spawned `claude -p` run actually DO anything?
 *
 * The panel used to answer this with the child's exit code alone, which is a lie in the one
 * case that matters. Confirmed against the real CLI (2.1.198): when a slash command doesn't
 * resolve — e.g. the workspace-root skill symlinks at acme/.claude/skills/ are dangling, so
 * `/resolve-ticket` is simply not a command — the run emits
 *
 *   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
 *     "text":"Unknown command: /resolve-ticket"}], "usage":{…all zeros}}}
 *   {"type":"result","subtype":"success","is_error":false,"num_turns":0,
 *     "total_cost_usd":0,"result":"Unknown command: /resolve-ticket"}
 *
 * and exits 0. Every layer that only reads `subtype` or the exit code therefore reports a
 * completely inert run as `✓ success`. `is_error` does NOT save you here — it is literally
 * `false` — so the authoritative signal has to be evidence of WORK, not a status field:
 *
 *   A run did work iff it appended a stage_end event to the ticket's events.jsonl,
 *   or the SDK's own result event reports a nonzero total_cost_usd.
 *
 * Neither → no-op → failed, however cheerful the exit code was.
 *
 * Everything here is pure (string/number in, plain object out) so tests/run-outcome-lib.test.mjs
 * can drive the real incident's event stream through it; dashboard/server.mjs keeps the I/O.
 */

/** CLI-generated "your command/skill/agent does not exist" output. Anchored at line start:
 * these are matched against text the CLI itself produced (see `inspectStreamLine` for which
 * text qualifies), never against model prose, so a run can't be failed for merely discussing
 * an unknown command. */
export const HARD_ERROR_PATTERNS = [
  /^Unknown command:/i,
  /^Unknown slash command\b/i,
  /^Unknown agent type\b/i,
  /^Skill not found\b/i,
  /^No such (?:skill|command|agent)\b/i,
];

/** `$0.00` is the tell for a no-op run — so a real-but-cheap run must never render as `$0.00`.
 * toFixed(2) alone flattens a genuine $0.004 run into the exact string that means "nothing
 * happened", which is precisely how the incident stayed invisible. */
export function formatCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  return '$' + (Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2));
}

/** First CLI hard-error line in `text`, trimmed and truncated — else null. */
export function hardErrorIn(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line && HARD_ERROR_PATTERNS.some((re) => re.test(line))) return line.slice(0, 200);
  }
  return null;
}

/** Clip with a visible marker. An unmarked cut reads as a whole command that makes no sense:
 * the log showed `grep -E "pr-re)` for a real grep cut at 90 characters. */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Every panel-spawned Bash call opens with a cd into the workspace - the same ~50 characters
 * on every line, which pushed the actual command past the clip. The cwd is fixed for the whole
 * run, so repeating it per line buys nothing and costs most of the readable budget. */
function stripCdPrefix(cmd) {
  return cmd.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
}

export function toolBrief(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return ` (${clip(stripCdPrefix(String(input.command).replace(/\s+/g, ' ')), 160)})`;
  if (input.file_path) return ` (${input.file_path})`;
  if (input.path) return ` (${input.path})`;
  if (input.prompt) return ` (${clip(String(input.prompt).replace(/\s+/g, ' '), 70)})`;
  if (input.description) return ` (${clip(String(input.description), 70)})`;
  return '';
}

// Render one `--output-format stream-json` event into a concise, human-readable log line. Returns
// null to drop noise; returns the raw line unchanged when it isn't JSON (e.g. stderr text).
export function formatStreamEvent(line) {
  const t = String(line ?? '').trim();
  if (!t) return null;
  let ev;
  try { ev = JSON.parse(t); } catch { return line; }
  if (ev.type === 'assistant' && ev.message?.content) {
    const out = [];
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text && c.text.trim()) {
        // A synthetic "Unknown command: …" is the whole run, not a remark inside it — mark it
        // so the log reads as a failure at the line where the failure actually happened.
        const text = c.text.trim();
        out.push(isSynthetic(ev) && hardErrorIn(text) ? `✗ ${text}` : text);
      } else if (c.type === 'tool_use') out.push(`→ ${c.name}${toolBrief(c.input)}`);
    }
    return out.length ? out.join('\n') : null;
  }
  if (ev.type === 'user' && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_result') {
        let txt = c.content;
        if (Array.isArray(txt)) txt = txt.map((x) => x?.text || '').join(' ');
        // Say when output was elided. Showing only the first line of a 40-line result with no
        // marker reads as if that was the whole output.
        const all = String(txt || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const first = all[0] || '';
        const more = all.length > 1 ? ` … (+${all.length - 1} more lines)` : '';
        return `  ⟵ ${c.is_error ? 'error: ' : ''}${clip(first, 200)}${more}`;
      }
    }
    return null;
  }
  if (ev.type === 'result') {
    const cost = ev.total_cost_usd != null ? ` · ${formatCost(ev.total_cost_usd)}` : '';
    // `num_turns: 0` means the CLI never took a single turn — nothing ran, whatever `subtype`
    // says. Without this the incident's own final line reads `✓ success · $0.00`, which is the
    // exact string that made three inert runs look like three good ones.
    const noTurns = ev.num_turns === 0;
    if (ev.is_error || noTurns) {
      const detail = String(ev.result || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
      const label = ev.is_error ? (ev.subtype || 'done') : 'no-op (0 turns)';
      return `✗ ${label}${cost}${detail ? ` · ${detail.slice(0, 160)}` : ''}`;
    }
    return `✓ ${ev.subtype || 'done'}${cost}`;
  }
  return null; // system/init and other control events → drop
}

/** `model: "<synthetic>"` means the CLI fabricated the message rather than the model producing
 * it — the reliable marker for CLI-side failures dressed up as assistant text. */
function isSynthetic(ev) {
  return ev?.message?.model === '<synthetic>';
}

/** Pull the run-outcome signals out of one raw stream-json line: the authoritative `result`
 * event, and any CLI hard error. Formatting lives in `formatStreamEvent`; this is the data. */
export function inspectStreamLine(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { result: null, hardError: null };
  let ev;
  // Not JSON → the CLI's own plaintext on stdout/stderr, so it is safe to scan wholesale.
  try { ev = JSON.parse(t); } catch { return { result: null, hardError: hardErrorIn(t) }; }

  if (ev?.type === 'result') {
    const usage = ev.usage || {};
    const numTurns = typeof ev.num_turns === 'number' ? ev.num_turns : null;
    return {
      result: {
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
        isError: ev.is_error === true,
        subtype: typeof ev.subtype === 'string' ? ev.subtype : null,
        numTurns,
        // The final assistant text. Needed to tell a run that finished the work from one
        // that stopped to ask the operator something - both exit 0 and both cost money.
        text: typeof ev.result === 'string' ? ev.result : null,
      },
      // `result` echoes the final assistant text, which on a real run is model prose — only
      // trust it as CLI output when zero turns ran, i.e. no model text can exist yet.
      hardError: numTurns === 0 ? hardErrorIn(typeof ev.result === 'string' ? ev.result : null) : null,
    };
  }

  if (ev?.type === 'assistant' && Array.isArray(ev.message?.content) && isSynthetic(ev)) {
    const text = ev.message.content
      .filter((c) => c?.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    return { result: null, hardError: hardErrorIn(text) };
  }

  return { result: null, hardError: null };
}

/** How many stage_end events an events.jsonl currently holds. Counted structurally rather than
 * via schemas.mjs' `parseEventLine`: the question is "did a stage report completing", and a
 * stage_end that fails strict validation still answers yes. Missing file → `''` → 0. */
export function countStageEnds(text) {
  if (typeof text !== 'string' || !text) return 0;
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { if (JSON.parse(line)?.event === 'stage_end') n++; } catch { /* not an event line */ }
  }
  return n;
}

/**
 * The verdict for one finished run.
 *
 * @param code           child exit code (0 is NOT proof of success — see the file header)
 * @param cancelled       true when the panel itself SIGTERM'd the run (operator cancel / pause)
 * @param costUsd         `total_cost_usd` from the SDK result event; null if none arrived
 * @param stageEndDelta   new stage_end events written by THIS run, or null when the caller has
 *                        no events.jsonl to measure (ad-hoc PR reviews) — null means "unknown",
 *                        not "zero", so cost carries the whole judgement there
 * @param resultIsError   the result event's `is_error`
 * @param resultSubtype   the result event's `subtype`, for the message
 * @param hardError       first CLI hard-error line seen, if any
 * @returns {{ok: boolean, status: 'success'|'failed'|'cancelled', failure: string|null}}
 */
/**
 * Phrases a run uses when it has stopped and is waiting on the operator. Deliberately a
 * fixed list rather than "ends with a question mark": a finished review legitimately ends by
 * raising a question about the code, and that must still read as success.
 */
const ASKS_OPERATOR_RE =
  /\b(what would you like|would you like me to|do you want me to|shall i|let me know (?:how|what|which|whether|if)|please confirm|awaiting your|tell me (?:which|what|how)|which would you (?:like|prefer))\b/i;

/**
 * Did the run stop to ask the operator a question rather than finish its work?
 *
 * This is the PROJ-1088 case: `/review-pr` found an existing report plus a posted-comment
 * file with no matching audit entry, reasonably suspected a previous run had broken the
 * zero-GitHub-writes rule, and halted with three numbered options. It exited 0 having spent
 * $0.77, so every existing signal read it as a clean success - the operator saw a green tick
 * and no new report, with the question only in panel-run.log.
 *
 * Only the tail is scanned: the ask is how such a message ends, and scanning a whole review
 * would match any prose that happens to contain one of these phrases mid-report.
 */
export function isQuestionStop(text) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  return ASKS_OPERATOR_RE.test(t.slice(-700));
}

/** The question itself, for the panel to show instead of making the operator open the log.
 *  The last non-empty line that actually asks, else the last non-empty line. */
export function questionFrom(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const asking = [...lines].reverse().find((l) => ASKS_OPERATOR_RE.test(l));
  return clip(asking || lines[lines.length - 1], 300);
}

export function classifyRunOutcome({
  code = 0,
  cancelled = false,
  costUsd = null,
  stageEndDelta = null,
  resultIsError = false,
  resultSubtype = null,
  resultText = null,
  hardError = null,
} = {}) {
  // A deliberate cancel is not a defect — it must not be dressed as one, or the new failure
  // signal cries wolf every time an operator hits Cancel and stops being worth reading.
  if (cancelled) return { ok: false, status: 'cancelled', failure: 'cancelled by the operator' };

  if (hardError) {
    return {
      ok: false,
      status: 'failed',
      failure: `${hardError} — nothing resolved, so nothing ran (check the .claude/skills and .claude/agents symlinks at the workspace root)`,
    };
  }
  if (resultIsError) {
    return {
      ok: false,
      status: 'failed',
      failure: `the run reported an error result${resultSubtype ? ` (${resultSubtype})` : ''}`,
    };
  }
  const exit = Number(code);
  if (Number.isFinite(exit) && exit !== 0) {
    return { ok: false, status: 'failed', failure: `exited with code ${exit}` };
  }

  // Before the cost check: this run DID spend money, so `spent` would call it a success.
  if (isQuestionStop(resultText)) {
    return {
      ok: false,
      status: 'needs-input',
      failure: `the run stopped to ask: ${questionFrom(resultText)}`,
    };
  }
  const spent = typeof costUsd === 'number' && costUsd > 0;
  const worked = stageEndDelta != null && stageEndDelta > 0;
  if (!spent && !worked) {
    const cost = typeof costUsd === 'number' ? `${formatCost(costUsd)} spent` : 'no cost reported';
    const stages = stageEndDelta == null ? '' : ' and no new stage_end event in events.jsonl';
    return { ok: false, status: 'failed', failure: `no-op run: ${cost}${stages} — nothing actually ran` };
  }
  return { ok: true, status: 'success', failure: null };
}

/**
 * The same evidence rule as `classifyRunOutcome`, applied to a PR review's persisted
 * `status.json` rather than a live event stream — for runs that finished BEFORE the panel
 * recorded a verdict, and so left no `result` and no `failure` behind.
 *
 * `costUsd`/`tokens` are only written once a `result` event arrived, so zeros in both plus no
 * `result` means the run completed having done nothing. That is the exact residue the original
 * incident left in a review's status.json: `{"costUsd": 0, "tokens": 0}` and nothing else.
 */
export function isPersistedNoOp({ running, result, costUsd, tokens, hasReview } = {}) {
  if (running || result) return false;
  // A real review.md outranks the cost heuristic. `costUsd`/`tokens` are only written by
  // `onFinish`, so a run whose panel process was killed can show zeros while its output sits
  // on disk - calling that a no-op would offer a retry for work that is already done.
  if (hasReview) return false;
  return costUsd === 0 && tokens === 0;
}

/**
 * A review whose run died before its verdict was recorded, but which produced its output anyway.
 *
 * The panel seeds `result: "in-progress"` at spawn and only overwrites it in `onFinish`, so a
 * killed panel process leaves that value frozen with nothing running; separately, a skill that
 * never wrote `result` itself leaves the field absent while cost was still recorded. In both
 * cases the artifacts on disk are the evidence that the work finished, which is why they decide
 * this and the `result` field does not.
 *
 * Callers reconcile these once at startup so the board stops offering a retry that would
 * re-spend for a report it already has.
 */
export function isOrphanedComplete({ running, result, hasReview, hasQualityInputs } = {}) {
  if (running) return false;
  if (!hasReview || !hasQualityInputs) return false;
  const recorded = result == null ? '' : String(result).trim().toLowerCase();
  return recorded === '' || recorded === 'in-progress';
}

/** The log/SSE line announcing a bad outcome, or null when the run was fine. */
export function runFailureLine(mode, outcome) {
  if (!outcome || outcome.ok) return null;
  const what = outcome.status === 'cancelled' ? 'CANCELLED' : 'FAILED';
  return `✗ run ${mode} ${what} — ${outcome.failure}`;
}

/** Closing line of the run's log file. `code=` is kept for continuity; `status=` is the truth. */
export function runEndTrailer(mode, code, outcome) {
  return `=== run-end ${mode} code=${code} status=${outcome?.status || 'success'} ===`;
}
