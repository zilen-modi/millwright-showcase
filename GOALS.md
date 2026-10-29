# Autopilot — Goals

Working document. Created 2026-08-09 from the pipeline-integrity review of 25 real ticket runs.
Each goal carries **why**, **what**, and an **acceptance check** — a command or query that proves
it, not a claim that it's done. Tick a box only when its acceptance check passes.

> **Scope note.** "Frontend" in Goal B means the **Autopilot control panel** (`dashboard/panel/*`),
> not the ERP design system. `erp-next-ui-monorepo` / `ui-kit-v2` stays SCSS-modules + Figma tokens —
> that kit *is* Autopilot's product, and moving it to shadcn would nullify the design-fidelity work.

---

## Goal A — Make the pipeline unable to lie to itself

**The finding.** Every gate downstream of BUILD is enforced by prompt text, so the orchestrator can
satisfy a gate by asserting it passed. Measured across the 25 tickets in `tickets/`:

| Designed behaviour | Actual |
|---|---|
| Per-node screenshot diff is "an objective gate, not an eyeball" | **0** `visual-diff-report.json` exist anywhere |
| `loop.mjs` scores every review round | 11/25 have `rubric-inputs.json`; 4/25 have `rubric.jsonl` — vs 26 `review` events |
| `loop.budgetUsdPerTicket: 5` | 5 tickets exceeded it (2908 $10.34, 2825 $10.04, 2899 $7.47) |
| Artifact written after every stage | 15/25 ticket dirs missing `verify.md` / `review.md` / `ship.md` |
| "Delegate every stage — never inline" | 80/266 events self-labelled `estimated` (30%) |

PROJ-3027, 3016 and 3025 all **hard-fail `loop.mjs` today** (`visualDiffPassRate=1` with no
evidence). All three shipped and merged. The gate is correct; it was never in the path.

**The cost.** PROJ-3012 (radio font), 3014 (radio geometry), 3022 (multiselect padding),
3025 (tag dark colours), 3028 (tag vertical padding) are all design-fidelity defects filed against
components Autopilot itself shipped — while the rubric reported ≥0.965 on essentially everything.
The rubric measures the reviewer's confidence, not the artifact.

### A1 — `loop.mjs` becomes the only writer of `rubricScore` `[x]`

Today the score is model-written into `status.json` and [`server.mjs:345`](dashboard/server.mjs#L345)
displays it as if computed. Make `loop.mjs` append `rubric.jsonl` and patch `status.json.rubricScore`
itself, stamped with the branch HEAD sha it scored. Nothing else may write that field.

- **Acceptance:** `grep -rn 'rubricScore' .claude/ | wc -l` → `0`; every `status.json` with a
  `rubricScore` has a matching final `rubric.jsonl` line carrying the same sha.

### A2 — The panel's ship path refuses an unscored ticket `[x]`

`--auto-ship` / Continue must hard-refuse unless the last `rubric.jsonl` line references the current
branch HEAD. Enforce in `server.mjs` at spawn time, not in SKILL prose.

- **Acceptance:** replay a ticket with a stale/absent `rubric.jsonl` → the run is rejected with a
  readable reason and no PR is opened. Add a `tests/` case.

### A3 — Close the `visualDiffSkipReason` hole `[x]`

[`rubric-lib.mjs:72`](scripts/rubric-lib.mjs#L72) awards `rate: 1` for *any* non-empty string — a free
0.30. The post-PROJ-2998 fix only moved the self-report from a number to a sentence (PROJ-2910
used it). Two changes:

1. A skip **excludes** the dimension and renormalizes the remaining weights — never scores a perfect 1.
2. A skip is **refused** when `design.md` enumerated variants; the ticket folder already holds the
   proof of whether a visual diff was possible.

- **Acceptance:** unit tests in `tests/rubric-lib.test.mjs` for both; re-running `loop.mjs` over
  PROJ-2910's inputs no longer yields a passing visualDiff dimension.

### A3½ — "not applicable" and "could not run" are different verdicts `[x]`

Closing A3 exposed a second-order version of the same bug: **exclusion itself became the
loophole.** With the skip no longer paying out 1.0, a dimension whose check simply *could not
run* was still dropped and the rest renormalized — so PROJ-3016 scored a clean **1.000 / done**
with two of five dimensions gone (visual diff skipped, conventions unlintable because the
worktree had been torn down). A perfect score resting on three checks.

The rubric now separates them: `excluded` (genuinely not applicable — no variants enumerated,
logic-only diff) still renormalizes and may pass; `unmeasured` (no worktree, no linter, no
browser) also drops from the arithmetic but forces `action: "stop-unverified"` regardless of
score, outranking even the budget and round caps. Naming a dimension in both lists resolves to
`unmeasured`, so an infrastructure failure cannot be laundered into a clean exclusion.

- **Acceptance:** ✅ PROJ-3016 now reports `score 1.000 … not met`, `unmeasured: conventions ←
  blocks "done"`, `action: stop-unverified`, exit 1.

### A4 — Headless visual diff actually runs `[~]` — built, blocked on one target-repo dep

PROJ-2910's skip reason ("no browser/Playwright/Storybook in headless") is a real infrastructure
gap that will recur on every headless UI ticket, and it is the direct cause of A3 being needed.

**Built and verified:** `scripts/story-capture-lib.mjs` (pure: iframe-URL building, variant×theme
expansion, story↔Figma pairing, coverage verdict — 20 tests) and `scripts/story-capture.mjs`
(Playwright driver; serves a `storybook build` output over loopback, captures each variant per
theme, emits a `visual-diff.mjs` manifest naming ONLY pairs that exist on both sides). Playwright +
Chromium are installed in `millwright/` and launch/screenshot correctly. A missing capture is a hard,
actionable failure — never a silent skip. Partial coverage exits non-zero on purpose: partial
evidence reads as "we checked", and the uncaptured variants are where regressions hide.

**Blocked on:** `storybook build` fails in the current `erp-next-ui-monorepo` checkout —
`react-toastify` is declared in `packages/erp-next-ui-kit-v2/package.json` (devDependency + optional
peer) but is **not present in `node_modules`**, so `src/components/Notification/transitions.ts`
cannot resolve `cssTransition` and the preview bundle fails. The checkout is stale relative to its
own manifest; this is a target-repo dependency state, not an Autopilot defect. Deliberately NOT
fixed here — Autopilot must never mutate a primary checkout.

- **Unblock (your call, in the monorepo):** `yarn install` — then
  `node scripts/story-capture.mjs --key <KEY> --stories <plan.json> --static <storybook-static>`
  followed by `node scripts/visual-diff.mjs --manifest tickets/<KEY>/visual-diff-manifest.json`.
- **Acceptance (still open):** one UI ticket run end-to-end headless produces
  `visual-diff-report.json` with per-variant verdicts, and `loop.mjs` scores from it.

### A5 — `conventionViolations` and `a11yFailures` become mechanical `[x]` (conventions) · `[ ]` (a11y/axe)

Both are self-reported integers today. At least half of [`conventions.md`](conventions.md) is
grep-able right now: no raw hex, no `Figma`/node-ids in comments or test titles, no `TODO`/`FIXME`,
no comment over 3 lines, flat folder structure, branch-name shape. Build
`scripts/conventions-lint.mjs` and have `loop.mjs` call it. Same argument for a11y via axe over the
Storybook stories.

- **Acceptance:** `node scripts/conventions-lint.mjs --diff <patch>` returns a count; `loop.mjs`
  ignores any `conventionViolations` supplied in `rubric-inputs.json`.

### A6 — Lessons become tests, not hopes `[x]`

`champion/registry.json` has **0** promotions, `eval/golden-set.json` has **2** cases, and
`eval/eval-report.json` is from Aug 3 — the self-improvement phase is scaffolding that never ran.
The harness already does the right shape of check (`file-overlap`, `must-contain`,
`no-raw-hex-in-components`). Every human correction that becomes a `conventions.md` rule should also
become a golden-set case.

- **Acceptance:** golden set ≥ 15 cases, one per conventions rule; `npm run eval` runs in CI-style
  and "did lesson N regress?" is answerable by a command.

### A7 — Measure the escaped-defect rate `[x]`

The only honest KPI. Trace each new UI-fidelity ticket back to the PR that shipped the component
(data is in `tickets/*/status.json` + `gh`) and report defects-per-shipped-component. Rubric-vs-
escaped-defects is also the only way to tell whether the rubric weights are right.

- **Acceptance:** `scripts/regression-trace.mjs` emits the rate; it appears on the panel's Cost page.

### A8 — Operational hygiene `[x]` (scheduler question still open)

- **Commit the system.** One commit (`84a606f`) covers everything, with 20 modified + 10 untracked
  files uncommitted — including `quality-agent`, `dup-scan`, and the review panel. A system that
  rewrites its own agent prompts and keeps a promotion registry cannot answer "which prompt shipped
  PROJ-3025?". Do this **first** — A1/A6 depend on having history.
- `scripts/jira.mjs` (most network-dependent script) and `scripts/preflight.mjs` don't use
  `guard.mjs`, against the SKILL's "non-negotiable" rule.
- PROJ-2910 has sat at `blocked-worktree-mismatch` since 2026-08-07 — nothing sweeps stalled tickets.
- ~~`scheduler.enabled: true` at 360 min, but the last recorded queue run is 2026-07-31 — either it
  isn't running or it isn't recording.~~ **Answered: it was running and recording nowhere.**
  `runScan()` held `lastScan` in a module variable only, so (a) `queue-runs/` gained no file
  despite scans happening, and (b) every panel restart reset `lastScan.at` to null, which made
  `schedulerTick`'s `!lastScan.at` branch fire an immediate Jira scan on boot regardless of the
  360-minute interval. Now persisted to `queue-runs/last-scan.json` (resume state) and appended
  to `queue-runs/scans.jsonl` (audit trail); `runs.jsonl` is untouched because it records queue
  runs that resolved tickets, and a scan is not one. Verified across a restart: `lastScanAt`
  and `nextRunAt` both survive.

**Keep as-is:** stage decomposition, worktree isolation, model tiering (cost fell $10.34 → ~$2/ticket,
avg $3.36 over 23), the MCP boundary for intake/review, the preflight duplicate gate, and the
human-merge line. 18 merged PRs is a real result — the fix is integrity, not redesign.

---

## Goal B — Move the control panel to React + shadcn

**Why.** The panel is now the primary interface to Autopilot (launch, board, cost, PR review,
config) and it's 5 hand-written HTML pages driving `document.createElement` by hand
([`kanban.js`](dashboard/panel/kanban.js) rebuilds the board imperatively and hand-manages
`logs` / `openDrawers` / `collapsedCols` across full re-renders) against a 481-line stylesheet.
Every new surface — the escaped-defect view from A7, richer rubric evidence, run diffing — costs
more than it should, and state bugs across re-renders are structural.

**Target stack.** Vite + React + TypeScript + Tailwind + shadcn/ui, built to static assets that the
existing `dashboard/server.mjs` serves. **The API contract does not change** — `/api/state`,
`/api/cost`, `/api/ticket`, `/api/log`, `/api/stream` (SSE) and the POST actions stay exactly as they
are, so the server keeps being the single source of truth and the migration is front-of-the-wire only.

### B1 — Scaffold + build wiring `[ ]`

- `dashboard/ui/` — Vite + React + TS + Tailwind + shadcn, building to `dashboard/panel-dist/`.
- `npm run panel:dev` → Vite dev server proxying `/api/*` to `server.mjs` (HMR while developing).
- `npm run panel` → build, then serve. **The panel must never serve stale assets** — this is the one
  real regression risk, since today there is no build step at all.
- `server.mjs` serves `panel-dist/` with an SPA fallback; the old `dashboard/panel/*` stays until B4.

### B2 — Design tokens → shadcn theme `[ ]`

[`panel.css`](dashboard/panel/panel.css) already defines a coherent system — cool-neutral palette,
one indigo accent, functional per-phase colours (`--ph-intake` … `--ph-archived`), light/dark via
both `prefers-color-scheme` and `data-theme`. Port these to the shadcn theme layer rather than
inventing a new palette; keep the per-phase accents as first-class tokens (the board reads by colour).

- **Acceptance:** light and dark both render correctly, and the explicit `data-theme` toggle still
  wins over the OS preference in both directions.

### B3 — Port the surfaces `[ ]`

One route at a time, each replacing its HTML page only when it's at parity:

- **Console** (`/`) — live run log, SSE-driven.
- **Board** (`/board`) — the phase kanban: ticket cards, on-card live-log drawers, the detail side
  drawer, manual archive, and the human-in-the-loop PLAN gate (approve → build / re-plan). The
  highest-value port; all the hand-managed re-render state becomes component state.
- **Cost** (`/cost`) — spend by stage/ticket, plus the A7 escaped-defect rate.
- **Review** (`/pr-review`) — the ad-hoc `/review-pr` flow.
- **Config** (`/config`) — including the `paused` kill-switch.

### B4 — Modernise the experience `[ ]`

Not a reskin — the things the current panel can't do:

- Optimistic run launches with proper pending/failed states (today a POST just reloads).
- Keyboard-first: command palette (`⌘K`) to launch a ticket, jump to a key, or pause.
- Real toasts for run start / block / merge-detected instead of silent state changes.
- Accessible drawers, dialogs and focus management from shadcn primitives — the panel currently
  hand-rolls these, and it's ironic to ship a11y tickets from a tool that fails them.
- Responsive down to a laptop split-screen.
- **Acceptance:** axe clean on every route; delete `dashboard/panel/*` and the legacy `sendStatic`
  routes once parity is signed off.

### Constraints

- No change to the JSON/SSE contract, the merge-poller, or `spawnClaudeRun`'s argv discipline
  (`KEY_RE` stays the only free text reaching a spawned command).
- Panel stays local-only and dependency-light at runtime — build-time deps are fine, but the served
  bundle must remain self-contained (no CDN, no external fonts), matching today's behaviour.
- The static `dashboard/index.html` + `build-dashboard.mjs` generator is separate and out of scope.

---

## Sequencing

1. **A8 commit hygiene** — nothing else is safely reversible without it.
2. **A1 + A3** — smallest diff, largest gain in trustworthiness (A3 is ~30 lines + tests).
3. **A2 + A4** — makes the gate real end-to-end rather than merely correct.
4. **A5 + A6 + A7** — turn claims into checks and lessons into tests.
5. **Goal B** — B1–B3 in parallel with the A-tail; B4 last.

Goal A protects correctness of shipped code; Goal B protects the operator's ability to see it.
If they compete for time, **A wins** — a prettier panel over ungated output makes the wrong number
easier to read.
