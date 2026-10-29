import { GitPullRequest, Search } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { FindingsTriage } from '@/components/FindingsTriage';
import { LogView } from '@/components/LogView';
import { PostFindingsDialog } from '@/components/PostFindingsDialog';
import { PostReviewDialog } from '@/components/PostReviewDialog';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useResource } from '@/hooks/useResource';
import { api, postJson } from '@/lib/api';
import { logLines, money } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import type { FindingRow, FindingsState, PrReviewDetail } from '@/lib/types';
import { reviewCommands, type Command } from '../commands';
import { useV2 } from '../data';
import { useStartExplain, useStartReview } from '../dispatch';
import { ExplainTab, useExplainerFor } from '../explain/ExplainTab';
import { Chip, Menu, MenuItem } from '../Menu';
import { Composer } from './Composer';
import { ThreadHeader } from './ThreadHeader';

const SEV_RANK = { high: 0, medium: 1, low: 2 } as const;

interface FindingFilter { q: string; severity: string[]; verdict: string[]; decision: string[]; since: string[]; sort: 'severity' | 'file' }
const EMPTY: FindingFilter = { q: '', severity: [], verdict: [], decision: [], since: [], sort: 'severity' };

const FACETS: { id: keyof Omit<FindingFilter, 'q' | 'sort'>; label: string; value: (r: FindingRow) => string }[] = [
  { id: 'severity', label: 'Severity', value: (r) => r.severity },
  { id: 'verdict', label: 'Second look', value: (r) => r.verdict },
  { id: 'decision', label: 'Decision', value: (r) => r.decision || 'undecided' },
  { id: 'since', label: 'Round', value: (r) => r.since || 'first round' },
];

/** Filter and sort a review's findings before they reach the triage list. */
export function filterFindings(f: FindingsState, flt: FindingFilter): FindingsState {
  const words = flt.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = f.rows.filter((r) => FACETS.every((x) => !flt[x.id].length || flt[x.id].includes(x.value(r)))
    && words.every((w) => `${r.title} ${r.body} ${r.fix} ${r.axis} ${r.evidence.map((e) => e.file).join(' ')}`.toLowerCase().includes(w)));
  const sorted = flt.sort === 'file'
    ? [...rows].sort((a, b) => (a.evidence[0]?.file || '~').localeCompare(b.evidence[0]?.file || '~') || (a.evidence[0]?.line || 0) - (b.evidence[0]?.line || 0))
    : [...rows].sort((a, b) => Number(a.folded) - Number(b.folded) || SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  return { ...f, rows: sorted };
}

export function ReviewThread({ reviewRef }: { reviewRef: string }) {
  const fetcher = useCallback((signal: AbortSignal) => api.prReview(reviewRef, signal), [reviewRef]);
  const { data, error, refresh } = useResource<PrReviewDetail>(fetcher, [reviewRef]);
  const d = data && data.ref === reviewRef ? data : null;
  const { refreshReviews } = useV2();
  const startReview = useStartReview();
  const startExplain = useStartExplain();
  const [tab, setTab] = useState('findings');
  const [flt, setFlt] = useState<FindingFilter>(EMPTY);
  const [postFindings, setPostFindings] = useState<string | null>(null);
  const [postComment, setPostComment] = useState<string | null>(null);
  const explainer = useExplainerFor(d?.prUrl);
  const shown = useMemo(() => (d?.findings ? filterFindings(d.findings, flt) : null), [d, flt]);

  if (!d) {
    return (
      <>
        <ThreadHeader title={<span className="font-mono">{reviewRef}</span>} subtitle={error ? `Could not load: ${error}` : 'Loading…'} />
        {!error ? <p className="flex items-center gap-2 p-4 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p> : null}
      </>
    );
  }

  const run = async (c: Command) => {
    const a = c.action;
    if (a.type === 'post') { if (d.findings) setPostFindings(d.ref); else setPostComment(d.ref); return; }
    if (a.type === 'rerun' && d.prUrl) { await startReview(d.prUrl, d.ref); refresh(); return; }
    if (a.type === 'explain' && d.prUrl) { await startExplain(d.prUrl); return; }
    if (a.type === 'accept-verified' && d.findings) {
      const fps = d.findings.rows.filter((r) => !r.folded && r.verdict === 'confirmed' && !r.decision).map((r) => r.fingerprint);
      try { await postJson('/api/pr-review-triage', { ref: d.ref, fingerprints: fps, decision: 'accept' }); refresh(); refreshReviews(); }
      catch (e) { toast.error('Could not save that', { description: e instanceof Error ? e.message : String(e) }); }
    }
  };
  const num = d.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  const repo = d.prUrl?.match(/github\.com\/[^/]+\/([^/]+)\//)?.[1] || '';
  const filtersOn = flt.q || FACETS.some((x) => flt[x.id].length);

  return (
    <>
      <ThreadHeader
        starId={d.ref}
        title={<span className="font-mono">{repo ? `${repo.replace(/^erp-next-/, '')}#${num}` : d.ref}</span>}
        subtitle={d.title}
        links={d.prUrl ? [{ href: d.prUrl, label: 'PR', icon: <GitPullRequest size={13} aria-hidden /> }] : []}
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge>{d.isOwn === true ? 'your PR' : d.isOwn === false ? "someone else's PR" : 'owner unknown'}</Badge>
          {d.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />reviewing</Badge>
            : d.result ? <Badge tone={d.failure ? 'critical' : d.result === 'needs-input' ? 'accent' : undefined}>{d.result}</Badge> : null}
          {d.postedComments?.length ? <Badge tone="good">posted</Badge> : null}
          {d.costUsd ? <span className="text-[12px] text-muted">{money(d.costUsd)}</span> : null}
        </div>
        {!d.running && d.result === 'needs-input' ? (
          <p role="alert" className="mt-2 mb-0 rounded-lg bg-accent-soft px-2.5 py-2 text-[12.5px] text-fg-2">
            <strong className="text-accent">This run stopped to ask you something.</strong> {d.question ? `“${d.question}”` : ''} Answer it, then /rerun.
          </p>
        ) : !d.running && d.failure ? (
          <p role="alert" className="mt-2 mb-0 rounded-lg bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2.5 py-2 text-[12.5px] text-fg-2">
            <strong className="text-critical">This run failed.</strong> {d.failure}
            {d.prUrl ? (
              <span className="mt-1.5 block">
                <button type="button" onClick={() => void startReview(d.prUrl as string, d.ref).then(() => refresh())}
                  className="cursor-pointer rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[12px] font-semibold text-fg hover:bg-surface-2">
                  Retry the review
                </button>
                <span className="ml-2 text-muted">It starts again from the beginning.</span>
              </span>
            ) : null}
          </p>
        ) : null}
      </ThreadHeader>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="px-3">
          <TabsTrigger value="findings">{d.findings ? `Findings ${d.findings.counts.total}` : 'Report'}</TabsTrigger>
          {d.findings ? <TabsTrigger value="report">Report</TabsTrigger> : null}
          {d.artifacts.quality ? <TabsTrigger value="quality">Quality</TabsTrigger> : null}
          <TabsTrigger value="log">Log</TabsTrigger>
          {explainer ? <TabsTrigger value="explain">Explain</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="findings" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {d.findings && shown ? (
            <>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <label className="flex min-w-[140px] flex-1 items-center gap-1.5 rounded-[8px] border border-border-strong bg-surface px-2.5 py-[4px] focus-within:border-accent">
                  <Search size={13} aria-hidden className="text-muted" />
                  <input value={flt.q} onChange={(e) => setFlt({ ...flt, q: e.target.value })} placeholder="Filter findings" aria-label="Filter findings" className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12.5px] text-fg outline-none placeholder:text-muted" />
                </label>
                {FACETS.map((x) => {
                  const opts = [...new Set(d.findings!.rows.map(x.value))];
                  if (opts.length < 2 && !flt[x.id].length) return null;
                  return (
                    <Menu key={x.id} label={`Filter by ${x.label.toLowerCase()}`} trigger={() => <Chip active={flt[x.id].length > 0}>{x.label}{flt[x.id].length ? `: ${flt[x.id].length === 1 ? flt[x.id][0] : flt[x.id].length}` : ''}</Chip>}>
                      {() => opts.map((o) => (
                        <MenuItem key={o} checked={flt[x.id].includes(o)} hint={d.findings!.rows.filter((r) => x.value(r) === o).length}
                          onSelect={() => setFlt({ ...flt, [x.id]: flt[x.id].includes(o) ? flt[x.id].filter((v) => v !== o) : [...flt[x.id], o] })}>{o}</MenuItem>
                      ))}
                    </Menu>
                  );
                })}
                <button type="button" onClick={() => setFlt({ ...flt, sort: flt.sort === 'severity' ? 'file' : 'severity' })} className="cursor-pointer border-0 bg-transparent p-0">
                  <Chip>{flt.sort === 'severity' ? 'By severity' : 'By file'}</Chip>
                </button>
                {filtersOn ? (
                  <button type="button" onClick={() => setFlt(EMPTY)} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-accent hover:underline">
                    Clear · {shown.rows.length} of {d.findings.rows.length}
                  </button>
                ) : null}
              </div>
              <FindingsTriage reviewRef={d.ref} findings={shown} prUrl={d.prUrl} locked={d.running} onChange={() => { refresh(); refreshReviews(); }} />
            </>
          ) : <div className="pt-2"><Markdown source={d.artifacts.review} /></div>}
        </TabsContent>
        {d.findings ? <TabsContent value="report" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><Markdown source={d.artifacts.review} /></TabsContent> : null}
        {d.artifacts.quality ? (
          <TabsContent value="quality" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <pre className="overflow-x-auto rounded-[9px] bg-log-bg px-3 py-2.5 font-mono text-[11.5px] text-log-fg">{pretty(d.artifacts.quality)}</pre>
          </TabsContent>
        ) : null}
        <TabsContent value="log" className="min-h-0 flex-1 px-4 pb-4">
          <LogView className="h-full max-h-none" label={`Run log for ${d.ref}`} lines={logLines(d.artifacts.log)} empty="No log yet." />
        </TabsContent>
        {explainer ? <TabsContent value="explain" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><ExplainTab slug={explainer} /></TabsContent> : null}
      </Tabs>

      <Composer commands={reviewCommands(d)} onRun={(c) => run(c)} placeholder="Type / for commands" />
      <PostFindingsDialog reviewRef={postFindings} onClose={() => setPostFindings(null)} onPosted={() => { refresh(); refreshReviews(); }} />
      <PostReviewDialog reviewRef={postComment} onClose={() => setPostComment(null)} onPosted={() => { refresh(); refreshReviews(); }} />
    </>
  );
}

function pretty(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
