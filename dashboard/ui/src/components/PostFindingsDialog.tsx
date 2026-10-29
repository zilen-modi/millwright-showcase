import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';
import type { FindingsReviewDraft } from '@/lib/types';

const DEFAULT_SUMMARY = 'A few things worth a look before merge.';

/**
 * Post the accepted findings as one GitHub review, under the operator's account.
 *
 * The server rebuilds the review from the files on disk and the live diff; this dialog only
 * shows it and sends back the summary plus the acceptedSha it previewed, so a decision changed
 * in another tab cannot slip into the post unseen. Same two-step arm as the comment dialog.
 */
export function PostFindingsDialog({
  reviewRef,
  onClose,
  onPosted,
}: {
  reviewRef: string | null;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [draft, setDraft] = useState<FindingsReviewDraft | null>(null);
  const [summary, setSummary] = useState(DEFAULT_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [armed, setArmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);

  useEffect(() => {
    if (!reviewRef) {
      setDraft(null); setSummary(DEFAULT_SUMMARY); setArmed(false); setError(null); setIssues(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/pr-review-post?ref=${encodeURIComponent(reviewRef)}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || `HTTP ${r.status}`)))))
      .then((d: FindingsReviewDraft) => { if (alive) setDraft(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reviewRef]);

  const post = useCallback(async () => {
    if (!reviewRef || !draft) return;
    setPosting(true);
    setError(null);
    setIssues(null);
    try {
      const r = await postJson<{ commentUrl: string; inline: number; inBody: number }>('/api/pr-review-post', {
        ref: reviewRef, summary, acceptedSha: draft.acceptedSha,
      });
      toast.success('Review posted', { description: `${r.inline} inline, ${r.inBody} in the summary · ${r.commentUrl}` });
      onPosted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.issues) setIssues(e.issues);
      setError(e instanceof Error ? e.message : String(e));
      setArmed(false);
    } finally {
      setPosting(false);
    }
  }, [reviewRef, draft, summary, onPosted, onClose]);

  const prClosed = !!draft?.pr && draft.pr.state !== 'OPEN';
  const lastPosted = draft?.postedComments.length ? draft.postedComments[draft.postedComments.length - 1] : null;
  const blocked = loading || !draft || !draft.acceptedCount || prClosed || !!draft.unresolved.length || !summary.trim();

  return (
    <Dialog open={!!reviewRef} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        title="Post the accepted findings as a review"
        description={
          draft
            ? `As ${draft.viewer || 'your gh account'} on ${draft.prUrl.replace('https://github.com/', '')}${draft.pr?.state ? ` (${draft.pr.state})` : ''} · comment only, it never approves or requests changes`
            : 'Preparing the review…'
        }
      >
        {error ? <p role="alert" className="mt-0 text-xs font-semibold text-critical">{error}</p> : null}
        {issues?.length ? (
          <ul className="mt-0 mb-2 list-disc pl-5 text-xs text-critical">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
        ) : null}

        {loading && !draft ? (
          <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Drafting" /> Building the review…</p>
        ) : draft ? (
          <>
            {lastPosted ? (
              <p className="mt-0 mb-2 text-xs text-muted">
                Posted from this review before{lastPosted.commentUrl ? <> - <a href={lastPosted.commentUrl} target="_blank" rel="noopener" className="text-accent">see it</a></> : null}.
                {' '}The same accepted set cannot be posted twice.
              </p>
            ) : null}
            {prClosed ? (
              <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-warning">This PR is {draft.pr?.state} - nothing will be posted.</p>
            ) : null}
            {draft.moved ? (
              <p className="mt-0 mb-2 text-xs text-warning">
                The PR has new commits since this review, so the line numbers may have shifted. Every finding goes in the summary instead of inline.
              </p>
            ) : draft.diffError ? (
              <p className="mt-0 mb-2 text-xs text-muted">Could not read the diff ({draft.diffError}), so every finding goes in the summary.</p>
            ) : null}
            {draft.prError ? <p className="mt-0 mb-2 text-xs text-muted">Could not confirm the PR state: {draft.prError}</p> : null}
            {draft.unresolved.length ? (
              <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-critical">
                Still names internal tooling: {draft.unresolved.map((u) => `${u.where} ("${u.hit}")`).join(', ')}. Edit that finding's wording first.
              </p>
            ) : null}

            <label className="mb-1 block text-xs font-semibold text-fg-2" htmlFor="review-summary">Summary</label>
            <Textarea
              id="review-summary"
              value={summary}
              onChange={(e) => { setSummary(e.target.value); setArmed(false); }}
              className="min-h-[64px] text-[13px]"
            />

            <div className="mt-3 max-h-[300px] overflow-y-auto pr-1">
              {draft.inline.length ? (
                <>
                  <p className="mt-0 mb-1.5 text-[11px] font-bold uppercase tracking-[.05em] text-muted">Inline ({draft.inline.length})</p>
                  <ul className="m-0 mb-3 grid list-none gap-2 p-0">
                    {draft.inline.map((c) => (
                      <li key={c.id} className="rounded-[9px] border border-border px-3 py-2">
                        <code className="font-mono text-[11.5px] text-muted">{c.path}:{c.line}</code>
                        <div className="text-[13px]"><Markdown source={c.body} /></div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {draft.inBody.length ? (
                <>
                  <p className="mt-0 mb-1.5 text-[11px] font-bold uppercase tracking-[.05em] text-muted">In the summary ({draft.inBody.length})</p>
                  <p className="mt-0 mb-1.5 text-xs text-muted">Their evidence is not on a changed line, so they are listed under the summary with their location.</p>
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {draft.inBody.map((c) => (
                      <li key={c.id} className="rounded-[9px] border border-border px-3 py-2">
                        {c.at ? <code className="font-mono text-[11.5px] text-muted">{c.at}</code> : null}
                        <div className="text-[13px]"><Markdown source={c.body} /></div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>

            <p className="mt-2 mb-0 text-[11px] text-muted">
              {draft.acceptedCount} accepted finding(s) · {draft.inline.length} inline · {draft.inBody.length} in the summary
            </p>
          </>
        ) : null}

        {armed ? (
          <p className="mt-2 mb-0 text-xs leading-relaxed text-fg-2">
            This posts a public review under your GitHub account. The author is notified immediately; you can edit or delete the comments afterwards.
          </p>
        ) : null}

        <DialogFooter>
          {!armed ? (
            <Button variant="ship" disabled={blocked} onClick={() => setArmed(true)}>Continue…</Button>
          ) : (
            <Button variant="ship" disabled={posting} onClick={() => void post()}>
              {posting ? <Spinner /> : null}
              Post this review as {draft?.viewer || 'me'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
