import { describe, expect, it } from 'vitest';

import {
  classifyRunOutcome,
  countStageEnds,
  formatCost,
  formatStreamEvent,
  hardErrorIn,
  inspectStreamLine,
  isOrphanedComplete,
  isPersistedNoOp,
  isQuestionStop,
  questionFrom,
  runEndTrailer,
  runFailureLine,
} from '../dashboard/run-outcome-lib.mjs';

// ---- the real incident, captured verbatim from `claude -p "/<unknown>" --output-format
// stream-json --verbose` (CLI 2.1.198). Note is_error:false, num_turns:0, total_cost_usd:0,
// subtype "success" — and the process exits 0. This is the stream the panel called a success.
const SYNTHETIC_UNKNOWN = JSON.stringify({
  type: 'assistant',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: 'Unknown command: /resolve-ticket' }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});
const NOOP_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  result: 'Unknown command: /resolve-ticket',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});
const REAL_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 24,
  result: 'Plan written to plan.md.',
  total_cost_usd: 1.42,
  usage: { input_tokens: 5000, output_tokens: 800, cache_creation_input_tokens: 100, cache_read_input_tokens: 40000 },
});

const STAGE_END = JSON.stringify({
  event: 'stage_end', stage: 'plan', agent: 'Plan', model: 'sonnet', status: 'ok', durationSec: 90, tokensTotal: 40000,
});

describe('formatCost', () => {
  it('renders a genuine zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
  it('never flattens a real-but-cheap run into the no-op string $0.00', () => {
    // toFixed(2) alone made $0.004 indistinguishable from "nothing happened".
    expect(formatCost(0.004)).toBe('$0.0040');
    expect(formatCost(0.0001)).toBe('$0.0001');
  });
  it('uses 2dp once the cost is legible', () => {
    expect(formatCost(1.4235)).toBe('$1.42');
    expect(formatCost(12)).toBe('$12.00');
  });
  it('degrades to $0.00 for junk', () => {
    expect(formatCost(null)).toBe('$0.00');
    expect(formatCost(undefined)).toBe('$0.00');
    expect(formatCost('abc')).toBe('$0.00');
  });
});

describe('formatStreamEvent', () => {
  it('marks an is_error result event as a failure, with its detail', () => {
    const line = formatStreamEvent(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'Tool loop exceeded\nmore detail', total_cost_usd: 0.5,
    }));
    expect(line).toBe('✗ error_during_execution · $0.50 · Tool loop exceeded');
  });
  it('still renders a genuinely successful result as ✓ with its cost', () => {
    expect(formatStreamEvent(REAL_RESULT)).toBe('✓ success · $1.42');
  });
  it('refuses to render a zero-turn result as ✓ success, whatever the subtype claims', () => {
    // This exact line — `✓ success · $0.00` — is what the incident's log showed three times.
    expect(formatStreamEvent(NOOP_RESULT))
      .toBe('✗ no-op (0 turns) · $0.00 · Unknown command: /resolve-ticket');
  });
  it('marks synthetic "Unknown command" assistant text as a failure at its own line', () => {
    expect(formatStreamEvent(SYNTHETIC_UNKNOWN)).toBe('✗ Unknown command: /resolve-ticket');
  });
  it('leaves real assistant prose alone even when it discusses unknown commands', () => {
    const line = formatStreamEvent(JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Unknown command: /foo is what it printed.' }] },
    }));
    expect(line).toBe('Unknown command: /foo is what it printed.');
  });
  it('renders tool_use and tool_result lines', () => {
    expect(formatStreamEvent(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls  -la' } }] },
    }))).toBe('→ Bash (ls -la)');
    expect(formatStreamEvent(JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', content: 'only one line' }] },
    }))).toBe('  ⟵ only one line');
  });
  // Rendering just the first line of a multi-line result read as if that WAS the whole output.
  it('says how much tool output was elided rather than hiding it', () => {
    expect(formatStreamEvent(JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom\nsecond' }] },
    }))).toBe('  ⟵ error: boom … (+1 more lines)');
    expect(formatStreamEvent(JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', content: 'a\nb\nc\nd' }] },
    }))).toBe('  ⟵ a … (+3 more lines)');
  });
  // A cd into the workspace opened every panel-spawned Bash line and ate most of the budget,
  // and an unmarked clip read as a complete command that made no sense.
  it('drops the repeated cd prefix and marks a clipped command', () => {
    expect(formatStreamEvent(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd "/Users/x/acme" && git status --short' } }] },
    }))).toBe('→ Bash (git status --short)');
    const long = 'x'.repeat(200);
    expect(formatStreamEvent(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }] },
    }))).toBe(`→ Bash (${'x'.repeat(160)}…)`);
  });
  it('passes non-JSON through and drops control events', () => {
    expect(formatStreamEvent('plain stderr text')).toBe('plain stderr text');
    expect(formatStreamEvent(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
    expect(formatStreamEvent('   ')).toBeNull();
  });
});

describe('hardErrorIn', () => {
  it('matches the CLI unresolved-command/skill/agent lines', () => {
    expect(hardErrorIn('Unknown command: /resolve-ticket')).toBe('Unknown command: /resolve-ticket');
    expect(hardErrorIn('Skill not found: resolve-ticket')).toBe('Skill not found: resolve-ticket');
    expect(hardErrorIn('Unknown agent type: coder-agent')).toBe('Unknown agent type: coder-agent');
    expect(hardErrorIn('No such skill: intake')).toBe('No such skill: intake');
  });
  it('only matches at line start, so prose about a command is not an error', () => {
    expect(hardErrorIn('it said Unknown command: /foo somewhere')).toBeNull();
  });
  it('returns null for empty/non-string input', () => {
    expect(hardErrorIn('')).toBeNull();
    expect(hardErrorIn(null)).toBeNull();
  });
});

describe('inspectStreamLine', () => {
  it('extracts cost/tokens/is_error/subtype/text from a result event', () => {
    // `text` is the final assistant message. Carried so a run that ended by asking the
    // operator something can be told apart from one that finished its work.
    expect(inspectStreamLine(REAL_RESULT).result).toEqual({
      costUsd: 1.42, tokens: 45900, isError: false, subtype: 'success', numTurns: 24,
      text: 'Plan written to plan.md.',
    });
  });
  it('flags a synthetic Unknown-command assistant event as a hard error', () => {
    expect(inspectStreamLine(SYNTHETIC_UNKNOWN).hardError).toBe('Unknown command: /resolve-ticket');
  });
  it('does not flag the same text from a real model turn', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Unknown command: /foo' }] },
    });
    expect(inspectStreamLine(raw).hardError).toBeNull();
  });
  it('trusts the result text as CLI output only when zero turns ran', () => {
    expect(inspectStreamLine(NOOP_RESULT).hardError).toBe('Unknown command: /resolve-ticket');
    const prose = JSON.stringify({
      type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.2,
      result: 'Unknown command: /foo — that was the bug I fixed.',
    });
    expect(inspectStreamLine(prose).hardError).toBeNull();
  });
  it('scans plaintext stderr wholesale', () => {
    expect(inspectStreamLine('Unknown command: /resolve-ticket').hardError)
      .toBe('Unknown command: /resolve-ticket');
  });
  it('reports nothing for blank lines and control events', () => {
    expect(inspectStreamLine('')).toEqual({ result: null, hardError: null });
    expect(inspectStreamLine(JSON.stringify({ type: 'system', subtype: 'init' })))
      .toEqual({ result: null, hardError: null });
  });
  it('treats a missing total_cost_usd as unknown rather than zero', () => {
    expect(inspectStreamLine(JSON.stringify({ type: 'result', subtype: 'success' })).result.costUsd).toBeNull();
  });
});

describe('countStageEnds', () => {
  it('counts stage_end lines and ignores everything else', () => {
    const text = [STAGE_END, JSON.stringify({ event: 'stage_start', stage: 'build' }), STAGE_END, 'garbage', ''].join('\n');
    expect(countStageEnds(text)).toBe(2);
  });
  it('is 0 for an absent or empty events.jsonl', () => {
    expect(countStageEnds('')).toBe(0);
    expect(countStageEnds(null)).toBe(0);
  });
  it('counts a stage_end that would fail strict schema validation — it still proves work', () => {
    expect(countStageEnds(JSON.stringify({ event: 'stage_end' }))).toBe(1);
  });
});

describe('classifyRunOutcome', () => {
  it('fails the incident: $0.00 and no new stage_end, despite exit 0 and subtype success', () => {
    const out = classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: 0 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('failed');
    expect(out.failure).toContain('no-op run');
    expect(out.failure).toContain('$0.00');
    expect(out.failure).toContain('no new stage_end event');
  });

  it('passes a normal successful run', () => {
    expect(classifyRunOutcome({ code: 0, costUsd: 1.42, stageEndDelta: 1 }))
      .toEqual({ ok: true, status: 'success', failure: null });
  });

  it('fails an is_error result event even when the exit code is 0', () => {
    const out = classifyRunOutcome({ code: 0, costUsd: 0.9, stageEndDelta: 1, resultIsError: true, resultSubtype: 'error_max_turns' });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('failed');
    expect(out.failure).toBe('the run reported an error result (error_max_turns)');
  });

  it('accepts a run that spent money but appended no stage_end', () => {
    // e.g. a stage that failed loudly mid-way — real work happened, so it is not a no-op;
    // whatever went wrong is the pipeline's own business to report.
    expect(classifyRunOutcome({ code: 0, costUsd: 0.31, stageEndDelta: 0 }).ok).toBe(true);
  });

  it('accepts a run that appended a stage_end even if the cost came back as 0', () => {
    expect(classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: 2 }).ok).toBe(true);
  });

  it('fails a non-zero exit with the code', () => {
    const out = classifyRunOutcome({ code: 137, costUsd: 2, stageEndDelta: 1 });
    expect(out).toEqual({ ok: false, status: 'failed', failure: 'exited with code 137' });
  });

  it('reports a hard error ahead of everything else, and names the symlink cause', () => {
    const out = classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: 0, hardError: 'Unknown command: /resolve-ticket' });
    expect(out.status).toBe('failed');
    expect(out.failure).toContain('Unknown command: /resolve-ticket');
    expect(out.failure).toContain('.claude/skills');
  });

  it('calls an operator cancel cancelled, not failed', () => {
    // SIGTERM yields exit code null → 0 and zero cost, which is shape-identical to a no-op.
    const out = classifyRunOutcome({ code: 0, cancelled: true, costUsd: null, stageEndDelta: 0 });
    expect(out).toEqual({ ok: false, status: 'cancelled', failure: 'cancelled by the operator' });
  });

  it('fails a run that produced no result event at all', () => {
    const out = classifyRunOutcome({ code: 0, costUsd: null, stageEndDelta: 0 });
    expect(out.ok).toBe(false);
    expect(out.failure).toContain('no cost reported');
  });

  it('judges a PR review (no events.jsonl) on cost alone', () => {
    const noop = classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: null });
    expect(noop.ok).toBe(false);
    expect(noop.failure).toContain('no-op run');
    expect(noop.failure).not.toContain('stage_end'); // nothing to measure → don't claim it
    expect(classifyRunOutcome({ code: 0, costUsd: 0.55, stageEndDelta: null }).ok).toBe(true);
  });

  it('defaults to a success verdict for an empty call rather than throwing', () => {
    expect(classifyRunOutcome().ok).toBe(false); // no evidence of work is a failure, not a crash
    expect(classifyRunOutcome({}).status).toBe('failed');
  });
});

describe('isPersistedNoOp', () => {
  it('flags the residue the incident left in a PR review status.json', () => {
    // Real case: pr-reviews/acme-it-erp-erp-next-ui-monorepo-818/status.json was exactly this.
    expect(isPersistedNoOp({ running: false, result: null, costUsd: 0, tokens: 0 })).toBe(true);
  });

  it('never flags a review that spent money or produced tokens', () => {
    expect(isPersistedNoOp({ running: false, result: null, costUsd: 2.53, tokens: 1246062 })).toBe(false);
    expect(isPersistedNoOp({ running: false, result: null, costUsd: 0, tokens: 500 })).toBe(false);
  });

  it('never flags a review that recorded a result, or one still running', () => {
    expect(isPersistedNoOp({ running: false, result: 'report-only', costUsd: 0, tokens: 0 })).toBe(false);
    expect(isPersistedNoOp({ running: true, result: null, costUsd: 0, tokens: 0 })).toBe(false);
  });

  it('does not flag a review with no cost fields at all — never run is not the same as no-op', () => {
    expect(isPersistedNoOp({ running: false, result: null })).toBe(false);
    expect(isPersistedNoOp()).toBe(false);
  });

  // Real residue from PR 814: a 12.6KB review.md next to costUsd 0 / tokens 0, because the
  // panel process was killed before onFinish recorded either. Cost is not evidence here.
  it('does not flag a zero-cost run that left a real review behind', () => {
    expect(isPersistedNoOp({ running: false, result: null, costUsd: 0, tokens: 0, hasReview: true })).toBe(false);
    expect(isPersistedNoOp({ running: false, result: null, costUsd: 0, tokens: 0, hasReview: false })).toBe(true);
  });
});

describe('isOrphanedComplete', () => {
  const artifacts = { hasReview: true, hasQualityInputs: true };

  // The three "in-progress" rows on disk (PRs 814, 859, 866). The panel seeds that value at
  // spawn and only onFinish clears it, so a killed process leaves it frozen with nothing running.
  it('reconciles a frozen in-progress review that produced its output', () => {
    expect(isOrphanedComplete({ running: false, result: 'in-progress', ...artifacts })).toBe(true);
    expect(isOrphanedComplete({ running: false, result: ' In-Progress ', ...artifacts })).toBe(true);
  });

  // PRs 1058 and 868: cost WAS recorded, so onFinish ran - the skill just never wrote `result`.
  it('reconciles a review whose result was never written at all', () => {
    expect(isOrphanedComplete({ running: false, result: null, ...artifacts })).toBe(true);
    expect(isOrphanedComplete({ running: false, ...artifacts })).toBe(true);
  });

  it('never reconciles a review that is still running', () => {
    expect(isOrphanedComplete({ running: true, result: 'in-progress', ...artifacts })).toBe(false);
  });

  it('never reconciles a review that has no output to stand on', () => {
    expect(isOrphanedComplete({ running: false, result: 'in-progress', hasReview: false, hasQualityInputs: false })).toBe(false);
    expect(isOrphanedComplete({ running: false, result: null, hasReview: true, hasQualityInputs: false })).toBe(false);
    expect(isOrphanedComplete({ running: false, result: null, hasReview: false, hasQualityInputs: true })).toBe(false);
    expect(isOrphanedComplete()).toBe(false);
  });

  it('leaves an already-recorded verdict alone, including a real failure', () => {
    for (const result of ['report-only', 'pushed-fix', 'failed', 'cancelled', 'blocked']) {
      expect(isOrphanedComplete({ running: false, result, ...artifacts })).toBe(false);
    }
  });
});

describe('runFailureLine / runEndTrailer', () => {
  it('announces a failure and says nothing when the run was fine', () => {
    const bad = classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: 0 });
    expect(runFailureLine('plan', bad)).toMatch(/^✗ run plan FAILED — no-op run/);
    expect(runFailureLine('plan', classifyRunOutcome({ code: 0, costUsd: 1, stageEndDelta: 1 }))).toBeNull();
  });
  it('distinguishes a cancel in the announcement', () => {
    expect(runFailureLine('build', classifyRunOutcome({ cancelled: true })))
      .toBe('✗ run build CANCELLED — cancelled by the operator');
  });
  it('keeps code= in the trailer for continuity and adds the real status', () => {
    const bad = classifyRunOutcome({ code: 0, costUsd: 0, stageEndDelta: 0 });
    expect(runEndTrailer('plan', 0, bad)).toBe('=== run-end plan code=0 status=failed ===');
    const good = classifyRunOutcome({ code: 0, costUsd: 1, stageEndDelta: 1 });
    expect(runEndTrailer('plan', 0, good)).toBe('=== run-end plan code=0 status=success ===');
  });
});

// The end-to-end regression: drive the incident's actual stream through the same steps
// dashboard/server.mjs runs, and assert the panel would now report a failure.
describe('incident replay — dangling skill symlinks', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
    SYNTHETIC_UNKNOWN,
    NOOP_RESULT,
  ];

  function replay(lines, { stageEndsBefore, stageEndsAfter, code }) {
    let result = null;
    let hardError = null;
    const rendered = [];
    for (const raw of lines) {
      const line = formatStreamEvent(raw);
      if (line != null) rendered.push(line);
      const seen = inspectStreamLine(raw);
      if (seen.result) result = seen.result;
      if (seen.hardError && !hardError) hardError = seen.hardError;
    }
    const outcome = classifyRunOutcome({
      code,
      costUsd: result?.costUsd ?? null,
      stageEndDelta: stageEndsAfter - stageEndsBefore,
      resultIsError: !!result?.isError,
      resultSubtype: result?.subtype ?? null,
      hardError,
    });
    return { rendered, outcome };
  }

  it('reports a failure instead of "✓ success · $0.00"', () => {
    const { rendered, outcome } = replay(stream, { stageEndsBefore: 3, stageEndsAfter: 3, code: 0 });
    expect(rendered).not.toContain('✓ success · $0.00');
    expect(rendered).toContain('✗ Unknown command: /resolve-ticket');
    expect(rendered).toContain('✗ no-op (0 turns) · $0.00 · Unknown command: /resolve-ticket');
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(runFailureLine('plan', outcome)).toContain('Unknown command: /resolve-ticket');
    expect(runEndTrailer('plan', 0, outcome)).toBe('=== run-end plan code=0 status=failed ===');
  });

  it('still reports success for the same shape when the run genuinely worked', () => {
    const good = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Planning.' }] } }),
      REAL_RESULT,
    ];
    const { rendered, outcome } = replay(good, { stageEndsBefore: 3, stageEndsAfter: 4, code: 0 });
    expect(rendered).toContain('✓ success · $1.42');
    expect(outcome).toEqual({ ok: true, status: 'success', failure: null });
    expect(runFailureLine('plan', outcome)).toBeNull();
  });
});

// Verbatim tail of the PR-1088 re-review that stopped to ask. It exited 0 and cost $0.77, so
// every pre-existing signal called it a clean success while no new report was written.
const PR_1088_TAIL = `Given a duplicate GitHub comment is a real risk if I re-run the pipeline, I stopped instead of proceeding. What would you like me to do:
1. Just correct \`status.json\` to \`report-only\` (local file only, no GitHub write)
2. Delete/edit the wrongly-posted GitHub comment?
3. Re-review anyway (new commits since, or you want a second look)?`;

describe('isQuestionStop', () => {
  it('catches the real PR-1088 run that halted for input', () => {
    expect(isQuestionStop(PR_1088_TAIL)).toBe(true);
  });

  it.each([
    'Would you like me to open the PR now?',
    'Do you want me to delete the comment first?',
    'Let me know which option you prefer.',
    'Please confirm before I push.',
    'Shall I proceed with the rebase?',
  ])('recognises an ask: %s', (t) => {
    expect(isQuestionStop(t)).toBe(true);
  });

  it('does NOT flag a finished review that merely ends on a question about the code', () => {
    // The distinction that matters: a review raising a question is still a completed review.
    expect(isQuestionStop(
      'Verdict: report-only. One open question for the author: is the 48px band intentional?',
    )).toBe(false);
  });

  it('does not flag a normal completion summary', () => {
    expect(isQuestionStop('Review complete. 4 high, 4 medium, 4 low findings written to review.md.')).toBe(false);
  });

  it('only scans the tail, so an ask quoted mid-report does not count', () => {
    const long = 'What would you like me to do about this?' + ' filler.'.repeat(400) + ' Done.';
    expect(isQuestionStop(long)).toBe(false);
  });

  it('is tolerant of empty input', () => {
    expect(isQuestionStop('')).toBe(false);
    expect(isQuestionStop(null)).toBe(false);
    expect(isQuestionStop(undefined)).toBe(false);
  });
});

describe('questionFrom', () => {
  it('pulls the asking line out of the real run', () => {
    expect(questionFrom(PR_1088_TAIL)).toContain('What would you like me to do');
  });

  it('falls back to the last line when nothing matches', () => {
    expect(questionFrom('all done\nwrote review.md')).toBe('wrote review.md');
  });

  it('returns null for nothing', () => {
    expect(questionFrom('')).toBeNull();
  });
});

describe('classifyRunOutcome - a run that stopped to ask', () => {
  it('is needs-input, not success, even though it spent money', () => {
    const o = classifyRunOutcome({ code: 0, costUsd: 0.77, resultText: PR_1088_TAIL });
    expect(o).toMatchObject({ ok: false, status: 'needs-input' });
    expect(o.failure).toContain('What would you like me to do');
  });

  it('a real completion with the same cost stays success', () => {
    expect(classifyRunOutcome({ code: 0, costUsd: 0.77, resultText: 'Review complete.' }))
      .toEqual({ ok: true, status: 'success', failure: null });
  });

  it('a hard error still outranks an ask', () => {
    const o = classifyRunOutcome({ code: 0, costUsd: 0.77, resultText: PR_1088_TAIL, resultIsError: true });
    expect(o.status).toBe('failed');
  });

  it('a cancel still outranks an ask', () => {
    expect(classifyRunOutcome({ cancelled: true, resultText: PR_1088_TAIL }).status).toBe('cancelled');
  });

  it('an asking run that spent nothing is still needs-input, not a no-op', () => {
    // needs-input is the more useful verdict: there is a question to answer.
    expect(classifyRunOutcome({ code: 0, costUsd: 0, resultText: PR_1088_TAIL }).status).toBe('needs-input');
  });
});
