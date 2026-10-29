// Zod schemas for Autopilot's config + telemetry. Validating on load turns silent
// config drift (a mistyped mode, a bad cost-model entry, a malformed event line) into
// a clear, early error instead of a wrong dashboard or a surprising autonomous run.
import { z } from 'zod';

const modelRates = z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() });

/** Rubric weights for the repair loop's numeric goal. Tolerant of small drift — sums
 * are checked against 1 within a small epsilon rather than requiring exact equality. */
const RubricWeightsSchema = z
  .object({
    visualDiff: z.number().nonnegative(),
    // Optional so a config written before the functional gate existed still validates; the sum
    // check treats an absent weight as 0, which is exactly what scoreRubric does with it.
    e2e: z.number().nonnegative().optional(),
    acCoverage: z.number().nonnegative(),
    conventions: z.number().nonnegative(),
    a11y: z.number().nonnegative(),
    codeQuality: z.number().nonnegative(),
  })
  .refine(
    (w) =>
      Math.abs(
        w.visualDiff + (w.e2e ?? 0) + w.acCoverage + w.conventions + w.a11y + w.codeQuality - 1,
      ) < 0.01,
    { message: 'rubricWeights must sum to ~1 (within 0.01)' },
  );

export const LoopSchema = z
  .object({
    rubricTarget: z.number().min(0).max(1),
    // null (or absent) = no per-ticket cap. Still `.positive()` when a number is given, so a
    // typo'd 0 is rejected rather than silently read as either "no cap" or "cap everything".
    budgetUsdPerTicket: z.number().positive().nullish(),
    maxRepairRounds: z.number().int().positive(),
    stallRounds: z.number().int().positive(),
    rubricWeights: RubricWeightsSchema,
  })
  .passthrough();

export const CostModelSchema = z
  .object({
    version: z.number(),
    currency: z.string().default('USD'),
    cacheReadMultiplier: z.number().min(0).max(1).default(0.1),
    outputRatio: z.number().min(0).max(1).default(0.3),
    models: z.record(modelRates).refine((m) => '_default' in m, {
      message: 'cost-model.models must include a "_default" entry',
    }),
  })
  .passthrough();

/** Phase 2 control plane — when a stage hands the ticket back to a human instead of
 * shipping/proceeding on its own. */
export const EscalationSchema = z
  .object({
    confidenceThreshold: z.number().min(0).max(1),
    highStakesRequiresHuman: z.boolean(),
    channels: z.array(z.string()),
  })
  .passthrough();

/** Phase 3 — champion/challenger prompt optimization. Sizes for the deterministic
 * improve/holdout split, the margin a challenger must clear to be promoted, the floor
 * under which any holdout regression blocks promotion outright, and the minimum
 * holdout size the eval must have evaluated before a promotion can be trusted at all
 * (see scripts/champion-lib.mjs). */
export const SelfImprovementSchema = z
  .object({
    improveSetSize: z.number().int().positive(),
    holdoutSetSize: z.number().int().positive(),
    promotionMargin: z.number().min(0).max(1),
    minHoldoutCases: z.number().int().positive(),
    regressionFloor: z.number().min(0).max(1),
  })
  .passthrough();

/** Phase 4 — Devil's-advocate builder/critic loop. `maxRounds` bounds how many times the
 * critic gets to poke holes before the loop is forced to stop (see scripts/critic-lib.mjs). */
export const CriticSchema = z
  .object({
    maxRounds: z.number().int().positive(),
  })
  .passthrough();

/** Phase 4 — UX-flow usability rubric. `requiredChecks` names every check the reviewer
 * must record pass/fail for while driving a real browser; `target` is the pass-rate bar
 * (see scripts/ux-lib.mjs). */
export const UxSchema = z
  .object({
    requiredChecks: z.array(z.string().min(1)).min(1),
    target: z.number().min(0).max(1),
  })
  .passthrough();

/** Phase 4 — follow-up tracker for stale open PRs/escalations. `escalateAfterDays` must be
 * at least `nudgeAfterDays` — escalating before ever nudging would skip the courtesy step
 * (see scripts/followup-lib.mjs). */
export const FollowupSchema = z
  .object({
    nudgeAfterDays: z.number().positive(),
    escalateAfterDays: z.number().positive(),
  })
  .passthrough()
  .refine((f) => f.escalateAfterDays >= f.nudgeAfterDays, {
    message: 'escalateAfterDays must be >= nudgeAfterDays',
  });

/** Ad-hoc /review-pr flow: when the PR under review is the user's OWN (author.login ==
 * `gh api user` login), auto-fix findings whose severity is in `fixSeverities` and push to
 * the SAME PR branch — mirrors the existing (unvalidated) `prSelfReview` block's shape 1:1.
 * When the PR is NOT the user's own, this block is never consulted: report-only, no write. */
export const PrReviewSelfFixSchema = z
  .object({
    enabled: z.boolean(),
    fixSeverities: z.array(z.string()),
    maxRounds: z.number().int().positive(),
  })
  .passthrough();

/** The PR inbox poller. `expectLogin` is the gh account this inbox is FOR: a sweep that resolves
 *  a different active account reports the mismatch instead of quietly showing the wrong person's
 *  PRs. Declared rather than left to ConfigSchema's passthrough so a typo'd key is rejected by
 *  POST /api/config instead of silently never polling. */
export const PrInboxSchema = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive(),
    includeOutsideManifest: z.boolean().optional(),
    expectLogin: z.string().min(1).optional(),
    maxOpenPerRepo: z.number().int().positive().max(100).optional(),
  })
  .passthrough();

export const ConfigSchema = z
  .object({
    version: z.number(),
    gates: z.record(z.string()).optional(),
    models: z.record(z.string()).optional(),
    routeConfidenceThreshold: z.number().min(0).max(1).optional(),
    verifyMaxLoops: z.number().int().positive().optional(),
    reviewRepairLoops: z.number().int().nonnegative().optional(),
    branchPrefix: z.string().optional(),
    baseBranch: z.string().optional(),
    testDiscipline: z.string().optional(),
    worktreeDir: z.string().optional(),
    teardownWorktreesAfterShip: z.boolean().optional(),
    prReviewSelfFix: PrReviewSelfFixSchema.optional(),
    prInbox: PrInboxSchema.optional(),
    loop: LoopSchema.optional(),
    escalation: EscalationSchema.optional(),
    selfImprovement: SelfImprovementSchema.optional(),
    critic: CriticSchema.optional(),
    ux: UxSchema.optional(),
    followup: FollowupSchema.optional(),
  })
  .passthrough();

export const QueueSchema = z
  .object({
    version: z.number(),
    jql: z.string().min(1),
    maxPerRun: z.number().int().positive().max(20),
    mode: z.enum(['dry-run', 'build-verify-notify', 'auto-draft-pr']),
    skipIfBranchExists: z.boolean().default(true),
    notify: z.boolean().default(true),
    runLogDir: z.string().optional(),
  })
  .passthrough();

/** One repo-manifest.json entry. Loose/`.passthrough()` — the manifest carries many
 * repo-specific optional fields (subPackages, needs, correction, ...) this schema
 * doesn't need to model; it only pins down what other code actually depends on.
 * `github` (added for the ad-hoc /review-pr flow) is optional so a non-code reference
 * entry like `acme-resources-main` (no git remote at all) stays valid. */
export const RepoManifestEntrySchema = z
  .object({
    id: z.string().min(1),
    buildable: z.boolean(),
    github: z.object({ owner: z.string().min(1), repo: z.string().min(1) }).optional(),
  })
  .passthrough();

export const RepoManifestSchema = z
  .object({
    version: z.number(),
    repos: z.array(RepoManifestEntrySchema).min(1),
  })
  .passthrough();

// The pipeline's nodes and edges live in stage-graph.mjs — the single source of truth. This
// file only VALIDATES against them. Re-exported so existing importers keep working; adding a
// stage means editing the graph, never this line.
export { STAGES, TERMINAL_STAGES, ALL_STATES } from './stage-graph.mjs';
import { STAGES as PIPELINE_STAGES } from './stage-graph.mjs';

export const EventSchema = z
  .object({
    event: z.literal('stage_end'),
    stage: z.enum(PIPELINE_STAGES),
    agent: z.string().optional(),
    model: z.string().optional(),
    status: z.enum(['ok', 'fail', 'blocked', 'review', 'pending']).default('ok'),
    durationSec: z.number().nonnegative().default(0),
    tokensIn: z.number().nonnegative().optional(),
    tokensOut: z.number().nonnegative().optional(),
    tokensTotal: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

/** Parse one JSONL line into a validated event, or null (with a reason) if invalid. */
export function parseEventLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (raw.event && raw.event !== 'stage_end') return { ok: false, reason: 'not a stage_end' };
  const res = EventSchema.safeParse(raw);
  return res.success
    ? { ok: true, event: res.data }
    : { ok: false, reason: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
