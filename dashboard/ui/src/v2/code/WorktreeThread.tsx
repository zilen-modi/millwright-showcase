import { ArrowDownToLine, ArrowUpFromLine, Copy, FileCode, GitCommit, GitPullRequest, Play, RefreshCw, Square, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';
import { LogView } from '@/components/LogView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { useLogEvents } from '@/hooks/stream';
import { useResource } from '@/hooks/useResource';
import { ApiError, postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { Composer } from '../thread/Composer';
import { ThreadHeader } from '../thread/ThreadHeader';
import { useThread } from '../useListQuery';
import { ago } from '../rows';
import type { CheckoutDetail, RunCard } from './types';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
}

const enc = encodeURIComponent;
const KIND_TONE: Record<string, 'warning' | 'good' | 'critical' | 'accent' | undefined> = { modified: 'warning', added: 'good', untracked: 'good', deleted: 'critical', renamed: 'accent', conflict: 'critical' };

/** One checkout: its changes and diffs, files, history, manifest commands, and a Claude chat. */
export function WorktreeThread({ id }: { id: string }) {
  const fetcher = useCallback((signal: AbortSignal) => getJson<CheckoutDetail>(`/api/worktree?id=${enc(id)}`, signal), [id]);
  const { data, error, refresh } = useResource<CheckoutDetail>(fetcher, [id]);
  const d = data && data.id === id ? data : null;
  const [tab, setTab] = useState('changes');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { close } = useThread();

  const act = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const r = await postJson<{ message: string; id?: string }>('/api/worktree-action', { id, action, ...extra });
      toast.success(r.message || 'Done');
      refresh();
      return true;
    } catch (e) {
      toast.error(`${action} did not work`, { description: e instanceof Error ? e.message : String(e), duration: 10000 });
      return false;
    } finally { setBusy(null); }
  }, [id, refresh]);

  if (!d) {
    return (
      <>
        <ThreadHeader title={<span className="font-mono">{id}</span>} subtitle={error ? `Could not read it: ${error}` : 'Reading…'} />
        {!error ? <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" />Reading the checkout…</p> : null}
      </>
    );
  }
  const s = d.status;
  const a = d.actions;
  const why = (key: keyof CheckoutDetail['actions'], text: string) => (a[key] ? undefined : text);

  return (
    <>
      <ThreadHeader
        title={<span className="font-mono">{s.branch || (d.detached ? 'detached HEAD' : '—')}</span>}
        subtitle={<>{d.repo}{d.isPrimary ? ' · main checkout (view-only here)' : ` · ${d.dir}`}{d.readOnly ? ' · read-only repo' : ''}</>}
        links={d.pr ? [{ href: d.pr.url, label: `PR #${d.pr.number}`, icon: <GitPullRequest size={13} aria-hidden /> }] : []}
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {d.files.length ? <Badge tone="warning">{d.files.length} changed</Badge> : <Badge tone="good">clean</Badge>}
          {s.upstream ? <span className="text-[12px] text-muted">↑{s.ahead} ↓{s.behind} vs {s.upstream}</span> : !d.isPrimary && s.branch ? <span className="text-[12px] text-muted">not pushed yet</span> : null}
          <span className="flex-1" />
          <Tooltip label="Copy the folder path">
            <button type="button" aria-label="Copy the folder path" onClick={() => { void navigator.clipboard.writeText(d.path); toast.success('Path copied'); }} className="cursor-pointer rounded-[7px] border-0 bg-transparent p-1 text-fg-2 hover:bg-surface-2"><Copy size={13} aria-hidden /></button>
          </Tooltip>
          <ActionButton label="Fetch" icon={<RefreshCw size={12} aria-hidden />} busy={busy === 'fetch'} disabled={why('fetch', 'Not available')} onClick={() => void act('fetch')} />
          <ActionButton label="Pull" icon={<ArrowDownToLine size={12} aria-hidden />} busy={busy === 'pull'} disabled={why('pull', d.files.length ? 'Commit or discard changes first.' : 'No upstream to pull from yet.')} onClick={() => void act('pull')} />
          <ActionButton label="Push" icon={<ArrowUpFromLine size={12} aria-hidden />} busy={busy === 'push'} disabled={why('push', d.isPrimary ? 'The main checkout is view-only - work in a worktree.' : 'Nothing new to push.')}
            onClick={() => setConfirm({ title: `Push ${s.branch}?`, body: `Pushes ${s.ahead || 'the'} commit(s) to origin/${s.branch}. Never force-pushes.`, confirmLabel: 'Push', onConfirm: () => void act('push') })} />
          <PrButton detail={d} disabled={why('pr', !s.upstream ? 'Push the branch first.' : 'Push your latest commits first.')} onCreate={(extra) => act('pr', extra)} busy={busy === 'pr'} />
          {!d.isPrimary ? (
            <ActionButton label="" ariaLabel="Remove this worktree" icon={<Trash2 size={12} aria-hidden />} busy={busy === 'remove'} disabled={why('remove', 'It has uncommitted changes.')}
              onClick={() => setConfirm({ title: `Remove ${d.dir}?`, body: 'Deletes this worktree folder. The branch and its commits are kept, so you can make a worktree for it again.', confirmLabel: 'Remove worktree', destructive: true, onConfirm: () => { void act('remove').then((ok) => { if (ok) close(); }); } })} />
          ) : null}
        </div>
      </ThreadHeader>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="px-3">
          <TabsTrigger value="changes">Changes{d.files.length ? ` ${d.files.length}` : ''}</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="log">History</TabsTrigger>
          {d.commands.length ? <TabsTrigger value="run">Run{d.runs.length ? ` · ${d.runs.length}` : ''}</TabsTrigger> : null}
          <TabsTrigger value="chat">Claude</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <Changes detail={d} busy={busy} act={act} setConfirm={setConfirm} />
        </TabsContent>
        <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><Files id={id} /></TabsContent>
        <TabsContent value="log" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <ol className="m-0 list-none p-0">
            {d.log.map((c) => (
              <li key={c.sha} className="flex items-baseline gap-2 border-b border-border py-1.5 text-[12.5px]">
                <code className="font-mono text-[11.5px] text-accent">{c.short}</code>
                <span className="min-w-0 flex-1 truncate text-fg" title={c.subject}>{c.subject}</span>
                <span className="text-[11.5px] whitespace-nowrap text-muted">{c.author} · {ago(c.at)}</span>
              </li>
            ))}
          </ol>
        </TabsContent>
        {d.commands.length ? <TabsContent value="run" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><Run detail={d} onChange={refresh} /></TabsContent> : null}
        <TabsContent value="chat" className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"><WorktreeChat id={id} editable={!d.isPrimary && !d.readOnly} /></TabsContent>
      </Tabs>

      <Composer
        commands={[{ name: 'ask', label: 'Ask Claude about this checkout', takesNotes: true, action: { type: 'ask' } }]}
        onRun={async (_c, args) => {
          try { await postJson('/api/worktree-chat', { id, text: args }); setTab('chat'); refresh(); }
          catch (e) { toast.error('Could not ask that', { description: e instanceof Error ? e.message : String(e) }); }
        }}
        placeholder={d.isPrimary || d.readOnly ? 'Ask Claude about this code (read-only here)' : 'Ask Claude to explain or change something in this worktree'}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function ActionButton({ label, ariaLabel, icon, disabled, busy, onClick }: { label: string; ariaLabel?: string; icon: React.ReactNode; disabled?: string; busy?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={disabled || ariaLabel || label}>
      <span><Button size="sm" aria-label={ariaLabel || label} disabled={!!disabled || busy} onClick={onClick}>{busy ? <Spinner /> : icon}{label}</Button></span>
    </Tooltip>
  );
}

function PrButton({ detail, disabled, busy, onCreate }: { detail: CheckoutDetail; disabled?: string; busy: boolean; onCreate: (extra: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState('dev');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(true);
  if (detail.pr) return null;
  return (
    <>
      <ActionButton label="PR" icon={<GitPullRequest size={12} aria-hidden />} busy={busy} disabled={disabled} onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Open a PR for ${detail.status.branch}`} description="Opens a pull request on GitHub under your account. It never merges.">
          <div className="grid gap-2.5">
            <label className="grid gap-1 text-[12.5px] font-semibold text-fg-2">Into
              <input value={base} onChange={(e) => setBase(e.target.value)} className="rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 font-mono text-[13px] font-normal" />
            </label>
            <label className="grid gap-1 text-[12.5px] font-semibold text-fg-2">Title <span className="font-normal text-muted">(empty = from the commits)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 text-[13px] font-normal" />
            </label>
            {title ? <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Description" className="min-h-[90px]" /> : null}
            <label className="flex items-center gap-2 text-[12.5px] text-fg-2"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Open as a draft</label>
          </div>
          <DialogFooter>
            <Button variant="primary" disabled={busy || !base.trim()} onClick={async () => { if (await onCreate({ base: base.trim(), title: title.trim() || undefined, body, draft })) setOpen(false); }}>
              {busy ? <Spinner /> : <GitPullRequest size={13} aria-hidden />}Open the PR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Changes({ detail, busy, act, setConfirm }: {
  detail: CheckoutDetail; busy: string | null;
  act: (action: string, extra?: Record<string, unknown>) => Promise<boolean>;
  setConfirm: (r: ConfirmRequest) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const files = detail.files;
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  useEffect(() => { setPicked((p) => new Set([...p].filter((x) => paths.includes(x)))); }, [paths]);
  const fetcher = useCallback((signal: AbortSignal) => (open ? getJson<{ diff: string }>(`/api/worktree-diff?id=${enc(detail.id)}&path=${enc(open)}`, signal) : Promise.resolve(null)), [detail.id, open]);
  const { data: diff } = useResource(fetcher, [detail.id, open]);
  const sel = [...picked];
  const editable = !detail.isPrimary && !detail.readOnly;

  if (!files.length) return <p className="pt-3 text-[13px] text-muted">No uncommitted changes. {editable ? 'Ask Claude below to make one, or run a command in Run.' : ''}</p>;
  return (
    <div className="pt-2">
      <div className="mb-1.5 flex items-center gap-2 text-[12px]">
        <label className="flex items-center gap-1.5 font-semibold text-fg-2">
          <input type="checkbox" checked={sel.length === files.length} onChange={() => setPicked(sel.length === files.length ? new Set() : new Set(paths))} aria-label="Select every changed file" />
          {sel.length ? `${sel.length} selected` : 'Select all'}
        </label>
        <span className="flex-1" />
        {editable && sel.length ? (
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => setConfirm({
            title: `Discard changes in ${sel.length} file(s)?`, body: 'Tracked files go back to the last commit; new files are deleted. This cannot be undone.',
            confirmLabel: 'Discard', destructive: true, onConfirm: () => void act('discard', { files: sel }),
          })}><Undo2 size={12} aria-hidden />Discard</Button>
        ) : null}
      </div>
      <ul className="m-0 list-none rounded-[9px] border border-border p-0">
        {files.map((f) => (
          <li key={f.path} className={cn('border-b border-border last:border-0', open === f.path && 'bg-surface-2')}>
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <input type="checkbox" checked={picked.has(f.path)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; })} aria-label={`Select ${f.path}`} disabled={!editable} />
              <button type="button" onClick={() => setOpen(open === f.path ? null : f.path)} className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-[12px] text-fg hover:text-accent" title={f.path}>
                {f.from ? `${f.from} → ` : ''}{f.path}
              </button>
              {f.add || f.del ? <span className="font-mono text-[11px]"><span className="text-good">+{f.add || 0}</span> <span className="text-critical">−{f.del || 0}</span></span> : null}
              <Badge tone={KIND_TONE[f.kind]}>{f.kind}</Badge>
            </div>
            {open === f.path ? <DiffView text={diff?.diff ?? null} /> : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form className="mt-3" onSubmit={async (e) => { e.preventDefault(); if (await act('commit', { files: sel, message })) { setMessage(''); setPicked(new Set()); } }}>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message, e.g. fix(PROJ-1234): disable Save while the form is empty" aria-label="Commit message" className="min-h-[60px] text-[12.5px]"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
          <div className="mt-1.5 flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={!sel.length || !message.trim() || !!busy}>{busy === 'commit' ? <Spinner /> : <GitCommit size={13} aria-hidden />}Commit {sel.length || ''} file{sel.length === 1 ? '' : 's'}</Button>
            <span className="text-[11.5px] text-muted">The repo's commit hooks run as usual. ⌘Enter commits.</span>
          </div>
        </form>
      ) : <p className="mt-2 text-[12px] text-muted">The main checkout is view-only here. To change code, create a worktree for a branch in #code.</p>}
    </div>
  );
}

export function DiffView({ text }: { text: string | null }) {
  if (text == null) return <p className="m-0 flex items-center gap-2 px-3 pb-2 text-[12px] text-muted"><Spinner className="h-3 w-3 border" />Loading the diff…</p>;
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l));
  return (
    <pre className="m-0 max-h-[460px] overflow-auto border-t border-border bg-page font-mono text-[11.5px] leading-[1.45]">
      {lines.map((l, i) => (
        <div key={i} className={cn('px-3 whitespace-pre',
          l.startsWith('+++') || l.startsWith('---') ? 'text-muted'
            : l.startsWith('@@') ? 'bg-accent-soft text-accent'
            : l.startsWith('+') ? 'bg-[color-mix(in_srgb,var(--good)_13%,transparent)] text-fg'
            : l.startsWith('-') ? 'bg-[color-mix(in_srgb,var(--critical)_11%,transparent)] text-fg'
            : 'text-fg-2')}>{l || ' '}</div>
      ))}
    </pre>
  );
}

function Files({ id }: { id: string }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 200); return () => clearTimeout(t); }, [q]);
  const list = useResource(useCallback((signal: AbortSignal) => getJson<{ total: number; files: string[]; more: number }>(`/api/worktree-files?id=${enc(id)}&q=${enc(debounced)}`, signal), [id, debounced]), [id, debounced]);
  const file = useResource(useCallback((signal: AbortSignal) => (path ? getJson<{ content: string | null; size: number; binary?: boolean; tooBig?: boolean }>(`/api/worktree-file?id=${enc(id)}&path=${enc(path)}`, signal) : Promise.resolve(null)), [id, path]), [id, path]);

  if (path) {
    const f = file.data;
    return (
      <div className="pt-2">
        <div className="mb-2 flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPath(null)}>← Files</Button>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={path}>{path}</span>
          <Tooltip label="Copy the path"><button type="button" aria-label="Copy the path" onClick={() => { void navigator.clipboard.writeText(path); toast.success('Path copied'); }} className="cursor-pointer rounded-[7px] border-0 bg-transparent p-1 text-fg-2 hover:bg-surface-2"><Copy size={13} aria-hidden /></button></Tooltip>
        </div>
        {!f ? <p className="flex items-center gap-2 text-[12.5px] text-muted"><Spinner label="Loading" />Loading…</p>
          : f.content == null ? <p className="text-[12.5px] text-muted">{f.binary ? 'A binary file - nothing to show.' : `Too big to show here (${Math.round(f.size / 1000)} KB).`}</p>
          : path.endsWith('.md') ? <Markdown source={f.content} /> : (
            <pre className="m-0 overflow-auto rounded-[9px] border border-border bg-page py-2 font-mono text-[11.5px] leading-[1.5]">
              {f.content.split('\n').map((l, i) => (
                <div key={i} className="flex"><span className="w-12 flex-none pr-3 text-right text-muted select-none">{i + 1}</span><span className="whitespace-pre text-fg">{l || ' '}</span></div>
              ))}
            </pre>
          )}
      </div>
    );
  }
  return (
    <div className="pt-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file - e.g. transfer modal tsx" aria-label="Find a file" autoFocus
        className="mb-2 w-full rounded-[8px] border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-muted focus:border-accent" />
      {!list.data ? <p className="flex items-center gap-2 text-[12.5px] text-muted"><Spinner label="Loading" />Listing files…</p> : (
        <>
          <p className="m-0 mb-1 text-[11.5px] text-muted">{list.data.files.length + list.data.more} of {list.data.total} files{list.data.more ? ` · showing the first ${list.data.files.length}` : ''}</p>
          <ul className="m-0 list-none p-0">
            {list.data.files.map((p) => (
              <li key={p}>
                <button type="button" onClick={() => setPath(p)} className="flex w-full cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-1.5 py-1 text-left font-mono text-[12px] text-fg-2 hover:bg-surface-2 hover:text-fg">
                  <FileCode size={12} aria-hidden className="flex-none text-muted" /><span className="truncate">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Run({ detail, onChange }: { detail: CheckoutDetail; onChange: () => void }) {
  const [view, setView] = useState<string | null>(detail.runHistory[0]?.runId || null);
  const start = async (command: string) => {
    try {
      const r = await postJson<{ runId: string }>('/api/worktree-run', { id: detail.id, command });
      setView(r.runId); onChange();
    } catch (e) { toast.error('Could not start it', { description: e instanceof ApiError ? e.message : String(e) }); }
  };
  const stop = async (runId: string) => {
    try { await postJson('/api/worktree-run-stop', { runId }); onChange(); }
    catch (e) { toast.error('Could not stop it', { description: e instanceof Error ? e.message : String(e) }); }
  };
  const running = new Map(detail.runHistory.filter((r) => r.status === 'running' || r.status === 'stopping').map((r) => [r.cmdId, r]));
  return (
    <div className="pt-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {detail.commands.map((c) => {
          const r = running.get(c.id);
          return (
            <div key={c.id} className="flex items-center gap-2 rounded-[9px] border border-border bg-surface px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[12.5px] font-semibold text-fg">{c.label}{c.longRunning ? <span className="ml-1.5 text-[11px] font-normal text-muted">keeps running</span> : null}</p>
                <p className="m-0 truncate font-mono text-[11px] text-muted" title={c.note || c.cmd}>{c.cmd}</p>
              </div>
              {r ? <Button size="sm" variant="danger" onClick={() => void stop(r.runId)}><Square size={11} aria-hidden />Stop</Button>
                : <Button size="sm" onClick={() => void start(c.id)}><Play size={11} aria-hidden />Run</Button>}
            </div>
          );
        })}
      </div>
      {detail.runHistory.length ? (
        <>
          <div className="mt-3 mb-1.5 flex flex-wrap gap-1.5">
            {detail.runHistory.slice(0, 8).map((r) => (
              <button key={r.runId} type="button" onClick={() => setView(r.runId)} className={cn('cursor-pointer rounded-full border px-2.5 py-0.5 text-[11.5px]', view === r.runId ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-fg-2')}>
                {r.cmdId} · <RunStatus r={r} />
              </button>
            ))}
          </div>
          {view ? <RunOutput runId={view} /> : null}
        </>
      ) : null}
    </div>
  );
}

function RunStatus({ r }: { r: RunCard }) {
  return <span className={r.status === 'failed' ? 'text-critical' : r.status === 'passed' ? 'text-good' : ''}>{r.status === 'running' ? 'running' : r.status === 'failed' ? `failed (${r.code})` : r.status}</span>;
}

function RunOutput({ runId }: { runId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    getJson<{ lines: string[] }>(`/api/worktree-run-log?runId=${enc(runId)}`).then((r) => { if (alive) setLines(r.lines); }).catch(() => {});
    return () => { alive = false; };
  }, [runId]);
  useLogEvents((e) => { if (e.key === `cmd:${runId}`) setLines((l) => [...l.slice(-1999), e.line]); });
  return <LogView className="max-h-[360px]" label="Command output" lines={lines} empty="No output yet." />;
}

interface WtMessage { id: string; question: { text: string; at: string }; answer: { text: string; citations: string[] } | null; running: boolean; failed: string | null }

function WorktreeChat({ id, editable }: { id: string; editable: boolean }) {
  const fetcher = useCallback((signal: AbortSignal) => getJson<{ messages: WtMessage[] }>(`/api/worktree-chat?id=${enc(id)}`, signal), [id]);
  const { data } = useResource(fetcher, [id]);
  const messages = data?.messages || [];
  if (!messages.length) {
    return (
      <div className="px-2 py-8 text-center">
        <p className="m-0 text-[14px] font-semibold text-fg">Ask Claude about this {editable ? 'worktree' : 'checkout'}</p>
        <p className="m-0 mt-1 text-[12.5px] text-muted">
          {editable
            ? '"Why does the transfer test fail?" · "Disable Save while the form is empty". Claude can change files here, but never commits or pushes - its changes show up in Changes for you to review and commit.'
            : 'Questions only here: the main checkout and read-only repos are never edited.'}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 pb-2 pt-2">
      {messages.map((m) => (
        <div key={m.id} className="grid gap-2">
          <div className="ml-auto max-w-[85%] rounded-[12px] rounded-br-[4px] bg-accent-soft px-3 py-2 text-[13px] whitespace-pre-wrap text-fg">{m.question.text}</div>
          <div className="max-w-[95%] rounded-[12px] rounded-bl-[4px] border border-border bg-surface px-3 py-2">
            {m.answer ? (
              <>
                <div className="text-[13px]"><Markdown source={m.answer.text} /></div>
                {m.answer.citations.length ? <p className="m-0 mt-1.5 flex flex-wrap gap-1">{m.answer.citations.map((c) => <code key={c} className="rounded-[5px] border border-border bg-surface-2 px-1.5 font-mono text-[11px] text-fg-2">{c}</code>)}</p> : null}
              </>
            ) : m.failed ? <p className="m-0 text-[12.5px] text-critical">No answer: {m.failed}</p>
              : <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted"><Spinner className="h-3 w-3 border" />{editable ? 'Working in the worktree…' : 'Reading the code…'}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
