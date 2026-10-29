#!/usr/bin/env node
// Autopilot PRE-FLIGHT gate — deterministic "is this already done / a duplicate?" check.
// Runs BEFORE planning so Autopilot never burns a build+PR on work that already exists.
//
// It looks three ways (the 3rd is what caught PROJ-2954 — the fix wasn't tagged with the
// ticket key, but it showed up in the entry files' recent history):
//   1. Commits/branches that REFERENCE the ticket key or its parent.
//   2. Keyword hits in recent commit subjects.
//   3. RECENT COMMITS TOUCHING THE ROUTED ENTRY FILES (the strong signal).
//
// Usage:
//   node millwright/scripts/preflight.mjs --key PROJ-2954 --parent PROJ-2823 \
//     --repo erp-next-ui-monorepo \
//     --files "packages/erp-next-ui-kit-v2/src/components/Menu/Menu.module.scss,..." \
//     --keywords "menu,overflow,recolour,token" [--since 2026-07-01]
//
// Writes millwright/tickets/<KEY>/preflight.md and prints a JSON verdict on the last line.
//
// GUARDRAILS: every `git` invocation runs through guardExec (scripts/guard.mjs) instead of a
// bare execFileSync with `catch { return "" }`. That old swallow was the exact failure this
// gate exists to prevent: if the repo path was wrong or git failed for any reason, EVERY probe
// returned empty and preflight cheerfully reported "✅ no existing work — safe to build". A
// failed probe is now UNVERIFIED: it is acknowledged, listed in preflight.md, and forces the
// verdict to REVIEW-BEFORE-BUILD (`unverified: true` in the JSON) rather than a false all-clear.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { guardExec } from "./guard.mjs";
import { acknowledgement } from "./guard-lib.mjs";
import { preflightVerdict } from "./preflight-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "..", "..");            // acme/
const AUTOPILOT = join(HERE, "..");

function arg(name, def = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const KEY = arg("key");
const PARENT = arg("parent");
const REPO = arg("repo");
const FILES = arg("files").split(",").map((s) => s.trim()).filter(Boolean);
const KEYWORDS = arg("keywords").split(",").map((s) => s.trim()).filter(Boolean);
const SINCE = arg("since");
if (!KEY || !REPO) { console.error("preflight: --key and --repo are required"); process.exit(2); }

const REPO_PATH = join(WORKSPACE, REPO);

// Every failed probe, so an empty result is never mistaken for "nothing found".
const failures = [];
/** Guarded git probe. Local git is deterministic, so retries: 0 — the guard is here for
 * classification + acknowledgement, not backoff. Returns "" on failure AND records why. */
async function git(label, args) {
  const r = await guardExec(`preflight ${label}`, "git", ["-C", REPO_PATH, ...args], {
    source: `git ${args[0]}`, retries: 0, timeoutMs: 30000,
  });
  if (!r.ok) {
    const line = acknowledgement(r);
    console.error(line);
    failures.push({ probe: label, kind: r.kind, message: String(r.message || "").split("\n")[0].slice(0, 200) });
    return "";
  }
  return String(r.value?.stdout ?? "").trim();
}

async function main() {
  // A wrong --repo used to make every probe return "" and yield a confident all-clear.
  if (!existsSync(join(REPO_PATH, ".git"))) {
    failures.push({ probe: "repo", kind: "not-found", message: `not a git repo: ${REPO_PATH}` });
  }

  // 1. commits referencing the key or parent (any branch)
  const grepArgs = ["log", "--all", "-i", "--oneline", "-n", "20"];
  [KEY, PARENT].filter(Boolean).forEach((k) => grepArgs.push(`--grep=${k}`));
  const refCommits = (KEY || PARENT) ? (await git("ref-commits", grepArgs)).split("\n").filter(Boolean) : [];

  // 2. branches referencing key/parent
  const allBranches = (await git("branches", ["branch", "-a", "--format=%(refname:short)"])).split("\n").filter(Boolean);
  const refBranches = allBranches.filter((b) => [KEY, PARENT].filter(Boolean).some((k) => b.toLowerCase().includes(k.toLowerCase())));

  // 3. recent commits touching the routed entry files (the strong signal)
  let fileCommits = [];
  if (FILES.length) {
    const a = ["log", "--oneline", "-n", "12", "--date=short", "--pretty=%h %ad %an %s"];
    if (SINCE) a.push(`--since=${SINCE}`);
    a.push("--", ...FILES);
    fileCommits = (await git("file-commits", a)).split("\n").filter(Boolean);
  }

  // keyword hits within the file-touching commits
  const kwHits = KEYWORDS.length
    ? fileCommits.filter((c) => KEYWORDS.some((k) => c.toLowerCase().includes(k.toLowerCase())))
    : [];

  // uncommitted local changes to the files
  const dirty = FILES.length ? (await git("dirty", ["status", "--porcelain", "--", ...FILES])).split("\n").filter(Boolean) : [];

  const currentBranch = await git("current-branch", ["rev-parse", "--abbrev-ref", "HEAD"]);

  // verdict (pure logic lives in preflight-lib.mjs — unit-tested)
  const base = preflightVerdict({ refCommits, refBranches, fileCommits, keys: [KEY, PARENT] });
  const unverified = failures.length > 0;
  // Fail closed: a probe that never ran cannot clear a ticket. Reuse the existing
  // REVIEW-BEFORE-BUILD verdict (a value the pipeline already understands) rather than
  // inventing an enum value downstream consumers don't handle.
  const verdict = unverified ? "REVIEW-BEFORE-BUILD" : base.verdict;
  const likelyExisting = base.likelyExisting;
  const signals = unverified
    ? [...base.signals, `${failures.length} git probe(s) FAILED — results below are incomplete (UNVERIFIED)`]
    : base.signals;

  // write preflight.md
  const md = `# Pre-flight — ${KEY}
**Repo:** ${REPO} (branch \`${currentBranch || "unknown"}\`) · **Verdict:** ${verdict}${unverified ? " (UNVERIFIED)" : ""}

${unverified
  ? "⛔ One or more git probes FAILED, so this check is **incomplete**. An empty result here does NOT mean \"no existing work\". **Do not auto-build** — fix the failure below and re-run."
  : likelyExisting
    ? "⚠️ Existing work may already cover this ticket. **Do not auto-build** — a human/planner must review the evidence below first."
    : "✅ No existing commits/branches touch the routed files or reference the ticket. Safe to plan + build."}
${unverified ? `\n## Failed probes (UNVERIFIED)\n${failures.map((f) => `- \`${f.probe}\` — ${f.kind}: ${f.message}`).join("\n")}\n` : ""}
## Signals
${signals.length ? signals.map((s) => `- ${s}`).join("\n") : "- none"}

## Recent commits touching the routed entry files
${fileCommits.length ? fileCommits.map((c) => `- \`${c}\``).join("\n") : "- (none / no --files given)"}
${kwHits.length ? `\n**Keyword matches (${KEYWORDS.join(", ")}):**\n${kwHits.map((c) => `- \`${c}\``).join("\n")}` : ""}

## Commits referencing ${[KEY, PARENT].filter(Boolean).join(" / ") || "the key"}
${refCommits.length ? refCommits.map((c) => `- \`${c}\``).join("\n") : "- none"}

## Branches referencing the ticket/parent
${refBranches.length ? refBranches.map((b) => `- \`${b}\``).join("\n") : "- none"}

## Uncommitted local changes to entry files
${dirty.length ? dirty.map((d) => `- \`${d}\``).join("\n") : "- none (clean)"}

## Recommendation
${unverified
  ? "Re-run pre-flight after fixing the failed probe(s). Until it completes cleanly, treat the duplicate check as NOT DONE."
  : likelyExisting
    ? "Compare the current code against the ticket's expected result. If it already matches, comment on the ticket (cite the commit) and route to QA / close as done-or-duplicate instead of building."
    : "Proceed to PLAN → BUILD."}
`;

  const outDir = join(AUTOPILOT, "tickets", KEY);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "preflight.md"), md);

  console.log(md);
  console.log("\n" + JSON.stringify({
    key: KEY,
    verdict,
    likelyExisting,
    unverified,
    gitFailures: failures,
    refCommits: refCommits.length,
    refBranches: refBranches.length,
    fileCommits: fileCommits.length,
  }));
}

main().catch((e) => {
  console.error(`✗ preflight failed: ${e?.message || e}`);
  process.exit(1);
});
