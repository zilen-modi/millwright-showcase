import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { postJson } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { useV2 } from './data';
import { useStartReview } from './dispatch';
import { useThread } from './useListQuery';

/** #reviews: paste a PR link to review it (v1's "Review a PR" form). */
export function ReviewUrlBox() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useStartReview();
  const { open } = useThread();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) { setError('Paste a PR link first.'); return; }
    setBusy(true);
    const ref = await start(url.trim(), 'PR');
    setBusy(false);
    if (ref) { setUrl(''); open({ kind: 'review', id: ref }); }
  }
  return (
    <form onSubmit={submit} aria-label="Review a PR" className="border-b border-border px-4 py-2.5">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          placeholder="https://github.com/acme-it-erp/<repo>/pull/<n>"
          aria-label="GitHub PR link"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-[9px] border border-border-strong bg-surface px-3 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Starting…' : 'Review'}</Button>
      </div>
      <p role={error ? 'alert' : undefined} className={error ? 'mt-1.5 mb-0 text-[12px] font-semibold text-critical' : 'mt-1.5 mb-0 text-[12px] text-muted'}>
        {error || 'On your own PR, findings above the fix bar are fixed and pushed. On anyone else\'s it is a report only - nothing reaches GitHub until you post it.'}
      </p>
    </form>
  );
}

/** #review-inbox: who it is for, how fresh it is, the Refresh sweep, and every warning v1 shows. */
export function InboxStatus() {
  const { inboxState: s, refreshInbox } = useV2();
  const [sweeping, setSweeping] = useState(false);
  if (!s) return null;
  const failed = s.repos.filter((r) => !r.ok);
  const truncated = s.repos.filter((r) => r.truncated);
  const busy = sweeping || s.sweeping;
  const refresh = async () => {
    setSweeping(true);
    try {
      const r = await postJson<{ rows?: number; failed?: string[]; error?: string | null }>('/api/pr-inbox-scan', {});
      if (r.error) toast.error('The inbox sweep failed', { description: r.error });
      else toast.success(`Inbox refreshed - ${r.rows ?? 0} PR(s)`, { description: r.failed?.length ? `${r.failed.length} repo(s) could not be read` : undefined });
    } catch (e) { toast.error('The inbox sweep failed', { description: e instanceof Error ? e.message : String(e) }); }
    setSweeping(false);
    refreshInbox();
  };
  const warn = (text: string) => (
    <p className="m-0 mt-1.5 flex items-start gap-1.5 text-[12px] text-fg-2"><AlertTriangle size={12} aria-hidden className="mt-0.5 flex-none text-warning" />{text}</p>
  );
  return (
    <div className="border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        {s.login ? <span>as <strong className="font-semibold text-fg-2">{s.login}</strong></span> : null}
        <span>{s.pending ? 'fetching from GitHub…' : s.at ? `updated ${shortDate(s.at)} ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'not swept yet'}{s.stale ? ' (stale)' : ''}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? <Spinner /> : <RefreshCw size={12} aria-hidden />}Refresh
        </Button>
      </div>
      {s.error ? warn(`${s.error} - the rows below are from an earlier sweep.`) : null}
      {s.loginMismatch ? warn('gh is signed in as a different account than the inbox expects. Run `gh auth switch` to the right one.') : null}
      {failed.length ? warn(`${failed.length} of ${s.repos.length} repos could not be refreshed (${failed.map((r) => `${r.slug.split('/').pop()}: ${r.error?.kind || 'error'}`).join(', ')}).`) : null}
      {truncated.length ? warn(`${truncated.map((r) => r.slug.split('/').pop()).join(', ')} ${truncated.length === 1 ? 'has' : 'have'} more open PRs than this list shows.`) : null}
    </div>
  );
}
