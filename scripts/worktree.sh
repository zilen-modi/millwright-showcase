#!/usr/bin/env bash
# Autopilot worktree lifecycle — isolate each repo's BUILD so the user's primary
# checkouts are never touched and parallel repos never collide.
#
#   worktree.sh create <KEY> <repoId> [baseBranch]   # add worktree + feature branch
#   worktree.sh remove <KEY> <repoId>                # remove the worktree (branch stays)
#   worktree.sh list   <repoId>                      # list worktrees for a repo
#
# Worktrees live under acme/.wt/<KEY>-<repoId>; branch is autopilot/<KEY>.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # acme/
CMD="${1:-}"; KEY="${2:-}"; REPO="${3:-}"; BASE="${4:-dev}"

usage() { echo "usage: worktree.sh <create|remove|list> <KEY> <repoId> [baseBranch]"; exit 1; }
[ -z "$CMD" ] && usage

case "$CMD" in
  create)
    [ -z "$KEY" ] || [ -z "$REPO" ] && usage
    REPO_PATH="$ROOT/$REPO"; WT_DIR="$ROOT/.wt/$KEY-$REPO"; BRANCH="millwright/$KEY"
    [ -d "$REPO_PATH/.git" ] || { echo "not a git repo: $REPO_PATH"; exit 1; }
    git -C "$REPO_PATH" fetch --quiet origin "$BASE" 2>/dev/null || true
    mkdir -p "$ROOT/.wt"
    if git -C "$REPO_PATH" show-ref --verify --quiet "refs/remotes/origin/$BASE"; then
      git -C "$REPO_PATH" worktree add -B "$BRANCH" "$WT_DIR" "origin/$BASE"
    else
      git -C "$REPO_PATH" worktree add -B "$BRANCH" "$WT_DIR" "$BASE"
    fi
    echo "worktree ready: $WT_DIR  (branch: $BRANCH, base: $BASE)"
    ;;
  remove)
    [ -z "$KEY" ] || [ -z "$REPO" ] && usage
    REPO_PATH="$ROOT/$REPO"; WT_DIR="$ROOT/.wt/$KEY-$REPO"
    git -C "$REPO_PATH" worktree remove --force "$WT_DIR" && echo "removed $WT_DIR (branch kept)"
    ;;
  list)
    [ -z "$KEY" ] && usage   # for list, arg2 is the repoId
    git -C "$ROOT/$KEY" worktree list
    ;;
  *) usage ;;
esac
