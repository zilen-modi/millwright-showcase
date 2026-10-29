import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';

type Severity = 'high' | 'medium' | 'low';

interface Draft {
  ref: string;
  body: string;
  bySeverity: Record<Severity, number>;
  findingCount: number;
  unclassified: string[];
  warnings: string[];
  unresolved: { line: number; hit: string }[];
  lint: { count: number; violations: { line: number; detail: string }[] };
  prUrl: string | null;
  viewer: string | null;
  viewerError: string | null;
  pr: { state: string | null; author: string | null; isDraft: boolean } | null;
  prError: string | null;
  postedComments: { at: string; commentUrl: string | null }[];
}

const ALL: Severity[] = ['high', 'medium', 'low'];

/**
 * Publish a review's findings to the PR, as the operator.
 *
 * Two steps on purpose. The comment goes out under the operator's own GitHub account and
 * notifies the author immediately, so the body they confirm is the body that is posted - the
 * draft is editable, and the arm step restates whose name is on it.
 */
export function PostReviewDialog({
  reviewRef,
  onClose,
  onPosted,
}: {
  reviewRef: string | null;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [severities, setSeverities] = useState<Severity[]>(['high', 'medium']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [armed, setArmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);

  // Re-draft whenever the severity selection changes, unless the operator has edited the body -
  // silently overwriting their wording would be worse than a stale count.
  useEffect(() => {
    if (!reviewRef) return;
    let alive = true;
    setLoading(true);
    setError(null);
    const q = `ref=${encodeURIComponent(reviewRef)}&severities=${severities.join(',')}`;
    fetch(`/api/pr-review-comment?${q}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || `HTTP ${r.status}`)))))
      .then((d: Draft) => {
        if (!alive) return;
        setDraft(d);
        if (!edited) setBody(d.body);
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRef, severities.join(',')]);

  useEffect(() => {
    if (!reviewRef) { setDraft(null); setBody(''); setEdited(false); setArmed(false); setIssues(null); setError(null); }
  }, [reviewRef]);

  const toggle = useCallback((s: Severity) => {
    setArmed(false);
    setSeverities((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : ALL.filter((x) => prev.includes(x) || x === s)));
  }, []);

  const post = useCallback(async () => {
    if (!reviewRef || !draft) return;
    setPosting(true);
    setIssues(null);
    setError(null);
    try {
      const r = await postJson<{ commentUrl: string }>('/api/pr-review-comment', {
        ref: reviewRef, body, severities, edited, reviewSha256: (draft as unknown as { reviewSha256?: string }).reviewSha256,
      });
      toast.success('Comment posted', { description: r.commentUrl });
      onPosted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.issues) setIssues(e.issues);
      setError(e instanceof Error ? e.message : String(e));
      setArmed(false);
    } finally {
      setPosting(false);
    }
  }, [reviewRef, draft, body, severities, edited, onPosted, onClose]);

  const bytes = new TextEncoder().encode(body).length;
  const prClosed = !!draft?.pr && draft.pr.state !== 'OPEN';
  const blocked = !body.trim() || prClosed || !!draft?.unresolved.length || loading;

  return (
    <Dialog open={!!reviewRef} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        title="Post these findings to the PR"
        description={
          draft?.prUrl
            ? `Posting as ${draft.viewer || 'your gh account'} to ${draft.prUrl.replace('https://github.com/', '')}${draft.pr?.state ? ` (${draft.pr.state})` : ''}`
            : 'Preparing the comment…'
        }
      >
        {error ? <p role="alert" className="mt-0 text-xs font-semibold text-critical">{error}</p> : null}
        {issues?.length ? (
          <ul className="mt-0 mb-2 list-disc pl-5 text-xs text-critical">
            {issues.map((i) => <li key={i}>{i}</li>)}
          </ul>
        ) : null}

        {draft?.postedComments.length ? (
          <p className="mt-0 mb-2 text-xs text-muted">
            Already posted once from this review.{' '}
            {draft.postedComments[draft.postedComments.length - 1].commentUrl ? (
              <a href={draft.postedComments[draft.postedComments.length - 1].commentUrl!} target="_blank" rel="noopener" className="text-accent">
                See the existing comment
              </a>
            ) : null}
            . Posting again adds a second comment.
          </p>
        ) : null}

        {prClosed ? (
          <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-warning">
            This PR is {draft?.pr?.state} - posting findings now is probably not what you want.
          </p>
        ) : null}
        {draft?.prError ? (
          <p className="mt-0 mb-2 text-xs text-muted">Could not confirm the PR state: {draft.prError}</p>
        ) : null}

        <div className="mb-2 flex flex-wrap items-center gap-3">
          {ALL.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-fg-2">
              <input
                type="checkbox"
                checked={severities.includes(s)}
                onChange={() => toggle(s)}
                aria-label={`Include ${s} findings`}
              />
              {s} {draft ? `(${draft.bySeverity[s] ?? 0})` : ''}
            </label>
          ))}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'Edit' : 'Preview'}
          </Button>
        </div>

        {draft?.warnings.length ? (
          <p className="mt-0 mb-2 text-xs text-muted">{draft.warnings.join(' ')}</p>
        ) : null}
        {draft?.unclassified.length ? (
          <p className="mt-0 mb-2 text-xs text-muted">
            {draft.unclassified.length} finding(s) could not be sorted by severity and are not included.
          </p>
        ) : null}
        {draft?.unresolved.length ? (
          <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-critical">
            {draft.unresolved.length} line(s) still name internal tooling
            ({draft.unresolved.map((u) => `line ${u.line}: "${u.hit}"`).join(', ')}) - edit them before posting.
          </p>
        ) : null}

        {loading && !draft ? (
          <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Drafting" /> Drafting the comment…</p>
        ) : showPreview ? (
          <div className="max-h-[280px] overflow-y-auto rounded-[9px] border border-border px-3 py-2">
            <Markdown source={body} empty="Nothing selected." />
          </div>
        ) : (
          <Textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); setEdited(true); setArmed(false); }}
            aria-label="Comment body"
            className="min-h-[220px] w-full resize-y font-mono text-[12px]"
          />
        )}

        <p className="mt-2 mb-0 text-[11px] text-muted">
          {draft?.findingCount ?? 0} finding(s) selected · {bytes} bytes
          {edited ? ' · edited' : ''}
          {draft && draft.lint.count === 0 && !draft.unresolved.length ? ' · reads as your own words' : ''}
        </p>

        {armed ? (
          <p className="mt-2 mb-0 text-xs leading-relaxed text-fg-2">
            This posts a public comment on someone else&apos;s PR under your GitHub account. You can
            edit or delete it afterwards, but the author is notified immediately and that cannot be undone.
          </p>
        ) : null}

        <DialogFooter>
          {draft?.findingCount === 0 ? (
            <Badge>nothing selected at these severities</Badge>
          ) : null}
          {!armed ? (
            <Button variant="ship" disabled={blocked || draft?.findingCount === 0} onClick={() => setArmed(true)}>
              Continue…
            </Button>
          ) : (
            <Button variant="ship" disabled={posting} onClick={() => void post()}>
              {posting ? <Spinner /> : null}
              Post this comment as {draft?.viewer || 'me'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
