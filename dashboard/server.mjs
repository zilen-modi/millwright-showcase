#!/usr/bin/env node
// Autopilot local control panel — a live phase-kanban + cost view that can trigger
// pipeline runs. Binds ONLY to 127.0.0.1 (never exposes the run trigger to a network).
// Pure aggregation/pricing is reused from ./lib.mjs + ../schemas.mjs; this file is the
// I/O + HTTP + process-spawning layer. It does NOT touch the static dashboard build.
//
// Run:            npm run panel        (or: node dashboard/server.mjs)
// Port:           PORT=4317 (default). URL is printed on start.
//
// Spawning claude (HEADLESS policy):
//   Panel-spawned `claude -p` runs cannot show a permission prompt, so the panel hands the CLI a
//   generated PRE-SCOPED permission policy via `--settings <headless-settings.json>` (written at
//   startup by writeHeadlessSettings). The policy pins `defaultMode: "dontAsk"` with an allow/deny
//   set scoped to this workspace's absolute path — so a run never prompts and never depends on an
//   interactive connector. The child also always gets AUTOPILOT_HEADLESS=1 (the pipeline reads it to
//   take the headless Jira path via scripts/jira.mjs instead of the Atlassian MCP) and, when present
//   in millwright/config/autopilot.env, NPM_TOKEN (+ its NODE_AUTH_TOKEN alias) so `yarn/npm` installs
//   of the private @acme-it-erp/* GitHub Packages authenticate instead of 401ing.
//
//   CLAUDE_BIN       path to the claude CLI (default: "claude"). Point at a stub script
//                    to test the run plumbing without invoking a real pipeline.
//   CLAUDE_RUN_ARGS  when SET (even empty), its space-split value is used verbatim in place of the
//                    generated `--settings` policy (still followed by `-p <prompt>`) — an escape hatch
//                    to override the policy, e.g. CLAUDE_RUN_ARGS="--permission-mode bypassPermissions".
//                    When UNSET, the generated headless-settings.json policy is used.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, createWriteStream, statSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, normalize, sep } from 'node:path';
import { execa } from 'execa';

import { CostModelSchema, ConfigSchema, parseEventLine } from '../schemas.mjs';
import {
  RESUMABLE_STAGES as GRAPH_RESUMABLE_STAGES,
  COLUMN_KEYS as GRAPH_COLUMN_KEYS,
  stageColumn,
} from '../stage-graph.mjs';
import { buildTicket, aggregate, budgetRows, parseRunsJsonl, STAGE_ORDER } from './lib.mjs';
import {
  isRetryableReview, parsePrRef, prRefId, prUrlFromRef, recoverPrUrlFromRef,
} from '../scripts/pr-ref-lib.mjs';
import {
  buildInboxRow, inboxBucket, mergeSnapshots, sortInbox,
} from '../scripts/pr-inbox-lib.mjs';
import {
  bodyFits, extractFindings, renderPrComment, scrubInternals,
} from '../scripts/review-comment-lib.mjs';
import { lintProse } from '../scripts/conventions-lint-lib.mjs';
import { buildReviewPayload, rightSideLines, setTriage, DECISIONS } from '../scripts/findings-lib.mjs';
import { archiveReviewRound, loadFindingRows as loadRoundRows } from './review-rounds-lib.mjs';
import { isSlug, parseSubject, renderExplainerHtml } from '../scripts/explain-lib.mjs';
import { createWorkspace } from './workspace.mjs';
import { estimateCost, normaliseScanRows, setQueueTriage, triageView } from '../scripts/queue-lib.mjs';
import {
  addComment, answersFile, changedBlocks, checklist, lineDiff, markSent, nextVersion, normaliseQuestions, normaliseReview,
  openComments, replanNotes, splitPlan, updateComment,
} from '../scripts/plan-review-lib.mjs';
import { ID_RE as CHAT_ID_RE, historyForRun, question as chatQuestion, thread as chatThread } from '../scripts/chat-lib.mjs';
import { createHash } from 'node:crypto';
import {
  classifyRunOutcome,
  countStageEnds,
  formatStreamEvent,
  inspectStreamLine,
  isOrphanedComplete,
  isPersistedNoOp,
  questionFrom,
  runEndTrailer,
  runFailureLine,
} from './run-outcome-lib.mjs';
import { guardExec } from '../scripts/guard.mjs';
import { resolveEnvFile } from '../scripts/env-file.mjs';
import {
  evaluateBudgetGate,
  evaluateShipGate,
  overrideEvent,
  requiresShipGate,
  shipExceptionRecord,
  SHIP_EXCEPTION_FILE,
} from './ship-gate-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/
const WORKSPACE = join(ROOT, '..'); // acme/ — resolve-ticket paths are relative to here
const TICKETS = join(ROOT, 'tickets');
const QUEUE_RUNS = join(ROOT, 'queue-runs');
const PR_REVIEWS = join(ROOT, 'pr-reviews');
// Plain-language explainers (/explain): one folder per subject, explain.md + status.json.
const EXPLAINERS = join(ROOT, 'explainers'); // ad-hoc /review-pr artifacts — sibling to
// tickets/, NOT nested under it: listTicketKeys() below has no key-format filter and would
// render a tickets/_pr-reviews/ subdirectory as a bogus phantom kanban card.
const PANEL = join(HERE, 'panel');
// Built React panel (Goal B1 / contract §5) — gitignored, absent until `npm run panel:build`
// has run. When it exists it is served with an SPA fallback; when it doesn't, the legacy
// dashboard/panel/* pages below serve exactly as they always have, so the panel never dies
// mid-migration.
const PANEL_DIST = join(HERE, 'panel-dist');

const PORT = Number(process.env.PORT) || 4317;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Overridable for the same reason CLAUDE_BIN is: it lets the GitHub-touching paths be exercised
// against a stub instead of the real API.
const GH_BIN = process.env.GH_BIN || 'gh';
// Written to the WORKSPACE ROOT so `/`-anchored rules resolve relative to the workspace (the
// workspace path contains a space, so keeping absolute paths out of the rules is the safe choice).
const HEADLESS_SETTINGS_PATH = join(WORKSPACE, 'headless-settings.json');
const CHAT_SETTINGS_PATH = join(WORKSPACE, 'headless-settings-chat.json');
// ERP Atlas (sibling repo) answers "how does the legacy ERP do X?" with PROGRAM:line citations.
// Runs get its stdio MCP server through `--mcp-config` when the checkout is present.
const ATLAS_DIR = join(WORKSPACE, 'erp-atlas');
const ATLAS_MCP_PATH = join(WORKSPACE, 'atlas-mcp.json');
// Read-only index tools. live_record/live_examples (TEST reads) and fact_propose stay denied:
// an unattended run must not load TEST or file facts; it records findings in legacy.md instead.
const ATLAS_READ_TOOLS = [
  'status', 'search', 'search_code', 'search_meaning', 'program_overview', 'read_lines', 'callers',
  'who_writes', 'who_reads', 'field_info', 'trace_field', 'file_detail', 'flow', 'process_flow',
  'processes', 'menu', 'drift', 'fact_lookup', 'test_data_fields', 'test_data_link',
];
const ATLAS_DENIED_TOOLS = ['live_record', 'live_examples', 'fact_propose'];
const CONFIG_PATH = join(ROOT, 'config', 'config.json');
const REPO_MANIFEST = join(ROOT, 'config', 'repo-manifest.json');
const QUEUE_PATH = join(ROOT, 'config', 'queue.json');
// An explicit CLAUDE_RUN_ARGS (even empty) overrides the generated `--settings` policy; when unset,
// runs use the generated headless-settings.json (see writeHeadlessSettings + startRun).
const RUN_ARGS_OVERRIDE = process.env.CLAUDE_RUN_ARGS != null
  ? process.env.CLAUDE_RUN_ARGS.split(/\s+/).filter(Boolean)
  : null;

// ---- headless credentials (read from millwright/config/autopilot.env) ----
// Tiny inline .env parser (no dependency): KEY=VALUE per line, ignores blanks/`#` comments, strips
// a trailing inline `# ...` comment + surrounding quotes. process.env wins over the file.
function parseEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return {}; }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1);
    if (val && !/^\s*["']/.test(val)) {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash);
    }
    out[key] = val.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const { path: ENV_PATH, legacy: ENV_IS_LEGACY } = resolveEnvFile(ROOT);
// Resolve the GitHub-Packages token FRESH each call (re-reads autopilot.env), so editing the file
// takes effect on the next run without restarting the panel. Accepts the several common names — the
// monorepo's .npmrc/.yarnrc use ${NPM_TOKEN}, but operators often set NODE_AUTH_TOKEN/GITHUB_TOKEN.
function resolveNpmToken() {
  const f = parseEnvFile(ENV_PATH);
  return process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN
    || f.NPM_TOKEN || f.NODE_AUTH_TOKEN || f.GITHUB_TOKEN || '';
}
// Injected into every spawned child under BOTH names (repo uses NPM_TOKEN; NODE_AUTH_TOKEN is a common
// alias). Empty → not injected, and private @acme-it-erp/* installs 401. Jira creds are NOT injected —
// jira.mjs reads them from the file so they stay out of the model's context.
function buildSecrets() {
  const t = resolveNpmToken();
  return t ? { NPM_TOKEN: t, NODE_AUTH_TOKEN: t } : {};
}

// Generate the pre-scoped permission policy consumed by `claude -p --settings <path>`. The file lives
// at the workspace root, so a `/`-anchored rule resolves relative to the workspace (e.g. `/.wt/**` →
// <workspace>/.wt/**). This keeps the space-containing absolute workspace path OUT of the rule strings.
function writeHeadlessSettings() {
  const rel = (p) => p;                 // `/millwright/…` — relative to this file's dir (workspace root)
  // Edit + Write only — `MultiEdit` isn't a recognized permission tool (it warns "no known tool").
  const ew = (rule) => [`Edit(${rule})`, `Write(${rule})`];
  const FIG = 'mcp__plugin_figma_figma';

  const settings = {
    _comment: 'GENERATED by dashboard/server.mjs (writeHeadlessSettings) — do not edit by hand. '
      + 'Pre-scoped permission policy for headless `claude -p` runs. Paths are relative to this file '
      + '(the workspace root), e.g. /.wt/** and /millwright/tickets/**.',
    permissions: {
      defaultMode: 'dontAsk',
      allow: [
        `Read(${rel('/**')})`,
        'Grep', 'Glob', 'LS', 'Task', 'TodoWrite',
        ...ew(rel('/millwright/tickets/**')),
        ...ew(rel('/millwright/queue-runs/**')),
        ...ew(rel('/.wt/**')),
        ...ew(rel('/millwright/explainers/**')),
        ...ew(rel('/millwright/workspace/**')),
        `Edit(${rel('/millwright/conventions.md')})`,
        `Write(${rel('/millwright/conventions.md')})`,
        // Bash is allowed broadly (per-command allow-rules don't reliably match under the CLI's
        // `dontAsk` parser, which denied git/gh/node outright at SHIP). The DENY list below is the
        // real boundary — dangerous + internet/exfil commands stay blocked and deny always wins.
        'Bash',
        `${FIG}__get_design_context`,
        `${FIG}__get_screenshot`,
        `${FIG}__get_metadata`,
        `${FIG}__get_variable_defs`,
        `${FIG}__get_code_connect_map`,
        ...ATLAS_READ_TOOLS.map((t) => `mcp__erp-atlas__${t}`),
      ],
      deny: [
        'Read(**/.env)', 'Read(**/*.env)', 'Read(**/autopilot.env)',
        'Edit(**/.env)', 'Write(**/.env)', 'Edit(**/*.env)', 'Write(**/*.env)',
        ...ew(rel('/millwright/config/**')),
        ...ew(rel('/.claude/**')),
        ...ew(rel('/millwright/.claude/**')),
        // A review's human decisions and its round history are the panel's alone.
        ...ew(rel('/millwright/pr-reviews/*/triage.json')),
        ...ew(rel('/millwright/pr-reviews/*/previous-findings.json')),
        ...ew(rel('/millwright/pr-reviews/*/rounds/**')),
        'Bash(sudo *)', 'Bash(git push --force*)', 'Bash(git push -f *)',
        'Bash(git reset --hard*)', 'Bash(git rebase*)', 'Bash(git filter-branch*)', 'Bash(rm -rf *)',
        // Internet/exfil channels — runs talk only to Jira/GitHub/Figma via git/gh/the wrapper.
        'Bash(curl *)', 'Bash(wget *)', 'Bash(nc *)', 'Bash(ncat *)', 'Bash(telnet *)',
        'Bash(ssh *)', 'Bash(scp *)', 'Bash(sftp *)', 'Bash(rsync *)',
        'WebFetch', 'WebSearch',
        'mcp__claude_ai_Atlassian_Rovo',
        `${FIG}__use_figma`,
        `${FIG}__create_new_file`,
        `${FIG}__generate_figma_design`,
        `${FIG}__upload_assets`,
        `${FIG}__add_code_connect_map`,
        `${FIG}__send_code_connect_mappings`,
        `${FIG}__generate_diagram`,
        `${FIG}__export_video`,
        ...ATLAS_DENIED_TOOLS.map((t) => `mcp__erp-atlas__${t}`),
      ],
    },
  };
  writeFileSync(HEADLESS_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  // Chat runs (ticket and worktree) may read and, in a worktree, edit - but never move git
  // history or branches. Enforced here, not only asked for in the skill.
  const chat = structuredClone(settings);
  chat._comment = 'GENERATED by dashboard/server.mjs - the headless policy for chat runs: no commits, pushes or branch moves.';
  chat.permissions.deny.push(...['commit', 'push', 'reset', 'rebase', 'checkout', 'switch', 'stash', 'branch', 'merge', 'cherry-pick', 'revert', 'tag', 'worktree', 'clean', 'restore']
    .flatMap((c) => [`Bash(git ${c}*)`, `Bash(git -C * ${c}*)`]), 'Bash(gh *)', 'Bash(node millwright/scripts/jira.mjs comment*)', 'Bash(node millwright/scripts/jira.mjs transition*)');
  writeFileSync(CHAT_SETTINGS_PATH, JSON.stringify(chat, null, 2));
  return HEADLESS_SETTINGS_PATH;
}

// The MCP config handed to runs with `--mcp-config`, or null when there is no Atlas checkout
// (runs then go without it; the CONTEXT stage records Atlas as unavailable).
function writeAtlasMcpConfig() {
  if (!existsSync(join(ATLAS_DIR, 'pyproject.toml'))) {
    if (existsSync(ATLAS_MCP_PATH)) unlinkSync(ATLAS_MCP_PATH);
    return null;
  }
  const config = {
    _comment: 'GENERATED by dashboard/server.mjs (writeAtlasMcpConfig) — do not edit by hand.',
    mcpServers: { 'erp-atlas': { command: 'uv', args: ['run', '--directory', ATLAS_DIR, 'atlas', 'mcp'] } },
  };
  writeFileSync(ATLAS_MCP_PATH, JSON.stringify(config, null, 2));
  return ATLAS_MCP_PATH;
}

const KEY_RE = /^PROJ-\d+$/; // strict — the ONLY free text that reaches the spawned command
// Safe path-segment check for a PR-review `ref` (server-derived as `<owner>-<repo>-<number>`,
// never split back apart) — rejects `/`/`..`/anything that could escape PR_REVIEWS via join().
const PR_REF_RE = /^[\w.-]+$/;
const ARCHIVE_MARKER = '.archived'; // empty marker file — manual archive, orthogonal to status.json
// Fixed prompt map — mode → resolve-ticket invocation. The ONLY value ever interpolated
// into a spawned command is the regex-validated <KEY>; nothing else (no notes, no free
// text) reaches argv. `plan` stops at PLAN for the human gate; `build` resumes an approved
// plan through review; `replan` re-runs just PLAN (feedback is passed via a file, never argv).
// `--auto-ship`: run through REVIEW, then open the PR ONLY if the rubric ≥ config loop.rubricTarget;
// otherwise stop at review for manual inspection. Never merges. `ship` is the manual force-ship
// (opens the PR regardless of rubric). `plan` stops at the plan gate and never ships.
const PROMPTS = {
  plan: (k) => `/resolve-ticket ${k} --until plan`,
  build: (k) => `/resolve-ticket ${k} --from build --auto-ship`,
  replan: (k) => `/resolve-ticket ${k} --from plan --until plan`,
  // `--from review` matters: without it the run restarts at INTAKE and rebuilds the whole
  // ticket before scoring it. PROJ-3107 cost $6 and ~918k tokens re-running a pipeline the
  // operator only wanted scored.
  review: (k) => `/resolve-ticket ${k} --from review --auto-ship`,
  ship: (k) => `/resolve-ticket ${k} --from ship --yes`,
};
// `continue` is dynamic — it resumes from the ticket's blocked stage (read server-side from
// status.json, validated against RESUMABLE_STAGES), so it isn't a fixed PROMPTS entry.
const MODES = new Set([...Object.keys(PROMPTS), 'continue']);
const RESUMABLE_STAGES = new Set(GRAPH_RESUMABLE_STAGES); // derived from stage-graph.mjs — never re-typed
/** Build the resume prompt for a blocked ticket, or null if there's no resumable stage.
 * Ship resumes with `--yes` (the operator's Continue click is the confirmation); every other
 * stage resumes forward only to REVIEW so a resume never auto-ships. Stage comes from
 * status.json and is allow-listed — no free text reaches argv. */
function continuePrompt(key) {
  const status = readJsonSafe(join(TICKETS, key, 'status.json'));
  const stage = status?.stage;
  if (!stage || !RESUMABLE_STAGES.has(stage)) return null;
  return stage === 'ship'
    ? `/resolve-ticket ${key} --from ship --yes`
    : `/resolve-ticket ${key} --from ${stage} --auto-ship`;
}
const MAX_CONCURRENT_RUNS = 2;

// Ordered kanban columns. The KEYS come from the graph's declared projection
// (stage-graph.mjs COLUMN_KEYS — preflight folds onto route, context onto plan); only the
// human LABELS are presentation and live here. A stage added to the graph gets a lane
// automatically instead of silently falling through to 'intake'.
const COLUMN_LABELS = {
  queued: 'Queued',
  intake: 'Intake',
  route: 'Route',
  plan: 'Plan',
  build: 'Build',
  verify: 'Verify',
  review: 'Review',
  ship: 'Ship · awaiting merge',
  archived: 'Archived',
};
const COLUMNS = GRAPH_COLUMN_KEYS.map((key) => ({ key, label: COLUMN_LABELS[key] || key }));
const COLUMN_KEYS = new Set(GRAPH_COLUMN_KEYS);

// ---- shared read helpers (guarded — one bad ticket dir must never crash a scan) ----

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** First markdown heading in a file (leading `#`s stripped), or `fallback`. */
function firstHeading(path, fallback) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim() || fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Last `score` from tickets/<KEY>/rubric.jsonl, or null. Never throws. */
function lastRubricScore(key) {
  const path = join(TICKETS, key, 'rubric.jsonl');
  try {
    const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last?.score === 'number' ? last.score : null;
  } catch {
    return null;
  }
}

/** What this ticket has cost so far, via the same accessor the cards and cost page use.
 *  Null only when there is genuinely nothing to price — and it complains loudly if the lookup
 *  itself fails, because a swallowed error here silently disables the budget gate, which is
 *  precisely what the first version of this function did. */
function ticketSpendUsd(key, cm) {
  try {
    const agg = loadTicketAggregate(key, cm, key);
    return typeof agg?.costUsd === 'number' ? agg.costUsd : null;
  } catch (e) {
    console.error(`[panel] budget gate could not price ${key}: ${e?.message || e}`);
    return null;
  }
}

/** Does the last receipt authorise a PR? The Ship button asks this so it can be honest about
 * what will happen — offering Ship on a ticket the gate will refuse is what made "override"
 * look broken. Same rule as evaluateShipGate: only `action: "done"` counts. */
function receiptIsDone(key) {
  const path = join(TICKETS, key, 'rubric.jsonl');
  try {
    const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    return JSON.parse(lines[lines.length - 1])?.action === 'done';
  } catch {
    return false;
  }
}

function loadCostModel() {
  const raw = readJsonSafe(join(ROOT, 'config', 'cost-model.json'));
  const res = CostModelSchema.safeParse(raw ?? {});
  if (!res.success) throw new Error('config/cost-model.json is invalid');
  return res.data;
}

function loadBudgetCap() {
  const raw = readJsonSafe(join(ROOT, 'config', 'config.json'));
  if (!raw) return null;
  const res = ConfigSchema.safeParse(raw);
  return res.success ? res.data.loop?.budgetUsdPerTicket ?? null : null;
}

/** Parse a ticket's events.jsonl into a priced aggregate (via lib.buildTicket), or null. */
function loadTicketAggregate(key, cm, summary) {
  const path = join(TICKETS, key, 'events.jsonl');
  if (!existsSync(path)) return null;
  try {
    const events = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const parsed = parseEventLine(t);
      if (parsed.ok) events.push(parsed.event);
    }
    return buildTicket(key, summary, events, cm);
  } catch {
    return null;
  }
}

function listTicketKeys() {
  if (!existsSync(TICKETS)) return [];
  try {
    return readdirSync(TICKETS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Keys from the most-recent queue run in queue-runs/runs.jsonl. */
function latestQueueOutcomeKeys() {
  const path = join(QUEUE_RUNS, 'runs.jsonl');
  if (!existsSync(path)) return [];
  try {
    const runs = parseRunsJsonl(readFileSync(path, 'utf8'));
    const latest = runs[0];
    if (!latest || !Array.isArray(latest.outcomes)) return [];
    return latest.outcomes.map((o) => o?.key).filter(Boolean);
  } catch {
    return [];
  }
}

const foldStage = stageColumn; // the graph owns the projection (STAGE_COLUMN_FOLD)

/** Map a ticket's status.json onto a kanban column key. Overrides (archived / ship-
 * awaiting-merge) key off `stage`; the base column is the furthest COMPLETED stage
 * (`lastCompleted`, falling back to `stage`) so a ticket sits under the work that's done,
 * not the stage it's mid-way through. `preflight`→route and `context`→plan fold onto
 * their neighbouring column (neither has a lane of its own). */
function columnFor(status, prs, inQueue) {
  if (!status) return inQueue ? 'queued' : 'intake';
  const stage = status.stage || status.lastCompleted || '';
  const isMerged = stage === 'merged' || !!status.mergedAt;
  if (isMerged) return 'archived';          // confirmed merged → archived
  if (prs.length) return 'ship';            // has a PR that isn't merged yet → awaiting merge
  if (stage === 'done') return 'archived';  // finished with NO PR (verify-and-report / closed)
  let base = foldStage(status.lastCompleted || stage);
  if (!COLUMN_KEYS.has(base)) base = foldStage(stage);
  return COLUMN_KEYS.has(base) ? base : 'intake';
}

// ---- /api/state ----

const hasBuildEvents = (agg) => !!(agg && agg.stages.some((s) => s.stage === 'build'));

/** Build one ticket's kanban card. A manual `.archived` marker forces the archived column
 * regardless of pipeline stage (the two archive signals are orthogonal). `planReady` marks
 * a ticket parked at the human PLAN gate: PLAN completed, not archived, no build events yet. */
function buildCard(key, cm, queueKeys) {
  const status = readJsonSafe(join(TICKETS, key, 'status.json'));
  const prs = Array.isArray(status?.prs) ? status.prs : status?.pr ? [status.pr] : [];
  const summary = firstHeading(join(TICKETS, key, 'ticket.md'), key);
  const agg = loadTicketAggregate(key, cm, summary);
  const manuallyArchived = existsSync(join(TICKETS, key, ARCHIVE_MARKER));
  const column = manuallyArchived ? 'archived' : columnFor(status, prs, queueKeys.has(key));
  const planReady = !manuallyArchived && status?.lastCompleted === 'plan' && !hasBuildEvents(agg);
  return {
    key,
    summary,
    phase: status?.stage || status?.lastCompleted || '',
    lastCompleted: status?.lastCompleted || null,
    column,
    prUrl: prs[0] || null,
    jiraStatus: status?.jiraStatus || null,
    // The RECEIPT is authoritative, never status.json (contract §1). Preferring
    // status.rubricScore here was the display half of the bug Goal A1 closes: 7 tickets
    // carry a model-written score with no rubric.jsonl behind it, and the panel rendered
    // them identically to a computed one. An unbacked number is surfaced as unverified
    // rather than shown as fact — the operator has to be able to tell them apart.
    rubricScore: lastRubricScore(key),
    rubricUnverified: lastRubricScore(key) === null && typeof status?.rubricScore === 'number'
      ? status.rubricScore
      : null,
    updatedAt: status?.updatedAt || null,
    costUsd: agg ? agg.costUsd : 0,
    tokens: agg ? agg.tokens : 0,
    running: running.has(key),
    runMode: running.get(key)?.mode || null,
    // Both computed here rather than re-derived in the client: the stage graph and the receipt
    // rule have one home each, and the buttons just render what the server says. `canContinue`
    // mirrors continuePrompt() exactly — a run killed mid-stage is resumable even though nothing
    // marked it blocked, which is why Continue used to disappear.
    canContinue: typeof status?.stage === 'string' && RESUMABLE_STAGES.has(status.stage),
    shipReady: receiptIsDone(key),
    manuallyArchived,
    planReady,
    // A run that halted on a guardrail writes status.json { status:"blocked", blockedReason, stage }.
    blocked: status?.status === 'blocked',
    blockedReason: status?.blockedReason || null,
    blockedStage: status?.status === 'blocked' ? status?.stage || null : null,
  };
}

function buildState() {
  const cm = loadCostModel();
  const queueKeys = new Set(latestQueueOutcomeKeys());
  const keys = listTicketKeys();
  const haveDir = new Set(keys);

  const tickets = [];
  for (const key of keys) {
    try {
      tickets.push(buildCard(key, cm, queueKeys));
    } catch {
      // one malformed ticket dir shouldn't drop the whole board
      tickets.push({ key, summary: key, phase: '', column: 'intake', prUrl: null, jiraStatus: null, rubricScore: null, updatedAt: null, costUsd: 0, tokens: 0, running: running.has(key), manuallyArchived: false, planReady: false });
    }
  }

  // Labelled tickets from the latest queue run that have no local ticket dir yet.
  const queue = [...queueKeys].filter((k) => !haveDir.has(k)).map((key) => ({ key }));

  const sched = schedulerCfg();
  const automation = {
    cron: { ...sched, lastScanAt: lastScan.at, nextRunAt: nextScanAt(), scanning: scanBusy, error: lastScan.error },
    paused: isPaused(),
    autoBuild: isAutoBuild(),
    pendingCount: lastScan.keys.length,
    pending: lastScan.keys,
    // The same scan, triaged: details, skip/snooze/order from queue-runs/triage.json, and a
    // cost estimate from tickets that already ran. `pending` above stays for the classic panel.
    triage: queueTriageState(tickets, haveDir),
  };
  // Stale sweep (A8) — additive: a `sweeper` block plus a `stale` marker on the cards it
  // names. No existing field changes shape, so the React panel and the legacy pages can
  // both read this state.
  const sweeper = buildSweep(tickets);
  const staleByKey = new Map(sweeper.tickets.map((s) => [s.key, s]));
  const inBuildQueue = new Set(buildQueue);
  for (const t of tickets) {
    const s = staleByKey.get(t.key);
    t.stale = s ? { reason: s.reason, idleHours: s.idleHours, thresholdHours: s.thresholdHours } : null;
    t.queuedForBuild = inBuildQueue.has(t.key);
  }
  return { generatedAt: new Date().toISOString(), columns: COLUMNS, tickets, queue, running: [...running.keys()], buildQueue: [...buildQueue], planQueue: [...planQueue], automation, sweeper };
}

const QUEUE_TRIAGE = join(QUEUE_RUNS, 'triage.json');

function scanItems() {
  const items = lastScan.items?.length ? lastScan.items : [];
  const known = new Set(items.map((i) => i.key));
  // Scans saved before details were kept have keys only; show them rather than drop them.
  return [...items, ...lastScan.keys.filter((k) => !known.has(k)).map((key) => normaliseScanRows([{ key }])[0])];
}

function queueTriageState(tickets, haveDir) {
  const tracked = new Set([...haveDir, ...running.keys()]);
  const { visible, hidden } = triageView(scanItems(), readJsonSafe(QUEUE_TRIAGE), { tracked });
  const history = tickets.filter((t) => t.costUsd > 0 && !t.running);
  const withEstimate = (i) => ({ ...i, estimate: estimateCost(i.summary, history), queuedForPlan: planQueue.includes(i.key) });
  return { visible: visible.map(withEstimate), hidden: hidden.map(withEstimate) };
}

// ---- /api/ticket (detail drawer) ----

const readTextSafe = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** Ordered stage_end rows for the timeline. Tolerant JSON parse (keeps non-enum stages like
 * `context` that the priced aggregate drops) — this view is informational, not billing. */
function buildTimeline(key) {
  const rows = [];
  try {
    for (const line of readFileSync(join(TICKETS, key, 'events.jsonl'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try { o = JSON.parse(t); } catch { continue; }
      if (o?.event !== 'stage_end') continue;
      rows.push({
        stage: o.stage || '',
        agent: o.agent || '',
        status: o.status || 'ok',
        durationSec: o.durationSec || 0,
        tokensTotal: typeof o.tokensTotal === 'number' ? o.tokensTotal : (o.tokensIn || 0) + (o.tokensOut || 0),
        notes: o.notes || '',
      });
    }
  } catch {
    /* no events yet — empty timeline */
  }
  return rows;
}

/** Every distinct plan.md the ticket has had, saved as plans/v<n>.md the first time it is seen,
 * so a re-plan can be compared with what it replaced. */
function planVersions(key) {
  const dir = join(TICKETS, key, 'plans');
  const indexPath = join(dir, 'index.json');
  const index = readJsonSafe(indexPath) || { versions: [] };
  const md = readTextSafe(join(TICKETS, key, 'plan.md'));
  const nv = md ? nextVersion(index.versions.map((v) => v.sha), md) : null;
  if (nv?.isNew) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `v${nv.version}.md`), md);
      index.versions.push({ version: nv.version, sha: nv.sha, at: new Date().toISOString() });
      writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    } catch { /* versions are a convenience; the plan itself is untouched */ }
  }
  return { versions: index.versions, current: nv?.version ?? null };
}

function planReviewDetail(key) {
  const { versions, current } = planVersions(key);
  const review = normaliseReview(readJsonSafe(join(TICKETS, key, 'plan-review.json')));
  const md = readTextSafe(join(TICKETS, key, 'plan.md'));
  const prev = current && current > 1 ? readTextSafe(join(TICKETS, key, 'plans', `v${current - 1}.md`)) : null;
  const questions = normaliseQuestions(readJsonSafe(join(TICKETS, key, 'questions.json')));
  const answers = readJsonSafe(join(TICKETS, key, 'answers.json'));
  return {
    versions,
    current,
    comments: review.comments,
    open: openComments(review).length,
    // The plan split into the headed blocks comments pin to - one implementation, server-side.
    blocks: md ? splitPlan(md).map(({ id, level, title, body, kind }) => ({ id, level, title, body, kind })) : [],
    checklist: md ? checklist(md) : [],
    changed: prev && md ? changedBlocks(prev, md) : null,
    questions,
    answers: Array.isArray(answers?.answers) ? answers.answers : [],
    // Asked and not yet answered: the plan stage is waiting on a person.
    awaitingAnswers: questions.length > 0 && !answers,
  };
}

function buildTicketDetail(key) {
  const cm = loadCostModel();
  const queueKeys = new Set(latestQueueOutcomeKeys());
  const card = buildCard(key, cm, queueKeys);
  const artifact = (name) => readTextSafe(join(TICKETS, key, name));
  return {
    shots: buildTicketShots(key),
    key: card.key,
    summary: card.summary,
    phase: card.phase,
    column: card.column,
    prUrl: card.prUrl,
    jiraStatus: card.jiraStatus,
    rubricScore: card.rubricScore,
    costUsd: card.costUsd,
    tokens: card.tokens,
    manuallyArchived: card.manuallyArchived,
    planReady: card.planReady,
    running: card.running,
    // Board/list already had these (buildCard computes them); the detail view didn't, so the
    // one place with room to explain a block and collect a resume note couldn't tell whether
    // there was one to explain.
    canContinue: card.canContinue,
    blocked: card.blocked,
    blockedReason: card.blockedReason,
    blockedStage: card.blockedStage,
    timeline: buildTimeline(key),
    planReview: planReviewDetail(key),
    artifacts: {
      plan: artifact('plan.md'),
      design: artifact('design.md'),
      context: artifact('context.md'),
      review: artifact('review.md'),
      verify: artifact('verify.md'),
      ticket: artifact('ticket.md'),
    },
  };
}

// ---- escaped-defect rate (contract §6) ----
// The one number that says whether any of the other gates are working: how often a
// shipped ticket later produced a fidelity defect against a component it had shipped.
// scripts/regression-trace.mjs walks the target repo's git history, so it costs ~4s —
// far too slow to run inside a request. It is computed on a TTL, served from cache, and
// refreshed in the background; a request never waits on it. `stale` is reported rather
// than hidden, because a silently-frozen number is worse than an honestly old one.
const REGRESSION_TTL_MS = 10 * 60 * 1000;
let regressionCache = { data: null, computedAt: 0, error: null };
let regressionInFlight = false;

async function refreshRegression() {
  if (regressionInFlight) return;
  regressionInFlight = true;
  const r = await guardExec('regression-trace', process.execPath, [join(ROOT, 'scripts', 'regression-trace.mjs'), '--json'], {
    cwd: ROOT,
    retries: 0,
    timeoutMs: 60000,
  });
  try {
    if (r.ok) {
      regressionCache = { data: JSON.parse(r.value.stdout), computedAt: Date.now(), error: null };
    } else {
      // Keep the last good value; record why it could not be refreshed.
      regressionCache = { ...regressionCache, error: r.reason || 'regression-trace failed' };
    }
  } catch (e) {
    regressionCache = { ...regressionCache, error: `regression-trace returned unparseable JSON: ${e?.message || e}` };
  } finally {
    regressionInFlight = false;
  }
}

/** Cached escaped-defect summary for the cost page. Kicks off a background refresh when
 * stale and returns immediately with whatever is known — including `null` on the very
 * first call, which the UI renders as "computing" rather than as a zero. */
function regressionBlock() {
  const age = Date.now() - regressionCache.computedAt;
  if (!regressionCache.data || age > REGRESSION_TTL_MS) refreshRegression();
  if (!regressionCache.data) {
    return { pending: true, error: regressionCache.error, computedAt: null, stale: false };
  }
  const d = regressionCache.data;
  return {
    pending: false,
    error: regressionCache.error,
    computedAt: new Date(regressionCache.computedAt).toISOString(),
    stale: age > REGRESSION_TTL_MS,
    shipped: d.shipped,
    escaped: d.escaped,
    escapedDefectRate: d.escapedDefectRate,
    rubricCorrelation: d.rubricCorrelation ?? null,
    byComponent: Array.isArray(d.byComponent) ? d.byComponent.filter((c) => (c.escapes || []).length) : [],
  };
}

// ---- /api/cost ----

function buildCost() {
  const cm = loadCostModel();
  const keys = listTicketKeys();

  const built = [];
  const meta = new Map();
  for (const key of keys) {
    const status = readJsonSafe(join(TICKETS, key, 'status.json'));
    const prs = Array.isArray(status?.prs) ? status.prs : status?.pr ? [status.pr] : [];
    const summary = firstHeading(join(TICKETS, key, 'ticket.md'), key);
    const agg = loadTicketAggregate(key, cm, summary);
    if (!agg) continue; // no priced events — nothing to report on the cost page
    built.push(agg);
    meta.set(key, { prUrl: prs[0] || null, jiraStatus: status?.jiraStatus || status?.stage || null, updatedAt: status?.updatedAt || null, running: running.has(key) });
  }

  const data = aggregate(built, new Date().toISOString(), cm.currency);

  // Per-stage breakdown incl. average duration (aggregate() gives cost/tokens per stage
  // but not duration, so fold that in here from the built stages).
  const stageAcc = Object.fromEntries(STAGE_ORDER.map((s) => [s, { stage: s, costUsd: 0, tokens: 0, durationSec: 0, count: 0 }]));
  for (const t of built) {
    for (const s of t.stages) {
      const a = stageAcc[s.stage];
      if (!a) continue;
      a.costUsd += s.costUsd;
      a.tokens += s.tokensIn + s.tokensOut;
      a.durationSec += s.durationSec;
      a.count += 1;
    }
  }
  const stages = Object.values(stageAcc).map((a) => ({
    stage: a.stage,
    costUsd: +a.costUsd.toFixed(4),
    tokens: a.tokens,
    count: a.count,
    avgDurationSec: a.count ? Math.round(a.durationSec / a.count) : 0,
  }));

  const cap = loadBudgetCap();
  const budget = {
    capPerTicket: cap,
    tickets: budgetRows(built, cap).map((row) => ({ ...row, rubricScore: lastRubricScore(row.key) })),
  };

  const tickets = built.map((t) => ({
    key: t.key,
    summary: t.summary,
    costUsd: t.costUsd,
    tokens: t.tokens,
    status: t.status,
    prUrl: meta.get(t.key)?.prUrl || null,
    jiraStatus: meta.get(t.key)?.jiraStatus || null,
    updatedAt: meta.get(t.key)?.updatedAt || null,
    running: meta.get(t.key)?.running || false,
  }));

  // PR reviews have no per-stage events.jsonl breakdown (see startPrReviewRun's onFinish) —
  // just a single total cost/token figure captured from the run's own `result` event.
  // Kept as a SEPARATE totals block from tickets' `data.totals`, not folded in: "Tickets"
  // in the ticket totals should keep meaning ticket count, not a mixed count.
  // Pairs computed ONCE and threaded in — `.map(buildPrReviewCard)` would hand the callback the
  // element index as its second argument, and re-deriving per card would re-read every status.json.
  const prPairs = knownPrRepoPairs();
  const prReviews = listPrReviewRefs().map((r) => buildPrReviewCard(r, prPairs));
  const prReviewTotals = {
    cost: prReviews.reduce((sum, r) => sum + (r.costUsd || 0), 0),
    tokens: prReviews.reduce((sum, r) => sum + (r.tokens || 0), 0),
    count: prReviews.length,
  };

  return {
    generatedAt: data.generatedAt,
    currency: data.currency,
    totals: data.totals,
    tickets,
    stages,
    budget,
    prReviews,
    prReviewTotals,
    regression: regressionBlock(),
  };
}

// ---- Server-Sent Events ----

const sseClients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client vanished mid-write — the close handler will reap it
  }
}

function broadcast(event, data) {
  for (const res of sseClients) sseSend(res, event, data);
}

let watchTimer = null;
function scheduleStateBroadcast() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => broadcast('state', { at: Date.now() }), 300); // debounce fs bursts
}

function startWatchers() {
  mkdirSync(EXPLAINERS, { recursive: true });
  for (const dir of [TICKETS, QUEUE_RUNS, PR_REVIEWS, EXPLAINERS]) {
    if (!existsSync(dir)) continue;
    try {
      watch(dir, { recursive: true }, scheduleStateBroadcast);
    } catch {
      // recursive watch may be unsupported on some platforms — degrade to no live updates
    }
  }
}

// ---- run management ----

const running = new Map(); // key -> { child, mode, logStream }
const runningPrReviews = new Map(); // ref -> { child, mode, logStream } — separate id space from `running`
const runningExplainers = new Map(); // slug -> { child, mode, logStream } — its own cap, like reviews
const runningChats = new Map(); // chat:<KEY>:<id> -> { child, mode, logStream } — read-only answers, own cap
// Keys approved for BUILD in bulk but still waiting for a concurrency slot. `/api/build-all`
// fills this FIFO; drainBuildQueue() starts as many as MAX_CONCURRENT_RUNS allows and re-drains
// each time a ticket run finishes, so the operator approves the whole plan-ready column once and
// the panel feeds them through the same 2-at-a-time cap the single button already obeys.
const buildQueue = [];
// Keys the operator chose to plan together from the queue, started as slots free up.
const planQueue = [];
// Keys the continuous auto-build sweep has already started once. Without this, a build that
// fails BEFORE writing any build stage_end leaves the ticket still "plan-ready", so the next
// sweep would re-pick it and retry forever — a runaway cost loop overnight. The explicit
// "Build all ready" button ignores this set (a human clicking it means "try again"); only the
// automatic sweep honours it. Cleared when auto-build is turned off or the panel is paused.
const autoBuildAttempted = new Set();

/** Split a stream into lines and invoke onLine(text) per line. */
function pipeLines(stream, onLine) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf.length) onLine(buf);
  });
}

/** Spawn one headless `claude -p <prompt>` run and wire its output into the log
 * file + SSE broadcast + registry-based lifecycle. Shared by the ticket-run path
 * (`startRun`) and the ad-hoc PR-review path (`startPrReviewRun`) — extracted rather
 * than pasted twice, which would be exactly the kind of duplication this feature exists
 * to catch. `id`/`mode`/`dir`/`logName`/`registry` let each caller keep its own id space
 * and log-file naming; the broadcast payload shape (`{key, mode, line}` / `{key, mode,
 * code}`) is unchanged for the ticket path so existing kanban.js/console.js consumers
 * (which read `d.mode` off `run-end`) keep working exactly as before. */
function spawnClaudeRun({ id, mode, dir, logName, prompt, registry, onFinish, model, countWork }) {
  const settingsFile = mode === 'chat' ? CHAT_SETTINGS_PATH : HEADLESS_SETTINGS_PATH;
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, logName);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== panel run ${mode} @ ${new Date().toISOString()} ===\n`);

  // Unset CLAUDE_RUN_ARGS → the generated pre-scoped policy; set → the override verbatim. `-p` last.
  const baseArgs = [
    ...(RUN_ARGS_OVERRIDE != null ? RUN_ARGS_OVERRIDE : ['--settings', settingsFile]),
    ...(atlasMcpPath ? ['--mcp-config', atlasMcpPath] : []),
  ];
  // stream-json (needs --verbose) flushes each event immediately — without it, `claude -p` block-
  // buffers stdout when not a TTY, so nothing logs until the process exits (no live streaming).
  // `model` is opt-in per caller: with no flag the CLI falls back to its own account-level
  // default, which may be a pricier tier than an orchestration-only run needs (parsing,
  // checkout, delegation — no heavy reasoning of its own). Ticket runs (`startRun`) don't
  // pass one, so their behavior is unchanged; the PR-review path pins Sonnet explicitly.
  const args = [...baseArgs, '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : []), '-p', prompt];
  // Always AUTOPILOT_HEADLESS=1 (pipeline takes the headless Jira path) + NPM_TOKEN/NODE_AUTH_TOKEN
  // (private-package auth) if present. Jira creds are deliberately NOT injected (jira.mjs reads
  // them from millwright/config/autopilot.env itself) — but `jira.mjs` gives `process.env` PRIORITY
  // over that file (an intentional quick-override escape hatch), so if a stale JIRA_API_TOKEN/
  // JIRA_EMAIL/JIRA_BASE_URL happens to be exported in whatever shell originally launched this
  // panel process, it would silently pass through to every spawned run, permanently shadowing a
  // since-rotated, correct token in the file (confirmed root cause of a real incident: the file's
  // token worked standalone, every headless run 401'd anyway). Deleting the keys from `childEnv`
  // is NOT enough on its own — execa's `env` option MERGES with the calling process's live
  // `process.env` by default (`extendEnv: true`), so a deleted key silently comes back from the
  // parent's real environment regardless of what the passed-in object says (confirmed directly:
  // the child still saw the parent's value even after `delete`). `extendEnv: false` makes
  // `childEnv` the child's COMPLETE environment instead of an overlay, so the deletion actually
  // takes effect.
  const secrets = buildSecrets();
  const childEnv = { ...process.env, AUTOPILOT_HEADLESS: '1', ...secrets };
  delete childEnv.JIRA_API_TOKEN;
  delete childEnv.JIRA_EMAIL;
  delete childEnv.JIRA_BASE_URL;
  // Atlas's TEST reads switch on only with this set; a pipeline run never gets it.
  delete childEnv.ATLAS_LIVE_EXAMPLES;
  logStream.write(secrets.NPM_TOKEN ? '[panel] NPM_TOKEN present → injected\n' : `[panel] NPM_TOKEN MISSING → private-package install will 401 (add it to ${ENV_PATH})\n`);
  const child = execa(CLAUDE_BIN, args, {
    cwd: WORKSPACE, env: childEnv, extendEnv: false, buffer: false, stdin: 'ignore', reject: false,
  });

  // Captured from the SDK's own final `result` event — the authoritative total cost/usage
  // for this run, independent of whatever formatStreamEvent renders as a human-readable
  // line. Ticket runs already have a richer, per-stage cost breakdown from events.jsonl
  // (written by the resolve-ticket pipeline itself) and ignore this; `onFinish` is how a
  // caller with no such breakdown (the ad-hoc PR-review path) gets a real number instead
  // of nothing.
  let lastResult = null;
  // First CLI "Unknown command:" / unresolved-skill line seen. Kept because it names the actual
  // root cause (broken symlinks) far better than the no-op verdict alone can.
  let hardError = null;
  const onLine = (raw) => {
    const line = formatStreamEvent(raw);
    if (line != null) {
      logStream.write(line + '\n');
      broadcast('log', { key: id, mode, line });
    }
    const seen = inspectStreamLine(raw);
    if (seen.result) lastResult = seen.result;
    if (seen.hardError && !hardError) hardError = seen.hardError;
  };
  pipeLines(child.stdout, onLine);
  pipeLines(child.stderr, onLine);

  // How much work existed BEFORE this run, so `finish` can tell whether the run added any.
  // Sampled synchronously here, not at exit, or a stage_end from a previous run would count.
  const workBefore = typeof countWork === 'function' ? countWork() : null;

  const finish = (code) => {
    const entry = registry.get(id);
    if (!entry) return; // already finished
    registry.delete(id);

    const workAfter = typeof countWork === 'function' ? countWork() : null;
    const outcome = classifyRunOutcome({
      code,
      cancelled: !!entry.cancelled,
      costUsd: lastResult?.costUsd ?? null,
      stageEndDelta: workBefore == null || workAfter == null ? null : workAfter - workBefore,
      resultIsError: !!lastResult?.isError,
      resultSubtype: lastResult?.subtype ?? null,
      resultText: lastResult?.text ?? null,
      hardError,
    });

    // The verdict goes through the SAME log+SSE path as every other line, so it lands in the
    // log file the operator reads on disk AND in the live console, not just in the payload.
    const verdict = runFailureLine(mode, outcome);
    if (verdict) {
      logStream.write(verdict + '\n');
      broadcast('log', { key: id, mode, line: verdict });
    }
    try { logStream.end(runEndTrailer(mode, code, outcome) + '\n'); } catch {}
    if (onFinish) { try { onFinish(lastResult, code, outcome); } catch { /* never let a cost-write bug break the run */ } }
    // `code`/`mode` stay exactly as they were for existing consumers (kanban.js, console.js);
    // `ok`/`status`/`failure` are additive.
    broadcast('run-end', { key: id, mode, code, ok: outcome.ok, status: outcome.status, failure: outcome.failure });
    scheduleStateBroadcast();
  };
  child.on('exit', (code) => finish(code ?? 0));
  // reject:false means the promise resolves even on non-zero exit / spawn error;
  // still guard so a spawn failure (e.g. CLAUDE_BIN missing) surfaces instead of throwing.
  child.then((r) => finish(r?.exitCode ?? 0)).catch((err) => {
    onLine(`[panel] run failed to start: ${err?.shortMessage || err?.message || err}`);
    finish(err?.exitCode ?? 1);
  });

  registry.set(id, { child, mode, logStream });
  scheduleStateBroadcast();
}

function startRun(key, mode, prompt) {
  spawnClaudeRun({
    id: key, mode, dir: join(TICKETS, key), logName: `panel-run-${mode}.log`, prompt, registry: running,
    // The pipeline appends one stage_end per completed stage — the only proof a stage run did
    // real work, and the half of the no-op test that an exit code can't fake.
    countWork: () => countStageEnds(readTextSafe(join(TICKETS, key, 'events.jsonl')) || ''),
    // A finished ticket run frees a slot — feed the next build into it. Fire the drain when the
    // queue has waiters OR auto-build is on (a run that just reached plan-ready must be swept in
    // even if the queue was momentarily empty). Runs after spawnClaudeRun's `finish` has already
    // done registry.delete(id), so running.size is current.
    onFinish: () => { if (buildQueue.length || planQueue.length || isAutoBuild()) drainBuildQueue(); },
  });
}

/** Enqueue every plan-ready ticket not already running/queued (budget-permitting). Returns the
 * keys accepted and the ones skipped-with-reason. Shared by the one-shot /api/build-all click and
 * the continuous auto-build sweep — both want exactly this "which plan-ready tickets are eligible"
 * decision, so it lives in one place. Does NOT start anything; the caller drains. */
function enqueuePlanReadyBuilds(tickets, { skipAttempted = false } = {}) {
  const cm = loadCostModel();
  const capUsd = loadBudgetCap();
  const planReady = tickets.filter((t) => t.planReady).map((t) => t.key);
  const queued = new Set(buildQueue);
  const accepted = [];
  const skipped = [];
  for (const key of planReady) {
    if (running.has(key) || queued.has(key)) { skipped.push({ key, reason: 'already building or queued' }); continue; }
    // The auto-build sweep never re-picks a ticket it already tried (anti-loop, see the set's
    // comment). The explicit button passes skipAttempted:false so a human can force a retry.
    if (skipAttempted && autoBuildAttempted.has(key)) { skipped.push({ key, reason: 'auto-build already attempted this ticket' }); continue; }
    // A plan-ready ticket's spend is fixed until it runs, so the single-run budget gate is
    // correct to apply here at enqueue time rather than per-drain.
    const budget = evaluateBudgetGate({ mode: 'build', key, spentUsd: ticketSpendUsd(key, cm), capUsd, acknowledged: false });
    if (!budget.allowed) { skipped.push({ key, reason: budget.reason }); continue; }
    buildQueue.push(key);
    queued.add(key);
    accepted.push(key);
  }
  return { accepted, skipped };
}

/** Start queued bulk builds up to the concurrency cap. Safe to call repeatedly: it no-ops when
 * paused, when the cap is full, or when the queue is empty, and skips any key that is already
 * running or no longer plan-ready (cancelled, or already built by another path). When auto-build
 * is on it first sweeps any newly-plan-ready tickets into the queue, so a ticket that just reached
 * the gate (e.g. another run finishing its plan) is picked up without a click. */
function drainBuildQueue() {
  if (isPaused()) return;
  const tickets = buildState().tickets;
  if (isAutoBuild()) enqueuePlanReadyBuilds(tickets, { skipAttempted: true });
  const planReady = new Set(tickets.filter((t) => t.planReady).map((t) => t.key));
  while (running.size < MAX_CONCURRENT_RUNS && buildQueue.length) {
    const key = buildQueue.shift();
    if (running.has(key) || !planReady.has(key)) continue;
    autoBuildAttempted.add(key); // marks it tried, so the auto-sweep won't retry a failed build
    startRun(key, 'build', PROMPTS.build(key));
  }
  while (running.size < MAX_CONCURRENT_RUNS && planQueue.length) {
    const key = planQueue.shift();
    if (running.has(key)) continue;
    startRun(key, 'plan', PROMPTS.plan(key));
  }
  scheduleStateBroadcast();
}

function startPrReviewRun(ref, prUrl) {
  const dir = join(PR_REVIEWS, ref);
  // Seed status.json with the URL BEFORE the run starts. `ref` is not reversible into a URL
  // (see prRefId), and the skill is what normally writes status.json — so a review that dies
  // early used to leave nothing to retry from, and rendered as a bare ref with no link.
  // Merged over any existing file so a retry never discards the previous attempt's fields.
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'status.json');
    const current = readJsonSafe(path) || {};
    writeFileSync(path, JSON.stringify({
      ...current, ref, prUrl, result: null, failure: null, startedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch { /* best-effort — never block the run on a status write */ }
  // A re-review is a new round of findings. Archive the last one before the run can write.
  try { archiveReviewRound(join(PR_REVIEWS, ref)); } catch (e) { console.error(`[pr-review ${ref}] could not archive the last round: ${e?.message || e}`); }

  spawnClaudeRun({
    id: ref, mode: 'review', dir, logName: 'panel-run.log', prompt: `/review-pr ${prUrl}`, registry: runningPrReviews,
    // Orchestration work (parse/checkout/delegate/branch-on-identity) doesn't need a
    // pricier default tier — quality-agent (the actual judgment work) is already pinned
    // to Sonnet in its own frontmatter; match it here instead of inheriting whatever the
    // account's default model is.
    model: 'sonnet',
    // PR reviews have no per-stage events.jsonl breakdown like tickets do — this is the
    // ONLY source of real cost/token data for them, so merge it into status.json (whatever
    // fields the /review-pr skill itself already wrote there) once the child has fully
    // exited — no race, the process's own writes are already flushed by exit time.
    // A PR review has no events.jsonl, so `countWork` is deliberately omitted — cost alone
    // decides there (classifyRunOutcome treats a null stage delta as unknown, not zero).
    onFinish: (result, code, outcome) => {
      const path = join(PR_REVIEWS, ref, 'status.json');
      const current = readJsonSafe(path) || {};
      const next = {
        ...current,
        costUsd: result?.costUsd ?? current.costUsd ?? 0,
        tokens: result?.tokens ?? current.tokens ?? 0,
        updatedAt: new Date().toISOString(),
      };
      // A review whose run did nothing must not keep whatever hopeful `result` the skill wrote
      // before it died (or, on a no-op, never wrote at all) — the card would read as a real review.
      if (outcome && !outcome.ok) {
        // `needs-input` is its own result: the run did not fail, it is waiting on an answer.
        // Recording it as `failed` was what made a halted re-review read as a finished one.
        if (outcome.status === 'cancelled') next.result = 'cancelled';
        else if (outcome.status === 'needs-input') next.result = 'needs-input';
        else next.result = 'failed';
        next.failure = outcome.failure;
        next.question = outcome.status === 'needs-input' ? questionFrom(lastResult?.text) : undefined;
      }
      try { writeFileSync(path, JSON.stringify(next, null, 2) + '\n'); } catch { /* best-effort */ }
    },
  });
}

/** Start a plain-language explainer. Only the validated slug reaches argv; the skill reads
 * what to explain from the status.json seeded here. */
function startExplainRun(subject) {
  const dir = join(EXPLAINERS, subject.slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'status.json');
  const current = readJsonSafe(path) || {};
  writeFileSync(path, JSON.stringify({
    ...current, slug: subject.slug, subject: { type: subject.type, id: subject.id, label: subject.label },
    title: current.title || subject.label, result: null, failure: null, startedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  spawnClaudeRun({
    id: subject.slug, mode: 'explain', dir, logName: 'panel-run.log', prompt: `/explain ${subject.slug}`,
    registry: runningExplainers, model: 'sonnet',
    onFinish: (result, code, outcome) => {
      const now = readJsonSafe(path) || {};
      const wrote = (readTextSafe(join(dir, 'explain.md')) || '').trim().length > 0;
      const ok = !!outcome?.ok && wrote;
      writeFileSync(path, JSON.stringify({
        ...now,
        costUsd: result?.costUsd ?? now.costUsd ?? 0,
        tokens: result?.tokens ?? now.tokens ?? 0,
        updatedAt: new Date().toISOString(),
        result: ok ? 'done' : outcome?.status === 'cancelled' ? 'cancelled' : 'failed',
        failure: ok ? null : outcome?.failure || (wrote ? null : 'the run finished without writing explain.md'),
      }, null, 2) + '\n');
    },
  });
}

/** Ask a ticket a question: the panel writes chat/<id>.q.json (+ the recent history), a
 * read-only /ticket-chat run writes chat/<id>.a.json. Only the key and id reach argv. */
function startChatRun(key, q) {
  const dir = join(TICKETS, key, 'chat');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${q.id}.q.json`), JSON.stringify(q, null, 2) + '\n');
  writeFileSync(join(dir, `${q.id}.context.json`), JSON.stringify({ history: historyForRun(chatEntries(key)) }, null, 2) + '\n');
  spawnClaudeRun({
    id: `chat:${key}:${q.id}`, mode: 'chat', dir, logName: `${q.id}.log`, prompt: `/ticket-chat ${key} ${q.id}`,
    registry: runningChats, model: 'sonnet',
    onFinish: (result, code, outcome) => {
      if (existsSync(join(dir, `${q.id}.a.json`))) return;
      writeFileSync(join(dir, `${q.id}.fail.json`), JSON.stringify({
        failure: outcome?.failure || 'the answer run finished without writing an answer', costUsd: result?.costUsd ?? 0,
      }, null, 2) + '\n');
    },
  });
}

function chatEntries(key) {
  const dir = join(TICKETS, key, 'chat');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const ids = [...new Set(names.map((n) => n.split('.')[0]).filter((id) => CHAT_ID_RE.test(id)))];
  return ids.map((id) => ({
    id,
    q: readJsonSafe(join(dir, `${id}.q.json`)),
    a: readJsonSafe(join(dir, `${id}.a.json`)),
    failed: readJsonSafe(join(dir, `${id}.fail.json`))?.failure || null,
  }));
}

function explainerCard(slug) {
  const dir = join(EXPLAINERS, slug);
  const s = readJsonSafe(join(dir, 'status.json')) || {};
  return {
    slug,
    subject: s.subject || null,
    title: s.title || s.subject?.label || slug,
    summary: typeof s.summary === 'string' ? s.summary : null,
    result: s.result || null,
    failure: s.failure || null,
    running: runningExplainers.has(slug),
    startedAt: s.startedAt || null,
    updatedAt: s.updatedAt || null,
    costUsd: typeof s.costUsd === 'number' ? s.costUsd : 0,
    hasText: existsSync(join(dir, 'explain.md')),
  };
}

function listExplainers() {
  let names = [];
  try { names = readdirSync(EXPLAINERS, { withFileTypes: true }).filter((d) => d.isDirectory() && isSlug(d.name)).map((d) => d.name); } catch { /* none yet */ }
  return names.map(explainerCard)
    .sort((a, b) => Number(b.running) - Number(a.running) || (b.updatedAt || b.startedAt || '').localeCompare(a.updatedAt || a.startedAt || ''));
}

/** Read a ticket's run log for the observability console: the given `mode`'s log, else the
 * most-recently-written `panel-run-*.log`. Returns the last ~800 lines (guarded). */
function readRunLog(key, mode) {
  const dir = join(TICKETS, key);
  let file = null;
  if (typeof mode === 'string' && /^[a-z]+$/.test(mode) && existsSync(join(dir, `panel-run-${mode}.log`))) {
    file = `panel-run-${mode}.log`;
  } else {
    let best = null, bestM = -1;
    let names = [];
    try { names = readdirSync(dir).filter((f) => /^panel-run-.+\.log$/.test(f)); } catch {}
    for (const f of names) {
      try { const m = statSync(join(dir, f)).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch {}
    }
    file = best;
  }
  if (!file) return { key, mode: null, lines: [] };
  let text = '';
  try { text = readFileSync(join(dir, file), 'utf8'); } catch {}
  const m = file.match(/^panel-run-(.+)\.log$/);
  return { key, mode: m ? m[1] : null, lines: text.split('\n').slice(-800) };
}

// ---- ship gate (Goal A2 / contract §3) ----
// No run that can open a PR is spawned until the ticket's scoring receipt
// (tickets/<KEY>/rubric.jsonl, written ONLY by scripts/loop.mjs) is verified against the real
// HEAD of the ticket's worktree. The decision itself is pure and unit-tested in
// ./ship-gate-lib.mjs; everything here is the I/O that feeds it. FAIL CLOSED throughout —
// a missing file, a missing worktree or an errored `rev-parse` is UNVERIFIED, and unverified
// is a rejection.

// A repo id read out of status.json is model-written data, and it is interpolated into a
// filesystem path that then reaches `git -C <path>` argv. Keep it to a single tame path
// segment: no separators, no `..`, no leading dot. Same discipline as KEY_RE.
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeRepoId = (r) => typeof r === 'string' && REPO_ID_RE.test(r) && !r.includes('..');

/** Where this ticket's worktree lives: <worktreeDir>/<KEY>-<repoId>, mirroring
 * scripts/worktree.mjs. `worktreeDir` is read from config (default `../.wt`, relative to
 * millwright/). Prefers the first listed repo whose directory actually exists so a
 * multi-repo ticket resolves to a real tree. */
function resolveWorktree(key) {
  const status = readJsonSafe(join(TICKETS, key, 'status.json'));
  const repos = (Array.isArray(status?.repos) ? status.repos : []).filter(safeRepoId);
  const cfgDir = readJsonSafe(CONFIG_PATH)?.worktreeDir;
  const wtRoot = resolve(ROOT, typeof cfgDir === 'string' && cfgDir.trim() ? cfgDir : '../.wt');
  for (const repo of repos) {
    const path = join(wtRoot, `${key}-${repo}`);
    if (existsSync(path)) return { path, exists: true, repo };
  }
  if (repos.length) return { path: join(wtRoot, `${key}-${repos[0]}`), exists: false, repo: repos[0] };
  return { path: null, exists: false, repo: null };
}

/** `git -C <worktree> rev-parse HEAD`, routed through guard.mjs so a failure is classified
 * and reported rather than silently swallowed. Returns `{ sha, error }` — never throws. */
async function readWorktreeHead(worktreePath) {
  if (!worktreePath) return { sha: null, error: 'no worktree path' };
  // Local git: retries: 0 (a broken worktree is deterministic — retrying only delays the
  // rejection), but still classified + surfaced by withGuard rather than swallowed.
  const r = await guardExec('ship-gate rev-parse', 'git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
    source: 'git rev-parse HEAD', retries: 0, timeoutMs: 10000,
  });
  if (!r.ok) return { sha: null, error: `${r.kind}: ${String(r.message || '').split('\n')[0].slice(0, 200)}` };
  return { sha: String(r.value?.stdout ?? '').trim(), error: null };
}

/** Read everything the gate needs, then let the pure function decide. */
async function checkShipGate(key, mode, { override = false, overrideReason = null } = {}) {
  if (!requiresShipGate(mode)) return evaluateShipGate({ mode, key });
  const rubricText = readTextSafe(join(TICKETS, key, 'rubric.jsonl')); // null when absent
  const wt = resolveWorktree(key);
  // Only pay for a rev-parse when the receipt could still pass — the pure function
  // short-circuits on a missing/not-done receipt anyway.
  const head = wt.exists ? await readWorktreeHead(wt.path) : { sha: null, error: null };
  return evaluateShipGate({
    mode,
    key,
    rubricText,
    worktreePath: wt.path,
    worktreeExists: wt.exists,
    headSha: head.sha,
    headShaError: head.error,
    override,
    overrideReason,
  });
}

/** Append the audit line for an honoured override (contract §3). Best-effort on the write
 * itself, but the caller only reaches here after the gate has already decided. */
function recordShipGateOverride(key, mode, decision, operatorReason) {
  const ev = overrideEvent({ key, mode, decision, operatorReason });
  try {
    mkdirSync(join(TICKETS, key), { recursive: true });
    appendFileSync(join(TICKETS, key, 'events.jsonl'), JSON.stringify(ev) + '\n');
  } catch (e) {
    console.error(`[panel] could not record ship_gate_override for ${key}: ${e?.message || e}`);
  }
  // Lifting the panel's check is only half the job: the orchestrator applies the same rule from
  // the other side, so without this it refuses and the operator sees nothing happen. This is what
  // tells it a human read these findings and accepted them, on this exact tree.
  const exception = shipExceptionRecord({ key, mode, decision, operatorReason });
  try {
    writeFileSync(join(TICKETS, key, SHIP_EXCEPTION_FILE), JSON.stringify(exception, null, 2) + '\n');
  } catch (e) {
    console.error(`[panel] could not write ${SHIP_EXCEPTION_FILE} for ${key}: ${e?.message || e}`);
  }
  console.warn(`[panel] SHIP GATE OVERRIDDEN for ${key} (${mode}) — ${decision.reason}`);
  return { ...ev, exception };
}

// ---- stale-ticket sweeper (Goal A8) ----
// A ticket that is blocked, or parked in a non-terminal stage without advancing, must be
// surfaced rather than silently forgotten (PROJ-2910 sat at blocked-worktree-mismatch for
// days and nothing noticed). Config lives under a `sweeper` block in config/config.json and
// is read DEFENSIVELY with defaults: config.json's schema is shared with other components,
// so the block is optional and the sweeper works whether or not it is present.
const SWEEPER_DEFAULTS = { enabled: true, blockedAfterHours: 12, staleAfterHours: 24 };
function sweeperCfg() {
  const s = readJsonSafe(CONFIG_PATH)?.sweeper;
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? Number(v) : d);
  if (!s || typeof s !== 'object') return { ...SWEEPER_DEFAULTS, configured: false };
  return {
    enabled: s.enabled !== false,
    blockedAfterHours: num(s.blockedAfterHours, SWEEPER_DEFAULTS.blockedAfterHours),
    staleAfterHours: num(s.staleAfterHours, SWEEPER_DEFAULTS.staleAfterHours),
    configured: true,
  };
}

// Columns where nothing is expected to happen next: no ticket there is "stalled".
const TERMINAL_COLUMNS = new Set(['archived', 'ship']);

/** Newest signal of activity for a ticket: status.updatedAt, else the newest mtime among its
 * own artifacts. Returns an epoch ms, or null when nothing can be read. */
function lastActivityMs(key, updatedAt) {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isFinite(t)) return t;
  let best = null;
  for (const f of ['status.json', 'events.jsonl']) {
    try {
      const m = statSync(join(TICKETS, key, f)).mtimeMs;
      if (best === null || m > best) best = m;
    } catch { /* not there — try the next */ }
  }
  return best;
}

/** Pure-ish: decide whether one card is stale, and why. Returns null when it isn't. */
function staleEntry(card, cfg, nowMs) {
  if (card.running || card.manuallyArchived || TERMINAL_COLUMNS.has(card.column)) return null;
  const at = lastActivityMs(card.key, card.updatedAt);
  const idleHours = at === null ? null : Math.max(0, (nowMs - at) / 3600000);
  const blocked = !!card.blocked;
  const threshold = blocked ? cfg.blockedAfterHours : cfg.staleAfterHours;
  // Unknown age is itself a smell for a blocked ticket — surface it; for a merely idle one,
  // there is nothing to measure against, so leave it alone.
  if (idleHours === null) return blocked ? { key: card.key, reason: 'blocked', idleHours: null, thresholdHours: threshold, stage: card.phase || null, column: card.column, blockedReason: card.blockedReason || null, updatedAt: card.updatedAt || null } : null;
  if (idleHours < threshold) return null;
  return {
    key: card.key,
    reason: blocked ? 'blocked' : 'stalled',
    idleHours: Math.round(idleHours * 10) / 10,
    thresholdHours: threshold,
    stage: card.phase || null,
    column: card.column,
    blockedReason: card.blockedReason || null,
    updatedAt: card.updatedAt || null,
  };
}

function buildSweep(tickets) {
  const cfg = sweeperCfg();
  if (!cfg.enabled) return { ...cfg, count: 0, tickets: [] };
  const now = Date.now();
  const stale = [];
  for (const card of tickets) {
    try {
      const entry = staleEntry(card, cfg, now);
      if (entry) stale.push(entry);
    } catch { /* one bad card must never drop the sweep */ }
  }
  stale.sort((a, b) => (b.idleHours ?? Infinity) - (a.idleHours ?? Infinity));
  return { ...cfg, count: stale.length, tickets: stale };
}

// ---- merge detection (awaiting-merge → merged) ----
// GitHub is the only source of truth for merge state; never infer it locally. A failed `gh` fetch is
// treated as UNVERIFIED (returns null) — we never assume a PR is merged. "Mark merged only": on a
// detected merge we update status.json (→ Archived); no Jira transition / no worktree teardown here.
/** `owner/repo` for a ticket, from its routed repo id via the manifest's `github` block. */
function ticketGithubSlug(key) {
  const status = readJsonSafe(join(TICKETS, key, 'status.json'));
  const repoId = (Array.isArray(status?.repos) ? status.repos : []).find(safeRepoId);
  if (!repoId) return null;
  const manifest = readJsonSafe(join(ROOT, 'config', 'repo-manifest.json'));
  const entry = (Array.isArray(manifest?.repos) ? manifest.repos : []).find((r) => r?.id === repoId);
  const gh = entry?.github;
  return gh?.owner && gh?.repo ? `${gh.owner}/${gh.repo}` : null;
}

/**
 * A PR reference as recorded in status.json, which is not always a URL: the pipeline has
 * written a full link, a bare `826`, and a `#817`. Rejecting the last two made the merge check
 * report "gh was unavailable" without ever calling gh — the number was there all along, and
 * the repo is recoverable from the ticket's own routing.
 *
 * @param {string|number} prRef
 * @param {string|null} fallbackSlug `owner/repo` to use when the ref carries no repo
 */
function parsePr(prRef, fallbackSlug = null) {
  const raw = String(prRef ?? '').trim();
  if (!raw) return null;
  const url = raw.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], num: url[2] };
  const bare = raw.match(/^#?(\d+)$/);
  if (bare && fallbackSlug) return { repo: fallbackSlug, num: bare[1] };
  return null;
}
/**
 * Ask GitHub whether a PR is merged. Never assumes merged — but it now says WHY it could not
 * tell, because one collapsed `null` meant an unparseable reference, a missing binary and a
 * failing call all surfaced as "gh was unavailable". That sent an operator (and me) hunting a
 * PATH problem when gh had never been invoked at all.
 *
 * @returns {{ok:true, state, mergedAt, mergedBy, mergeCommit}
 *          | {ok:false, failure:'no-pr-ref'|'gh-missing'|'gh-failed', detail:string}}
 */
async function fetchPrMergeState(prRef, fallbackSlug = null) {
  const pr = parsePr(prRef, fallbackSlug);
  if (!pr) {
    return {
      ok: false,
      failure: 'no-pr-ref',
      detail: `cannot tell which PR "${String(prRef ?? '').slice(0, 40)}" means`
        + `${fallbackSlug ? '' : ' (and the ticket names no routed repo to resolve a bare number against)'}`,
    };
  }
  let result;
  try {
    result = await execa(
      'gh', ['pr', 'view', pr.num, '--repo', pr.repo, '--json', 'state,mergedAt,mergedBy,mergeCommit'],
      { reject: false },
    );
  } catch (e) {
    // ENOENT here means the binary really is unreachable from this process.
    const missing = e?.code === 'ENOENT';
    return {
      ok: false,
      failure: missing ? 'gh-missing' : 'gh-failed',
      detail: missing ? 'the gh CLI is not on this process PATH' : String(e?.shortMessage || e?.message || e).slice(0, 200),
    };
  }
  if (result.exitCode !== 0 || !result.stdout) {
    return {
      ok: false,
      failure: 'gh-failed',
      detail: String(result.stderr || `gh exited ${result.exitCode} with no output`).split('\n')[0].slice(0, 200),
    };
  }
  try {
    const j = JSON.parse(result.stdout);
    return {
      ok: true,
      state: j.state,
      mergedAt: j.mergedAt || null,
      mergedBy: j.mergedBy?.login || null,
      mergeCommit: j.mergeCommit?.oid || null,
    };
  } catch {
    return { ok: false, failure: 'gh-failed', detail: 'gh returned output that is not JSON' };
  }
}
function markMerged(key, info) {
  const path = join(TICKETS, key, 'status.json');
  const status = readJsonSafe(path) || {};
  const next = { ...status, stage: 'merged', mergedAt: info.mergedAt || new Date().toISOString(), mergedBy: info.mergedBy || null, mergeCommit: info.mergeCommit || null, updatedAt: new Date().toISOString() };
  try { writeFileSync(path, JSON.stringify(next, null, 2) + '\n'); } catch {}
}
// A ticket is "awaiting merge" when it has a PR, its stage is `ship`, it isn't already merged, and no
// run is active on it. Only those get polled — a tiny set, so no API hammering.
function awaitingMergeKeys() {
  const out = [];
  for (const key of listTicketKeys()) {
    const s = readJsonSafe(join(TICKETS, key, 'status.json'));
    // Poll any ticket with a PR that isn't confirmed merged (regardless of stage word) so GitHub is
    // the arbiter — an unmerged PR stays awaiting-merge, a merged one gets mergedAt set → Archived.
    if (!s || s.stage === 'merged' || s.mergedAt || running.has(key)) continue;
    const prs = Array.isArray(s.prs) ? s.prs : s.pr ? [s.pr] : [];
    if (prs.length) out.push({ key, prUrl: prs[0] });
  }
  return out;
}
let mergePollBusy = false;
async function pollMerges() {
  if (mergePollBusy) return;
  mergePollBusy = true;
  let changed = false;
  try {
    for (const { key, prUrl } of awaitingMergeKeys()) {
      const info = await fetchPrMergeState(prUrl, ticketGithubSlug(key));
      if (info.ok && info.state === 'MERGED') { markMerged(key, info); changed = true; }
    }
  } catch { /* never let the poll crash the server */ }
  mergePollBusy = false;
  if (changed) scheduleStateBroadcast();
}

// ---- /api/pr-reviews, /api/pr-review (ad-hoc /review-pr flow) ----

function listPrReviewRefs() {
  if (!existsSync(PR_REVIEWS)) return [];
  try {
    return readdirSync(PR_REVIEWS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Whether a review's two output artifacts exist and are non-empty. This is the evidence that
 * decides `isOrphanedComplete` and overrides the cost heuristic in `isPersistedNoOp`: cost is
 * only recorded by `onFinish`, so a killed panel process leaves zeros next to a real report. */
function reviewArtifacts(ref) {
  const nonEmpty = (name) => {
    try { return statSync(join(PR_REVIEWS, ref, name)).size > 0; } catch { return false; }
  };
  return { hasReview: nonEmpty('review.md'), hasQualityInputs: nonEmpty('quality-inputs.json') };
}

/** One PR-review's summary card. `status.json` is written by the /review-pr skill itself
 * (`{prUrl, title, isOwn, result, updatedAt}` — `result` e.g. "pushed-fix" | "report-only" |
 * "blocked") — a run still in progress may have no status.json yet, so every field degrades
 * to null/the ref rather than throwing. */
/** `status.json` is written by the /review-pr skill itself — an LLM improvising from
 * prose instructions, not a strictly-typed contract, so tolerate the shape it actually
 * used even when it drifts from the pinned schema in review-pr/SKILL.md (e.g. a nested
 * `pr: {url, title}` instead of top-level `prUrl`/`title`, or `isOwnPr` instead of
 * `isOwn`). Never let a schema drift make a real review vanish from the dashboard. */
/** `{owner, repo}` pairs harvested from every review that HAS a persisted prUrl — the candidate
 * set `recoverPrUrlFromRef` needs to make a legacy ref's URL decidable. */
function knownPrRepoPairs() {
  const pairs = [];
  for (const dir of listPrReviewRefs()) {
    const s = readJsonSafe(join(PR_REVIEWS, dir, 'status.json'));
    const parsed = parsePrRef(s?.prUrl || s?.pr?.url);
    if (parsed) pairs.push({ owner: parsed.owner, repo: parsed.repo });
  }
  return pairs;
}

function buildPrReviewCard(ref, repoPairs) {
  const status = readJsonSafe(join(PR_REVIEWS, ref, 'status.json'));
  const isOwn = typeof status?.isOwn === 'boolean' ? status.isOwn
    : typeof status?.isOwnPr === 'boolean' ? status.isOwnPr
    : null;
  const inProgress = status?.status === 'in-progress' || status?.stage === 'review';
  const running = runningPrReviews.has(ref);
  const costUsd = typeof status?.costUsd === 'number' ? status.costUsd : 0;
  const tokens = typeof status?.tokens === 'number' ? status.tokens : 0;
  let result = status?.result || (!inProgress ? status?.status || status?.stage : null) || null;
  let failure = typeof status?.failure === 'string' ? status.failure : null;

  // A review that finished having spent nothing and produced no result did nothing at all —
  // the residue left by runs that predate the run-outcome check. Name it rather than rendering
  // a blank "—" that reads like a review nobody has looked at yet.
  const { hasReview } = reviewArtifacts(ref);
  if (isPersistedNoOp({ running, result, costUsd, tokens, hasReview })) {
    result = 'failed';
    // A log with real tool activity after the last run header means the run did work and was cut
    // off (usually a panel restart), which is not the same as a run that never started.
    const log = readTextSafe(join(PR_REVIEWS, ref, 'panel-run.log')) || '';
    const lastRun = log.slice(log.lastIndexOf('=== panel run'));
    const didWork = (lastRun.match(/^→ /gm) || []).length >= 3;
    failure = failure || (didWork
      ? 'interrupted: the run was doing work when it stopped (usually the panel restarting) and recorded no result'
      : 'no-op run: $0.00 spent and no result recorded — nothing ran (check the .claude/skills symlinks at the workspace root)');
  }

  // Set by reconcileOrphanedReviews for a finished review on the operator's OWN PR, where the
  // outcome cannot be proven after the fact (a push may or may not have happened). It suppresses
  // the retry offer without inventing a verdict - the row reads as finished, outcome unrecorded.
  const resultUnrecorded = status?.resultUnrecorded === true;

  // Reviews written before the URL was persisted at spawn time have no prUrl at all; recover it
  // from the ref when the owner/repo is decidable, so a legacy failure is still retryable.
  const prUrl = status?.prUrl || status?.pr?.url
    || recoverPrUrlFromRef(ref, repoPairs || knownPrRepoPairs()) || null;

  return {
    ref,
    prUrl,
    title: status?.title || status?.pr?.title || ref,
    isOwn,
    result,
    costUsd,
    tokens,
    updatedAt: status?.updatedAt || null,
    // `updatedAt` is only written when a run FINISHES, so a running review has none (or a stale
    // one from a previous attempt). These are what let the table sort by real activity instead.
    startedAt: status?.startedAt || null,
    reconciledAt: status?.reconciledAt || null,
    running,
    // Why it failed, and whether the panel should offer a retry — decided server-side so the
    // table and the drawer can't drift on the rule. A retry needs a URL to spawn from.
    failure,
    // The question a `needs-input` run stopped on, so the panel can show it instead of
    // sending the operator to panel-run.log to find out why nothing was produced.
    question: typeof status?.question === 'string' ? status.question : null,
    resultUnrecorded,
    retryable: isRetryableReview({ running, result }) && !!prUrl && !resultUnrecorded,
    // Triage counts for lists and filters, so they need not open every review to know which
    // ones are waiting on a decision. null for reviews without structured findings.
    triage: findingsSummary(ref),
    // OPEN / MERGED / CLOSED from the background PR-state cache; null until it has loaded.
    prState: (() => { const pr = parsePrRef(prUrl); return pr ? prStateFor(`${pr.owner}/${pr.repo}`)?.byNumber.get(Number(pr.number))?.state || null : null; })(),
  };
}

/**
 * Reconcile reviews whose run died before its verdict was recorded but which produced their
 * output anyway. Without this the board offers a Retry for work already on disk, and clicking it
 * re-spends: five such rows were carrying about 18 USD of finished reports.
 *
 * Runs once at startup, because the fix is a one-time write per orphan - doing it per card build
 * would rewrite status.json on every request.
 *
 * The reconciled value is only ever asserted when it is provable. For a PR that is not the
 * operator's, report-only was the sole reachable outcome (the pipeline cannot push to someone
 * else's PR), so that is recorded. Otherwise a push may or may not have happened, so nothing is
 * guessed - `resultUnrecorded` marks it finished-but-unknown and the operator can still retry.
 */
function reconcileOrphanedReviews() {
  let reconciled = 0;
  for (const ref of listPrReviewRefs()) {
    const path = join(PR_REVIEWS, ref, 'status.json');
    const status = readJsonSafe(path);
    if (!status || status.reconciledAt) continue;
    const { hasReview, hasQualityInputs } = reviewArtifacts(ref);
    if (!isOrphanedComplete({ running: runningPrReviews.has(ref), result: status.result, hasReview, hasQualityInputs })) continue;

    const isOwn = typeof status.isOwn === 'boolean' ? status.isOwn
      : typeof status.isOwnPr === 'boolean' ? status.isOwnPr
      : null;
    const patch = isOwn === false
      ? { result: 'report-only' }
      : { resultUnrecorded: true };
    try {
      writeFileSync(path, JSON.stringify({
        ...status,
        ...patch,
        reconciledAt: new Date().toISOString(),
        reconciledFrom: status.result ?? null,
      }, null, 2) + '\n');
      reconciled += 1;
    } catch (e) {
      console.error(`[panel] could not reconcile ${ref}: ${e?.message || e}`);
    }
  }
  if (reconciled) console.log(`reconciled ${reconciled} orphaned review(s) - a killed run had left a finished report looking retryable`);
}

/** Newest real activity on a review. `updatedAt` alone is not it: that field is written only
 * when a run finishes, so a review running RIGHT NOW has either no `updatedAt` or a stale one
 * from an earlier attempt - which sorted the most active row to the bottom of the table. */
function reviewActivityAt(card) {
  return card.updatedAt || card.startedAt || card.reconciledAt || '';
}

function buildPrReviewsState() {
  const pairs = knownPrRepoPairs();
  const reviews = listPrReviewRefs()
    .map((r) => buildPrReviewCard(r, pairs))
    // Running first - it is the row the operator is waiting on - then by newest activity.
    .sort((a, b) => (Number(b.running) - Number(a.running))
      || reviewActivityAt(b).localeCompare(reviewActivityAt(a)));
  return { generatedAt: new Date().toISOString(), reviews };
}

function buildPrReviewDetail(ref) {
  const card = buildPrReviewCard(ref);
  const artifact = (name) => readTextSafe(join(PR_REVIEWS, ref, name));
  return {
    ...card,
    artifacts: {
      review: artifact('review.md'),
      quality: artifact('quality-inputs.json'),
      log: artifact('panel-run.log'),
    },
    // Every publish of these findings, so the drawer can show "posted" and refuse a duplicate.
    postedComments: readJsonSafe(join(PR_REVIEWS, ref, 'status.json'))?.postedComments || [],
    findings: loadFindingRows(ref),
  };
}

function findingsSummary(ref) {
  const f = loadFindingRows(ref);
  if (!f) return null;
  const { total, undecided, accept, toPost, posted, folded } = f.counts;
  return { total, undecided, accept, toPost, posted, folded, round: f.round, stale: f.stale };
}

/** findings.json + verdicts.json + triage.json as rows (review-rounds-lib), or null for a review
 * that predates structured findings - the drawer then falls back to review.md and the
 * severity-bucket post. */
function loadFindingRows(ref) {
  return loadRoundRows(join(PR_REVIEWS, ref));
}

// ---- queue scan + scheduler + global pause (scan is `jira.mjs search` only — no claude, no per-ticket work) ----
// The scan state is PERSISTED, not just held in memory. It used to live only in this
// module variable, which is the whole of GOALS.md A8's "either it isn't running or it isn't
// recording": it was running, and recording nowhere. Two consequences, both real —
// queue-runs/ hadn't gained a file since 2026-07-31 despite scans happening, and every
// panel restart reset `lastScan.at` to null, so schedulerTick's `!lastScan.at` branch fired
// an immediate Jira scan on every boot regardless of the 360-minute interval.
const SCAN_STATE = join(QUEUE_RUNS, 'last-scan.json');
const SCAN_LOG = join(QUEUE_RUNS, 'scans.jsonl');

function loadLastScan() {
  const saved = readJsonSafe(SCAN_STATE);
  if (!saved || typeof saved.at !== 'string') return { at: null, keys: [], error: null };
  return { at: saved.at, keys: Array.isArray(saved.keys) ? saved.keys : [], items: normaliseScanRows(saved.items), error: saved.error ?? null };
}

/** Write the resume state and append an audit line. Best-effort: a scan that succeeded must
 * not be reported as failed just because the disk write did, so failures are logged and
 * swallowed rather than thrown. `runs.jsonl` is deliberately untouched — that file records
 * queue runs that actually resolved tickets, and a scan is not one. */
function persistScan(scan) {
  try {
    mkdirSync(QUEUE_RUNS, { recursive: true });
    writeFileSync(SCAN_STATE, JSON.stringify(scan, null, 2) + '\n');
    appendFileSync(SCAN_LOG, JSON.stringify({ scannedAt: scan.at, keys: scan.keys, error: scan.error }) + '\n');
  } catch (e) {
    console.error(`[panel] could not persist queue scan: ${e?.message || e}`);
  }
}

let lastScan = loadLastScan();
let scanBusy = false;
function patchConfig(mutate) { const cfg = readJsonSafe(CONFIG_PATH) || {}; mutate(cfg); writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); return cfg; }
function isPaused() { return !!readJsonSafe(CONFIG_PATH)?.paused; }
// When on, any ticket that reaches plan-ready is auto-enqueued for BUILD (no per-ticket click).
// Persisted in config.json so it survives a restart — the point of the overnight "build all 4"
// flow is that a recycled server re-arms itself instead of stranding the column at the gate.
function isAutoBuild() { return !!readJsonSafe(CONFIG_PATH)?.autoBuild; }
function schedulerCfg() { const s = readJsonSafe(CONFIG_PATH)?.scheduler || {}; return { enabled: !!s.enabled, intervalMinutes: Number(s.intervalMinutes) || 720 }; }
function nextScanAt() {
  const { enabled, intervalMinutes } = schedulerCfg();
  if (!enabled || !lastScan.at) return null;
  return new Date(new Date(lastScan.at).getTime() + intervalMinutes * 60000).toISOString();
}
async function runScan() {
  if (scanBusy || isPaused()) return lastScan;
  scanBusy = true; scheduleStateBroadcast();
  try {
    const jql = readJsonSafe(QUEUE_PATH)?.jql;
    if (!jql) { lastScan = { at: new Date().toISOString(), keys: lastScan.keys, error: 'no jql in config/queue.json' }; }
    else {
      const { stdout, exitCode } = await execa('node', [join(ROOT, 'scripts', 'jira.mjs'), 'search', jql], { reject: false });
      if (exitCode !== 0 || !stdout) lastScan = { at: new Date().toISOString(), keys: lastScan.keys, error: `scan failed — are Jira credentials set in ${ENV_PATH}? (Jira wrapper returned no data)` };
      else { const rows = JSON.parse(stdout); lastScan = { at: new Date().toISOString(), keys: rows.map((r) => r.key).filter(Boolean), items: normaliseScanRows(rows), error: null }; }
    }
  } catch (e) { lastScan = { at: new Date().toISOString(), keys: lastScan.keys, error: String(e?.message || e) }; }
  persistScan(lastScan);
  scanBusy = false; scheduleStateBroadcast();
  return lastScan;
}
function schedulerTick() {
  const { enabled, intervalMinutes } = schedulerCfg();
  if (!enabled || isPaused() || scanBusy) return;
  if (!lastScan.at || Date.now() - new Date(lastScan.at).getTime() >= intervalMinutes * 60000) runScan();
}

// ---- PR inbox: which PRs are waiting on this operator, and which are theirs ----
//
// Mirrors the queue-scan pattern above (persisted state, a busy flag, an interval tick) for the
// same reason it exists there: an in-memory-only sweep would re-fetch on every restart.
//
// Two accuracy rules shape the whole design, both measured against live GitHub:
//   - GitHub consumes a review request the instant ANY review is submitted, even a bare comment,
//     with no event to detect it. So `reviewRequests` is pending-only and a PR the operator
//     commented on drops off every "review-requested" query while still being theirs to finish.
//     pr-inbox-lib recovers those from `latestReviews` plus the head commit date.
//   - The search index lags (it is eventually consistent), so per-repo GraphQL against the
//     primary datastore is the source of truth. Search is used only to DISCOVER PRs in repos
//     outside the manifest, which the per-repo scan cannot see.
const PR_INBOX_DIR = join(ROOT, 'pr-inbox');
const PR_INBOX_STATE = join(PR_INBOX_DIR, 'last-sweep.json');

const PR_INBOX_QUERY = `query($o:String!,$r:String!,$n:Int!){
  rateLimit{ remaining resetAt }
  repository(owner:$o,name:$r){
    pullRequests(states:OPEN, first:$n, orderBy:{field:UPDATED_AT,direction:DESC}){
      totalCount
      pageInfo{ hasNextPage }
      nodes{
        number title url isDraft state updatedAt createdAt headRefName baseRefName
        author{ login }
        reviewDecision
        mergeable mergeStateStatus
        commits(last:1){ nodes{ commit{ oid committedDate statusCheckRollup{ state } } } }
        reviewRequests(first:25){ nodes{ requestedReviewer{
          __typename ... on User{ login } ... on Team{ slug } ... on Bot{ login } } } }
        latestReviews(first:25){ nodes{ author{ login } state submittedAt } }
      }
    }
  }
}`;

/** `owner/repo` for every manifest repo that has GitHub coordinates. This is the accuracy
 * boundary for the scan AND the gate on whether /review-pr can act on a row at all, so both
 * read one list. A manifest entry with no `github` block (a reference-only repo) is skipped. */
function manifestRepoSlugs() {
  const repos = readJsonSafe(REPO_MANIFEST)?.repos;
  if (!Array.isArray(repos)) return [];
  return repos
    .map((r) => r?.github)
    .filter((g) => g && g.owner && g.repo)
    .map((g) => `${g.owner}/${g.repo}`);
}

function prInboxCfg() {
  const c = readJsonSafe(CONFIG_PATH)?.prInbox || {};
  return {
    enabled: c.enabled !== false,
    intervalMinutes: Number(c.intervalMinutes) || 5,
    includeOutsideManifest: c.includeOutsideManifest !== false,
    expectLogin: typeof c.expectLogin === 'string' ? c.expectLogin : null,
    maxOpenPerRepo: Math.min(Number(c.maxOpenPerRepo) || 100, 100),
  };
}

/** `gh` prefers GH_TOKEN/GITHUB_TOKEN over the keychain's active account, and resolveNpmToken
 * above already treats GITHUB_TOKEN as an npm credential - so the day one is exported, this
 * poller would silently read a different person's inbox. Strip both and let the keychain decide. */
function ghEnv() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function ghRun(label, args) {
  const r = await guardExec(label, GH_BIN, args, { source: 'gh', retries: 1, timeoutMs: 20000, env: ghEnv(), extendEnv: false });
  // guardExec failures carry {kind, message} - there is no `reason` field on them.
  if (!r.ok) return { ok: false, kind: r.kind, message: r.message };
  return { ok: true, value: String(r.value.stdout ?? '') };
}

/** Raw stdout. `gh api --jq .login` prints a bare string, which is not valid JSON. */
async function ghText(label, args) {
  const r = await ghRun(label, args);
  return r.ok ? { ok: true, value: r.value.trim() } : r;
}

async function ghJson(label, args) {
  const r = await ghRun(label, args);
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.value) };
  } catch (e) {
    return { ok: false, kind: 'other', message: `gh returned unparseable JSON: ${e?.message || e}` };
  }
}

function emptyInboxSweep() {
  return { at: null, login: null, teams: [], perRepo: {}, search: null, rateLimit: null, error: null };
}

function loadPrInboxSweep() {
  const saved = readJsonSafe(PR_INBOX_STATE);
  if (!saved || typeof saved !== 'object') return emptyInboxSweep();
  return { ...emptyInboxSweep(), ...saved };
}

function persistPrInboxSweep(sweep) {
  try {
    mkdirSync(PR_INBOX_DIR, { recursive: true });
    writeFileSync(PR_INBOX_STATE, JSON.stringify(sweep, null, 2) + '\n');
  } catch (e) {
    console.error(`[panel] could not persist the PR inbox sweep: ${e?.message || e}`);
  }
}

let prInbox = loadPrInboxSweep();
let prInboxBusy = false;

async function sweepRepo(slug, { myLogin, myTeamSlugs, maxOpenPerRepo }) {
  const [owner, repo] = slug.split('/');
  const r = await ghJson(`pr-inbox ${slug}`, ['api', 'graphql', '-F', `o=${owner}`, '-F', `r=${repo}`, '-F', `n=${maxOpenPerRepo}`, '-f', `query=${PR_INBOX_QUERY}`]);
  if (!r.ok) return { ok: false, error: { kind: r.kind, message: r.message } };
  const conn = r.value?.data?.repository?.pullRequests;
  const rows = [];
  for (const pr of conn?.nodes || []) {
    if (pr?.state && pr.state !== 'OPEN') continue; // stale-cache tripwire
    const row = buildInboxRow({ pr, owner, repo, myLogin, myTeamSlugs, inManifest: true, source: 'repo-scan' });
    const bucket = inboxBucket(row, myLogin);
    if (bucket) rows.push({ ...row, bucket });
  }
  return {
    ok: true,
    rows,
    truncated: !!conn?.pageInfo?.hasNextPage,
    totalCount: typeof conn?.totalCount === 'number' ? conn.totalCount : null,
    rateLimit: r.value?.data?.rateLimit || null,
  };
}

async function sweepSearch({ myLogin, myTeamSlugs, manifest }) {
  const fields = 'number,title,url,isDraft,state,updatedAt,author,repository';
  const rows = [];
  const errors = [];
  for (const [label, qualifier] of [['requested', '--review-requested=@me'], ['authored', '--author=@me']]) {
    const r = await ghJson(`pr-inbox search ${label}`, ['search', 'prs', qualifier, '--state=open', '--limit', '100', '--json', fields]);
    if (!r.ok) { errors.push({ kind: r.kind, message: r.message }); continue; }
    for (const pr of Array.isArray(r.value) ? r.value : []) {
      const slug = pr?.repository?.nameWithOwner || '';
      const [owner, repo] = slug.split('/');
      if (!owner || !repo) continue;
      const inManifest = manifest.includes(slug);
      // Search cannot see reviewRequests, so a requested row is asserted from the qualifier that
      // found it rather than derived - the per-repo scan is what carries the real detail.
      const row = buildInboxRow({ pr: { ...pr, author: pr.author || null }, owner, repo, myLogin, myTeamSlugs, inManifest, source: 'search' });
      const bucket = label === 'authored' ? 'mine' : (inboxBucket(row, myLogin) || 'requested');
      rows.push({ ...row, bucket });
    }
  }
  return { rows, error: errors[0] || null };
}

async function runPrInboxSweep() {
  const cfg = prInboxCfg();
  // Deliberately NOT gated on isPaused(): pause stops spawned runs and spend, and a read-only
  // poll costs neither. Blinding the inbox while paused is how an operator resumes into a stale board.
  if (prInboxBusy || !cfg.enabled) return prInbox;
  prInboxBusy = true;
  scheduleStateBroadcast();
  try {
    const me = await ghText('pr-inbox identity', ['api', 'user', '--jq', '.login']);
    const myLogin = me.ok ? me.value : null;
    if (!myLogin) {
      // Without an identity nothing is trustworthy - keep the previous rows and say why.
      prInbox = { ...prInbox, at: new Date().toISOString(), error: me.ok ? 'gh returned no login' : `${me.kind}: ${me.message}` };
    } else {
      const teamsRes = await ghJson('pr-inbox teams', ['api', 'user/teams', '--paginate', '--jq', '[.[] | .organization.login + "/" + .slug]']);
      const myTeamSlugs = teamsRes.ok && Array.isArray(teamsRes.value) ? teamsRes.value : [];
      const manifest = manifestRepoSlugs();
      const perRepo = { ...prInbox.perRepo };
      let rateLimit = prInbox.rateLimit;
      // Sequential on purpose: 8 parallel gh processes invite a secondary rate limit for no gain
      // in a background poll, and one failing repo must not blank the others.
      for (const slug of manifest) {
        const res = await sweepRepo(slug, { myLogin, myTeamSlugs, maxOpenPerRepo: cfg.maxOpenPerRepo });
        const at = new Date().toISOString();
        if (res.ok) {
          perRepo[slug] = { at, rows: res.rows, error: null, truncated: res.truncated, totalCount: res.totalCount };
          if (res.rateLimit) rateLimit = res.rateLimit;
        } else {
          // Keep the last good rows and label the failure rather than emptying the repo.
          perRepo[slug] = { ...(perRepo[slug] || { rows: [], truncated: false, totalCount: null }), error: res.error, at: perRepo[slug]?.at || null };
        }
      }
      const search = cfg.includeOutsideManifest
        ? { at: new Date().toISOString(), ...(await sweepSearch({ myLogin, myTeamSlugs, manifest })) }
        : null;
      prInbox = { at: new Date().toISOString(), login: myLogin, teams: myTeamSlugs, perRepo, search, rateLimit, error: null };
    }
  } catch (e) {
    prInbox = { ...prInbox, error: String(e?.message || e) };
  }
  persistPrInboxSweep(prInbox);
  prInboxBusy = false;
  scheduleStateBroadcast();
  return prInbox;
}

function prInboxTick() {
  const { enabled, intervalMinutes } = prInboxCfg();
  if (!enabled || prInboxBusy) return;
  if (!prInbox.at || Date.now() - new Date(prInbox.at).getTime() >= intervalMinutes * 60000) runPrInboxSweep();
}

/** One pass over pr-reviews/, keyed by ref - the same string prRefId() produces for an inbox
 * row, so the join is a Map lookup and not a per-row stat. Reuses buildPrReviewCard so the
 * inbox can never disagree with the Reviews table below it. */
function prReviewIndex() {
  const pairs = knownPrRepoPairs();
  const byRef = new Map(listPrReviewRefs().map((ref) => [ref, buildPrReviewCard(ref, pairs)]));
  return (id, headCommittedAt) => {
    const c = byRef.get(id);
    if (!c) return { review: null, reviewStatus: 'never' };
    const stale = !!(headCommittedAt && c.updatedAt && new Date(c.updatedAt) < new Date(headCommittedAt));
    return {
      review: { ref: c.ref, result: c.result, running: c.running, retryable: c.retryable, updatedAt: c.updatedAt, costUsd: c.costUsd, failure: c.failure },
      reviewStatus: c.running ? 'running' : c.retryable ? 'failed' : stale ? 'done-stale' : 'done',
    };
  };
}

/** Cache-only by design. Every SSE `state` frame makes the UI refetch this, so a TTL-on-read
 * refresh would turn one file save into a GitHub sweep. The interval tick is the only thing
 * that talks to gh. */
function buildPrInboxState() {
  const cfg = prInboxCfg();
  const decorate = prReviewIndex();
  const merged = mergeSnapshots(prInbox.perRepo, prInbox.search?.rows || []);
  const ageMs = prInbox.at ? Date.now() - new Date(prInbox.at).getTime() : Infinity;
  const rows = sortInbox(merged.map((row) => {
    const repoState = prInbox.perRepo?.[row.repoSlug];
    return {
      ...row,
      ...decorate(row.id, row.headCommittedAt),
      fromStaleSnapshot: !!repoState?.error,
      snapshotAt: repoState?.at || prInbox.search?.at || null,
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    pending: !prInbox.at,
    at: prInbox.at,
    stale: ageMs > cfg.intervalMinutes * 60000 * 2,
    enabled: cfg.enabled,
    sweeping: prInboxBusy,
    login: prInbox.login,
    loginMismatch: !!(cfg.expectLogin && prInbox.login && cfg.expectLogin !== prInbox.login),
    teams: prInbox.teams || [],
    error: prInbox.error,
    rateLimit: prInbox.rateLimit,
    capacity: { running: runningPrReviews.size, max: MAX_CONCURRENT_RUNS },
    repos: Object.entries(prInbox.perRepo || {}).map(([slug, r]) => ({
      slug, at: r.at || null, ok: !r.error, error: r.error || null, truncated: !!r.truncated, openCount: r.totalCount ?? null,
    })),
    search: prInbox.search ? { at: prInbox.search.at, ok: !prInbox.search.error, error: prInbox.search.error || null } : null,
    rows,
  };
}


// ---- publishing a review's findings to the PR (human-initiated, never by the agent) ----
//
// The /review-pr run itself still makes zero GitHub writes. This is the panel performing a
// write with the operator's own gh credential, on an explicit click, with the exact bytes the
// operator previewed - the same act as typing `gh pr comment` in a terminal.

const DEFAULT_COMMENT_SEVERITIES = ['high', 'medium'];
const postingPrComments = new Set();

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** Rebuild the comment body from a review's own report. `review.md` is never posted verbatim:
 * every real one names internal tooling, which the unbranded-output rule forbids in anything a
 * human reads, so the findings are re-rendered and scrubbed and the operator can still edit. */
function buildCommentDraft(ref, severities) {
  const reviewMd = readTextSafe(join(PR_REVIEWS, ref, 'review.md')) || '';
  const parsed = extractFindings(reviewMd);
  const rendered = renderPrComment({ buckets: parsed.buckets, severities, recommendation: parsed.recommendation });
  const scrubbed = scrubInternals(rendered);
  const counts = Object.fromEntries(['high', 'medium', 'low'].map((k) => [k, (parsed.buckets?.[k] || []).length]));
  return {
    body: scrubbed.text,
    unresolved: scrubbed.unresolved,
    unclassified: parsed.unclassified || [],
    warnings: parsed.warnings || [],
    bySeverity: counts,
    findingCount: severities.reduce((n, k) => n + (counts[k] || 0), 0),
    reviewSha256: sha256(reviewMd),
    reviewEmpty: !reviewMd.trim(),
  };
}

/** The PR url for a ref, rebuilt server-side. The client never supplies one. */
function prUrlForRef(ref) {
  const status = readJsonSafe(join(PR_REVIEWS, ref, 'status.json'));
  const raw = status?.prUrl || status?.pr?.url || recoverPrUrlFromRef(ref, knownPrRepoPairs());
  const parsed = parsePrRef(raw);
  return parsed ? { parsed, url: prUrlFromRef(parsed) } : null;
}

function parseSeverities(raw) {
  const wanted = String(raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = wanted.filter((s) => ['high', 'medium', 'low'].includes(s));
  return allowed.length ? allowed : DEFAULT_COMMENT_SEVERITIES;
}

// ---- posting accepted findings as one GitHub review ----
//
// Same rules as the comment path above: the panel posts with the operator's own gh credential,
// only on a click, and only what was previewed. The payload is always rebuilt here from the
// review's files and the live diff - the client sends a summary and the acceptedSha it saw,
// never comment bodies.

const postingPrReviews = new Set();

/** The live PR plus the review payload built from the accepted findings. Inline comments need
 * the diff the reviewer read: when the PR's head moved since, everything goes in the body. */
async function buildFindingsReview(ref, summary) {
  const rows = loadFindingRows(ref);
  if (!rows) return { error: 'this review has no findings.json - use the comment post instead', code: 409 };
  const target = prUrlForRef(ref);
  if (!target) return { error: 'no PR url could be derived for this review', code: 400 };
  const slug = `${target.parsed.owner}/${target.parsed.repo}`;
  const number = String(target.parsed.number);
  const live = await ghJson('pr-review-post pr-state', ['pr', 'view', number, '--repo', slug, '--json', 'state,url,author,isDraft,headRefOid']);
  const headSha = live.ok ? live.value?.headRefOid || null : null;
  const moved = !!(rows.headSha && headSha && !headSha.startsWith(rows.headSha) && !rows.headSha.startsWith(headSha));
  let commentable = null;
  let diffError = null;
  if (headSha && !moved) {
    const diff = await ghRun('pr-review-post diff', ['pr', 'diff', number, '--repo', slug]);
    if (diff.ok) commentable = rightSideLines(diff.value);
    else diffError = `${diff.kind}: ${diff.message}`;
  }
  const built = buildReviewPayload({ rows: rows.rows, commentable, commitId: commentable ? headSha : null, summary });
  return {
    target, slug, rows, built, headSha, moved, diffError,
    live: live.ok ? { state: live.value?.state || null, author: live.value?.author?.login || null, isDraft: !!live.value?.isDraft } : null,
    liveError: live.ok ? null : `${live.kind}: ${live.message}`,
  };
}


// ---- ticket screenshots (design vs built vs pixel diff) ----
//
// The pipeline already writes these per UI ticket: figma/<variant>.png is the design reference,
// story/<variant>.png is the built component, diffs/<variant>.diff.png is the pixel diff, and
// visual-diff-report.json carries the PASS/FAIL verdict. Nothing ever surfaced them, so the
// only way to review a UI change was to open the files by hand.

const SHOT_DIRS = { figma: 'figma', story: 'story', diff: 'diffs' };
// Deliberately strict: this name is the only free text that reaches a filesystem path here.
const SHOT_NAME_RE = /^[\w.-]+\.png$/;

/** Resolve one screenshot to an absolute path, or null. Mirrors resolveDistFile's containment
 * check: a normalised path that escapes the ticket's own directory is refused, never served. */
function resolveTicketShot(key, kind, name) {
  if (!KEY_RE.test(key) || !SHOT_DIRS[kind] || !SHOT_NAME_RE.test(name)) return null;
  const base = join(TICKETS, key, SHOT_DIRS[kind]);
  const full = normalize(join(base, name));
  if (!full.startsWith(base + sep)) return null;
  try { return statSync(full).isFile() ? full : null; } catch { return null; }
}

function listShotFiles(key, kind) {
  try {
    return readdirSync(join(TICKETS, key, SHOT_DIRS[kind]), { withFileTypes: true })
      .filter((d) => d.isFile() && SHOT_NAME_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

/** Group a ticket's screenshots by variant so the UI can put design, built and diff side by
 * side, and attach the diff verdict where the report has one.
 *
 * The three directories do NOT agree on naming: a diff is `<variant>.diff.png` while a figma or
 * story shot is `<variant>-<theme>.png` (e.g. `available-dark.png`). So the diff's variant is
 * the stem, and a themed shot belongs to whichever diff stem prefixes it. Anything that matches
 * no diff still gets its own row rather than being dropped - an unreviewed shot is the whole
 * point of showing these. */
function buildTicketShots(key) {
  const files = { figma: listShotFiles(key, 'figma'), story: listShotFiles(key, 'story'), diff: listShotFiles(key, 'diff') };
  if (!files.figma.length && !files.story.length && !files.diff.length) return null;

  const report = readJsonSafe(join(TICKETS, key, 'visual-diff-report.json'));
  const verdicts = new Map((report?.variants || []).map((v) => [v.variant, v]));
  const shot = (kind, name) => ({ kind, name, url: `/api/ticket-shot?key=${encodeURIComponent(key)}&kind=${kind}&name=${encodeURIComponent(name)}` });

  const stems = files.diff.map((f) => f.replace(/\.diff\.png$/, ''));
  const rows = new Map(stems.map((stem) => [stem, { variant: stem, figma: [], story: [], diff: shot('diff', `${stem}.diff.png`) }]));

  for (const kind of ['figma', 'story']) {
    for (const name of files[kind]) {
      const stem = name.replace(/\.png$/, '');
      const owner = stems.find((v) => stem === v || stem.startsWith(`${v}-`)) || stem;
      if (!rows.has(owner)) rows.set(owner, { variant: owner, figma: [], story: [], diff: null });
      rows.get(owner)[kind].push(shot(kind, name));
    }
  }

  const variants = [...rows.values()].map((r) => {
    const v = verdicts.get(r.variant);
    return {
      ...r,
      status: v?.status || null,
      // BLOCKED carries the only explanation of why a variant was never compared - dropping it
      // leaves the panel saying "never compared" with no way to find out why.
      reason: v?.reason || null,
      worstRatio: v?.worstRatio ?? null,
      failedRegions: v?.failedRegions || [],
    };
  }).sort((a, b) => a.variant.localeCompare(b.variant));

  return {
    variants,
    pass: report ? report.pass === true : null,
    reportAt: report?.generatedAt || null,
    counts: { figma: files.figma.length, story: files.story.length, diff: files.diff.length },
  };
}

// ---- HTTP plumbing ----

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Types the built React bundle can emit (Goal B1). The bundle is self-contained — no CDN,
  // no external fonts — so every asset it references is served from here.
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendStatic(res, file) {
  const path = join(PANEL, file);
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ---- built panel (Goal B1 / contract §5) ----
// Checked per request (not once at boot) so a build that lands while the panel is up takes
// effect on the next reload — the migration must never require a server restart, and the
// panel must never serve half of one panel and half of the other.
const panelDistReady = () => existsSync(join(PANEL_DIST, 'index.html'));

/** Resolve a URL path inside panel-dist, or null if it escapes / isn't a real file. */
function resolveDistFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  rel = rel.replace(/^\/+/, '');
  if (!rel) return null;
  const full = normalize(join(PANEL_DIST, rel));
  if (full !== PANEL_DIST && !full.startsWith(PANEL_DIST + sep)) return null; // path traversal
  try { return statSync(full).isFile() ? full : null; } catch { return null; }
}

/** Serve panel-dist with an SPA fallback: a real file is served as itself, anything else
 * falls back to index.html so client-side routes (/board, /cost, …) work on a hard reload.
 * index.html is `no-store` — "the panel must never serve stale assets"; hashed build assets
 * are immutable and cached. */
function sendDist(res, urlPath) {
  const file = resolveDistFile(urlPath);
  const path = file || join(PANEL_DIST, 'index.html');
  let body;
  try { body = readFileSync(path); } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const ext = extname(path);
  const hashed = !!file && /\/assets\//.test(path.replace(/\\/g, '/')) && ext !== '.html';
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  return res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET') {
      // Built React panel wins when it exists (contract §5); otherwise the legacy pages
      // below serve exactly as before. `/api/*` is never handled here either way.
      if (!path.startsWith('/api/') && panelDistReady()) return sendDist(res, path);

      if (path === '/') return sendStatic(res, 'console.html');
      if (path === '/board') return sendStatic(res, 'kanban.html');
      if (path === '/cost') return sendStatic(res, 'cost.html');
      if (path === '/config') return sendStatic(res, 'config.html');
      if (path === '/pr-review') return sendStatic(res, 'review.html');
      if (path === '/panel.css') return sendStatic(res, 'panel.css');
      if (path === '/console.js') return sendStatic(res, 'console.js');
      if (path === '/kanban.js') return sendStatic(res, 'kanban.js');
      if (path === '/cost.js') return sendStatic(res, 'cost.js');
      if (path === '/config.js') return sendStatic(res, 'config.js');
      if (path === '/review.js') return sendStatic(res, 'review.js');

      if (path === '/api/state') return sendJson(res, 200, buildState());
      if (path === '/api/cost') return sendJson(res, 200, buildCost());
      if (path === '/api/config') return sendJson(res, 200, { config: readJsonSafe(CONFIG_PATH) || {} });
      if (path === '/api/pr-reviews') return sendJson(res, 200, buildPrReviewsState());
      if (path === '/api/pr-inbox') return sendJson(res, 200, buildPrInboxState());

      // Serve one ticket screenshot. Every component of the path is validated (strict key,
      // known kind, `[\w.-]+.png` name) and the resolved path must stay inside the ticket dir.
      if (path === '/api/ticket-shot') {
        const file = resolveTicketShot(
          url.searchParams.get('key') || '',
          url.searchParams.get('kind') || '',
          url.searchParams.get('name') || '',
        );
        if (!file) return sendJson(res, 404, { error: 'no such screenshot' });
        let body;
        try { body = readFileSync(file); } catch { return sendJson(res, 404, { error: 'no such screenshot' }); }
        // Immutable in practice: a re-capture writes a new run, and the drawer refetches names.
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        return res.end(body);
      }

      // Draft the comment body for preview. Separate from GET /api/pr-review on purpose: the
      // drawer refetches that on every SSE frame, and this one touches gh.
      if (path === '/api/pr-review-comment') {
        const ref = url.searchParams.get('ref') || '';
        if (!PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
        if (!existsSync(join(PR_REVIEWS, ref))) return sendJson(res, 404, { error: `no review for ${ref}` });
        const severities = parseSeverities(url.searchParams.get('severities'));
        const draft = buildCommentDraft(ref, severities);
        const target = prUrlForRef(ref);
        const status = readJsonSafe(join(PR_REVIEWS, ref, 'status.json')) || {};
        const viewer = await ghText('pr-comment identity', ['api', 'user', '--jq', '.login']);
        const live = target
          ? await ghJson('pr-comment pr-state', ['pr', 'view', String(target.parsed.number), '--repo', `${target.parsed.owner}/${target.parsed.repo}`, '--json', 'state,url,author,isDraft'])
          : { ok: false, kind: 'not-found', message: 'no PR url could be derived for this review' };
        return sendJson(res, 200, {
          ref,
          severities,
          ...draft,
          lint: lintProse(draft.body),
          prUrl: target?.url || null,
          viewer: viewer.ok ? viewer.value : null,
          viewerError: viewer.ok ? null : `${viewer.kind}: ${viewer.message}`,
          pr: live.ok ? { state: live.value?.state || null, author: live.value?.author?.login || null, isDraft: !!live.value?.isDraft } : null,
          prError: live.ok ? null : `${live.kind}: ${live.message}`,
          postedComments: Array.isArray(status.postedComments) ? status.postedComments : [],
        });
      }

      // Preview the GitHub review built from the accepted findings. Touches gh, so it is fetched
      // when the dialog opens rather than on every SSE frame.
      if (path === '/api/pr-review-post') {
        const ref = url.searchParams.get('ref') || '';
        if (!PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
        if (!existsSync(join(PR_REVIEWS, ref))) return sendJson(res, 404, { error: `no review for ${ref}` });
        const r = await buildFindingsReview(ref, url.searchParams.get('summary') || '');
        if (r.error) return sendJson(res, r.code, { error: r.error });
        const viewer = await ghText('pr-review-post identity', ['api', 'user', '--jq', '.login']);
        const status = readJsonSafe(join(PR_REVIEWS, ref, 'status.json')) || {};
        return sendJson(res, 200, {
          ref,
          prUrl: r.target.url,
          body: r.built.payload.body,
          inline: r.built.inline,
          inBody: r.built.inBody,
          acceptedCount: r.built.acceptedCount,
          acceptedSha: r.built.acceptedSha,
          unresolved: r.built.unresolved,
          lint: lintProse(JSON.stringify(r.built.payload)),
          headSha: r.headSha,
          moved: r.moved,
          diffError: r.diffError,
          viewer: viewer.ok ? viewer.value : null,
          viewerError: viewer.ok ? null : `${viewer.kind}: ${viewer.message}`,
          pr: r.live,
          prError: r.liveError,
          postedComments: Array.isArray(status.postedComments) ? status.postedComments : [],
        });
      }

      if (path === '/api/chat') {
        const key = url.searchParams.get('key') || '';
        if (!KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key' });
        const messages = chatThread(chatEntries(key)).map((m) => ({ ...m, running: runningChats.has(`chat:${key}:${m.id}`) }));
        return sendJson(res, 200, { key, messages, capacity: { running: runningChats.size, max: MAX_CONCURRENT_RUNS } });
      }

      if (path === '/api/plan-diff') {
        const key = url.searchParams.get('key') || '';
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        if (!KEY_RE.test(key) || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) return sendJson(res, 400, { error: 'invalid key or versions' });
        const a = readTextSafe(join(TICKETS, key, 'plans', `v${from}.md`));
        const b = readTextSafe(join(TICKETS, key, 'plans', `v${to}.md`));
        if (a == null || b == null) return sendJson(res, 404, { error: 'no such plan version' });
        return sendJson(res, 200, { key, from, to, diff: lineDiff(a, b), changed: changedBlocks(a, b) });
      }

      if (path === '/api/workspace') return sendJson(res, 200, await workspace.list());
      if (path === '/api/worktree' || path === '/api/worktree-diff' || path === '/api/worktree-files' || path === '/api/worktree-file' || path === '/api/worktree-chat') {
        const id = url.searchParams.get('id') || '';
        const r = path === '/api/worktree' ? await workspace.detail(id)
          : path === '/api/worktree-diff' ? await workspace.diff(id, url.searchParams.get('path') || '')
          : path === '/api/worktree-files' ? await workspace.files(id, url.searchParams.get('q') || '')
          : path === '/api/worktree-file' ? await workspace.fileContent(id, url.searchParams.get('path') || '')
          : await workspace.chatThreadFor(id);
        if (!r) return sendJson(res, 404, { error: 'no such checkout' });
        return r.error ? sendJson(res, r.code || 400, { error: r.error }) : sendJson(res, 200, r);
      }
      if (path === '/api/worktree-run-log') {
        const r = workspace.runLog(url.searchParams.get('runId') || '');
        return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'no such run' });
      }

      if (path === '/api/explainers') {
        return sendJson(res, 200, { generatedAt: new Date().toISOString(), explainers: listExplainers(), capacity: { running: runningExplainers.size, max: MAX_CONCURRENT_RUNS } });
      }

      if (path === '/api/explainer' || path === '/api/explainer-html') {
        const slug = url.searchParams.get('slug') || '';
        if (!isSlug(slug) || !existsSync(join(EXPLAINERS, slug))) return sendJson(res, 404, { error: `no explainer ${slug}` });
        const card = explainerCard(slug);
        const markdown = readTextSafe(join(EXPLAINERS, slug, 'explain.md'));
        if (path === '/api/explainer') {
          return sendJson(res, 200, { ...card, markdown, log: readTextSafe(join(EXPLAINERS, slug, 'panel-run.log')) });
        }
        if (!markdown) return sendJson(res, 404, { error: 'this explainer has no text yet' });
        const html = renderExplainerHtml({ title: card.title, markdown, subject: card.subject?.label, generatedAt: card.updatedAt });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          // A sandboxed page: the export runs no script and loads nothing, and the header says so.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          ...(url.searchParams.get('download') ? { 'content-disposition': `attachment; filename="${slug}.html"` } : {}),
        });
        return res.end(html);
      }

      if (path === '/api/pr-review') {
        const ref = url.searchParams.get('ref');
        if (typeof ref !== 'string' || !PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
        if (!existsSync(join(PR_REVIEWS, ref))) return sendJson(res, 404, { error: `no pr-review dir for ${ref}` });
        return sendJson(res, 200, buildPrReviewDetail(ref));
      }

      if (path === '/api/log') {
        const key = url.searchParams.get('key');
        if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key (expected PROJ-<n>)' });
        return sendJson(res, 200, readRunLog(key, url.searchParams.get('mode')));
      }

      if (path === '/api/ticket') {
        const key = url.searchParams.get('key');
        if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key (expected PROJ-<n>)' });
        if (!existsSync(join(TICKETS, key))) return sendJson(res, 404, { error: `no ticket dir for ${key}` });
        return sendJson(res, 200, buildTicketDetail(key));
      }

      if (path === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        sseClients.add(res);
        sseSend(res, 'state', { at: Date.now() }); // prompt an initial fetch
        req.on('close', () => sseClients.delete(res));
        return;
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && path === '/api/run') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const { key, mode, notes } = body;
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key (expected PROJ-<n>)' });
      if (typeof mode !== 'string' || !MODES.has(mode)) return sendJson(res, 400, { error: `invalid mode (${[...MODES].join('|')})` });
      if (running.has(key)) return sendJson(res, 409, { error: `a run is already active for ${key}` });
      if (running.size >= MAX_CONCURRENT_RUNS) return sendJson(res, 429, { error: `run limit reached (${MAX_CONCURRENT_RUNS} concurrent)` });
      const prompt = mode === 'continue' ? continuePrompt(key) : PROMPTS[mode](key);
      if (!prompt) return sendJson(res, 400, { error: `nothing to continue for ${key} (no resumable blocked stage in status.json)` });
      // SHIP GATE (contract §3) — enforced HERE, at spawn time, for every mode that can open
      // a PR. `override` is only ever honoured for the manual `ship` mode (the pure function
      // enforces that; an automated path cannot grant itself one), and every honoured
      // override is written to events.jsonl before the run starts.
      const gate = await checkShipGate(key, mode, {
        override: body?.override === true,
        overrideReason: typeof body?.overrideReason === 'string' ? body.overrideReason : null,
      });
      if (!gate.allowed) {
        return sendJson(res, 409, {
          error: 'ship gate: the rubric receipt could not be verified',
          reason: gate.reason,
          key,
          // Say plainly what the escape hatch does, so nobody clicks it expecting a merge.
          override:
            'Re-send with override:true and a reason to record a human-signed exception for this '
            + "ticket's current commit. That authorises a PR to be opened despite the score; it "
            + 'never merges, and it stops applying as soon as the branch moves on.',
        });
      }
      // Cost is checked before anything is spawned. Inside the repair loop the cap could only
      // stop further repair; it could never stop the next click.
      const budget = evaluateBudgetGate({
        mode,
        key,
        spentUsd: ticketSpendUsd(key, loadCostModel()),
        capUsd: loadBudgetCap(),
        acknowledged: body?.acknowledgeBudget === true,
      });
      if (!budget.allowed) {
        return sendJson(res, 409, {
          error: 'budget gate: this ticket is already over its cap',
          reason: budget.reason,
          key,
          spentUsd: budget.spentUsd,
          capUsd: budget.capUsd,
        });
      }
      if (budget.gated && budget.over) {
        console.warn(`[panel] BUDGET ACKNOWLEDGED for ${key} (${mode}) — ${budget.reason}`);
      }

      let shipException = null;
      if (gate.overridden) {
        shipException = recordShipGateOverride(key, mode, gate, gate.overrideReason).exception;
      }
      // Human notes are a plain FILE write, read by whichever stage runs next (resolve-ticket's
      // SKILL.md checks for this file at the top of every stage) — they NEVER touch the spawned
      // command's argv (which stays the fixed PROMPTS[mode](key)/continuePrompt(key) above). Not
      // just a `replan` thing: Continue on a ticket blocked mid-BUILD/VERIFY/SHIP needs the same
      // "here's context for what you're about to resume" path, so this accepts notes for any mode.
      // Re-plan from step comments, or continue with answers to the planner's questions: the
      // notes are composed here from the panel's own files, then travel exactly like typed notes.
      let runNotes = notes;
      let sendComments = false;
      if (body?.planComments === true && mode === 'replan') {
        runNotes = replanNotes(readJsonSafe(join(TICKETS, key, 'plan-review.json')), typeof notes === 'string' ? notes : '');
        if (!runNotes) return sendJson(res, 400, { error: 'there are no open comments to re-plan with' });
        sendComments = true;
      }
      if (body?.answers && typeof body.answers === 'object') {
        let a;
        try { a = answersFile(readJsonSafe(join(TICKETS, key, 'questions.json')), body.answers); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        writeFileSync(join(TICKETS, key, 'answers.json'), JSON.stringify(a.file, null, 2) + '\n');
        runNotes = [a.notes, typeof notes === 'string' ? notes.trim() : ''].filter(Boolean).join('\n\n');
      }
      if (typeof runNotes === 'string' && runNotes.trim()) {
        try {
          mkdirSync(join(TICKETS, key), { recursive: true });
          writeFileSync(join(TICKETS, key, 'resume-notes.md'), runNotes);
        } catch (e) {
          return sendJson(res, 500, { error: 'could not write resume notes: ' + e.message });
        }
      }
      startRun(key, mode, prompt);
      if (sendComments) {
        const path = join(TICKETS, key, 'plan-review.json');
        try { writeFileSync(path, JSON.stringify(markSent(readJsonSafe(path), (planVersions(key).current || 0) + 1), null, 2) + '\n'); }
        catch { /* the run started; the comments just stay open */ }
      }
      return sendJson(res, 202, {
        started: true,
        key,
        mode,
        ...(shipException
          ? {
              shipException: {
                headSha: shipException.headSha,
                acceptedFailure: shipException.acceptedFailure,
                note: 'recorded — the run may open a PR for this commit, and will still not merge',
              },
            }
          : {}),
      });
    }

    // Bulk-approve every plan-ready ticket for BUILD in one click. Each is already an
    // individually-reviewed plan sitting at the human gate; this enqueues them all and lets
    // drainBuildQueue() feed them through the same MAX_CONCURRENT_RUNS cap the single button
    // obeys — 2 start now, the rest auto-start as slots free. No cap on how many are enqueued.
    if (req.method === 'POST' && path === '/api/build-all') {
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      const { accepted, skipped } = enqueuePlanReadyBuilds(buildState().tickets);
      drainBuildQueue();
      return sendJson(res, 202, {
        accepted: accepted.length,
        started: accepted.filter((k) => running.has(k)),
        queued: accepted.filter((k) => !running.has(k)),
        skipped,
      });
    }

    // Toggle continuous auto-build. When enabled, every ticket that reaches plan-ready is
    // enqueued for BUILD automatically (through the same 2-slot cap) — no per-ticket click. The
    // flag persists in config.json, so a recycled server re-arms itself. Enabling it drains once
    // immediately so anything already plan-ready starts now.
    if (req.method === 'POST' && path === '/api/auto-build') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const enabled = !!body.enabled;
      patchConfig((cfg) => { cfg.autoBuild = enabled; });
      autoBuildAttempted.clear(); // fresh slate: re-enabling gives every plan-ready ticket a turn
      if (enabled && !isPaused()) drainBuildQueue();
      scheduleStateBroadcast();
      return sendJson(res, 200, { autoBuild: enabled });
    }

    // #code: git actions, manifest commands and per-worktree questions. Every input is checked
    // against what git or repo-manifest.json reported (dashboard/workspace.mjs).
    if (req.method === 'POST' && ['/api/worktree-action', '/api/worktree-run', '/api/worktree-run-stop', '/api/worktree-chat'].includes(path)) {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      if (path === '/api/worktree-chat' && isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      const id = String(body.id || '');
      const r = path === '/api/worktree-action' ? await workspace.action(id, body)
        : path === '/api/worktree-run' ? await workspace.runStart(id, String(body.command || ''))
        : path === '/api/worktree-run-stop' ? workspace.runStop(String(body.runId || ''))
        : await workspace.chatAsk(id, body.text);
      return r.error ? sendJson(res, r.code || 400, { error: r.error }) : sendJson(res, 200, r);
    }

    // Skip, snooze, restore or reorder scanned tickets. Panel-owned, spends nothing.
    if (req.method === 'POST' && path === '/api/queue-triage') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      if (keys.some((k) => !KEY_RE.test(k))) return sendJson(res, 400, { error: 'invalid key' });
      if (body.action === 'order' && (!Array.isArray(body.order) || body.order.some((k) => !KEY_RE.test(String(k))))) return sendJson(res, 400, { error: 'invalid order' });
      try {
        const next = setQueueTriage(readJsonSafe(QUEUE_TRIAGE), { keys, action: body.action, until: body.until, order: body.order, items: scanItems() });
        mkdirSync(QUEUE_RUNS, { recursive: true });
        writeFileSync(QUEUE_TRIAGE, JSON.stringify(next, null, 2) + '\n');
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
      scheduleStateBroadcast();
      return sendJson(res, 200, { ok: true });
    }

    // Plan several scanned tickets: as many start now as there are free slots, the rest wait
    // in order and start as runs finish - the same drain that feeds "Build all ready".
    if (req.method === 'POST' && path === '/api/plan-batch') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      const keys = [...new Set((Array.isArray(body.keys) ? body.keys : []).map(String))];
      if (!keys.length || keys.some((k) => !KEY_RE.test(k))) return sendJson(res, 400, { error: 'give one or more ticket keys' });
      const skipped = [];
      for (const k of keys) {
        if (running.has(k)) skipped.push({ key: k, reason: 'already running' });
        else if (planQueue.includes(k)) skipped.push({ key: k, reason: 'already waiting' });
        else planQueue.push(k);
      }
      const before = new Set(running.keys());
      drainBuildQueue();
      const started = keys.filter((k) => running.has(k) && !before.has(k));
      return sendJson(res, 202, { started, queued: planQueue.filter((k) => keys.includes(k)), skipped });
    }

    // Comment on a plan step, edit or resolve a comment, or delete it.
    if (req.method === 'POST' && path === '/api/plan-comment') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const key = String(body.key || '');
      if (!KEY_RE.test(key) || !existsSync(join(TICKETS, key))) return sendJson(res, 400, { error: 'invalid key' });
      const path2 = join(TICKETS, key, 'plan-review.json');
      try {
        const cur = readJsonSafe(path2);
        const next = body.op === 'add' ? addComment(cur, { blockId: body.blockId, blockTitle: body.blockTitle, text: body.text })
          : updateComment(cur, String(body.id || ''), { text: body.text, resolved: body.resolved, delete: body.op === 'delete' });
        writeFileSync(path2, JSON.stringify(next, null, 2) + '\n');
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
      scheduleStateBroadcast();
      return sendJson(res, 200, { ok: true, open: openComments(readJsonSafe(path2)).length });
    }

    // Ask a ticket a question. Read-only answer; an answer may suggest an action, never run one.
    if (req.method === 'POST' && path === '/api/chat') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      const key = String(body.key || '');
      if (!KEY_RE.test(key) || !existsSync(join(TICKETS, key))) return sendJson(res, 400, { error: 'invalid key, or the ticket has no folder yet' });
      if (runningChats.size >= MAX_CONCURRENT_RUNS) return sendJson(res, 429, { error: `${MAX_CONCURRENT_RUNS} questions are already being answered - wait for one` });
      let q;
      try { q = chatQuestion(body.text); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      startChatRun(key, q);
      return sendJson(res, 202, { started: true, id: q.id });
    }

    if (req.method === 'POST' && path === '/api/explain') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      const subject = parseSubject(body?.subject);
      if (subject.error) return sendJson(res, 400, { error: subject.error });
      if (!isSlug(subject.slug)) return sendJson(res, 400, { error: 'that subject cannot be explained' });
      if (runningExplainers.has(subject.slug)) return sendJson(res, 409, { error: `already writing the explainer for ${subject.label}`, slug: subject.slug });
      if (runningExplainers.size >= MAX_CONCURRENT_RUNS) return sendJson(res, 429, { error: `run limit reached (${MAX_CONCURRENT_RUNS} explainers at once)` });
      startExplainRun(subject);
      return sendJson(res, 202, { started: true, slug: subject.slug, subject });
    }

    if (req.method === 'POST' && path === '/api/pr-review') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — new runs are blocked (unpause to run)' });
      // parsePrRef is the ONLY validator for this free-text field — a strict anchored
      // regex (see scripts/pr-ref-lib.mjs), mirroring KEY_RE's strictness above. `prUrl`
      // only reaches the spawned command's argv after passing this check.
      const ref = parsePrRef(body?.prUrl);
      if (!ref) return sendJson(res, 400, { error: 'invalid prUrl (expected https://github.com/<owner>/<repo>/pull/<n>)' });
      const refId = prRefId(ref);
      if (runningPrReviews.has(refId)) return sendJson(res, 409, { error: `a review is already active for ${refId}` });
      if (runningPrReviews.size >= MAX_CONCURRENT_RUNS) return sendJson(res, 429, { error: `run limit reached (${MAX_CONCURRENT_RUNS} concurrent)` });
      // Rebuilt from the parsed parts, never `body.prUrl` verbatim — same reasoning as the
      // validation above, one step further: argv gets the canonical form or nothing.
      startPrReviewRun(refId, prUrlFromRef(ref));
      return sendJson(res, 202, { started: true, ref: refId });
    }

    if (req.method === 'POST' && (path === '/api/archive' || path === '/api/unarchive')) {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const { key } = body;
      if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key' });
      const marker = join(TICKETS, key, ARCHIVE_MARKER);
      try {
        if (path === '/api/archive') {
          mkdirSync(join(TICKETS, key), { recursive: true });
          writeFileSync(marker, '');
        } else if (existsSync(marker)) {
          unlinkSync(marker);
        }
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
      scheduleStateBroadcast();
      return sendJson(res, 200, { key, archived: path === '/api/archive' });
    }

    if (req.method === 'POST' && path === '/api/cancel') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const { key } = body;
      if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key' });
      const entry = running.get(key);
      if (!entry) return sendJson(res, 404, { error: `no active run for ${key}` });
      // Flag BEFORE the signal: a SIGTERM'd child reports exit code null (→ 0) and has spent
      // nothing, which is indistinguishable from a no-op run unless we record the intent.
      entry.cancelled = true;
      entry.child.kill('SIGTERM');
      return sendJson(res, 200, { cancelling: true, key });
    }

    if (req.method === 'POST' && path === '/api/cron') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      patchConfig((cfg) => {
        cfg.scheduler = cfg.scheduler || {};
        if (typeof body.enabled === 'boolean') cfg.scheduler.enabled = body.enabled;
        if (Number.isFinite(body.intervalMinutes) && body.intervalMinutes >= 1) cfg.scheduler.intervalMinutes = Math.round(body.intervalMinutes);
      });
      scheduleStateBroadcast();
      return sendJson(res, 200, { cron: schedulerCfg(), nextRunAt: nextScanAt() });
    }

    if (req.method === 'POST' && path === '/api/queue-run') {
      if (isPaused()) return sendJson(res, 423, { error: 'panel is paused — unpause to scan' });
      const r = await runScan();
      return sendJson(res, 200, { scanned: r.keys.length, keys: r.keys, error: r.error, at: r.at });
    }

    // Accept / park / reject one finding, or reword it. The panel is triage.json's only writer.
    if (req.method === 'POST' && path === '/api/pr-review-triage') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const ref = String(body.ref || '');
      if (!PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
      const dir = join(PR_REVIEWS, ref);
      if (!existsSync(join(dir, 'findings.json'))) return sendJson(res, 404, { error: `no findings for ${ref}` });
      if (runningPrReviews.has(ref)) return sendJson(res, 409, { error: 'the review is still running - triage it when it finishes' });
      const fps = (Array.isArray(body.fingerprints) ? body.fingerprints : [body.fingerprint]).map(String);
      const known = new Set((loadFindingRows(ref)?.rows || []).map((r) => r.fingerprint));
      const unknown = fps.filter((fp) => !known.has(fp));
      if (!fps.length || unknown.length) return sendJson(res, 400, { error: `unknown finding(s): ${unknown.join(', ') || 'none given'}` });
      const change = {};
      if ('decision' in body) {
        if (body.decision !== null && !DECISIONS.includes(body.decision)) return sendJson(res, 400, { error: `decision must be ${DECISIONS.join('|')} or null` });
        change.decision = body.decision;
      }
      if ('body' in body) change.body = typeof body.body === 'string' ? body.body : '';
      let triage = readJsonSafe(join(dir, 'triage.json'));
      for (const fp of fps) triage = setTriage(triage, fp, change);
      writeFileSync(join(dir, 'triage.json'), JSON.stringify(triage, null, 2) + '\n');
      scheduleStateBroadcast();
      return sendJson(res, 200, { ok: true, counts: loadFindingRows(ref)?.counts || null });
    }

    // Post the accepted findings as ONE GitHub review (event COMMENT), inline where the evidence
    // sits on the diff. Not pause-gated, for the same reason as the comment post below.
    if (req.method === 'POST' && path === '/api/pr-review-post') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const ref = String(body.ref || '');
      if (!PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
      const dir = join(PR_REVIEWS, ref);
      if (!existsSync(dir)) return sendJson(res, 404, { error: `no review for ${ref}` });
      if (runningPrReviews.has(ref)) return sendJson(res, 409, { error: 'the review is still running' });
      if (postingPrReviews.has(ref) || postingPrComments.has(ref)) return sendJson(res, 409, { error: `already posting for ${ref}` });

      postingPrReviews.add(ref);
      try {
        const r = await buildFindingsReview(ref, typeof body.summary === 'string' ? body.summary : '');
        if (r.error) return sendJson(res, r.code, { error: r.error });
        if (!manifestRepoSlugs().includes(r.slug)) {
          return sendJson(res, 403, { error: `${r.slug} is not in repo-manifest.json - the panel will not post to an unknown repo` });
        }
        if (!r.built.acceptedCount) return sendJson(res, 400, { error: 'nothing new to post - every accepted finding is already on the PR, or none are accepted' });
        if (body.acceptedSha !== r.built.acceptedSha) {
          return sendJson(res, 409, { error: 'the accepted findings changed since you previewed them - reopen the dialog so you post what you read' });
        }
        if (r.built.unresolved.length) {
          return sendJson(res, 422, {
            error: 'some findings still name internal tooling - edit their wording first',
            issues: r.built.unresolved.map((u) => `${u.where}: "${u.hit}"`),
          });
        }
        const text = JSON.stringify(r.built.payload);
        const lint = lintProse([r.built.payload.body, ...r.built.payload.comments.map((c) => c.body)].join('\n'));
        if (lint.count) {
          return sendJson(res, 422, { error: 'the review still names internal tooling', issues: lint.violations.map((v) => v.detail) });
        }
        const fits = bodyFits(r.built.payload.body);
        if (!fits.ok) return sendJson(res, 400, { error: `the review body is ${fits.bytes} bytes, over GitHub's ${fits.limit} limit` });
        if (!r.live) return sendJson(res, 502, { error: `could not confirm the PR is open (${r.liveError}) - nothing was posted` });
        if (r.live.state !== 'OPEN') return sendJson(res, 409, { error: `the PR is ${r.live.state} - nothing was posted` });

        const status = readJsonSafe(join(dir, 'status.json')) || {};
        const posted = Array.isArray(status.postedComments) ? status.postedComments : [];
        const already = posted.find((c) => c.acceptedSha === r.built.acceptedSha);
        if (already && body.allowDuplicate !== true) {
          return sendJson(res, 409, { error: `these findings were already posted: ${already.commentUrl || 'see the PR'}`, commentUrl: already.commentUrl || null });
        }

        const payloadPath = join(dir, `posted-review-${posted.length + 1}.json`);
        writeFileSync(payloadPath, text + '\n');
        // retries:0 - a review post is not idempotent.
        const res2 = await guardExec('gh-pr-review', GH_BIN, [
          'api', '--method', 'POST', `repos/${r.slug}/pulls/${r.target.parsed.number}/reviews`, '--input', payloadPath,
        ], { source: 'gh', retries: 0, timeoutMs: 30000, env: ghEnv(), extendEnv: false });
        if (!res2.ok) return sendJson(res, 502, { error: `gh could not post the review (${res2.kind}: ${res2.message})` });
        let reviewUrl = r.target.url;
        try { reviewUrl = JSON.parse(String(res2.value?.stdout || '{}')).html_url || reviewUrl; } catch { /* keep the PR url */ }

        const who = await ghText('pr-review-post identity', ['api', 'user', '--jq', '.login']);
        const record = {
          at: new Date().toISOString(),
          kind: 'review',
          commentUrl: reviewUrl,
          author: who.ok ? who.value : null,
          acceptedSha: r.built.acceptedSha,
          fingerprints: r.built.fingerprints,
          inline: r.built.inline.length,
          inBody: r.built.inBody.length,
          commitId: r.built.payload.commit_id || null,
          bodySha256: sha256(text),
        };
        try { writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...status, postedComments: [...posted, record] }, null, 2) + '\n'); } catch { /* posted; the record is best-effort */ }
        // Per finding, so a re-review carries "already on the PR" forward and never posts it twice.
        try {
          let triage = readJsonSafe(join(dir, 'triage.json'));
          for (const fp of r.built.fingerprints) triage = setTriage(triage, fp, { posted: { at: record.at, url: reviewUrl } });
          writeFileSync(join(dir, 'triage.json'), JSON.stringify(triage, null, 2) + '\n');
        } catch { /* the audit record above still names every fingerprint */ }
        scheduleStateBroadcast();
        return sendJson(res, 201, { posted: true, commentUrl: reviewUrl, at: record.at, inline: record.inline, inBody: record.inBody });
      } finally {
        postingPrReviews.delete(ref);
      }
    }

    // Publish a review's findings as a PR comment. Not pause-gated: pause is about spend and
    // autonomy, and this spawns nothing - an operator who paused in order to hand-review PRs
    // would be baffled to find this dead.
    if (req.method === 'POST' && path === '/api/pr-review-comment') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const ref = String(body.ref || '');
      if (!PR_REF_RE.test(ref)) return sendJson(res, 400, { error: 'invalid ref' });
      const dir = join(PR_REVIEWS, ref);
      if (!existsSync(dir)) return sendJson(res, 404, { error: `no review for ${ref}` });
      if (postingPrComments.has(ref)) return sendJson(res, 409, { error: `a comment is already being posted for ${ref}` });

      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text) return sendJson(res, 400, { error: 'the comment body is empty' });
      const fits = bodyFits(text);
      if (!fits.ok) return sendJson(res, 400, { error: `the comment is ${fits.bytes} bytes, over GitHub's ${fits.limit} limit` });
      const lint = lintProse(text);
      if (lint.count) {
        return sendJson(res, 422, {
          error: 'the comment still names internal tooling - it goes out under your name, so edit those lines first',
          issues: lint.violations.map((v) => `line ${v.line}: ${v.detail}`),
        });
      }

      const target = prUrlForRef(ref);
      if (!target) return sendJson(res, 400, { error: 'no PR url could be derived for this review' });
      const slug = `${target.parsed.owner}/${target.parsed.repo}`;
      // The panel may only ever write to a repo it already knows about.
      if (!manifestRepoSlugs().includes(slug)) {
        return sendJson(res, 403, { error: `${slug} is not in repo-manifest.json - the panel will not post to an unknown repo` });
      }

      const status = readJsonSafe(join(dir, 'status.json')) || {};
      const currentReviewSha = sha256(readTextSafe(join(dir, 'review.md')) || '');
      if (body.reviewSha256 && body.reviewSha256 !== currentReviewSha) {
        return sendJson(res, 409, { error: 'the review changed since you previewed it - reopen the dialog so you post what you actually read' });
      }
      const already = (Array.isArray(status.postedComments) ? status.postedComments : [])
        .find((c) => c.reviewSha256 === currentReviewSha);
      if (already && body.allowDuplicate !== true) {
        return sendJson(res, 409, { error: `these findings were already posted: ${already.commentUrl || 'see the PR'}`, commentUrl: already.commentUrl || null });
      }

      postingPrComments.add(ref);
      try {
        // Refuse to post blind: if the state fetch itself fails we do not know what we are
        // writing to. A closed or merged PR is not what the operator meant to comment on.
        const live = await ghJson('pr-comment pr-state', ['pr', 'view', String(target.parsed.number), '--repo', slug, '--json', 'state']);
        if (!live.ok) return sendJson(res, 502, { error: `could not confirm the PR is open (${live.kind}: ${live.message}) - nothing was posted` });
        if (live.value?.state !== 'OPEN') return sendJson(res, 409, { error: `the PR is ${live.value?.state} - nothing was posted` });

        const seq = (Array.isArray(status.postedComments) ? status.postedComments.length : 0) + 1;
        const bodyPath = join(dir, `posted-comment-${seq}.md`);
        writeFileSync(bodyPath, text.endsWith('\n') ? text : `${text}\n`);

        // retries:0 is mandatory - guardExec defaults to 2, and this is not idempotent.
        const posted = await guardExec('gh-pr-comment', GH_BIN, ['pr', 'comment', target.url, '--body-file', bodyPath], {
          source: 'gh', retries: 0, timeoutMs: 20000, env: ghEnv(), extendEnv: false,
        });
        if (!posted.ok) return sendJson(res, 502, { error: `gh could not post the comment (${posted.kind}: ${posted.message})` });

        const out = String(posted.value?.stdout || '').trim();
        const commentUrl = (out.match(/https:\/\/\S+/) || [target.url])[0];
        const who = await ghText('pr-comment identity', ['api', 'user', '--jq', '.login']);
        const record = {
          at: new Date().toISOString(),
          commentUrl,
          author: who.ok ? who.value : null,
          severities: Array.isArray(body.severities) ? body.severities : DEFAULT_COMMENT_SEVERITIES,
          bodySha256: sha256(text),
          bodyBytes: fits.bytes,
          reviewSha256: currentReviewSha,
          edited: body.edited === true,
        };
        const next = { ...status, postedComments: [...(Array.isArray(status.postedComments) ? status.postedComments : []), record] };
        try { writeFileSync(join(dir, 'status.json'), JSON.stringify(next, null, 2) + '\n'); } catch { /* the comment is already posted; the record is best-effort */ }
        scheduleStateBroadcast();
        return sendJson(res, 201, { posted: true, commentUrl, at: record.at, bodySha256: record.bodySha256 });
      } finally {
        postingPrComments.delete(ref);
      }
    }

    // Manual PR-inbox refresh. Not pause-gated: it spawns nothing and spends nothing, and the
    // action it feeds (POST /api/pr-review) stays gated.
    if (req.method === 'POST' && path === '/api/pr-inbox-scan') {
      if (prInboxBusy) return sendJson(res, 202, { sweeping: true, at: prInbox.at });
      const s = await runPrInboxSweep();
      const failed = Object.entries(s.perRepo || {}).filter(([, r]) => r.error).map(([slug]) => slug);
      return sendJson(res, 200, {
        at: s.at,
        login: s.login,
        error: s.error,
        repos: Object.keys(s.perRepo || {}).length,
        failed,
        rows: mergeSnapshots(s.perRepo, s.search?.rows || []).length,
      });
    }

    if (req.method === 'POST' && path === '/api/pause') {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const paused = !!body.paused;
      patchConfig((cfg) => { cfg.paused = paused; });
      // Pause is a full stop: cancel active runs AND drop anything queued for bulk build, so
      // resuming doesn't silently restart a batch the operator paused specifically to halt.
      if (paused) {
        buildQueue.length = 0;
        planQueue.length = 0;
        autoBuildAttempted.clear();
        for (const e of running.values()) { try { e.cancelled = true; e.child.kill('SIGTERM'); } catch { /* already gone */ } }
      }
      scheduleStateBroadcast();
      return sendJson(res, 200, { paused });
    }

    if (req.method === 'POST' && path === '/api/config') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const parsed = ConfigSchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(res, 400, { error: 'config failed validation', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
      }
      try { writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2) + '\n'); }
      catch (e) { return sendJson(res, 500, { error: 'could not write config: ' + e.message }); }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/check-merge') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const { key } = body;
      if (typeof key !== 'string' || !KEY_RE.test(key)) return sendJson(res, 400, { error: 'invalid key' });
      const status = readJsonSafe(join(TICKETS, key, 'status.json'));
      const prs = Array.isArray(status?.prs) ? status.prs : status?.pr ? [status.pr] : [];
      if (!prs.length) return sendJson(res, 400, { error: `no PR recorded for ${key}` });
      const info = await fetchPrMergeState(prs[0], ticketGithubSlug(key));
      if (!info.ok) {
        // Still never assume merged — but say which of the three things went wrong.
        return sendJson(res, 200, {
          key,
          state: 'unverified',
          failure: info.failure,
          detail: info.detail,
          prRef: String(prs[0] ?? ''),
        });
      }
      if (info.state === 'MERGED') { markMerged(key, info); scheduleStateBroadcast(); }
      return sendJson(res, 200, { key, ...info });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || 'internal error' });
  }
});

// Every PR's state per repo (open / merged / closed), so lists can hide finished work. One gh call
// per manifest repo, refreshed in the background; until it lands, state is unknown (null) and
// nothing is hidden.
const PR_STATE_TTL_MS = 10 * 60_000;
const prStates = new Map(); // slug -> { at, byNumber: Map, byHead: Map }
const prStateLoading = new Set();
function prStateFor(slug) {
  const cur = prStates.get(slug);
  if ((!cur || Date.now() - cur.at > PR_STATE_TTL_MS) && !prStateLoading.has(slug)) {
    prStateLoading.add(slug);
    ghJson('pr-states', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '1000', '--json', 'number,state,headRefName,headRefOid,url,title,mergedAt'])
      .then((r) => {
        if (!r.ok) return;
        const byNumber = new Map();
        const byHead = new Map();
        // gh lists newest first, so the first PR seen for a head branch is its latest one.
        for (const p of r.value || []) {
          byNumber.set(p.number, p);
          if (!byHead.has(p.headRefName)) byHead.set(p.headRefName, p);
        }
        prStates.set(slug, { at: Date.now(), byNumber, byHead });
        scheduleStateBroadcast();
      })
      .finally(() => prStateLoading.delete(slug));
  }
  return cur || null;
}
const prSlugFor = (repo) => manifestRepoSlugs().find((sl) => sl.endsWith(`/${repo}`)) || null;
const slimPr = (p) => (p ? { number: p.number, url: p.url, title: p.title, state: p.state, mergedAt: p.mergedAt || null } : null);

// The code workspace (#code): repos, worktrees, git actions, manifest commands, per-worktree chat.
let inboxRowsCache = { at: 0, rows: [] };
const workspace = createWorkspace({
  workspace: WORKSPACE,
  root: ROOT,
  manifest: () => readJsonSafe(REPO_MANIFEST),
  broadcast,
  scheduleStateBroadcast,
  ghEnv,
  secrets: buildSecrets,
  spawnClaudeRun,
  prForBranch: (repo, branch) => {
    if (!branch) return null;
    if (Date.now() - inboxRowsCache.at > 10_000) inboxRowsCache = { at: Date.now(), rows: buildPrInboxState().rows || [] };
    const row = inboxRowsCache.rows.find((r) => r.repo === repo && r.headRefName === branch);
    if (row) return { number: row.number, url: row.url, title: row.title, state: row.state, bucket: row.bucket, reviewDecision: row.reviewDecision, checksState: row.checksState };
    const slug = prSlugFor(repo);
    return slug ? slimPr(prStateFor(slug)?.byHead.get(branch)) : null;
  },
  prByNumber: (repo, number) => {
    const slug = prSlugFor(repo);
    return slug ? slimPr(prStateFor(slug)?.byNumber.get(Number(number))) : null;
  },
});
// Commands started from #code run in their own process groups; don't orphan a dev server.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { workspace.stopAll(); process.exit(0); });

const settingsPath = writeHeadlessSettings();
const atlasMcpPath = writeAtlasMcpConfig();
// Before anything reads a card: a run killed mid-flight leaves `result` frozen at in-progress
// with its report already on disk, which the board would otherwise render as retryable.
reconcileOrphanedReviews();
startWatchers();
// Auto-poll awaiting-merge PRs (guarded; small set). First pass shortly after boot, then every 60s.
setTimeout(pollMerges, 4000);
setInterval(pollMerges, 60000).unref();
// Scheduled queue scan (scan & notify only). Tick every minute; runScan gates on interval + pause.
setTimeout(schedulerTick, 6000);
setInterval(schedulerTick, 60000).unref();
// PR inbox sweep. Read-only against GitHub, so it runs even while paused.
setTimeout(prInboxTick, 8000);
setInterval(prInboxTick, 60000).unref();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Autopilot panel → http://127.0.0.1:${PORT}  (Console)  ·  /board  (Kanban)  ·  /cost  (Cost)  ·  /pr-review  (Review)`);
  console.log(`CLAUDE_BIN=${CLAUDE_BIN}`);
  console.log(panelDistReady()
    ? `panel: serving built assets from ${PANEL_DIST} (SPA fallback → index.html)`
    : `panel: serving legacy pages from ${PANEL} (no panel-dist/index.html yet)`);
  console.log('ship gate: ON — build/review/continue/ship require a done rubric.jsonl receipt matching worktree HEAD');
  console.log(`headless policy: --settings ${settingsPath}  (defaultMode "dontAsk", ws-scoped allow/deny)`);
  console.log('child env: AUTOPILOT_HEADLESS=1  (pipeline uses the headless Jira path — scripts/jira.mjs)');
  console.log(atlasMcpPath
    ? `erp-atlas MCP: --mcp-config ${atlasMcpPath}  (read tools only; TEST reads and fact_propose denied)`
    : `erp-atlas MCP: OFF (no checkout at ${ATLAS_DIR})`);
  if (resolveNpmToken()) {
  if (ENV_IS_LEGACY) {
    console.warn(`secrets: reading the pre-rename ${ENV_PATH}. Rename it to config/millwright.env — `
      + 'deleting it while the code still resolves it is how Jira auth silently dies.');
  }
    console.log(`NPM_TOKEN: found → injected as NPM_TOKEN + NODE_AUTH_TOKEN (re-read from env/${ENV_PATH} per run; private @acme-it-erp/* installs will auth)`);
  } else {
    console.log(`NPM_TOKEN: NOT found (checked $NPM_TOKEN/$NODE_AUTH_TOKEN/$GITHUB_TOKEN + ${ENV_PATH}) — private @acme-it-erp/* installs will 401.`);
    console.log(`   Fix: put NPM_TOKEN=<GitHub PAT with read:packages> in ${ENV_PATH} (re-read per run, no restart needed).`);
  }
  if (RUN_ARGS_OVERRIDE != null) {
    console.log(`run args: ${RUN_ARGS_OVERRIDE.length ? RUN_ARGS_OVERRIDE.join(' ') : '(none)'}  [CLAUDE_RUN_ARGS override — generated policy bypassed]`);
  }
});
