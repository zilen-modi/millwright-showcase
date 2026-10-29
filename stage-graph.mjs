// The pipeline as an actual graph — the single source of truth for its nodes, its edges,
// and every projection of them. Pure data + pure functions; no I/O, no zod, so schemas.mjs
// and the panel can both build on it without a cycle.
//
// Why this file exists: the node set was already single-sourced and schema-enforced
// (`stage: z.enum(STAGES)`), but there was NO edge set anywhere in the system. The happy
// path was implied by array order, while the real graph has a repair cycle
// (review → build → verify → review), an early exit (preflight → done, skipping build and
// ship entirely), and escalation terminals — all of which lived only in SKILL prose. So
// nothing could detect an ILLEGAL transition: a ticket recording `ship` straight after
// `plan` with no `verify` validated fine, because no code knew which transitions were legal.
// Typed nodes with folklore edges is where pipelines actually go wrong.

/** Pipeline work nodes, in happy-path order. A stage_end event may only name one of these. */
export const STAGES = ['intake', 'route', 'preflight', 'context', 'plan', 'build', 'verify', 'review', 'ship'];

/** States a ticket can rest in that are NOT work stages. `status.json.stage` may hold these.
 * - `done`      — finished with NO PR (verify-and-report, or closed as duplicate)
 * - `merged`    — GitHub confirmed the PR merged (the panel's poller sets this)
 * - `escalated` — handed to a human by any `stop-*` verdict; resumes from its paused stage */
export const TERMINAL_STAGES = ['done', 'merged', 'escalated'];

export const ALL_STATES = [...STAGES, ...TERMINAL_STAGES];

/** The edge set. `when` is the condition that selects this edge — it is documentation the
 * validator can print, not something evaluated here. Every non-obvious edge below exists
 * because the pipeline genuinely takes it; if you add a stage, add its edges here and the
 * derived sets, the validator and the panel all follow. */
export const STAGE_EDGES = [
  { from: 'intake', to: 'route', when: 'always' },
  { from: 'route', to: 'preflight', when: 'always' },

  // The early exit: preflight can end the ticket outright when the work already exists.
  // Building work that already shipped is worse than not running — it burns a full budget
  // to produce a confusing PR.
  { from: 'preflight', to: 'context', when: 'clear-to-build / partially done' },
  { from: 'preflight', to: 'done', when: 'already-done or duplicate → verify-and-report' },

  { from: 'context', to: 'plan', when: 'always' },
  { from: 'plan', to: 'build', when: 'always' },
  { from: 'build', to: 'verify', when: 'always' },

  // The fixer loop inside VERIFY: red gates feed errors back to a fix pass, bounded by
  // config.verifyMaxLoops.
  { from: 'verify', to: 'build', when: 'red — fixer pass, bounded by verifyMaxLoops' },
  { from: 'verify', to: 'review', when: 'green' },

  // The repair cycle: this is the edge that makes the pipeline a graph rather than a list.
  { from: 'review', to: 'build', when: 'loop.mjs → continue, bounded by maxRepairRounds' },
  { from: 'review', to: 'ship', when: 'loop.mjs → done (rubric >= target)' },

  // SHIP's own self-review loop (config.prSelfReview) reviews the PR it just opened, hands
  // high/medium findings back to coder-agent in the SAME worktree, and re-runs VERIFY before
  // pushing again. So work legitimately flows backwards out of ship — this is not a defect,
  // and omitting these two edges made every self-reviewed ticket look illegal.
  { from: 'ship', to: 'build', when: 'prSelfReview found a high/medium finding to fix' },
  { from: 'ship', to: 'verify', when: 'prSelfReview re-runs the gates before pushing a fix' },

  // A re-plan can send the pipeline back for more design context before planning again
  // (resume-notes.md → PLAN, which may need a variant CONTEXT never pulled).
  { from: 'plan', to: 'context', when: 're-plan needs context the first pass missed' },

  // `merged` is set by the panel's merge-poller from GitHub — an EXTERNAL observer that can
  // confirm a merge at any moment, whatever stage the local event log last recorded. Modelling
  // it as reachable only from `ship` would flag the poller's own correctness as a violation.
  ...STAGES.map((from) => ({ from, to: 'merged', when: 'GitHub confirmed the PR merged (panel merge-poller)' })),

  // Escalation is reachable from every work stage — a guardrail can halt anywhere.
  ...STAGES.map((from) => ({ from, to: 'escalated', when: 'stop-* verdict, guardrail halt, or stakes gate' })),

  // Resuming after a human answers an escalation returns to the stage that paused.
  ...STAGES.map((to) => ({ from: 'escalated', to, when: 'human answered — resume the paused stage' })),
];

/** Successor states of `stage`, deduped. */
export function nextStages(stage) {
  return [...new Set(STAGE_EDGES.filter((e) => e.from === stage).map((e) => e.to))];
}

/** Is `from → to` an edge the pipeline is allowed to take? Self-transitions are legal:
 * a stage can re-run in place (a repair round re-running BUILD writes `build` twice). */
export function isLegalTransition(from, to) {
  if (from === to) return true;
  return STAGE_EDGES.some((e) => e.from === from && e.to === to);
}

/** Walk an observed sequence of states and report every illegal hop, with the legal
 * alternatives — so a violation reads as "ship cannot follow plan; plan → build" rather
 * than a bare false. Unknown states are reported too: they mean drift, not a typo. */
export function validateStagePath(path) {
  const seq = (path || []).filter(Boolean);
  const violations = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (!ALL_STATES.includes(s)) {
      violations.push({ index: i, from: seq[i - 1] ?? null, to: s, reason: `unknown state "${s}"`, allowed: [] });
      continue;
    }
    if (i === 0) continue;
    const prev = seq[i - 1];
    if (!ALL_STATES.includes(prev)) continue; // already reported
    if (!isLegalTransition(prev, s)) {
      violations.push({ index: i, from: prev, to: s, reason: `"${s}" cannot follow "${prev}"`, allowed: nextStages(prev) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Every work stage is resumable — `--from <stage>` accepts exactly these. Derived, never
 * re-typed: the panel used to keep a hand-copy of this list, and the SKILL documented a
 * SHORTER one (omitting preflight and context), so a ticket blocked at CONTEXT read as
 * unresumable when the server would in fact have resumed it. */
export const RESUMABLE_STAGES = [...STAGES];

/** The board shows fewer lanes than the pipeline has stages: preflight and context are
 * projected onto their neighbours rather than getting a column each. A declared projection,
 * not drift — but declared HERE so the panel and its TypeScript types derive from one map
 * instead of mirroring each other by hand. */
export const STAGE_COLUMN_FOLD = { preflight: 'route', context: 'plan' };

export const COLUMN_KEYS = [
  'queued',
  ...STAGES.filter((s) => !(s in STAGE_COLUMN_FOLD)),
  'archived',
];

/** Fold a pipeline stage onto the column that displays it. */
export function stageColumn(stage) {
  return STAGE_COLUMN_FOLD[stage] || stage;
}
