import { ChevronDown, ChevronRight, FolderGit2, GitBranch, GitPullRequest, Lock, MessageCircle, Play, Plus, Search } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { useResource } from '@/hooks/useResource';
import { postJson } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Chip, Menu, MenuItem } from '../Menu';
import { ago } from '../rows';
import { useThread } from '../useListQuery';
import type { Checkout, WorkspaceState } from './types';

const KINDS = [
  { id: 'all', label: 'All' }, { id: 'changed', label: 'Has changes' }, { id: 'ahead', label: 'Not pushed' },
  { id: 'behind', label: 'Behind' }, { id: 'running', label: 'Running' }, { id: 'pr', label: 'Has PR' },
] as const;
const OWNERS = [
  { id: 'all', label: 'Everything' }, { id: 'repo', label: 'Main checkouts' }, { id: 'ticket', label: 'Ticket worktrees' },
  { id: 'pr', label: 'PR review worktrees' }, { id: 'branch', label: 'My branches' },
] as const;
const SORTS = [{ id: 'recent', label: 'Last commit' }, { id: 'changed', label: 'Most changes' }, { id: 'name', label: 'Name' }] as const;

export function useWorkspace() {
  return useResource<WorkspaceState>(async (signal) => {
    const r = await fetch('/api/workspace', { signal });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  });
}

const label = (w: Checkout) => (w.isPrimary ? 'main checkout' : w.owner.kind === 'ticket' ? w.owner.id : w.owner.kind === 'pr' ? `PR #${w.owner.id}` : w.dir);

/**
 * #code: every repo's main checkout and every worktree under .wt, with what git says about each.
 * Click one to work on it in the thread; "New worktree" starts a branch without an IDE.
 */
export function CodeChannel() {
  const { data, error, refresh } = useWorkspace();
  const { thread, open } = useThread();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('all');
  const [owner, setOwner] = useState<(typeof OWNERS)[number]['id']>('all');
  const [repo, setRepo] = useState('all');
  const [sort, setSort] = useState<(typeof SORTS)[number]['id']>('recent');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  // Worktrees of merged or closed PRs are finished work; main checkouts always stay listed.
  const finished = (w: Checkout) => !w.isPrimary && (w.pr?.state === 'MERGED' || w.pr?.state === 'CLOSED');
  const finishedCount = (data?.worktrees || []).filter(finished).length;

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (data?.worktrees || []).filter((w) => {
      if (!showFinished && finished(w)) return false;
      const s = w.status;
      if (repo !== 'all' && w.repo !== repo) return false;
      if (owner !== 'all' && (owner === 'repo' ? !w.isPrimary : w.owner.kind !== owner || w.isPrimary)) return false;
      if (kind === 'changed' && !(s?.changed)) return false;
      if (kind === 'ahead' && !(s?.ahead)) return false;
      if (kind === 'behind' && !(s?.behind)) return false;
      if (kind === 'running' && !w.runs.length) return false;
      if (kind === 'pr' && !w.pr) return false;
      const hay = `${w.repo} ${w.dir} ${s?.branch || w.branch || ''} ${w.owner.id} ${s?.lastCommit || ''} ${w.pr?.title || ''}`.toLowerCase();
      return words.every((x) => hay.includes(x));
    });
    const val = (w: Checkout) => (sort === 'name' ? w.dir : sort === 'changed' ? -(w.status?.changed || 0) : -(Date.parse(w.status?.lastCommitAt || '') || 0));
    rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (sort === 'name' ? String(val(a)).localeCompare(String(val(b))) : (val(a) as number) - (val(b) as number)));
    const byRepo = new Map<string, Checkout[]>();
    for (const r of data?.repos || []) byRepo.set(r.id, []);
    for (const w of rows) byRepo.get(w.repo)?.push(w);
    return [...byRepo.entries()].filter(([, ws]) => ws.length);
  }, [data, q, kind, owner, repo, sort, showFinished]);

  const running = (data?.runs || []).filter((r) => r.status === 'running' || r.status === 'stopping');
  const shown = groups.reduce((n, [, ws]) => n + ws.length, 0);
  const pending = (data?.worktrees || []).filter((w) => !w.status).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[5px] focus-within:border-accent">
            <Search size={14} aria-hidden className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by repo, branch, ticket, commit" aria-label="Filter checkouts" data-list-search className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-fg outline-none placeholder:text-muted" />
          </label>
          <Menu label="Filter by repo" trigger={() => <Chip active={repo !== 'all'}>{repo === 'all' ? 'Repo' : repo.replace(/^erp-next-/, '')}<ChevronDown size={12} aria-hidden /></Chip>}>
            {(close) => [{ id: 'all' }, ...(data?.repos || [])].map((r) => (
              <MenuItem key={r.id} checked={repo === r.id} onSelect={() => { setRepo(r.id); close(); }}>{r.id === 'all' ? 'All repos' : r.id}</MenuItem>
            ))}
          </Menu>
          <Menu label="Filter by kind of checkout" trigger={() => <Chip active={owner !== 'all'}>{OWNERS.find((o) => o.id === owner)!.label}<ChevronDown size={12} aria-hidden /></Chip>}>
            {(close) => OWNERS.map((o) => <MenuItem key={o.id} checked={owner === o.id} onSelect={() => { setOwner(o.id); close(); }}>{o.label}</MenuItem>)}
          </Menu>
          <span className="flex-1" />
          <Menu label="Sort" align="right" trigger={() => <Chip>{SORTS.find((s) => s.id === sort)!.label}</Chip>}>
            {(close) => SORTS.map((s) => <MenuItem key={s.id} checked={sort === s.id} onSelect={() => { setSort(s.id); close(); }}>{s.label}</MenuItem>)}
          </Menu>
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus size={13} aria-hidden />New worktree</Button>
        </div>
        <div role="group" aria-label="State" className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} className="cursor-pointer border-0 bg-transparent p-0">
              <Chip active={kind === k.id}>{k.label}</Chip>
            </button>
          ))}
          {finishedCount ? (
            <button type="button" aria-pressed={showFinished} onClick={() => setShowFinished((v) => !v)} className="cursor-pointer border-0 bg-transparent p-0">
              <Chip active={showFinished}>{showFinished ? 'Hide' : 'Show'} merged PRs ({finishedCount})</Chip>
            </button>
          ) : null}
          <span className="ml-auto self-center text-[12px] text-muted">{shown} checkout{shown === 1 ? '' : 's'}{pending ? ` · reading ${pending}…` : ''}</span>
        </div>
      </div>

      {running.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-2 px-4 py-2">
          <span className="text-[12px] font-semibold text-fg-2">Running</span>
          {running.map((r) => (
            <button key={r.runId} type="button" onClick={() => open({ kind: 'worktree', id: r.wt })} className="cursor-pointer border-0 bg-transparent p-0">
              <Chip><Spinner className="h-2.5 w-2.5 border" />{r.cmdId} · {r.wt.split('/').pop()}</Chip>
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-4 text-[13px] text-critical">Could not read the workspace: {error}</p> : null}
        {!data ? <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" />Reading every checkout…</p>
          : !shown ? <p className="p-6 text-center text-[13px] text-muted">Nothing matches these filters.</p>
          : groups.map(([repoId, ws]) => (
            <section key={repoId} aria-label={repoId}>
              <button type="button" onClick={() => setCollapsed((c) => ({ ...c, [repoId]: !c[repoId] }))} aria-expanded={!collapsed[repoId]}
                className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 border-0 border-b border-border bg-page/95 px-4 py-1.5 text-left text-[11.5px] font-semibold text-fg-2 backdrop-blur">
                {collapsed[repoId] ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
                <FolderGit2 size={13} aria-hidden />{repoId}<span className="font-normal text-muted">{ws.length}</span>
              </button>
              {collapsed[repoId] ? null : (
                <ul className="m-0 list-none p-0">
                  {ws.map((w) => <CheckoutRow key={w.id} w={w} selected={thread?.kind === 'worktree' && thread.id === w.id} onOpen={() => open({ kind: 'worktree', id: w.id })} />)}
                </ul>
              )}
            </section>
          ))}
      </div>

      <NewWorktreeDialog open={creating} repos={(data?.repos || []).filter((r) => !r.readOnly)} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); refresh(); open({ kind: 'worktree', id }); }} />
    </div>
  );
}

function CheckoutRow({ w, selected, onOpen }: { w: Checkout; selected: boolean; onOpen: () => void }) {
  const s = w.status;
  const branch = s?.branch ?? w.branch;
  return (
    <li>
      <button type="button" onClick={onOpen} className={cn('group relative w-full cursor-pointer border-0 border-b border-border py-2 pr-3 pl-4 text-left', selected ? 'bg-accent-soft' : 'bg-transparent hover:bg-surface-2')}>
        <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-[3px] rounded-full" style={{ background: s?.changed ? 'var(--warning)' : s?.ahead ? 'var(--accent)' : w.isPrimary ? 'var(--muted)' : 'var(--border-strong)' }} />
        <span className="flex items-center gap-2">
          {w.isPrimary ? <FolderGit2 size={13} aria-hidden className="text-muted" /> : <GitBranch size={13} aria-hidden className="text-muted" />}
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{branch || (w.detached ? `detached ${s ? '' : ''}` : '—')}</span>
          {w.readOnly ? <Tooltip label="Never modified by Millwright"><Lock size={12} aria-hidden className="text-muted" /></Tooltip> : null}
          <span className="w-12 flex-none text-right text-[11.5px] whitespace-nowrap text-muted">{ago(s?.lastCommitAt)}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={cn('text-[11.5px]', w.isPrimary ? 'font-semibold text-fg-2' : 'text-muted')}>{label(w)}</span>
          {!s ? <span className="text-[11.5px] text-muted">reading…</span> : s.error ? <Badge tone="critical">{s.error}</Badge> : (
            <>
              {s.changed ? <Badge tone="warning">{s.changed} changed</Badge> : null}
              {s.ahead ? <Badge tone="accent">↑{s.ahead} to push</Badge> : null}
              {s.behind ? <Badge>↓{s.behind} behind</Badge> : null}
              {!s.upstream && !w.isPrimary && branch ? <span className="text-[11px] text-muted">not pushed yet</span> : null}
            </>
          )}
          {w.pr ? (
            <span className={cn('inline-flex items-center gap-0.5 text-[11.5px]', w.pr.state === 'MERGED' || w.pr.state === 'CLOSED' ? 'text-muted' : 'text-accent')}>
              <GitPullRequest size={11} aria-hidden />#{w.pr.number}{w.pr.state === 'MERGED' ? ' merged' : w.pr.state === 'CLOSED' ? ' closed' : ''}
            </span>
          ) : null}
          {w.runs.length ? <Badge tone="accent"><Play size={10} aria-hidden />{w.runs.join(', ')}</Badge> : null}
          {w.chatting ? <Badge tone="accent"><MessageCircle size={10} aria-hidden />Claude working</Badge> : null}
          {s?.lastCommit ? <span className="min-w-0 max-w-full truncate text-[11.5px] text-muted">{s.lastCommit}</span> : null}
        </span>
      </button>
    </li>
  );
}

export function NewWorktreeDialog({ open, repos, onClose, onCreated, initialRepo }: {
  open: boolean; repos: WorkspaceState['repos']; onClose: () => void; onCreated: (id: string) => void; initialRepo?: string;
}) {
  const [repo, setRepo] = useState(initialRepo || repos[0]?.id || '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const repoDefault = repos.find((r) => r.id === (repo || repos[0]?.id))?.defaultBase || 'dev';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advice = branch && !/^(feat|fix|chore|refactor|docs|test|perf|style|ci|build)\/PROJ-\d+-[a-z0-9-]+$/.test(branch.trim())
    ? 'The convention is type/PROJ-1234-short-description.' : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await postJson<{ id: string; message: string }>('/api/worktree-action', { action: 'new-worktree', repo: repo || repos[0]?.id, branch: branch.trim(), base: base.trim() || repoDefault });
      toast.success('Worktree ready', { description: r.message });
      setBranch('');
      onCreated(r.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title="New worktree" description="A separate folder for a branch, so several pieces of work can be open at once without switching anything.">
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1 text-[12.5px] font-semibold text-fg-2">Repo
            <select value={repo || repos[0]?.id} onChange={(e) => { setRepo(e.target.value); setBase(''); }} className="rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 text-[13px] font-normal text-fg">
              {repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[12.5px] font-semibold text-fg-2">Branch
            <input value={branch} onChange={(e) => { setBranch(e.target.value); setError(null); }} placeholder="fix/PROJ-1234-short-description" spellCheck={false} autoFocus
              className="rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 font-mono text-[13px] font-normal text-fg outline-none focus:border-accent" />
            <span className="text-[11.5px] font-normal text-muted">An existing branch (local or on origin) is checked out as it is. A new one starts from the base below.</span>
            {advice ? <span className="text-[11.5px] font-normal text-warning">{advice}</span> : null}
          </label>
          <label className="grid gap-1 text-[12.5px] font-semibold text-fg-2">Base for a new branch
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={repoDefault} spellCheck={false} className="rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 font-mono text-[13px] font-normal text-fg" />
          </label>
          {error ? <p role="alert" className="m-0 text-[12.5px] font-semibold whitespace-pre-wrap text-critical">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" variant="primary" disabled={busy || !branch.trim()}>{busy ? <Spinner /> : null}Create worktree</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
