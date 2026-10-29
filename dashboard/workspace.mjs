// The code workspace behind #code: list every repo checkout and worktree, read their state,
// run git actions and manifest commands in them, and give each worktree a Claude chat. All
// input is checked against what git or the manifest reported first (scripts/workspace-lib.mjs);
// nothing here takes a free path, a free command or a free git argument.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { execa } from 'execa';

import { question as chatQuestion, thread as chatThread, ID_RE as CHAT_ID_RE, historyForRun } from '../scripts/chat-lib.mjs';
import {
  allowedActions, branchAdvice, manifestCommands, maskSecrets, ownerOf, secretsAdded, parseLog, parseStatus, parseWorktreeList, pickFiles,
  validBranch, validMessage, worktreeDirFor,
} from '../scripts/workspace-lib.mjs';

const STATUS_TTL_MS = 20_000;
const MAX_RUNS = 6;
const RUN_LINES = 2000;
const FILE_MAX = 400_000;

export function createWorkspace({ workspace, root, manifest, broadcast, scheduleStateBroadcast, ghEnv, secrets, spawnClaudeRun, prForBranch, prByNumber }) {
  const WT = join(workspace, '.wt');
  const CHATS = join(root, 'workspace');
  const statusCache = new Map(); // id -> { at, status, last }
  const refreshing = new Set();
  const runs = new Map(); // runId -> run
  const runningChats = new Map();
  let listCache = { at: 0, items: [] };
  const defaultBases = new Map(); // repo -> its origin/HEAD branch

  async function defaultBase(repoId) {
    if (!defaultBases.has(repoId)) {
      const r = await git(join(workspace, repoId), ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      defaultBases.set(repoId, r.exitCode === 0 ? String(r.stdout).trim().replace(/^origin\//, '') : 'dev');
    }
    return defaultBases.get(repoId);
  }

  const repos = () => {
    const m = manifest();
    const list = Array.isArray(m?.repos) ? m.repos : Object.values(m?.repos || {});
    return list.filter((r) => r?.id && existsSync(join(workspace, r.id, '.git')));
  };
  // Read-only by the repo's own policy only (README safety rules: the legacy app and the reference
  // repo are never modified) - never by a note that merely mentions another repo.
  const readOnlyRepo = (r) => r.id === 'erp-next-fe' || r.id === 'acme-resources-main' || /never (be )?modif|read-only/i.test(String(r.policy || ''));

  const git = (cwd, args, opts = {}) => execa('git', args, { cwd, reject: false, timeout: opts.timeout ?? 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) }, ...opts.execa });

  // ---- listing ----

  async function listAll(force = false) {
    if (!force && Date.now() - listCache.at < 10_000) return listCache.items;
    const items = [];
    for (const r of repos()) {
      const res = await git(join(workspace, r.id), ['worktree', 'list', '--porcelain']);
      for (const w of parseWorktreeList(res.stdout)) {
        const rel = relative(workspace, w.path);
        if (rel.startsWith('..') || w.bare) continue; // only checkouts inside the workspace
        const isPrimary = rel === r.id;
        items.push({
          id: rel,
          repo: r.id,
          path: w.path,
          isPrimary,
          readOnly: readOnlyRepo(r),
          dir: basename(w.path),
          owner: isPrimary ? { kind: 'repo', id: r.id, repo: r.id } : ownerOf(basename(w.path)),
          branch: w.branch,
          detached: w.detached,
          locked: w.locked,
          prunable: w.prunable,
        });
      }
    }
    listCache = { at: Date.now(), items };
    return items;
  }

  const byId = async (id) => (await listAll()).find((w) => w.id === id) || (await listAll(true)).find((w) => w.id === id) || null;

  async function readStatus(w) {
    const [st, last] = await Promise.all([
      git(w.path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      git(w.path, ['log', '-1', '--format=%cI%x1f%s']),
    ]);
    if (st.exitCode !== 0) return { error: (st.stderr || 'git status failed').split('\n')[0] };
    const [at, subject] = String(last.stdout || '').split('\x1f');
    return { ...parseStatus(st.stdout), lastCommitAt: at || null, lastCommit: subject || null };
  }

  /** Refresh stale statuses in the background, four at a time, then nudge the panel. */
  function refreshStale(items) {
    const stale = items.filter((w) => !refreshing.has(w.id) && Date.now() - (statusCache.get(w.id)?.at || 0) > STATUS_TTL_MS);
    if (!stale.length) return;
    stale.forEach((w) => refreshing.add(w.id));
    let i = 0;
    const worker = async () => {
      while (i < stale.length) {
        const w = stale[i++];
        try { statusCache.set(w.id, { at: Date.now(), status: await readStatus(w) }); } catch { /* next pass */ }
        refreshing.delete(w.id);
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]).then(() => scheduleStateBroadcast());
  }

  function summary(w) {
    const st = statusCache.get(w.id)?.status || null;
    const dirty = st?.files ? st.files.length : null;
    return {
      ...w,
      status: st ? {
        branch: st.branch ?? w.branch, upstream: st.upstream || null, ahead: st.ahead || 0, behind: st.behind || 0,
        changed: dirty, lastCommitAt: st.lastCommitAt, lastCommit: st.lastCommit, error: st.error || null,
      } : null,
      // A PR-review worktree belongs to its PR by number (it is often detached); others by branch.
      pr: (w.owner.kind === 'pr' ? prByNumber(w.repo, w.owner.id) : null) || prForBranch(w.repo, st?.branch ?? w.branch),
      runs: [...runs.values()].filter((r) => r.wt === w.id && r.status === 'running').map((r) => r.cmdId),
      chatting: [...runningChats.keys()].some((k) => k.startsWith(`wtchat:${slugOf(w)}:`)),
    };
  }

  async function list() {
    const items = await listAll();
    refreshStale(items);
    return {
      repos: await Promise.all(repos().map(async (r) => ({ id: r.id, readOnly: readOnlyRepo(r), layer: r.layer || null, purpose: r.purpose || null, defaultBase: await defaultBase(r.id) }))),
      worktrees: items.map(summary),
      runs: runCards(),
      capacity: { runs: [...runs.values()].filter((r) => r.status === 'running').length, maxRuns: MAX_RUNS },
    };
  }

  /** The manifest's commands, plus "install" when the manifest has none and the checkout has a
   * lockfile - a fresh worktree needs it before anything else runs. */
  function commandsFor(w) {
    const list = manifestCommands(repos().find((r) => r.id === w.repo));
    if (!list.some((c) => c.id === 'install')) {
      const cmd = existsSync(join(w.path, 'yarn.lock')) ? 'yarn install' : existsSync(join(w.path, 'package-lock.json')) ? 'npm ci' : null;
      if (cmd) list.unshift({ id: 'install', label: 'install', cmd, note: 'from the lockfile', longRunning: false });
    }
    return list;
  }

  // ---- detail ----

  async function detail(id) {
    const w = await byId(id);
    if (!w) return null;
    const st = await readStatus(w);
    statusCache.set(w.id, { at: Date.now(), status: st });
    const [log, numstat] = await Promise.all([
      git(w.path, ['log', '-n', '20', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s']),
      git(w.path, ['diff', 'HEAD', '--numstat']),
    ]);
    const counts = new Map(String(numstat.stdout || '').split('\n').filter(Boolean).map((l) => { const [a, d, p] = l.split('\t'); return [p, { add: Number(a) || 0, del: Number(d) || 0 }]; }));
    const dirty = (st.files || []).length > 0;
    return {
      ...summary(w),
      status: st,
      files: (st.files || []).map((f) => ({ ...f, ...(counts.get(f.path) || {}) })),
      log: parseLog(log.stdout),
      commands: w.readOnly ? [] : commandsFor(w),
      actions: allowedActions({ isPrimary: w.isPrimary, readOnlyRepo: w.readOnly, dirty, ahead: st.ahead || 0, hasUpstream: !!st.upstream, branch: st.branch }),
      runHistory: runCards().filter((r) => r.wt === w.id),
    };
  }

  async function diff(id, path) {
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    const st = await readStatus(w);
    const f = (st.files || []).find((x) => x.path === path);
    if (!f) return { code: 404, error: 'that file has no changes here' };
    const res = f.kind === 'untracked'
      ? await git(w.path, ['diff', '--no-index', '--', '/dev/null', path])
      : await git(w.path, ['diff', 'HEAD', '-M', '--', ...(f.from ? [f.from] : []), path]);
    const text = maskSecrets(String(res.stdout || ''));
    return { path, kind: f.kind, diff: text.length > FILE_MAX ? `${text.slice(0, FILE_MAX)}\n… (cut: the diff is over ${FILE_MAX / 1000} KB)` : text };
  }

  async function files(id, q) {
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    const res = await git(w.path, ['ls-files', '--cached', '--others', '--exclude-standard'], { timeout: 20_000 });
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = String(res.stdout || '').split('\n').filter(Boolean);
    const hits = all.filter((p) => words.every((x) => p.toLowerCase().includes(x)));
    return { total: all.length, files: hits.slice(0, 300), more: Math.max(0, hits.length - 300) };
  }

  async function fileContent(id, path) {
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    const listed = await git(w.path, ['ls-files', '--cached', '--others', '--exclude-standard', '--', path]);
    if (!String(listed.stdout || '').split('\n').includes(path)) return { code: 404, error: 'not a file in this checkout' };
    const full = normalize(resolve(w.path, path));
    if (!full.startsWith(w.path + sep)) return { code: 400, error: 'outside the checkout' };
    const size = statSync(full).size;
    if (size > FILE_MAX) return { path, size, content: null, tooBig: true };
    const buf = readFileSync(full);
    if (buf.includes(0)) return { path, size, content: null, binary: true };
    return { path, size, content: maskSecrets(buf.toString('utf8')) };
  }

  // ---- git actions ----

  async function action(id, body) {
    const a = String(body?.action || '');
    if (a === 'new-worktree') return newWorktree(body);
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    const st = await readStatus(w);
    const dirty = (st.files || []).length > 0;
    const allowed = allowedActions({ isPrimary: w.isPrimary, readOnlyRepo: w.readOnly, dirty, ahead: st.ahead || 0, hasUpstream: !!st.upstream, branch: st.branch });
    const key = { 'fetch': 'fetch', pull: 'pull', commit: 'commit', discard: 'discard', push: 'push', pr: 'pr', remove: 'remove' }[a];
    if (!key) return { code: 400, error: `unknown action ${a}` };
    if (!allowed[key]) return { code: 409, error: refusal(a, w, st, dirty) };
    const done = (res, ok) => {
      statusCache.delete(w.id); listCache.at = 0; scheduleStateBroadcast();
      const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
      return res.exitCode === 0 ? { ok: true, message: ok, output: out.slice(-4000) } : { code: 502, error: out.split('\n').slice(-6).join('\n') || `${a} failed` };
    };
    if (a === 'fetch') return done(await git(w.path, ['fetch', '--prune'], { timeout: 90_000 }), 'Fetched.');
    if (a === 'pull') return done(await git(w.path, ['pull', '--ff-only'], { timeout: 90_000 }), 'Up to date with its upstream.');
    if (a === 'push') return done(await git(w.path, ['push', '-u', 'origin', 'HEAD'], { timeout: 120_000 }), `Pushed ${st.branch}.`);
    if (a === 'commit') {
      const picked = pickFiles(body.files, st);
      if (picked.error) return { code: 400, error: picked.error };
      const msgErr = validMessage(body.message);
      if (msgErr) return { code: 400, error: msgErr };
      // Never commit a credential: check exactly what would be added, untracked files included.
      const kinds = new Map(st.files.map((f) => [f.path, f.kind]));
      const tracked = picked.files.filter((p) => kinds.get(p) !== 'untracked');
      let added = tracked.length ? String((await git(w.path, ['diff', 'HEAD', '--', ...tracked])).stdout || '') : '';
      for (const p of picked.files.filter((x) => kinds.get(x) === 'untracked')) added += `\n${String((await git(w.path, ['diff', '--no-index', '--', '/dev/null', p])).stdout || '')}`;
      const leaks = secretsAdded(added);
      if (leaks.length) return { code: 422, error: `Not committed: ${leaks.length} added line(s) look like a credential (${leaks[0].hint}). Use an environment variable such as \${NPM_TOKEN} instead.` };
      const add = await git(w.path, ['add', '-A', '--', ...picked.files]);
      if (add.exitCode !== 0) return { code: 502, error: add.stderr || 'git add failed' };
      return done(await git(w.path, ['commit', '-m', String(body.message).trim(), '--', ...picked.files], { timeout: 180_000 }), `Committed ${picked.files.length} file(s).`);
    }
    if (a === 'discard') {
      const picked = pickFiles(body.files, st);
      if (picked.error) return { code: 400, error: picked.error };
      const kinds = new Map(st.files.map((f) => [f.path, f.kind]));
      const untracked = picked.files.filter((p) => kinds.get(p) === 'untracked');
      const tracked = picked.files.filter((p) => kinds.get(p) !== 'untracked');
      if (tracked.length) { const r = await git(w.path, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]); if (r.exitCode !== 0) return done(r); }
      if (untracked.length) { const r = await git(w.path, ['clean', '-f', '--', ...untracked]); if (r.exitCode !== 0) return done(r); }
      return done({ exitCode: 0, stdout: '', stderr: '' }, `Discarded changes in ${picked.files.length} file(s).`);
    }
    if (a === 'pr') {
      const base = String(body.base || 'dev');
      if (validBranch(base)) return { code: 400, error: 'invalid base branch' };
      const args = ['pr', 'create', '--head', st.branch, '--base', base, ...(body.title ? ['--title', String(body.title).slice(0, 250), '--body', String(body.body || '').slice(0, 60_000)] : ['--fill']), ...(body.draft ? ['--draft'] : [])];
      const res = await execa('gh', args, { cwd: w.path, reject: false, timeout: 60_000, env: ghEnv(), extendEnv: false });
      return done(res, (String(res.stdout || '').match(/https:\/\/\S+/) || ['PR opened.'])[0]);
    }
    if (a === 'remove') {
      if (w.isPrimary) return { code: 409, error: 'the main checkout cannot be removed' };
      if ([...runs.values()].some((r) => r.wt === w.id && r.status === 'running')) return { code: 409, error: 'stop its running commands first' };
      return done(await git(join(workspace, w.repo), ['worktree', 'remove', w.path]), `Removed ${w.dir}. The branch is kept.`);
    }
    return { code: 400, error: 'unknown action' };
  }

  function refusal(a, w, st, dirty) {
    if (w.readOnly) return `${w.repo} is read-only - Millwright never modifies it.`;
    if (w.isPrimary && ['commit', 'discard', 'push', 'pr', 'remove'].includes(a)) return 'The main checkout is view-only here. Create a worktree for the branch you want to work on.';
    if (a === 'pull' && dirty) return 'Commit or discard the changes first - pull only fast-forwards a clean tree.';
    if (a === 'pull') return 'This branch has no upstream to pull from yet. Push it first.';
    if (a === 'commit' || a === 'discard') return 'There is nothing changed to commit or discard.';
    if (a === 'push') return st.branch ? 'Nothing new to push.' : 'This worktree is not on a branch (detached HEAD).';
    if (a === 'pr') return !st.upstream ? 'Push the branch first.' : 'Push your latest commits first.';
    if (a === 'remove') return 'It has uncommitted changes - commit or discard them first.';
    return 'Not allowed here.';
  }

  async function newWorktree(body) {
    const repo = repos().find((r) => r.id === body.repo);
    if (!repo) return { code: 400, error: 'unknown repo' };
    if (readOnlyRepo(repo)) return { code: 409, error: `${repo.id} is read-only - Millwright never modifies it.` };
    const branch = String(body.branch || '').trim();
    const bad = validBranch(branch);
    if (bad) return { code: 400, error: bad };
    const base = String(body.base || '').trim() || await defaultBase(repo.id);
    if (validBranch(base)) return { code: 400, error: 'invalid base branch' };
    const dir = join(WT, worktreeDirFor(repo.id, branch));
    if (existsSync(dir)) return { code: 409, error: `${relative(workspace, dir)} already exists` };
    const cwd = join(workspace, repo.id);
    const fetch = await git(cwd, ['fetch', 'origin', '--prune'], { timeout: 120_000 });
    if (fetch.exitCode !== 0) return { code: 502, error: `could not fetch: ${(fetch.stderr || '').split('\n')[0]}` };
    const local = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0;
    const remote = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).exitCode === 0;
    if (!local && !remote && (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])).exitCode !== 0) {
      return { code: 400, error: `origin/${base} does not exist in ${repo.id}. Its default branch is ${await defaultBase(repo.id)}.` };
    }
    mkdirSync(WT, { recursive: true });
    // An existing branch is checked out as it is; a new one starts from origin/<base> with no
    // upstream, so "ahead" means ahead of nothing until its first push sets one.
    const args = local ? ['worktree', 'add', dir, branch]
      : remote ? ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`]
      : ['worktree', 'add', '--no-track', '-b', branch, dir, `origin/${base}`];
    const res = await git(cwd, args, { timeout: 120_000 });
    listCache.at = 0; scheduleStateBroadcast();
    if (res.exitCode !== 0) return { code: 502, error: (res.stderr || 'git worktree add failed').split('\n').slice(-4).join('\n') };
    return { ok: true, id: relative(workspace, dir), message: local ? `Checked out ${branch}.` : remote ? `Tracking origin/${branch}.` : `New branch ${branch} from origin/${base}.`, advice: branchAdvice(branch) };
  }

  // ---- running manifest commands ----

  function runCards() {
    return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 40).map((r) => ({
      runId: r.runId, wt: r.wt, cmdId: r.cmdId, cmd: r.cmd, status: r.status, code: r.code, startedAt: r.startedAt, endedAt: r.endedAt,
      tail: r.lines.slice(-3),
    }));
  }

  async function runStart(id, cmdId) {
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    if (w.readOnly) return { code: 409, error: `${w.repo} is read-only.` };
    const c = commandsFor(w).find((x) => x.id === cmdId);
    if (!c) return { code: 400, error: `${cmdId} is not a command in repo-manifest.json for ${w.repo}` };
    if ([...runs.values()].some((r) => r.wt === w.id && r.cmdId === cmdId && r.status === 'running')) return { code: 409, error: `${cmdId} is already running here` };
    if ([...runs.values()].filter((r) => r.status === 'running').length >= MAX_RUNS) return { code: 429, error: `${MAX_RUNS} commands are already running - stop one first` };
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const child = execa(c.cmd, { shell: true, cwd: w.path, reject: false, buffer: false, detached: true, stdin: 'ignore', env: { ...process.env, ...secrets(), FORCE_COLOR: '0', CI: c.longRunning ? undefined : '1' } });
    const run = { runId, wt: w.id, cmdId, cmd: c.cmd, status: 'running', code: null, startedAt: new Date().toISOString(), endedAt: null, lines: [], child };
    runs.set(runId, run);
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        run.lines.push(maskSecrets(line));
        if (run.lines.length > RUN_LINES) run.lines.splice(0, run.lines.length - RUN_LINES);
        broadcast('log', { key: `cmd:${runId}`, mode: 'cmd', line: maskSecrets(line) });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.then((res) => {
      run.status = run.status === 'stopping' ? 'stopped' : res.exitCode === 0 ? 'passed' : 'failed';
      run.code = res.exitCode ?? null;
      run.endedAt = new Date().toISOString();
      run.child = null;
      statusCache.delete(w.id);
      scheduleStateBroadcast();
    });
    scheduleStateBroadcast();
    return { ok: true, runId };
  }

  function runStop(runId) {
    const r = runs.get(runId);
    if (!r || !r.child) return { code: 404, error: 'that command is not running' };
    r.status = 'stopping';
    try { process.kill(-r.child.pid, 'SIGTERM'); } catch { try { r.child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { if (r.child) { try { process.kill(-r.child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 5000).unref();
    return { ok: true };
  }

  const runLog = (runId) => { const r = runs.get(runId); return r ? { runId, status: r.status, code: r.code, lines: r.lines } : null; };

  function stopAll() { for (const r of runs.values()) if (r.child) { try { process.kill(-r.child.pid, 'SIGTERM'); } catch { /* gone */ } } }

  // ---- Claude per worktree ----

  const slugOf = (w) => w.id.replace(/[\\/]/g, '__');
  const chatDir = (w) => join(CHATS, slugOf(w), 'chat');

  async function chatAsk(id, text) {
    const w = await byId(id);
    if (!w) return { code: 404, error: 'no such checkout' };
    if (runningChats.size >= 2) return { code: 429, error: 'two questions are already being answered - wait for one' };
    let q;
    try { q = chatQuestion(text); } catch (e) { return { code: 400, error: e.message }; }
    const dir = chatDir(w);
    mkdirSync(dir, { recursive: true });
    const slug = slugOf(w);
    const editable = !w.isPrimary && !w.readOnly;
    writeFileSync(join(dir, '..', 'target.json'), JSON.stringify({ id: w.id, path: w.path, repo: w.repo, branch: statusCache.get(w.id)?.status?.branch || w.branch, editable }, null, 2) + '\n');
    writeFileSync(join(dir, `${q.id}.q.json`), JSON.stringify(q, null, 2) + '\n');
    writeFileSync(join(dir, `${q.id}.context.json`), JSON.stringify({ history: historyForRun(chatEntries(dir)) }, null, 2) + '\n');
    spawnClaudeRun({
      id: `wtchat:${slug}:${q.id}`, mode: 'chat', dir, logName: `${q.id}.log`, prompt: `/worktree-chat ${slug} ${q.id}`,
      registry: runningChats, model: 'sonnet',
      onFinish: (result, code, outcome) => {
        statusCache.delete(w.id);
        if (!existsSync(join(dir, `${q.id}.a.json`))) {
          writeFileSync(join(dir, `${q.id}.fail.json`), JSON.stringify({ failure: outcome?.failure || 'the run finished without an answer' }, null, 2) + '\n');
        }
        scheduleStateBroadcast();
      },
    });
    return { ok: true, id: q.id };
  }

  function chatEntries(dir) {
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    const ids = [...new Set(names.map((n) => n.split('.')[0]).filter((x) => CHAT_ID_RE.test(x)))];
    const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
    return ids.map((x) => ({ id: x, q: read(join(dir, `${x}.q.json`)), a: read(join(dir, `${x}.a.json`)), failed: read(join(dir, `${x}.fail.json`))?.failure || null }));
  }

  async function chatThreadFor(id) {
    const w = await byId(id);
    if (!w) return null;
    const dir = chatDir(w);
    return { messages: chatThread(chatEntries(dir)).map((m) => ({ ...m, running: runningChats.has(`wtchat:${slugOf(w)}:${m.id}`) })), editable: !w.isPrimary && !w.readOnly };
  }

  return { list, detail, diff, files, fileContent, action, runStart, runStop, runLog, stopAll, chatAsk, chatThreadFor };
}
