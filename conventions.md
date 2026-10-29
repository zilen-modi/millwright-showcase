# Autopilot — accumulated conventions (the learning loop)

Every BUILD (coder-agent) MUST read this file and follow it. When a human corrects Autopilot's
output, the correction is distilled into a rule here (a "reflection" step) so the same mistake is
never made twice. Newest lessons appended at the bottom.

> **🔒 = already machine-checked** by `scripts/conventions-lint.mjs`, which `coder-agent` runs
> before committing and `loop.mjs` re-runs during REVIEW (it ignores any hand-supplied violation
> count). You still have to *not violate* these — but you don't have to police them by eye, and
> you can't argue with the result. Everything unmarked is a **judgement call**: no tool will catch
> it, so it is where your attention actually belongs. When a new lesson lands here, check whether
> it can be mechanised into 🔒 rather than left as prose — see the Learning-loop section of
> `.claude/skills/resolve-ticket/SKILL.md`.

## Tokens & colour
- 🔒 **No raw hex.** Bind to the kit's semantic tokens.
- **Resolve every Figma token name → hex → the token the KIT actually applies for that hex.** Never
  match a Figma variable *name* blindly. Example that bit us: field focus in Figma reads
  `border-interactive` (#006adc), but the kit's real field-focus convention is the `interactive`
  token (#0f62fe), which shipped siblings (SearchInput/TextInput) apply by overriding the shell.
  Check the nearest sibling component before choosing a focus/border token.
- **A shared-token change has kit-wide blast radius.** Changing e.g. `skeleton-background` touches
  every skeleton + all its SCSS spec tests. Enumerate all consumers and update every token test.

## Design fidelity vs. judgement
- **Do NOT blindly "match Figma" when it conflicts with a11y / contrast / dark-theme.** Flag it as a
  design escalation instead of shipping a regression. Examples: `text-disabled` (#161616 @25% alpha)
  fails WCAG and is invisible in dark; `tag-red` light pair is 3.46:1. Bind to the safe themed token
  and record the shortfall in a test; escalate.
- **Per-variant, not aggregate.** Pull EVERY variant node (State × Selection × Display × Direction ×
  Size), diff each. Per-variant details (focus token, read-only tag colour, multi-line layout) live
  only in their own node.
- **An unused import in a dev-mode response means the generator DROPPED an instance — re-query the
  leaf node before you record an absence** (learned PROJ-3645). `get_design_context` on the parent
  row node returned the status cell as an empty self-closing element, and CONTEXT wrote down "the
  Over state renders no badge". It emitted `import Tag from ".../Tag.tsx"` at the top of that same
  response and never used it — that dangling import was the tell. Querying the status cell node
  **directly** returned `<Tag label="Over 5" type="Dot" size="Medium" color="Red" outline="True" />`.
  Shipping the parent's answer would have missed a badge on 2 of 8 variants.
  **The rule: "the design shows nothing here" is a positive claim and needs its own node query.**
  An absence inherited from a parent node is not evidence. Cross-check the rendered screenshot
  against the config whenever you are about to record that something is missing — and when they
  disagree, query the leaf; do not just prefer one source.

## Component behaviour rules (learned)
- **Read-only ≠ Disabled.** Read-only keeps full-colour tags/content; only *disabled* mutes them.
- **Warning state = message only, normal border** (per user), even if Figma shows a coloured border.
  Error keeps its coloured border.
- **Multi-line fields:** the right-side actions cluster is vertically **centered** across wrapped
  rows (`align-self: center`), and the field width must be **definite/stable** — never let a
  shrink-wrap parent make the field resize as content (tags) is added/removed.
- 🔒 **Flat folder structure.** Match peer components (Checkbox/Tag/TagGroup) — no `components/` or
  `hooks/` subfolders inside a component dir.

## Stories / examples
- **Standard story set for any input:** states + **Controlled** (`value`/`onChange`) + **form
  integration** (react-hook-form via `Controller`, shows the error state on empty submit).
- Demo wrappers must give the component a **definite width** so it doesn't jitter on interaction.

## Tests
- 🔒 **No test file for a React component, and none for a `constants` module.** Not as part of a
  fix, not as a regression pin. A constants test restates the constant; a component render test
  pins markup that design churn rewrites anyway. Both cost review time without catching defects.
  Operator asked for these to be deleted on PR #1079 and PR #1116 before making it a rule.
- Tests for **pure logic are still wanted**: helpers, mappers, schemas, utils, `*-lib.mjs`.
  That is where a test earns its keep.
- Verify a component change by **rendering it and reporting what you saw**, not by leaving a test
  behind as the evidence. If BUILD generates one anyway, delete it before the PR goes up.
- This lowers a ticket's `acCoverage`/`codeQuality` slightly. Accept that - the rule outranks the
  score, and a skipped test here is not an `unmeasured` dimension.

## Comments (shipped code)
- 🔒 **No `TODO`/`FIXME`.** Track deferrals in the ticket/PR, not the source.
- 🔒 **No Figma references in comments or test titles** — no `Figma`, no node ids (`3091-1058`,
  `1346:2928`), no "spec node", no "per Figma". State the fact without the citation.
- 🔒 **No comment longer than 3 lines.** Prefer one concise line; delete comments that restate code.
  Comment the non-obvious *why*, nothing else.

## Option / list-item rows (learned PROJ-2908 — human caught it)
- The OPTION row is where "plausible but wrong" hides. A tidy-looking list passed a spot-check but
  was structurally wrong vs Figma. ALWAYS run the objective per-node visual diff on the **option/menu
  node**, not just the closed/open field. A reviewer's `visualDiffPassRate` estimate is NOT a
  substitute for `visual-diff.mjs` on the option node.
- Match the Figma **Menu List Item** exactly: row height (46px here, not the field's 32px), leading
  icon slot size, and any secondary description line.
- **Match highlight = bold the matched substring** (Poppins Bold), NOT a background fill. Don't let a
  `themed(background-color, …)` override a `background: none`.

## Micro-interactions on sensitive inputs (learned PROJ-2908)
- For a faithful port, the SUBTLE keyboard/focus behaviours matter as much as the visuals — verify them
  against the previous version, don't reimplement from intuition. Combobox specifics caught by the human:
  - Trailing icon buttons (clear ✕, chevron, cancel) are **`tabIndex={-1}`** — not separate tab stops;
    the input is the only focusable element. A plain `<button>` is tabbable by default — set -1 explicitly.
  - **Tab commits** the highlighted option, else falls back to the **first match** (sync). For **async**:
    **block while `isFetching`**, and on a quick Tab commit only an **exact (case-insensitive) match**, never
    an arbitrary first partial result.
- When porting, diff the old component's keydown handler + affordance tabIndex line-by-line into a checklist.
- **Typeahead auto-highlight is a behaviour, not a visual** (learned PROJ-2908 — human caught it in browser QA).
  v1 auto-highlights the FIRST real match while typing (a derived `defaultActiveIndex` with an arrow
  *override* slot, not a raw index reset to -1 on each keystroke). A naive port that sets
  `highlightedIndex = -1` on every input change silently drops this: no focus ring on the first match,
  and type→Enter becomes a no-op. Mirror the derived-default + override model. Cascade to check: Enter
  commits the auto-highlight; Tab commits it (sync); and for async the auto-highlight must NOT let a
  quick Tab commit a partial result — pass an `isHighlightExplicit` flag so Tab only commits the
  highlighted row when the user actually arrowed/hovered, else exact-match only.
- **Synthetic-key browser QA is timing-fragile.** Dispatching `keydown` synchronously right after a
  controlled-input `input` event fires on the STALE React handler (old closure) and reads pre-flush
  DOM — type→Enter looks like a no-op when it actually committed. Split the type and the key into
  separate tool calls (a render happens between them), or trust the jsdom unit tests for commit-on-key.

## Branch naming (learned — human correction, PROJ-2996/2997)
- 🔒 **Branch name = `{type}/PROJ-{number}-{short-desc}`**, NOT the bare `autopilot/PROJ-{number}`.
  `{type}` is the conventional-commit type of the change (bug → `fix`, feature → `feat`); `{short-desc}`
  is a 2–4 word kebab slug of what changed. Examples: `fix/PROJ-2996-tag-iconleft-control`,
  `feat/PROJ-2997-tag-maxwidth`. Get the name RIGHT AT CREATION — pass it to
  `worktree.mjs create <KEY> <repoId> <baseBranch> <branchName>` (5th arg); do not rely on the
  `autopilot/<KEY>` default.
- **NEVER rename a branch that already has an open PR** via the GitHub rename API
  (`POST /repos/.../branches/{b}/rename`) — in this repo it CLOSED the open PRs (#772/#773) instead of
  retargeting them, forcing new PRs. If a wrong-named branch already has a PR, prefer opening a fresh
  correctly-named branch/PR over renaming, or accept the name. Name correctly the first time.

## External-output style (learned — human directive)
- 🔒 **Human-visible text is unbranded and un-tagged.** PR title/body, PR comments, Jira comments,
  escalation notes, and **commit messages** must NEVER contain the word "Autopilot", any bot/tool
  branding, an emoji signature (`🤖`), "Generated with…", or "never merges" boilerplate. Write
  exactly as a developer on the team would.
- **Never @mention / tag anyone in Jira** (no `[~accountid:…]`, no `@name`) — plain comments only.
- Keep it natural and concise: what changed, why, how it was tested, links. No stage/rubric/pipeline
  jargon or internal artifact names in anything a human reads.
- **Branch names** use `{type}/PROJ-{n}-{desc}` — never an `millwright/…` prefix (it shows in the PR).

## PR format & title (learned — human directive)
- **Fill the target repo's own `.github/pull_request_template.md`** for the PR body — never invent a
  structure. Read the template file FIRST, every time, including for a PR opened by hand outside a
  pipeline run — that is how PROJ-3749 (#1116) went up with invented headings. Fill: Summary/Description bullets (real changes), Jira link `[PROJ-n](…/browse/PROJ-n)`,
  tick only the Code Review Checklist items that are genuinely true, leave PR Size unticked (a GitHub
  Action labels it), and the repo-specific sections (frontend → Screenshots; backend → API Details +
  Bruno collection, else tick N/A). Human-readable, unbranded.
- **Say why each checklist box is ticked, and leave the untrue ones unticked.** One short ` - `
  note per line: how it was satisfied, or why it does not apply. An honest gap ("not checked
  across breakpoints") is worth more to a reviewer than a uniformly full list, and a tick with no
  evidence behind it is the thing the checklist exists to prevent.
- **PR title — identical convention across EVERY repo:** `<type>(<scope>): <concise summary> (PROJ-n)`
  (conventional-commit), matching the branch type + commits. e.g.
  `fix(ui-kit-v2): toggle checkbox on Enter key (PROJ-3000)`.

## Choice controls: `valueText` is the option, `labelText` is the field (learned PROJ-2910 — human caught it)
- **`RadioButton` / `Checkbox` take BOTH.** `labelText` is the caption *above* the control
  describing the field; **`valueText` is the option text beside the control, and it is what
  supplies the accessible name.** Both are optional `ReactNode`, so passing the option text as
  `labelText` typechecks, renders every word you expected, and is still wrong.
- The visible symptom is a stacked layout — captions in a row with bare circles/boxes beneath
  them — because each control renders its own caption row. The real damage is invisible: the
  input ends up with **no accessible name at all**, so a screen reader announces "radio button"
  with nothing to distinguish the options.
- Diagnose it by measuring, not by looking: the control's `<label>` wrapper collapses to the
  size of the control (20×20) because it holds no text. If a label wrapper is the same size as
  its input, the option text went to the wrong prop.
- Same distinction on both components. When a choice control looks wrong, check this before
  reaching for CSS — the layout is a symptom, not the cause.

## Lesson (PROJ-3113): "always-white" surfaces vs the theme-flipping `background` token
A Figma variable named like a kit token is not the same token - resolve name -> hex -> the token
the kit actually uses, PER THEME. PROJ-3113's icon chip is `#ffffff` in BOTH light and dark
(Figma "Brand/Background" is a fixed white). Binding it to the kit's `background` token compiled to
white in light but **black in dark** (`background` = `#ffffff`/`#000000`), so the chip went black in
dark mode - a defect that passes a tautological SCSS test if the test compares the element against
that same theme-flipping token's own resolved value. For a surface that must stay one colour across
themes, bind to a token that holds that value in BOTH maps (e.g. `focus-inset` = `#ffffff`/`#ffffff`)
and pin the LITERAL value in the scss test (`#ffffff` in both themes), not the source token.
