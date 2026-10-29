// Pure decision logic for eval.mjs's `--mode rerun` — which repo a golden entry targets,
// which commit to build against, where the throwaway worktree lives, and what headless
// build command to spawn. No filesystem/network/spawning here (that's eval.mjs's job),
// so every decision is deterministic and unit-testable with vitest.
//
// The rerun boundary is BUILD: `--until build` runs INTAKE→…→BUILD and STOPS before
// VERIFY/REVIEW/SHIP, so a rerun never opens a PR, never comments on Jira, never merges.

/** Which repo does a golden entry target?
 *  1. An explicit `entry.repo` wins (recommended — never guess when it's stated).
 *  2. Otherwise infer from `entry.expect.filesTouched` by matching each path against the
 *     manifest's repo ids and their sub-package paths; the repo with the longest matching
 *     path prefix wins.
 * Throws a clear error when it can't be determined — rerun must know the repo, not guess
 * silently and build the wrong tree. */
export function repoForEntry(entry, manifest) {
  const e = entry || {};
  if (e.repo) return e.repo;

  const repos = (manifest && manifest.repos) || [];
  const touched = (e.expect && e.expect.filesTouched) || [];
  if (!repos.length || !touched.length) {
    throw new Error(
      `eval rerun: cannot determine repo for ${e.key || '(no key)'} — add a "repo" field to its golden-set entry`,
    );
  }

  // Candidate (repoId, prefix) pairs: the repo id itself (a path that starts with it) and
  // every sub-package path declared for that repo. Longest prefix that matches a touched
  // file wins, so `packages/foo/…` maps to the monorepo that declares `packages/foo`.
  const candidates = [];
  for (const r of repos) {
    if (!r || !r.id) continue;
    candidates.push({ repo: r.id, prefix: r.id });
    const subs = r.subPackages || {};
    for (const v of Object.values(subs)) {
      if (v && typeof v === 'object' && typeof v.path === 'string') {
        candidates.push({ repo: r.id, prefix: v.path });
      }
    }
  }

  let best = null;
  for (const file of touched) {
    for (const c of candidates) {
      if (underPrefix(file, c.prefix) && (!best || c.prefix.length > best.prefix.length)) {
        best = c;
      }
    }
  }
  if (best) return best.repo;

  throw new Error(
    `eval rerun: could not infer repo for ${e.key || '(no key)'} from filesTouched — add an explicit "repo" field`,
  );
}

/** `file` falls under `prefix` (a dir with/without trailing slash, or a full path). */
function underPrefix(file, prefix) {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return file === prefix || file === p || file.startsWith(p);
}

/** The ref to build against. The PARENT of the merged commit (`<sha>^`) so the agent
 * reproduces the change from the pre-merge tree; falls back to the base branch when the
 * entry records no `mergedCommit`. Returns `{ ref, kind: 'commit'|'branch', note }`. */
export function baseRefFor(entry, baseBranch = 'dev') {
  const sha = entry && entry.mergedCommit;
  if (sha && String(sha).trim()) {
    return { ref: `${String(sha).trim()}^`, kind: 'commit', note: `parent of merged ${sha}` };
  }
  return { ref: baseBranch, kind: 'branch', note: `no mergedCommit — building against ${baseBranch}` };
}

/** Throwaway worktree dir name — `eval-` namespaced so it can NEVER collide with a real
 * run's `<KEY>-<repo>` worktree. */
export function evalWorktreeName(key, repo) {
  return `eval-${key}-${repo}`;
}

/** Eval branch name — also namespaced away from any real feature branch. */
export function evalBranchName(key) {
  return `eval/${key}`;
}

/** Split a command template into argv, respecting simple double-quotes, and substitute
 * `{KEY}` / `{REPO}` placeholders. Returns null when no template is given. Used by the
 * `EVAL_BUILD_CMD` env override so the build step can be mocked in tests/CI without
 * spawning a real claude run. */
export function parseCmdTemplate(template, { key, repo } = {}) {
  if (!template || !String(template).trim()) return null;
  const subst = (s) => s.replaceAll('{KEY}', key ?? '').replaceAll('{REPO}', repo ?? '');
  const tokens = String(template).match(/"[^"]*"|\S+/g) || [];
  const argv = tokens.map((t) =>
    subst(t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t),
  );
  return { cmd: argv[0], args: argv.slice(1) };
}

/** The headless argv for a BUILD-only rerun. Default:
 *   <claudeBin> -p "/resolve-ticket <KEY> --repo <repo> --until build --yes"
 *     --output-format stream-json --verbose [--settings <settingsPath>]
 * `--until build` stops before VERIFY/REVIEW/SHIP (no PR, no Jira); `--yes` pre-approves
 * gates so the run is unattended; `--repo` pins the repo so the router can't wander.
 * An `EVAL_BUILD_CMD` template (with {KEY}/{REPO}) overrides the whole command. */
export function buildRerunArgv(key, repo, opts = {}) {
  const { claudeBin = 'claude', settingsPath = null, buildCmdTemplate = null } = opts;
  const fromTemplate = parseCmdTemplate(buildCmdTemplate, { key, repo });
  if (fromTemplate) return fromTemplate;

  const prompt = `/resolve-ticket ${key} --repo ${repo} --until build --yes`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (settingsPath) args.push('--settings', settingsPath);
  return { cmd: claudeBin, args };
}

/** Cache key for a rerun result. A rebuild is only worth spending tokens on when
 * something that affects the produced diff changed: the ticket (`goldenKey`), the tree it
 * builds against (`baseSha` — a resolved commit, so a moving base branch invalidates
 * naturally), or the prompts that drive the build (`promptHash`). Same triple → same
 * build → reuse the stored score instead of re-running BUILD. Pure/deterministic; the
 * file reading + git rev-parse that produce baseSha/promptHash live in eval.mjs. */
export function rerunCacheKey(goldenKey, baseSha, promptHash) {
  return `${goldenKey}::${baseSha}::${promptHash}`;
}

/** Assemble the full deterministic plan for one entry — no IO. eval.mjs turns this into
 * git/worktree/spawn calls. */
export function rerunPlan(entry, manifest, opts = {}) {
  const repo = repoForEntry(entry, manifest);
  const base = baseRefFor(entry, opts.baseBranch);
  return {
    key: entry.key,
    repo,
    base,
    worktree: evalWorktreeName(entry.key, repo),
    branch: evalBranchName(entry.key),
    build: buildRerunArgv(entry.key, repo, opts),
  };
}
