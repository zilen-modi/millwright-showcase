# Champion/challenger — self-improving prompts (Phase 3)

Autopilot's agent prompts (`.claude/agents/*.md`, the story-reviewer rubric, etc.) are
themselves a target for improvement, but a prompt change is a META-change: it can
silently regress every future ticket, not just the one you were testing against. This
loop makes that improvement measurable and safe by reusing the eval loop's own scoring
model (`scripts/eval-lib.mjs`'s `scoreDiff`) and case bank (`eval/golden-set.json`)
instead of inventing a second one.

## The loop

1. **Propose a challenger.** Draft a candidate prompt for an agent (e.g. a revised
   `coder-agent.md`) alongside the current champion — never edit the champion prompt
   in place while testing.
2. **Score both on the improve-set (tune).** Run each golden-set case's ticket
   through champion and challenger separately, capture the produced diff, and score it
   with `eval.mjs --mode diff` (or the underlying `scoreDiff`) against that case's
   `expect` block. Use these scores to iterate on the challenger. This is the only
   phase where you're allowed to look at the scores and adjust the prompt.
3. **Score both on the holdout (validate) — and stop looking until you commit to a
   verdict.** Once the challenger is frozen, run the SAME scoring over the holdout
   split — cases the challenger was never tuned against. Save each side's results as a
   `[{key, score}]` JSON file (see `scripts/champion.mjs`'s usage comment for the
   shape).
4. **Get the verdict.**
   ```
   node scripts/champion.mjs --agent coder-agent \
     --champion champion-scores.json --challenger challenger-scores.json
   ```
   This restricts both score sets to the deterministic holdout split
   (`scripts/champion-lib.mjs`'s `splitCases`, keyed off `config.json`'s
   `selfImprovement` sizes) and applies `promotionDecision`'s three gates:
   holdout coverage, margin, and no-regression. See that function's doc comment for
   the exact rule. It prints PROMOTE or HOLD (+ reason) and exits non-zero on HOLD.
5. **A human approves the promotion.** A PROMOTE verdict is advisory, not automatic —
   promoting a prompt is a meta-change gated the same way SHIP is: a human reviews the
   challenger prompt and the holdout numbers, then runs
   `recordPromotion(registry, { agent, fromVersion, toVersion, delta, holdoutN })`
   (from `scripts/champion-lib.mjs`) to append the promotion to `promotionLog` and
   bump `champions/registry.json`'s champion version. Nothing in this package flips
   that switch on its own.

## Why `champion.mjs` currently always says HOLD

`eval/golden-set.json` only has 2 entries today. `config.json`'s `selfImprovement`
defaults (`improveSetSize: 25`, `holdoutSetSize: 15`, `minHoldoutCases: 10`) mean the
holdout split comes back empty, and `promotionDecision` correctly refuses with
`insufficient holdout (0 < 10) — cannot promote without risking overfit`. **That's the
overfit guard doing its job, not a bug** — a "promotion" validated against a
handful of cases (or zero) is not validated at all; it would just be memorizing the
tune set. Grow `golden-set.json` as more tickets ship (see `eval/README.md`) and this
gate opens up naturally once there's enough unseen ground truth to trust a verdict.

## Files

- `champion/registry.json` — the champion registry: current prompt version + ref per
  agent, and an append-only `promotionLog`.
- `scripts/champion-lib.mjs` — pure split/aggregate/decide/record logic
  (`tests/champion-lib.test.mjs`). No filesystem, no `Math.random`, no `Date` —
  determinism matters so the same two score sets always produce the same verdict.
- `scripts/champion.mjs` — the IO wrapper (CLI, guarded reads, verdict printing).
