import { useCallback, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { LiveDot, Spinner } from '@/components/ui/spinner';
import { Table, TableScroll, Td, Th, Tr } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { LogView } from '@/components/LogView';
import { FindingsTriage } from '@/components/FindingsTriage';
import { PostFindingsDialog } from '@/components/PostFindingsDialog';
import { PostReviewDialog } from '@/components/PostReviewDialog';
import { PrInbox } from '@/components/PrInbox';
import { useResource } from '@/hooks/useResource';
import { api, postJson } from '@/lib/api';
import { logLines, shortDate } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import type { PrReviewDetail, PrReviewsState } from '@/lib/types';

const owner = (isOwn: boolean | null) => (isOwn === true ? 'you' : isOwn === false ? 'other' : '—');

const FAILED_RESULTS = new Set(['failed', 'cancelled', 'blocked']);
const isFailed = (result: string | null) => !!result && FAILED_RESULTS.has(result.toLowerCase());

/** How to colour a finished review's result badge. `retryable` without an outright failure is
 * a stalled run — e.g. a stale "in-progress" whose process is long gone — and must not wear
 * the same neutral chip as a review that genuinely completed. */
function resultTone(r: { result: string | null; retryable: boolean }) {
  if (isFailed(r.result)) return 'critical' as const;
  // Nothing failed and nothing completed: the run is waiting on an answer.
  if (r.result === 'needs-input') return 'accent' as const;
  if (r.retryable) return 'warning' as const;
  return undefined;
}

/**
 * Start (or restart) a review for a known PR URL.
 *
 * A retry is the same `POST /api/pr-review` as a first run — `/review-pr` keeps no stage
 * checkpoints, so there is nothing to resume and every retry re-reviews from scratch. The
 * endpoint 409s when a run is already active for the ref, which surfaces here as the error.
 */
function useStartReview(refresh: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  const start = useCallback(async (prUrl: string, label: string) => {
    setPending(prUrl);
    try {
      const r = await postJson<{ ref: string }>('/api/pr-review', { prUrl });
      toast.success(`${label} — review started`, { description: r.ref });
      refresh();
      return r.ref;
    } catch (err) {
      toast.error(`${label} — could not start the review`, {
        description: err instanceof Error ? err.message : String(err),
        duration: 8000,
      });
      return null;
    } finally {
      setPending(null);
    }
  }, [refresh]);
  return { start, pending };
}

export function PrReview() {
  const { data, error, loading, refresh } = useResource<PrReviewsState>((signal) => api.prReviews(signal));
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailRef, setDetailRef] = useState<string | null>(null);
  const { start: startReview, pending: retryPending } = useStartReview(refresh);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const prUrl = url.trim();
    if (!prUrl) { setFormError('Paste a PR URL first.'); return; }
    setFormError(null);
    setBusy(true);
    try {
      const r = await postJson<{ ref: string }>('/api/pr-review', { prUrl });
      setUrl('');
      toast.success('Review started', { description: r.ref });
      refresh();
      setDetailRef(r.ref);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const reviews = data?.reviews || [];

  return (
    <>
      <form
        onSubmit={submit}
        className="rounded-panel border border-border bg-surface p-4 shadow-card"
        aria-label="Review a PR"
      >
        <p className="m-0 mb-2.5 text-[11px] font-bold uppercase tracking-[.05em] text-muted">Review a PR</p>
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            value={url}
            onChange={(e) => { setUrl(e.target.value); if (formError) setFormError(null); }}
            spellCheck={false}
            autoComplete="off"
            aria-label="GitHub PR URL"
            aria-invalid={formError ? true : undefined}
            placeholder="https://github.com/acme-it-erp/<repo>/pull/<n>"
            className="min-w-[260px] flex-1"
          />
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            {busy ? 'Starting…' : 'Review'}
          </Button>
        </div>
        {formError ? (
          <p role="alert" className="mt-2 mb-0 text-xs font-semibold text-critical">{formError}</p>
        ) : (
          <p className="mt-2 mb-0 text-xs leading-relaxed text-muted">
            If the PR is yours, findings that pass the fix-severity bar get auto-fixed and pushed to the
            same branch. If it isn't yours, this only ever produces a report below — nothing is posted
            to GitHub.
          </p>
        )}
      </form>

      <PrInbox onOpenReview={setDetailRef} onReviewStarted={refresh} />

      <Card className="mt-4">
        <CardHeader><CardTitle>Reviews</CardTitle></CardHeader>
        {error ? (
          <p role="alert" className="px-5 pb-4 text-[13px] text-critical">Could not load reviews: {error}</p>
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>PR</Th><Th>Title</Th><Th>Owner</Th><Th>Result</Th><Th>Updated</Th>
                  <Th><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr><Td colSpan={6} className="text-muted">Loading…</Td></tr>
                ) : reviews.length === 0 ? (
                  <tr><Td colSpan={6} className="text-muted">No reviews yet — paste a PR URL above.</Td></tr>
                ) : reviews.map((r) => (
                  <Tr key={r.ref} className="cursor-pointer">
                    <Td>
                      {r.prUrl ? (
                        <a
                          href={r.prUrl}
                          target="_blank"
                          rel="noopener"
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-accent"
                        >
                          #{r.ref.split('-').pop()}
                        </a>
                      ) : <span className="font-mono text-muted">{r.ref}</span>}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setDetailRef(r.ref)}
                        className="cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] text-fg hover:text-accent"
                      >
                        {r.title || r.ref}
                      </button>
                    </Td>
                    <Td>{owner(r.isOwn)}</Td>
                    <Td>
                      {r.running
                        ? <span className="inline-flex items-center gap-1.5"><LiveDot /> running</span>
                        : r.resultUnrecorded
                          ? <Badge>finished</Badge>
                          : r.result
                            ? <Badge tone={resultTone(r)}>{r.result}</Badge>
                            : <span className="text-muted">—</span>}
                      {!r.running && r.resultUnrecorded ? (
                        <span className="mt-1 block max-w-[280px] text-[11px] leading-snug text-muted">
                          report on disk; the run was killed before its outcome was recorded
                        </span>
                      ) : null}
                      {!r.running && (r.question || r.failure) ? (
                        <span className="mt-1 block max-w-[280px] text-[11px] leading-snug text-muted">
                          {r.result === 'needs-input' ? `asked: ${r.question || r.failure}` : r.failure}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-muted">{shortDate(r.updatedAt)}</Td>
                    <Td>
                      {r.retryable && r.prUrl ? (
                        <Button
                          size="sm"
                          disabled={retryPending === r.prUrl}
                          aria-label={`Retry the review for ${r.ref}`}
                          onClick={(e) => {
                            e.stopPropagation(); // the row is styled clickable — don't also open the drawer
                            void startReview(r.prUrl as string, r.ref);
                          }}
                        >
                          {retryPending === r.prUrl ? 'Starting…' : 'Retry'}
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      <ReviewDrawer reviewRef={detailRef} onClose={() => setDetailRef(null)} onRetried={refresh} />
    </>
  );
}

function ReviewDrawer({
  reviewRef,
  onClose,
  onRetried,
}: {
  reviewRef: string | null;
  onClose: () => void;
  onRetried: () => void;
}) {
  const fetcher = useCallback(
    (signal: AbortSignal) => (reviewRef ? api.prReview(reviewRef, signal) : Promise.resolve(null)),
    [reviewRef],
  );
  const { data, error, refresh } = useResource<PrReviewDetail | null>(fetcher, [reviewRef]);
  const detail = data && data.ref === reviewRef ? data : null;
  const [postRef, setPostRef] = useState<string | null>(null);
  const posted = detail?.postedComments || [];
  const postedAt = posted.length ? posted[posted.length - 1].at : null;
  // Why a review may not be published. Mirrors the server's own refusals so the button explains
  // itself instead of failing on click. `retryable` covers failed/blocked/in-progress/no-result
  // in one predicate: a partial report is the worst thing to put on a colleague's PR.
  const postBlockedReason = !detail ? null
    : detail.running ? 'The review is still running.'
    : !detail.artifacts.review?.trim() ? 'This review produced no report to post.'
    : detail.retryable ? 'This run did not finish cleanly - re-run it before posting a partial report.'
    : detail.resultUnrecorded ? 'This run was killed before its outcome was recorded - re-run it before posting.'
    : detail.isOwn === true && detail.result === 'pushed-fix' ? 'The findings were already fixed and pushed to this branch.'
    : null;
  const canPost = !!detail && !postBlockedReason;
  // Structured findings post as one review of the accepted rows; older reviews keep the
  // severity-bucket comment.
  const findings = detail?.findings || null;
  const findingsBlockedReason = !findings ? null
    : findings.counts.toPost ? null
    : findings.counts.posted && findings.counts.accept ? 'Everything you accepted is already on the PR.'
    : 'Accept at least one finding to post it.';
  const [postFindingsRef, setPostFindingsRef] = useState<string | null>(null);
  const { start, pending } = useStartReview(() => { refresh(); onRetried(); });

  return (
    <Sheet open={reviewRef !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {reviewRef ? (
        <SheetContent
          title={
            detail?.prUrl ? (
              <a href={detail.prUrl} target="_blank" rel="noopener" className="font-mono text-sm font-bold text-accent">
                {reviewRef}
              </a>
            ) : <span className="font-mono text-sm font-bold text-fg">{reviewRef}</span>
          }
          description={detail?.title || 'Loading…'}
        >
          {error ? (
            <p className="text-[13px] text-critical">Failed to load: {error}</p>
          ) : !detail ? (
            <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Loading review" /> Loading…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge>{owner(detail.isOwn)}</Badge>
                {detail.result ? (
                  <Badge tone={resultTone(detail) ?? 'accent'}>{detail.result}</Badge>
                ) : null}
                {detail.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />running</Badge> : null}
                {postedAt ? <Badge tone="good">posted</Badge> : null}
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {canPost && findings ? (
                    findingsBlockedReason ? (
                      <Tooltip label={findingsBlockedReason}>
                        <Button variant="muted" disabled>Post accepted…</Button>
                      </Tooltip>
                    ) : (
                      <Tooltip label="Post the accepted findings as one review on the PR, inline where they point at changed lines. You preview it first.">
                        <Button variant="ship" onClick={() => setPostFindingsRef(detail.ref)}>
                          Post {findings.counts.toPost} accepted…
                        </Button>
                      </Tooltip>
                    )
                  ) : canPost ? (
                    <Tooltip label="Draft a comment from these findings and post it to the PR under your GitHub account. You preview and can edit it first.">
                      <Button variant="ship" onClick={() => setPostRef(detail.ref)}>Post to GitHub…</Button>
                    </Tooltip>
                  ) : postBlockedReason ? (
                    <Tooltip label={postBlockedReason}>
                      <Button variant="muted" disabled>Post to GitHub…</Button>
                    </Tooltip>
                  ) : null}
                  {!detail.running && detail.prUrl ? (
                    <Button
                      disabled={pending === detail.prUrl}
                      aria-label={`${detail.retryable ? 'Retry' : 'Re-run'} the review for ${detail.ref}`}
                      onClick={() => void start(detail.prUrl as string, detail.ref)}
                    >
                      {pending === detail.prUrl ? 'Starting…' : detail.retryable ? 'Retry' : 'Re-run'}
                    </Button>
                  ) : null}
                </span>
              </div>

              {!detail.running && detail.result === 'needs-input' ? (
                <p
                  role="alert"
                  className="mt-3 mb-0 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-accent-soft px-2.5 py-2 text-xs leading-snug text-fg-2"
                >
                  <strong className="text-accent">This run stopped to ask you something.</strong>{' '}
                  It did not review the PR, so the report below is from an earlier run.
                  {detail.question ? <> The question was: “{detail.question}”</> : null}
                  {' '}Answer it, then Re-review.
                </p>
              ) : !detail.running && detail.failure ? (
                <p
                  role="alert"
                  className="mt-3 mb-0 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,var(--border))] bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2.5 py-2 text-xs leading-snug text-fg-2"
                >
                  <strong className="text-critical">This run failed.</strong> {detail.failure}
                  {' '}Retry re-reviews the PR from the start — there is no partial state to resume.
                </p>
              ) : null}

              {findings ? (
                <>
                  <FindingsTriage
                    reviewRef={detail.ref}
                    findings={findings}
                    prUrl={detail.prUrl}
                    locked={detail.running}
                    onChange={refresh}
                  />
                  <details className="mt-4">
                    <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[.05em] text-muted">Full report</summary>
                    <div className="mt-2"><Markdown source={detail.artifacts.review} /></div>
                  </details>
                </>
              ) : (
                <section className="mt-4">
                  <h3 className="m-0 mb-2 text-[11px] font-bold uppercase tracking-[.05em] text-muted">Review</h3>
                  <Markdown source={detail.artifacts.review} />
                </section>
              )}

              {detail.artifacts.quality ? (
                <section className="mt-4">
                  <h3 className="m-0 mb-2 font-mono text-[11px] font-bold uppercase tracking-[.05em] text-muted">
                    quality-inputs.json
                  </h3>
                  <pre className="overflow-x-auto rounded-[9px] bg-log-bg px-3 py-2.5 font-mono text-[11.5px] text-log-fg">
                    {prettyJson(detail.artifacts.quality)}
                  </pre>
                </section>
              ) : null}

              <section className="mt-4">
                <h3 className="m-0 mb-2 text-[11px] font-bold uppercase tracking-[.05em] text-muted">Log</h3>
                <LogView
                  className="max-h-[300px]"
                  label={`Run log for ${reviewRef}`}
                  lines={logLines(detail.artifacts.log)}
                  empty="No log yet."
                />
              </section>
            </>
          )}
        </SheetContent>
      ) : null}
      <PostReviewDialog reviewRef={postRef} onClose={() => setPostRef(null)} onPosted={() => { refresh(); onRetried(); }} />
      <PostFindingsDialog reviewRef={postFindingsRef} onClose={() => setPostFindingsRef(null)} onPosted={() => { refresh(); onRetried(); }} />
    </Sheet>
  );
}

function prettyJson(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
