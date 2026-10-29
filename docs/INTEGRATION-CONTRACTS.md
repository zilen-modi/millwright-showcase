# Integration contracts

Interfaces that more than one component depends on. Fixed up front so the pieces of
[GOALS.md](../GOALS.md) can be built independently and still fit together. **Do not change a
shape here without updating every consumer listed under it.**

---

## 1. `rubric.jsonl` — the scoring receipt (Goal A1)

`scripts/loop.mjs` is the **only** writer. One JSON object per line, appended per scored round.

```json
{
  "key": "PROJ-3027",
  "round": 1,
  "score": 0.93,
  "breakdown": { "visualDiff": 1, "acCoverage": 1, "conventions": 1, "a11y": 1, "codeQuality": 0.9 },
  "weights": { "visualDiff": 0.3, "acCoverage": 0.25, "conventions": 0.17, "a11y": 0.13, "codeQuality": 0.15 },
  "excluded": [],
  "unmeasured": [],
  "pinned": [],
  "reachableScore": null,
  "action": "done",
  "reason": "score 0.930 >= target 0.900",
  "sha": "a1b2c3d4e5f6...",
  "shaSource": "worktree",
  "visualDiff": { "source": "report", "rate": 1, "reason": null },
  "spentUsd": 3.02,
  "budgetUsd": 5,
  "scoredAt": "2026-08-09T12:00:00.000Z"
}
```

- `sha` — the **HEAD commit of the branch that was scored**, resolved by `loop.mjs` via
  `git -C <worktree> rev-parse HEAD`. This is what makes the score unforgeable: it binds a number
  to a tree. When no worktree can be resolved, `sha` is `null` and `shaSource` is `"unavailable"`.
- `action` — one of `done | continue | stop-budget | stop-rounds | stop-stall | stop-unverified`.
- `excluded` vs `unmeasured` — **different claims, and only one may end in a pass.**
  `excluded` means the dimension is genuinely *not applicable* (no variants enumerated;
  a logic-only diff): its weight is dropped and the rest renormalized. `unmeasured` means
  the check *could not run* (no worktree, no linter, no browser) — also dropped from the
  arithmetic, but it forces `action: "stop-unverified"` regardless of score. Collapsing
  the two is how PROJ-3016 scored a clean 1.000 on three of five dimensions.
- `pinned` / `reachableScore` — a **third** claim, distinct from both: the dimension was
  measured, it failed, and a human ruled that failure a deferral for this ticket. Its weight is
  dropped and the rest renormalized, and `action` may then be `done` at a raw `score` *below*
  target — `reachableScore` is the number that actually cleared the bar. Two independent keys
  are required and neither is sufficient alone: an approved entry in
  `tickets/<KEY>/e2e-flows.json` and `tickets/<KEY>/e2e-report.json` — the functional browser gate.
The flows file is AUTHORED (never generated) and its presence is what makes the `e2e` dimension
applicable at all: without it the dimension is excluded and the ticket scores as it did before the
gate existed. The report is written by `scripts/e2e.mjs` as `{ key, appBase, flows: [{ name,
status, steps, failedStep, error }], pass }`, and `loop.mjs` RECOMPUTES the rate from the per-flow
verdicts — the `pass` summary is never trusted. A flow status is `PASS`, `FAIL`, or `BLOCKED`;
`BLOCKED` means the flow never executed (no session, app down) and is excluded from the rate, so a
report with nothing but `BLOCKED` is **unmeasured**, not a zero. A flow containing a write step
needs `"writes": true` in the spec AND `--allow-writes` on the command: two consents, because a
spec can be written by an agent and the backend is real.

`tickets/<KEY>/deferrals.json`, **and** the dimension provably flat across the last
  `stallRounds` receipts. A declaration on its own is a self-issued discount; flatlining on its
  own forgives work nobody did. PROJ-3645 is the case: visualDiff and a11y both sat at 0 for
  three rounds, but only the product-thumbnail deferral was ruled, so a11y stayed in the
  arithmetic and the loop kept repairing. Anything still in the arithmetic is held to the full
  target. When `pinned` is non-empty, **every human-visible surface must state the raw score
  and what was set aside** — a PR that hides it is the failure this key exists to prevent.
- `breakdown`/`weights` — post-renormalization (see §2), so the line is self-explaining.

`tickets/<KEY>/deferrals.json` — `{ "deferrals": [{ "dimension", "id", "reason", "approvedBy" }] }`.
Written by a human (or by REVIEW recording a human's ruling), never by the loop. `approvedBy` must
be non-empty or the entry is ignored.

`loop.mjs` **also** patches `tickets/<KEY>/status.json` with `rubricScore`, `rubricSha`,
`rubricRound` and `rubricScoredAt`. **Nothing else may write `rubricScore`** — not the
orchestrator, not an agent, not by hand.

**Consumers:** `dashboard/server.mjs` (ship gate §3, board display), `dashboard/ui` (Cost/Board).

---

## 2. Rubric dimension exclusion (Goal A3)

A dimension may be **excluded**, which is not the same as scoring 1.0. When excluded, its weight is
removed and the remaining weights are renormalized to sum to 1.

`scoreRubric(inputs, weights, target)` returns:

```js
{ score, breakdown, weights, excluded: ['visualDiff'], pass }
```

- `breakdown` omits excluded dimensions entirely (never `1`).
- `weights` is the renormalized set actually used.
- Excluding **every** dimension is an error, not a perfect score.

`resolveVisualDiff(inputs, report, opts)` returns
`{ rate, verified, source, reason, excluded }` where `source ∈ report | skip | unverified | none`.
A `visualDiffSkipReason` yields `{ excluded: true }` — **never `rate: 1`** — and is **refused**
(`verified: false`) when `opts.designEnumeratedVariants === true`, i.e. the ticket's `design.md`
enumerated variant nodes and therefore a visual diff was possible.

---

## 3. Ship gate (Goal A2) — `dashboard/server.mjs`

**Which modes are gated, and why not all of them.** `build`, `review` and `continue` RUN the
review stage and therefore *write* the receipt via `loop.mjs`. Gating them at spawn deadlocks the
panel: the run is refused for lacking the very artifact it exists to produce, so a ticket can
never earn its first receipt — and the rejection tells the operator to "run the review stage",
which is the button they just pressed. Those modes are **not** gated here; their shipping
decision is made afterwards by the orchestrator's `--auto-ship` gate reading the receipt
`loop.mjs` has by then written.

Only **`ship`** (`--from ship --yes`) is gated at spawn — it jumps straight to opening a PR,
consuming a receipt it never produces, so the check is both meaningful and non-circular.
`plan`/`replan` stop at the plan gate and can never open a PR.

Before spawning a `ship` run, the server must verify the ticket's scoring receipt:

1. Read the **last** line of `tickets/<KEY>/rubric.jsonl`. Missing/unparseable → **reject**.
2. `action` must be `"done"` → else **reject**.
3. `sha` must equal `git -C <worktree> rev-parse HEAD` for the ticket's worktree → else **reject**.
   `sha: null`, a missing worktree, or a failed `rev-parse` → **reject** (fail closed).

Rejection is HTTP **409** with `{ error, reason, key }` — a readable sentence, surfaced in the UI.

**Escape hatch, deliberately narrow:** the manual `ship` mode (`--from ship --yes`) accepts
`{ "override": true }` in the POST body. The UI must render this as an explicit confirmation naming
what is unverified. Every override appends a line to `tickets/<KEY>/events.jsonl` with
`"event":"ship_gate_override"` and the reason. Automated paths can never set it.

---

## 4. `conventions-lint` (Goal A5)

**CLI** — `node scripts/conventions-lint.mjs [--diff <patch>] [--files a,b,c] [--repo-root <dir>] [--branch <name>] [--json]`

`--json` prints exactly:

```json
{ "count": 2, "violations": [ { "rule": "no-raw-hex", "file": "src/…/Tag.module.scss", "line": 42, "detail": "raw hex #0f62fe — bind a token" } ] }
```

Exit `0` when `count === 0`, `1` otherwise. Non-JSON mode prints a readable list.

**Lib** — `scripts/conventions-lint-lib.mjs`, pure (no fs):
`lintSources(sources, opts) -> { count, violations }` where `sources` is
`[{ path, text }]`. Unit-tested in `tests/conventions-lint-lib.test.mjs`.

**Rules** (each grep-able, each traceable to a line in [`conventions.md`](../conventions.md)):

| `rule` | Catches |
|---|---|
| `no-raw-hex` | `#rgb`/`#rrggbb` in component sources — excludes token-definition files |
| `no-figma-refs` | `Figma`, `spec node`, `per Figma`, node ids (`3091-1058`, `1346:2928`) in comments/test titles |
| `no-todo-fixme` | `TODO` / `FIXME` in shipped source |
| `comment-max-3-lines` | a `//` comment block longer than 3 consecutive lines |
| `flat-component-structure` | `components/` or `hooks/` subdirectory inside a component dir |
| `no-tool-branding` | `Autopilot`, `🤖`, `Generated with`, `Co-authored-by` in source or commit text |
| `branch-name-shape` | branch not matching `{type}/PROJ-{n}-{kebab-desc}` (only with `--branch`) |

**Consumer:** `loop.mjs` computes `conventionViolations` by calling this lib and **ignores any
`conventionViolations` supplied in `rubric-inputs.json`**.

---

## 5. Panel build output (Goal B1)

- The React app lives in `dashboard/ui/`, builds to **`dashboard/panel-dist/`** (gitignored).
- `dashboard/server.mjs` serves `panel-dist/` when it exists, with an **SPA fallback**: any GET that
  is not `/api/*` and not a real file → `panel-dist/index.html`. When `panel-dist/` is absent it
  falls back to the legacy `dashboard/panel/*` pages, so the panel never dies mid-migration.
- Server port stays **4317**. Vite dev server proxies `/api/*` → `http://127.0.0.1:4317`.
- `npm run panel` **builds then serves** — it must never serve stale assets.
  `npm run panel:dev` runs Vite with HMR against a separately-running server.
- The bundle must be self-contained: no CDN, no external fonts, no runtime network beyond `/api/*`.

**The JSON/SSE API contract does not change.** `GET /api/state`, `/api/cost`, `/api/config`,
`/api/ticket`, `/api/log`, `/api/pr-reviews`, `/api/pr-review`, `/api/stream` (SSE); `POST /api/run`,
`/api/pr-review`, `/api/archive`, `/api/unarchive`, `/api/cancel`, `/api/cron`, `/api/queue-run`,
`/api/pause`, `/api/config`, `/api/check-merge`.

---

## 6. `regression-trace` (Goal A7)

**CLI** — `node scripts/regression-trace.mjs [--json]`

Links each shipped ticket to the components it touched, then attributes later fidelity tickets
against those components back to the PR that introduced them.

```json
{
  "shipped": 20,
  "escaped": 9,
  "escapedDefectRate": 0.45,
  "byComponent": [ { "component": "Tag", "shippedBy": "PROJ-2825", "escapes": ["PROJ-3025", "PROJ-3028"] } ],
  "rubricCorrelation": { "verdict": "…", "escapeMeanRubric": 0.991, "cleanMeanRubric": 0.993 },
  "escapeDetails": [], "heuristicValidation": {}, "notes": []
}
```

**Consumers:** the panel Cost page. `/api/cost` gains a `regression` block that wraps this with
`{ pending, error, computedAt, stale }`. The trace walks the target repo's git history (~4s), far
too slow to run inside a request — the server computes it on a 10-minute TTL, serves the cached
value, and refreshes in the background. A request never waits on it; `pending: true` on the very
first call must render as "computing", never as a zero, and `stale` is shown rather than hidden.

---

## 7. Pipeline stage graph (`stage-graph.mjs`)

The **single source of truth** for the pipeline's nodes, edges and every projection of them.
`schemas.mjs` imports `STAGES` from here and only *validates* against it; `dashboard/server.mjs`
derives `RESUMABLE_STAGES`, the board's column keys and the column fold from it. Nothing may
re-type any of these lists.

- `STAGES` — the 9 work nodes, in happy-path order. A `stage_end` event may name only these.
- `TERMINAL_STAGES` — `done` (finished with no PR), `merged` (GitHub confirmed), `escalated`.
  `status.json.stage` may hold these; events may not.
- `STAGE_EDGES` — `{from, to, when}`. The pipeline is **not a line**: it has a repair cycle
  (`review → build → verify → review`), a fixer loop (`verify → build`), an early exit
  (`preflight → done`), SHIP's self-review flowing backwards (`ship → build|verify`), and
  escalation reachable from everywhere. `merged` is reachable from any stage because the
  merge-poller observes GitHub asynchronously.
- `isLegalTransition(from, to)` / `validateStagePath(path)` — a violation names the offending
  hop and the legal alternatives. Self-transitions are legal (a repair round re-runs BUILD).
- `RESUMABLE_STAGES` — every work stage. `--from` accepts exactly these.
- `COLUMN_KEYS` / `stageColumn()` — the board's declared projection: `preflight` folds onto
  `route`, `context` onto `plan`. Only the human labels live in `server.mjs`.

**Auditor:** `node scripts/validate-graph.mjs [--key K] [--json]` walks each ticket's
`events.jsonl` plus its resting `status.json` state and reports every undeclared transition.
Exits non-zero, so it can gate CI. This is what makes "did this ticket actually pass through
VERIFY?" answerable — the node set was schema-enforced from the start, but the *order* never
was, so a ticket recording `ship` straight after `plan` validated exactly as cleanly as one
that walked the whole pipeline.
