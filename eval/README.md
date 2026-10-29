# Eval — golden-set regression harness

A set of already-merged tickets (`golden-set.json`) is ground truth. The harness scores
a **produced diff** against each ticket's expected merged outcome, so changes to the
SKILL/agents get regression-tested instead of shipping blind.

- `golden-set.json` — hand-curated ground truth. See the file's `_comment` field.
- `../scripts/eval-lib.mjs` — pure, unit-tested scoring (`scoreDiff`, `summarizeEval`)
  and diff parsing (`parseUnixDiff`). No IO.
- `../scripts/eval.mjs` — CLI/IO wrapper.

## `--mode diff` (default, cheap, CI-friendly)

Scores a **provided** produced diff — either a `git diff` patch file or a JSON file
already in the produced shape — against one or more golden-set entries. No pipeline
re-run, fully deterministic.

```
node scripts/eval.mjs --mode diff --diff path/to.patch --key PROJ-2825
node scripts/eval.mjs --mode diff --diff path/to/produced.json --key PROJ-2825
```

Produced shape (if supplying JSON directly instead of a patch):

```json
{
  "filesChanged": ["packages/.../Tag/Tag.tsx"],
  "additions": 42,
  "deletions": 3,
  "containsByFile": { "packages/.../_tag.scss": ["$tag-neutral-background: ...;"] },
  "testCountDelta": 6
}
```

Exits non-zero if any evaluated ticket scores below the pass threshold (0.8).

## `--mode rerun` (heavy — real BUILD, spends tokens)

Re-runs the Autopilot pipeline through **BUILD** for a golden-set ticket in a throwaway
worktree, captures the actual resulting `git diff`, then scores it through the exact same
`scoreDiff` path as `--mode diff`. This is what lets you measure whether a SKILL/agent
prompt change actually produces better code end-to-end — not just against a frozen diff.

```
# print the plan (repo / base commit / worktree / build command) — spawns NOTHING:
node scripts/eval.mjs --mode rerun --key PROJ-2825 --dry-run

# real run — builds in a worktree and scores the diff (tokens + configured headless claude):
node scripts/eval.mjs --mode rerun --key PROJ-2825
```

How it works, per entry:
1. **Repo** — `entry.repo` (a manifest id); if absent, inferred from `expect.filesTouched`.
2. **Base commit** — the **parent of `entry.mergedCommit`** (`<sha>^`) so the agent rebuilds
   the change from the pre-merge tree; falls back to the base branch when no `mergedCommit`.
3. **Worktree** — `acme/.wt/eval-<KEY>-<repo>` on branch `eval/<KEY>` (namespaced so it can
   never collide with a real run). Stale ones from a prior eval are force-removed first.
4. **Build** — `claude -p "/resolve-ticket <KEY> --repo <repo> --until build --yes"`. **`--until
   build` stops before VERIFY/REVIEW/SHIP**, so a rerun never opens a PR, comments on Jira, or
   merges. `--yes` runs it unattended; `--repo` pins the repo.
5. **Score** — `git add -A` then `git diff --cached <base>` → `parseUnixDiff` → `scoreDiff`.
6. **Teardown** — the worktree is removed (keep it with `--keep`).

Flags: `--dry-run` (plan only), `--keep` (leave the worktree), `--capture-only` (skip BUILD and
score the diff already sitting in the worktree — handy after a manual/interrupted build),
`--key` (one ticket; omit for all), `--out`, `--golden`, `--manifest`, `--config`.

Env overrides: `CLAUDE_BIN` (claude binary), `EVAL_CLAUDE_SETTINGS` (a headless `--settings`
file for unattended permissions), and `EVAL_BUILD_CMD` — a full command template with `{KEY}`
/ `{REPO}` placeholders that **replaces** the claude invocation (used to mock the build in tests
/ CI, or point at a custom runner). Exits non-zero if any ticket fails to reach the 0.8 bar or a
build errors.
