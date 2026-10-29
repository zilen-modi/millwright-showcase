// Shapes returned by dashboard/server.mjs. Transcribed from the handlers themselves
// (buildState / buildTicketDetail / buildCost / buildPrReviewsState) — the JSON contract
// is fixed by docs/INTEGRATION-CONTRACTS.md §5 and does not change with this migration.

export type ColumnKey =
  | 'queued' | 'intake' | 'route' | 'plan' | 'build'
  | 'verify' | 'review' | 'ship' | 'archived';

export interface Column {
  key: ColumnKey;
  label: string;
}

export interface TicketCard {
  key: string;
  summary: string;
  phase: string;
  lastCompleted?: string | null;
  column: ColumnKey;
  prUrl: string | null;
  jiraStatus: string | null;
  rubricScore: number | null;
  /** A score found in status.json with NO rubric.jsonl receipt behind it. Rendered as
   *  unverified, never as a rubric score — telling the two apart is the point of A1. */
  rubricUnverified?: number | null;
  updatedAt: string | null;
  costUsd: number;
  tokens: number;
  running: boolean;
  runMode?: string | null;
  manuallyArchived: boolean;
  planReady: boolean;
  /** Server-computed: the ticket's stage is resumable, so `continue` will be accepted. Not
   *  the same as `blocked` — a run killed mid-stage is resumable but was never marked blocked. */
  canContinue?: boolean;
  /** Server-computed: the last rubric receipt says `done`, so the ship gate will let a PR open. */
  shipReady?: boolean;
  blocked?: boolean;
  blockedReason?: string | null;
  blockedStage?: string | null;
  /** Additive stale-sweep marker (A8) — present on cards the sweeper named. */
  stale?: StaleMark | null;
  /** Client-only: a queue entry with no ticket dir yet. */
  queued?: boolean;
  /** Server-computed: enqueued by "Build all ready", waiting for a concurrency slot. */
  queuedForBuild?: boolean;
}

export interface StaleMark {
  reason: 'blocked' | 'stalled' | string;
  idleHours: number | null;
  thresholdHours: number;
}

export interface SweeperBlock {
  enabled: boolean;
  blockedAfterHours: number;
  staleAfterHours: number;
  configured?: boolean;
  count: number;
  tickets: {
    key: string;
    reason: string;
    idleHours: number | null;
    thresholdHours: number;
    stage: string | null;
    column: ColumnKey;
    blockedReason: string | null;
    updatedAt: string | null;
  }[];
}

export interface Automation {
  cron: {
    enabled: boolean;
    intervalMinutes: number;
    lastScanAt: string | null;
    nextRunAt: string | null;
    scanning: boolean;
    error: string | null;
  };
  paused: boolean;
  /** Continuous auto-build: every ticket reaching plan-ready is enqueued for build. */
  autoBuild?: boolean;
  pendingCount: number;
  pending: string[];
  /** The scan triaged: details, estimates, skip/snooze/order. Absent on older servers. */
  triage?: { visible: QueueItem[]; hidden: QueueItem[] };
}

export interface PlanComment {
  id: string;
  blockId: string;
  blockTitle: string;
  text: string;
  at: string | null;
  /** Sent with a re-plan; the plan version that re-plan was expected to produce. */
  sentAt: string | null;
  sentInVersion: number | null;
  resolved: boolean;
}

export interface PlanQuestion { id: string; question: string; why: string | null; options: string[] }

export interface PlanReview {
  versions: { version: number; sha: string; at: string }[];
  current: number | null;
  comments: PlanComment[];
  open: number;
  blocks: { id: string; level: number; title: string; body: string; kind: string }[];
  checklist: { done: boolean; text: string }[];
  /** Block ids that changed from the previous version, by kind of change. */
  changed: { added: string[]; changed: string[]; removed: string[] } | null;
  questions: PlanQuestion[];
  answers: { id: string; question: string; answer: string }[];
  awaitingAnswers: boolean;
}

export interface QueueItem {
  key: string;
  summary: string;
  status: string;
  priority: string | null;
  type: string | null;
  epic: { key: string; summary: string } | null;
  assignee: string | null;
  labels: string[];
  updated: string | null;
  created: string | null;
  estimate: { median: number; p75: number; n: number; basis: string } | null;
  queuedForPlan: boolean;
  changedSinceSkip?: boolean;
  hiddenBy?: 'skip' | 'snooze';
  until?: string;
  since?: string;
}

export interface BoardState {
  generatedAt: string;
  columns: Column[];
  tickets: TicketCard[];
  queue: { key: string }[];
  running: string[];
  /** Keys approved for bulk build, waiting for a concurrency slot. */
  buildQueue?: string[];
  /** Keys chosen with "Plan selected", waiting for a slot. */
  planQueue?: string[];
  automation: Automation;
  sweeper?: SweeperBlock;
}

export interface TimelineRow {
  stage: string;
  agent: string;
  status: string;
  durationSec: number;
  tokensTotal: number;
  notes: string;
}

export interface TicketArtifacts {
  plan: string | null;
  design: string | null;
  context: string | null;
  review: string | null;
  verify: string | null;
  ticket: string | null;
}

/** One screenshot on disk under tickets/<key>/{figma,story,diffs}/. `url` is the serving
 *  endpoint, not a filesystem path - the panel never sees where these live. */
export interface TicketShot {
  kind: 'figma' | 'story' | 'diff';
  name: string;
  url: string;
}

export interface TicketShotVariant {
  variant: string;
  figma: TicketShot[];
  story: TicketShot[];
  /** null when nothing ever compared this variant, which is a reviewable fact in itself. */
  diff: TicketShot | null;
  /** BLOCKED = the comparison could not run at all, which is not the same as failing it. */
  status: 'PASS' | 'FAIL' | 'BLOCKED' | null;
  /** Why a BLOCKED variant could not be compared. Only the report knows. */
  reason: string | null;
  worstRatio: number | null;
  failedRegions: string[];
}

export interface TicketShots {
  variants: TicketShotVariant[];
  /** null when there is no visual-diff report at all, distinct from a report that failed. */
  pass: boolean | null;
  reportAt: string | null;
  counts: { figma: number; story: number; diff: number };
}

export interface TicketDetail {
  key: string;
  summary: string;
  phase: string;
  column: ColumnKey;
  prUrl: string | null;
  jiraStatus: string | null;
  rubricScore: number | null;
  costUsd: number;
  tokens: number;
  manuallyArchived: boolean;
  planReady: boolean;
  running: boolean;
  canContinue: boolean;
  blocked: boolean;
  blockedReason: string | null;
  blockedStage: string | null;
  timeline: TimelineRow[];
  /** Plan versions, step comments and the planner's questions (server planReviewDetail). */
  planReview?: PlanReview;
  artifacts: TicketArtifacts;
  /** null for any ticket with no screenshots on disk - most non-UI tickets. */
  shots: TicketShots | null;
}

export interface CostTicket {
  key: string;
  summary: string;
  costUsd: number;
  tokens: number;
  status: string;
  prUrl: string | null;
  jiraStatus: string | null;
  updatedAt: string | null;
  running: boolean;
}

export interface CostStage {
  stage: string;
  costUsd: number;
  tokens: number;
  count: number;
  avgDurationSec: number;
}

export interface BudgetRow {
  key: string;
  spentUsd: number;
  capUsd: number;
  ratio: number;
  over: boolean;
  rubricScore: number | null;
}

export interface PrReviewCard {
  ref: string;
  prUrl: string | null;
  title: string;
  isOwn: boolean | null;
  result: string | null;
  costUsd: number;
  tokens: number;
  updatedAt: string | null;
  running: boolean;
  /** Why the run failed, when the run-outcome check judged it a failure. */
  failure: string | null;
  /** The question a `needs-input` run stopped on. Such a run exits 0 and spends money, so
   * without this the panel showed a green tick and no new report. */
  question?: string | null;
  /** Seeded when the run spawns. `updatedAt` is only written when a run finishes, so this is
   * what dates a review that is still running. */
  startedAt?: string | null;
  reconciledAt?: string | null;
  /** The review finished and its report is on disk, but the run was killed before the outcome
   * was recorded and it could not be proven after the fact. Suppresses the retry offer so a
   * finished report is not re-spent, without inventing a verdict. */
  resultUnrecorded?: boolean;
  /** Server's verdict on whether a retry is offerable (needs a known prUrl). A retry always
   * restarts from scratch — `/review-pr` keeps no checkpoints, so there is no "continue". */
  retryable: boolean;
  /** The PR's state on GitHub (OPEN / MERGED / CLOSED); null until the panel has loaded it. */
  prState?: string | null;
  /** Triage counts from findings.json, or null for a review without structured findings. */
  triage?: {
    total: number; undecided: number; accept: number; toPost: number; posted: number; folded: number;
    round: number; stale: boolean;
  } | null;
}

export interface PostedComment {
  at: string;
  commentUrl: string | null;
  author: string | null;
  severities: string[];
  bodySha256: string;
  bodyBytes: number;
  reviewSha256: string;
  edited?: boolean;
}

export interface PrReviewDetail extends PrReviewCard {
  artifacts: {
    review: string | null;
    quality: string | null;
    log: string | null;
  };
  /** Every publish of these findings to the PR. An array because a re-review legitimately
   * posts again, and the history must survive a retry. */
  postedComments?: PostedComment[];
  /** findings.json + verdicts.json + triage.json (scripts/findings-lib.mjs buildRows), or null
   * for a review written before structured findings existed. */
  findings?: FindingsState | null;
}

export type FindingDecision = 'accept' | 'park' | 'reject';
export type FindingVerdict = 'confirmed' | 'refuted' | 'uncertain' | 'unverified';

export interface FindingRow {
  id: string;
  fingerprint: string;
  severity: 'high' | 'medium' | 'low';
  axis: string;
  kind: 'issue' | 'question';
  title: string;
  body: string;
  fix: string;
  blocking: boolean;
  evidence: { file: string; line: number; note: string }[];
  /** Why the panel turned an unevidenced blocking issue into a question. */
  demoted: string | null;
  verdict: FindingVerdict;
  verdictReason: string;
  /** Refuted by the verifier: shown collapsed, never deleted. */
  folded: boolean;
  decision: FindingDecision | null;
  /** The decision came from the same finding in the previous round. */
  decisionInherited: boolean;
  /** The operator's own wording, posted instead of the generated text. */
  editedBody: string | null;
  /** On a re-review: raised for the first time, or the same problem as last round. */
  since: 'new' | 'still-open' | null;
  carriedFrom: string | null;
  /** Already on the PR from an earlier post; never posted again. */
  posted: { at: string | null; url: string | null } | null;
}

export interface ResolvedFinding {
  fingerprint: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  evidence: { file: string; line: number; note: string }[];
  /** `not-raised`: the re-review neither raised it again nor said it was fixed. */
  status: 'fixed' | 'no-longer-applies' | 'not-raised';
  reason: string;
  decision: FindingDecision | null;
  posted: { at: string | null; url: string | null } | null;
}

export interface FindingsState {
  headSha: string | null;
  rows: FindingRow[];
  resolved: ResolvedFinding[];
  warnings: string[];
  /** Round shown (1 = first review). */
  round: number;
  previousRound: number | null;
  /** A re-review has started (or failed) and these rows are the previous round's. */
  stale: boolean;
  counts: {
    total: number; folded: number; undecided: number; accept: number; park: number; reject: number;
    posted: number; toPost: number; new: number; resolved: number;
  };
}

export interface FindingsReviewDraft {
  ref: string;
  prUrl: string;
  body: string;
  inline: { id: string; path: string; line: number; body: string }[];
  inBody: { id: string; at: string | null; body: string }[];
  acceptedCount: number;
  acceptedSha: string;
  unresolved: { where: string; line: number; hit: string }[];
  lint: { count: number; violations: { line: number; detail: string }[] };
  headSha: string | null;
  moved: boolean;
  diffError: string | null;
  viewer: string | null;
  viewerError: string | null;
  pr: { state: string | null; author: string | null; isDraft: boolean } | null;
  prError: string | null;
  postedComments: { at: string; commentUrl: string | null; kind?: string }[];
}

/** Optional block added by Goal A7 (`scripts/regression-trace.mjs`). Rendered when present. */
export interface RegressionBlock {
  /** True until the first background computation lands — render "computing", never 0. */
  pending: boolean;
  error?: string | null;
  computedAt?: string | null;
  /** The cached figure is older than its TTL. Shown, not hidden: a silently frozen
   *  number is worse than an honestly old one. */
  stale?: boolean;
  shipped?: number;
  escaped?: number;
  escapedDefectRate?: number;
  rubricCorrelation?: {
    verdict?: string;
    escapeMeanRubric?: number | null;
    cleanMeanRubric?: number | null;
    ticketsWithScore?: number;
    ticketsWithoutScore?: number;
  } | null;
  byComponent?: { component: string; shippedBy: string; escapes: string[] }[];
}

export interface CostState {
  generatedAt: string;
  currency: string;
  totals: {
    tickets: number;
    cost: number;
    tokens: number;
    cacheReadTokens?: number;
    inputTokens?: number;
    cacheHitRate?: number | null;
    durationSec?: number;
    shipped?: number;
  };
  tickets: CostTicket[];
  stages: CostStage[];
  budget: { capPerTicket: number | null; tickets: BudgetRow[] };
  prReviews: PrReviewCard[];
  prReviewTotals: { cost: number; tokens: number; count: number };
  regression?: RegressionBlock;
}

export interface PrReviewsState {
  generatedAt: string;
  reviews: PrReviewCard[];
}

/** The existing review a PR-inbox row joins to, when one exists on disk. */
export interface PrInboxReviewLink {
  ref: string;
  result: string | null;
  running: boolean;
  retryable: boolean;
  updatedAt: string | null;
  costUsd: number;
  failure: string | null;
}

export interface PrInboxRow {
  /** prRefId(owner, repo, number) - the same id as a pr-reviews/<ref> directory, which is what
   * makes the join to an existing review a lookup rather than a per-row stat. */
  id: string;
  owner: string;
  repo: string;
  repoSlug: string;
  number: number;
  url: string;
  title: string;
  author: string;
  bucket: 'requested' | 'mine';
  isDraft: boolean;
  state: string | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  updatedAt: string | null;
  createdAt: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  /** null once GitHub no longer lists a pending request, which happens the instant any review
   * is submitted - including a bare comment. Such rows are recovered via myReviewState/stale. */
  requestedVia: { kind: 'user' | 'team'; label: string } | null;
  myReviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | null;
  myReviewAt: string | null;
  headCommittedAt: string | null;
  /** Head commit is newer than my last review. committedDate, not push time, so it is a hint. */
  myReviewStale: boolean;
  /** Whether the PR can land. `mergeable` covers conflicts only; `mergeStateStatus` says why
   * GitHub is refusing (BLOCKED = wants a review, UNSTABLE = a red check, DIRTY = conflicts). */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  mergeStateStatus: string | null;
  checksState: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  /** False means /review-pr hard-stops on this repo, so the action is disabled, not hidden. */
  inManifest: boolean;
  source: 'repo-scan' | 'search' | null;
  fromStaleSnapshot: boolean;
  snapshotAt: string | null;
  review: PrInboxReviewLink | null;
  reviewStatus: 'never' | 'running' | 'failed' | 'done' | 'done-stale';
}

export interface PrInboxRepoStatus {
  slug: string;
  at: string | null;
  ok: boolean;
  error: { kind: string; message: string } | null;
  truncated: boolean;
  openCount: number | null;
}

export interface PrInboxState {
  generatedAt: string;
  /** True until the first sweep lands - render "fetching", never "0 waiting". */
  pending: boolean;
  at: string | null;
  stale: boolean;
  enabled: boolean;
  sweeping: boolean;
  login: string | null;
  loginMismatch: boolean;
  teams: string[];
  error: string | null;
  rateLimit: { remaining: number; resetAt: string } | null;
  capacity: { running: number; max: number };
  repos: PrInboxRepoStatus[];
  search: { at: string | null; ok: boolean; error: { kind: string; message: string } | null } | null;
  rows: PrInboxRow[];
}

export interface RunLog {
  key: string;
  mode: string | null;
  lines: string[];
}

export type RunMode = 'plan' | 'build' | 'replan' | 'review' | 'ship' | 'continue';

export type JsonRecord = Record<string, unknown>;
