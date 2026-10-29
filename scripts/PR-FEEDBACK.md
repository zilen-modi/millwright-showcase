# PR/QA feedback loop

Turns a shipped Autopilot PR from one-shot into an iterating collaborator: when a
human/QA leaves review comments on the PR, or files a new sub-bug on the ticket,
Autopilot triages the actionable items into a worklist and repairs them — instead of
treating SHIP as the end of the story.

`scripts/pr-feedback.mjs` / `scripts/pr-feedback-lib.mjs` only do the **READ + TRIAGE**
step. Repair, push, and any reply back to the human/Jira are orchestrated + gated by the
SKILL — this script never writes code and never posts anywhere.

## 1. Gather the inputs

- **PR review threads/comments** — fetched directly by `pr-feedback.mjs` via
  `gh pr view <pr> --json reviews,comments,reviewThreads,state` (guarded — see
  `guard.mjs`; a failed fetch is ACKNOWLEDGED and halts, never silently skipped).
- **Jira sub-bugs** — Jira is MCP-only and not reachable from a CLI script, so the
  **orchestrator** fetches any sub-bugs filed against the ticket (via the Jira MCP) and
  passes them in as `--jira-items sub-bugs.json`:

  ```json
  [{ "key": "PROJ-3001", "summary": "...", "description": "...", "status": "To Do" }]
  ```

## 2. Run the triage

```bash
node scripts/pr-feedback.mjs --pr 123 \
  [--repo-cwd "/path/to/repo"] \
  [--jira-items sub-bugs.json]
```

`--repo-cwd` defaults to the erp-next-ui-monorepo checkout. The script:

1. Fetches the PR via `gh pr view` (guarded fetch — BLOCKED + non-zero exit on failure).
2. Classifies every unresolved review thread/comment (`triageThreads`, pure logic in
   `pr-feedback-lib.mjs`) into:
   - **actionable** — imperative wording ("please", "should", "must", "make sure",
     a bare imperative verb like "Add a null check.") or a code suggestion block. These
     need a code change.
   - **questions** — ends in `?` with no change-request phrasing. These need a reply,
     not a fix — the repair loop must not silently "answer" them by guessing at code.
   - **info** — praise/FYI/anything else. No action needed.
   - Resolved threads are skipped entirely (already addressed).
3. Classifies Jira sub-bugs (`triageSubBugs`) into actionable items, skipping anything
   already `Done`.
4. Merges both actionable lists (`mergeWorklist`) into one ordered worklist: items that
   describe the same feedback (same file+line, or matching ask text) are deduped, and
   the result is ordered most-specific first (file+line > file-only > text-only), so the
   repair loop tackles the most concretely-anchored feedback first.
5. Prints a readable worklist + a JSON summary on the last line, and exits 0 with
   "no actionable feedback" when the worklist is empty.

## 3. The repair loop (orchestrated by the SKILL, not this script)

For each worklist item, in order:

1. **Repair** — hand the item (`path`/`line`/`ask`, or `key`/`ask` for a sub-bug) to
   `coder-agent` in the same worktree/branch as the original PR, scoped to just that
   item.
2. **VERIFY** — re-run the same verify gate the original build used; do not push on a
   failed verify.
3. **Push** a fix commit (Conventional Commit, referencing the ticket key and, for a
   sub-bug item, its own key).
4. **Reply** — `gh pr comment` on the PR thread and/or update the Jira sub-bug, tagging
   `queue.json.owner`. This is an OUTWARD action: it is gated/announced like any other
   external reply, never sent silently by this script.

Open **questions** are surfaced separately in the output and should be replied to
directly (via the gated reply step) rather than resolved by guessing at a code change.
