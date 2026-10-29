// The code workspace: every repo checkout and worktree, what state git says it is in, which
// manifest commands it can run, and the checks every git action passes before it touches
// anything. Pure - dashboard/server.mjs does the git and process I/O.

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** `git worktree list --porcelain` -> [{path, head, branch, detached, bare, locked, prunable}]. */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) out.push(cur); cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

const KIND = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict' };

/** `git status --porcelain=v2 --branch -z` -> branch info and changed files. */
export function parseStatus(text) {
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [] };
  const parts = String(text ?? '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# branch.head ')) st.branch = p.slice(14) === '(detached)' ? null : p.slice(14);
    else if (p.startsWith('# branch.oid ')) st.head = p.slice(13);
    else if (p.startsWith('# branch.upstream ')) st.upstream = p.slice(18);
    else if (p.startsWith('# branch.ab ')) { const m = p.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]); } }
    else if (p[0] === '1') {
      const f = p.split(' ');
      st.files.push(file(f[1], f.slice(8).join(' ')));
    } else if (p[0] === '2') {
      const f = p.split(' ');
      const entry = file(f[1], f.slice(9).join(' '));
      entry.from = parts[i + 1];
      i += 1;
      st.files.push(entry);
    } else if (p[0] === 'u') {
      const f = p.split(' ');
      st.files.push({ path: f.slice(10).join(' '), staged: false, unstaged: true, kind: 'conflict' });
    } else if (p[0] === '?') st.files.push({ path: p.slice(2), staged: false, unstaged: true, kind: 'untracked' });
  }
  return st;
}

function file(xy, path) {
  const [x, y] = xy.split('');
  return { path, staged: x !== '.', unstaged: y !== '.', kind: KIND[x !== '.' ? x : y] || 'modified' };
}

/** `git log --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s -n N` -> commits. */
export function parseLog(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((l) => {
    const [sha, short, author, at, subject] = l.split('\x1f');
    return { sha, short, author, at, subject };
  });
}

/** Who a worktree folder belongs to, from the names Millwright gives them. */
export function ownerOf(dirName) {
  const t = dirName.match(/^(PROJ-\d+)-(.+)$/);
  if (t) return { kind: 'ticket', id: t[1], repo: t[2] };
  const p = dirName.match(/^pr-(.+)-(\d+)$/);
  if (p) return { kind: 'pr', id: p[2], repo: p[1] };
  const b = dirName.match(/^br-([a-z0-9-]+?)--(.+)$/);
  if (b) return { kind: 'branch', id: b[2], repo: b[1] };
  return { kind: 'other', id: dirName, repo: null };
}

/** The commands a repo's manifest entry lists, as runnable shell text. Manifest strings carry
 * notes in brackets after two spaces ("yarn install  (requires NODE_AUTH_TOKEN)"); those are
 * dropped. Nested groups (perKit, perPackage) become dotted ids. Only these ever run. */
export function manifestCommands(entry) {
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const id = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        const cmd = v.split(/\s{2,}\(/)[0].trim();
        if (/^(yarn|npm|npx|pnpm|node|pytest|uvicorn|pip|python3?|make|lerna|tsx|NODE_ENV=\S+ \S+)(\s|$)/.test(cmd) && !/[;&|`$<>]/.test(cmd.replace(/^NODE_ENV=\S+ /, ''))) {
          out.push({ id, label: id.replace(/\./g, ' · '), cmd, note: v.length > cmd.length ? v.slice(cmd.length).trim().replace(/^\(|\)$/g, '') : null, longRunning: /(^|\.)(dev|run|storybook|start|watch)/i.test(id) || /dev(:watch)?\b|storybook|uvicorn|--watch/.test(cmd) });
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, id);
    }
  };
  walk(entry?.commands, '');
  return out;
}

// ---- checks every action passes ----

/** git's own ref rules, minus anything that could read as an option or a path trick. */
export function validBranch(name) {
  const n = str(name);
  if (!n || n.length > 120) return 'Give the branch a name.';
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock')) return 'That is not a valid branch name.';
  if (/\.\.|@\{|\/\/|[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return 'That is not a valid branch name.';
  return null;
}

/** The team's convention, as advice: {type}/PROJ-{n}-{short-desc}. */
export function branchAdvice(name) {
  return /^(feat|fix|chore|refactor|docs|test|perf|style|ci|build)\/PROJ-\d+-[a-z0-9-]+$/.test(str(name))
    ? null : 'The convention is type/PROJ-1234-short-description, e.g. fix/PROJ-2996-tag-iconleft-control.';
}

export function validMessage(msg) {
  const m = String(msg ?? '').trim();
  if (!m) return 'Write a commit message.';
  if (m.length > 5000) return 'Keep the commit message under 5000 characters.';
  return null;
}

/** Files an action names must be ones git reported for this worktree - never a free path. */
export function pickFiles(requested, status) {
  const known = new Set(status.files.map((f) => f.path));
  const list = (Array.isArray(requested) ? requested : []).map(String);
  const unknown = list.filter((p) => !known.has(p));
  if (!list.length) return { error: 'Pick at least one file.' };
  if (unknown.length) return { error: `Not a changed file here: ${unknown.slice(0, 3).join(', ')}` };
  return { files: list };
}

/** A worktree folder name for a branch: br-<repo>--<branch with / as ->. */
export function worktreeDirFor(repo, branch) {
  return `br-${repo}--${str(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}`;
}

/** Which actions a checkout allows. Primary checkouts are read-only here (branch work happens in
 * worktrees, so nothing switches under an open editor); repos the manifest marks as never-modify
 * are read-only everywhere. */
export function allowedActions({ isPrimary, readOnlyRepo, dirty, ahead, hasUpstream, branch }) {
  if (readOnlyRepo) return { fetch: true };
  if (isPrimary) return { fetch: true, pull: !dirty, newWorktree: true };
  return {
    fetch: true,
    pull: !dirty && hasUpstream,
    commit: dirty,
    discard: dirty,
    push: !!branch && (ahead > 0 || !hasUpstream),
    pr: !!branch && hasUpstream && ahead === 0,
    remove: !dirty,
    run: true,
    chat: true,
  };
}

// ---- secrets ----

// Shapes of credentials that must never be shown in the panel or committed: GitHub, npm, Slack,
// AWS, Atlassian and generic bearer-ish tokens, private keys, and `token/secret/password = "..."`.
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bATATT[A-Za-z0-9_\-=]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /((?:token|secret|password|passwd|api[_-]?key|authToken)["']?\s*[:=]\s*["']?)(?!\$\{)([A-Za-z0-9_\-./+=]{16,})/gi,
];

/** Replace anything that looks like a credential with a marker. Environment references like
 * "${NPM_TOKEN}" are left alone - they are the safe way to write it. */
export function maskSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, a, b) => (typeof b === 'string' && typeof a === 'string' && re.source.startsWith('((?:token') ? `${a}•••• (hidden)` : `${m.slice(0, 4)}•••• (hidden)`));
  }
  return out;
}

/** Added lines of a unified diff that carry a credential, as {line, hint}. */
export function secretsAdded(diff) {
  const hits = [];
  String(diff ?? '').split('\n').forEach((l, i) => {
    if (!l.startsWith('+') || l.startsWith('+++')) return;
    if (maskSecrets(l) !== l) hits.push({ line: i + 1, hint: maskSecrets(l.slice(1)).trim().slice(0, 120) });
  });
  return hits;
}
