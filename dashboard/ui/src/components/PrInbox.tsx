import { RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { LiveDot, Spinner } from '@/components/ui/spinner';
import { Table, TableScroll, Td, Th, Tr } from '@/components/ui/table';
import { Tabs, TabsContent, SegmentedList, SegmentedTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { useResource } from '@/hooks/useResource';
import { api, postJson } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { blocker } from '@/lib/prInbox';
import type { PrInboxRow, PrInboxState } from '@/lib/types';

/** GitHub drops a review request the moment any review is submitted, so a strict "requested"
 *  list silently loses work that is still yours. Stated on the surface rather than buried. */
const FOOTNOTE =
  'Needs review = GitHub still lists you as a reviewer, plus PRs where you asked for changes or '
  + 'the branch moved since your review. GitHub drops the request as soon as you submit any review, '
  + 'and PRs you review without being asked are not listed.';

const DECISION_TONE = {
  APPROVED: 'good',
  CHANGES_REQUESTED: 'warning',
  REVIEW_REQUIRED: 'phase',
} as const;

function RowStatus({ row }: { row: PrInboxRow }) {
  const block = blocker(row);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.isDraft ? <Badge>draft</Badge> : null}
      {row.reviewDecision ? (
        <Badge tone={DECISION_TONE[row.reviewDecision]}>{row.reviewDecision.replace('_', ' ').toLowerCase()}</Badge>
      ) : null}
      {row.requestedVia?.kind === 'team' ? (
        <Tooltip label={`Requested via the ${row.requestedVia.label} team, not you directly`}>
          <Badge tone="accent">via team</Badge>
        </Tooltip>
      ) : null}
      {row.myReviewState === 'CHANGES_REQUESTED' ? <Badge tone="warning">you asked changes</Badge> : null}
      {row.myReviewStale ? (
        <Tooltip label="The head commit is newer than your last review. Based on commit date, so a rebase can trip it.">
          <Badge tone="warning">branch moved</Badge>
        </Tooltip>
      ) : null}
      {block ? (
        <Tooltip label={block.why}>
          <Badge tone={block.tone}>{block.label}</Badge>
        </Tooltip>
      ) : row.state === 'OPEN' && !row.isDraft && row.mergeable ? (
        <Tooltip label="No conflicts, checks green, and the required approvals are in.">
          <Badge tone="good">ready to merge</Badge>
        </Tooltip>
      ) : null}
    </span>
  );
}

function ReviewCell({ row, onOpenReview }: { row: PrInboxRow; onOpenReview: (ref: string) => void }) {
  if (!row.review) return <span className="text-muted">—</span>;
  if (row.review.running) {
    return <span className="inline-flex items-center gap-1.5"><LiveDot /> running</span>;
  }
  return (
    <button
      type="button"
      className="cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] text-fg hover:text-accent"
      onClick={(e) => { e.stopPropagation(); onOpenReview(row.review!.ref); }}
    >
      {row.reviewStatus === 'done-stale'
        ? `reviewed ${shortDate(row.review.updatedAt)} · branch moved since`
        : row.review.result || row.reviewStatus}
    </button>
  );
}

export function PrInbox({
  onOpenReview,
  onReviewStarted,
}: {
  onOpenReview: (ref: string) => void;
  onReviewStarted: () => void;
}) {
  const { data, error, refresh } = useResource<PrInboxState>((signal) => api.prInbox(signal));
  const [starting, setStarting] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const startReview = useCallback(async (row: PrInboxRow) => {
    setStarting(row.id);
    try {
      const r = await postJson<{ ref: string }>('/api/pr-review', { prUrl: row.url });
      toast.success(`${row.repo}#${row.number} — review started`, { description: r.ref });
      refresh();
      onReviewStarted();
    } catch (e) {
      toast.error(`${row.repo}#${row.number} — could not start the review`, {
        description: e instanceof Error ? e.message : String(e),
        duration: 8000,
      });
    } finally {
      setStarting(null);
    }
  }, [refresh, onReviewStarted]);

  const sweep = useCallback(async () => {
    setSweeping(true);
    try {
      await postJson('/api/pr-inbox-scan', {});
      refresh();
    } catch (e) {
      toast.error('Could not refresh the PR inbox', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSweeping(false);
    }
  }, [refresh]);

  const rows = data?.rows || [];
  const requested = rows.filter((r) => r.bucket === 'requested');
  const mine = rows.filter((r) => r.bucket === 'mine');
  const full = !!data && data.capacity.running >= data.capacity.max;
  const failedRepos = (data?.repos || []).filter((r) => !r.ok);
  const truncated = (data?.repos || []).filter((r) => r.truncated);

  const actionFor = (row: PrInboxRow) => {
    if (row.review?.running) {
      return <Button size="sm" disabled><LiveDot /> running</Button>;
    }
    const label = row.reviewStatus === 'never' ? 'Review' : 'Re-review';
    if (!row.inManifest) {
      return (
        <Tooltip label={`${row.repoSlug} is not in repo-manifest.json, so a review would hard-stop on an unknown repo. Add it to the manifest first.`}>
          <Button size="sm" variant="muted" disabled>{label}</Button>
        </Tooltip>
      );
    }
    if (full) {
      return (
        <Tooltip label={`${data!.capacity.max} reviews are already running - wait for a slot`}>
          <Button size="sm" disabled>{label}</Button>
        </Tooltip>
      );
    }
    return (
      <Button
        size="sm"
        variant="primary"
        disabled={starting === row.id}
        aria-label={`Review ${row.repoSlug}#${row.number}`}
        onClick={(e) => { e.stopPropagation(); void startReview(row); }}
      >
        {starting === row.id ? 'Starting…' : label}
      </Button>
    );
  };

  const table = (list: PrInboxRow[], tab: 'requested' | 'mine', empty: string) => (
    <TableScroll>
      <Table>
        <thead>
          <Tr>
            <Th>PR</Th>
            <Th>Title</Th>
            <Th>{tab === 'mine' ? 'Base' : 'Author'}</Th>
            <Th>Status</Th>
            <Th>Review</Th>
            <Th>Updated</Th>
            <Th><span className="sr-only">Actions</span></Th>
          </Tr>
        </thead>
        <tbody>
          {list.length === 0 ? (
            <Tr><Td className="text-muted" colSpan={7}>{empty}</Td></Tr>
          ) : list.map((row) => (
            <Tr key={row.id}>
              <Td>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="font-mono text-accent"
                >
                  {row.repo}#{row.number}
                </a>
              </Td>
              <Td className="max-w-[320px] truncate" title={row.title}>{row.title}</Td>
              <Td className="text-muted">{tab === 'mine' ? row.baseRefName : row.author}</Td>
              <Td><RowStatus row={row} /></Td>
              <Td><ReviewCell row={row} onOpenReview={onOpenReview} /></Td>
              <Td className="text-muted">{shortDate(row.updatedAt)}</Td>
              <Td>{actionFor(row)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Inbox</CardTitle>
        <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {data?.login ? <span>as {data.login}</span> : null}
          {data?.at ? <span>· updated {shortDate(data.at)}{data.stale ? ' (stale)' : ''}</span> : null}
          <Button size="sm" variant="ghost" disabled={sweeping || data?.sweeping} onClick={() => void sweep()}>
            {sweeping || data?.sweeping ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
            Refresh
          </Button>
        </span>
      </CardHeader>
      <CardBody>
        {error ? <p role="alert" className="mt-0 text-xs font-semibold text-critical">{error}</p> : null}

        {data?.error ? (
          <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-critical">
            {data.error} — the rows below, if any, are from an earlier sweep.
          </p>
        ) : null}

        {data?.loginMismatch ? (
          <p role="alert" className="mt-0 mb-2 text-xs font-semibold text-warning">
            gh&apos;s active account is {data.login}, but the config expects a different one. This is{' '}
            {data.login}&apos;s inbox. Run `gh auth switch` if that is wrong.
          </p>
        ) : null}

        {failedRepos.length ? (
          <p className="mt-0 mb-2 text-xs text-muted">
            {failedRepos.length} of {data!.repos.length} repos could not be refreshed
            ({failedRepos.map((r) => `${r.slug.split('/')[1]}: ${r.error?.kind}`).join(', ')}) — their rows are older.
          </p>
        ) : null}

        {truncated.length ? (
          <p className="mt-0 mb-2 text-xs text-muted">
            {truncated.map((r) => r.slug).join(', ')} has more open PRs than this list shows.
          </p>
        ) : null}

        {data?.pending ? (
          <p className="mt-0 flex items-center gap-2 text-[13px] text-muted">
            <Spinner label="Fetching your PRs" /> Fetching from GitHub…
          </p>
        ) : (
          <Tabs defaultValue="requested">
            <SegmentedList>
              <SegmentedTrigger value="requested">Needs review {requested.length}</SegmentedTrigger>
              <SegmentedTrigger value="mine">Mine {mine.length}</SegmentedTrigger>
            </SegmentedList>
            <TabsContent value="requested">
              {table(requested, 'requested', 'Nothing is waiting on your review.')}
            </TabsContent>
            <TabsContent value="mine">
              {table(mine, 'mine', 'You have no open PRs.')}
            </TabsContent>
          </Tabs>
        )}

        <p className="mt-2 mb-0 text-[11px] leading-relaxed text-muted">{FOOTNOTE}</p>
      </CardBody>
    </Card>
  );
}
