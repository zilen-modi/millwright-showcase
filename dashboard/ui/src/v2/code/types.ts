export interface Checkout {
  id: string;
  repo: string;
  path: string;
  isPrimary: boolean;
  readOnly: boolean;
  dir: string;
  owner: { kind: 'repo' | 'ticket' | 'pr' | 'branch' | 'other'; id: string; repo: string | null };
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  status: {
    branch: string | null; upstream: string | null; ahead: number; behind: number; changed: number | null;
    lastCommitAt: string | null; lastCommit: string | null; error: string | null;
  } | null;
  pr: { number: number; url: string; title: string; state: string | null; mergedAt?: string | null; bucket?: string; reviewDecision?: string | null; checksState?: string | null } | null;
  runs: string[];
  chatting: boolean;
}

export interface RunCard {
  runId: string; wt: string; cmdId: string; cmd: string;
  status: 'running' | 'stopping' | 'stopped' | 'passed' | 'failed';
  code: number | null; startedAt: string; endedAt: string | null; tail: string[];
}

export interface WorkspaceState {
  repos: { id: string; readOnly: boolean; layer: string | null; purpose: string | null; defaultBase: string }[];
  worktrees: Checkout[];
  runs: RunCard[];
  capacity: { runs: number; maxRuns: number };
}

export interface ChangedFile { path: string; staged: boolean; unstaged: boolean; kind: string; from?: string; add?: number; del?: number }

export interface CheckoutDetail extends Omit<Checkout, 'status'> {
  status: { branch: string | null; upstream: string | null; ahead: number; behind: number; head: string | null; lastCommitAt: string | null; lastCommit: string | null; error?: string };
  files: ChangedFile[];
  log: { sha: string; short: string; author: string; at: string; subject: string }[];
  commands: { id: string; label: string; cmd: string; note: string | null; longRunning: boolean }[];
  actions: Partial<Record<'fetch' | 'pull' | 'commit' | 'discard' | 'push' | 'pr' | 'remove' | 'run' | 'chat' | 'newWorktree', boolean>>;
  runHistory: RunCard[];
}
