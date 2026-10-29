import { Check, CheckCircle2, GitCompare, MessageSquarePlus, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { useRuns } from '@/hooks/runs';
import { postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';
import type { PlanComment, PlanReview as Review, TicketCard } from '@/lib/types';
import { cn } from '@/lib/utils';

type Block = Review['blocks'][number];
interface DiffLine { type: 'same' | 'add' | 'del'; text: string }

const KIND_LABEL: Record<string, string> = { summary: 'Summary', ac: 'Acceptance criteria', parity: 'Legacy parity', risk: 'Risks', tests: 'Tests', questions: 'Questions', step: 'Step' };

/**
 * The plan as steps to review: comment on any block, re-plan with just those comments, see what
 * the re-plan changed, approve when nothing is left open. Comments live in plan-review.json
 * (panel-owned); the plan itself is never edited here.
 */
export function PlanReview({ card, review, onChange }: { card: TicketCard; review: Review; onChange: () => void }) {
  const { run, pending } = useRuns();
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [extra, setExtra] = useState('');
  const open = review.comments.filter((c) => !c.resolved && !c.sentAt);
  const byBlock = (id: string) => review.comments.filter((c) => c.blockId === id);
  const changedKind = (id: string) => (review.changed?.added.includes(id) ? 'new' : review.changed?.changed.includes(id) ? 'changed' : null);
  const acDone = review.checklist.filter((c) => c.done).length;
  const busy = card.running || !!pending[card.key];

  const comment = useCallback(async (body: Record<string, unknown>) => {
    try { await postJson('/api/plan-comment', { key: card.key, ...body }); onChange(); return true; }
    catch (e) { toast.error('Could not save the comment', { description: e instanceof Error ? e.message : String(e) }); return false; }
  }, [card.key, onChange]);

  const showDiff = async () => {
    if (diff) { setDiff(null); return; }
    if (!review.current || review.current < 2) return;
    setDiffBusy(true);
    try {
      const r = await fetch(`/api/plan-diff?key=${encodeURIComponent(card.key)}&from=${review.current - 1}&to=${review.current}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDiff(j.diff);
    } catch (e) { toast.error('Could not load the changes', { description: e instanceof Error ? e.message : String(e) }); }
    setDiffBusy(false);
  };

  if (!review.blocks.length) return <p className="text-[13px] text-muted">No plan.md yet. The plan appears here after the PLAN stage.</p>;

  return (
    <div className="pb-4">
      <div className="sticky top-0 z-10 -mx-4 mb-3 border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">Plan{review.current ? ` v${review.current}` : ''}</span>
          {review.checklist.length ? <Badge tone={acDone === review.checklist.length ? 'good' : undefined}>{acDone}/{review.checklist.length} criteria checked</Badge> : null}
          {review.changed ? <Badge tone="accent">{review.changed.added.length + review.changed.changed.length} block(s) changed since v{(review.current || 1) - 1}</Badge> : null}
          {review.current && review.current > 1 ? (
            <Button size="sm" variant="ghost" disabled={diffBusy} onClick={() => void showDiff()}>
              {diffBusy ? <Spinner /> : <GitCompare size={13} aria-hidden />}{diff ? 'Hide changes' : `Changes from v${review.current - 1}`}
            </Button>
          ) : null}
          <span className="flex-1" />
          <span className="text-[12px] text-muted">{open.length ? `${open.length} open comment${open.length === 1 ? '' : 's'}` : 'No open comments'}</span>
        </div>
        {card.planReady ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={open.length ? 'Anything else for the re-plan (optional)' : 'Comment on a step below to ask for changes'}
              aria-label="Extra notes for the re-plan"
              disabled={!open.length || busy}
              className="min-w-[200px] flex-1 rounded-[8px] border border-border-strong bg-page px-2.5 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
            />
            <Button
              disabled={!open.length || busy}
              onClick={async () => { if (await run(card.key, 'replan', { planComments: true, notes: extra.trim() || undefined })) { setExtra(''); onChange(); } }}
            >
              <RotateCcw size={13} aria-hidden />Re-plan with {open.length || ''} comment{open.length === 1 ? '' : 's'}
            </Button>
            <Tooltip label={open.length ? 'Resolve or send your open comments first - approving now would build without them.' : 'Runs build, verify and review. A PR opens only if the rubric receipt verifies. Never merges.'}>
              <span>
                <Button variant="approve" disabled={!!open.length || busy} onClick={() => void run(card.key, 'build')}>
                  <CheckCircle2 size={13} aria-hidden />Approve and build
                </Button>
              </span>
            </Tooltip>
          </div>
        ) : busy ? <p className="mt-1.5 mb-0 flex items-center gap-1.5 text-[12px] text-muted"><Spinner className="h-2.5 w-2.5 border" />A run is in progress - comments are still saved for the next re-plan.</p> : null}
      </div>

      {diff ? (
        <pre aria-label="Changes between plan versions" className="mb-4 max-h-[420px] overflow-auto rounded-[9px] border border-border bg-surface-2 p-0 font-mono text-[11.5px] leading-snug">
          {diff.filter((l, i, all) => l.type !== 'same' || all.slice(Math.max(0, i - 2), i + 3).some((x) => x.type !== 'same')).map((l, i) => (
            <div key={i} className={cn('px-3 whitespace-pre-wrap', l.type === 'add' && 'bg-[color-mix(in_srgb,var(--good)_14%,transparent)] text-fg', l.type === 'del' && 'bg-[color-mix(in_srgb,var(--critical)_12%,transparent)] text-fg-2 line-through decoration-[color-mix(in_srgb,var(--critical)_50%,transparent)]', l.type === 'same' && 'text-muted')}>
              {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text || ' '}
            </div>
          ))}
        </pre>
      ) : null}

      <ol className="m-0 grid min-w-0 grid-cols-1 list-none gap-2.5 p-0">
        {review.blocks.map((b) => <BlockCard key={b.id} block={b} comments={byBlock(b.id)} changed={changedKind(b.id)} onComment={comment} />)}
      </ol>
    </div>
  );
}

function BlockCard({ block, comments, changed, onComment }: {
  block: Block;
  comments: PlanComment[];
  changed: 'new' | 'changed' | null;
  onComment: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const openHere = comments.filter((c) => !c.resolved && !c.sentAt).length;
  return (
    <li
      id={`plan-${block.id}`}
      className={cn(
        'group min-w-0 rounded-panel border bg-surface px-3.5 py-2.5',
        openHere ? 'border-[color-mix(in_srgb,var(--warning)_50%,var(--border))]' : changed ? 'border-[color-mix(in_srgb,var(--accent)_40%,var(--border))]' : 'border-border',
        block.level === 3 && 'ml-4',
      )}
    >
      <div className="flex items-center gap-2">
        <h4 className={cn('m-0 min-w-0 flex-1 truncate font-semibold text-fg', block.level === 2 ? 'text-[13.5px]' : 'text-[13px]')}>{block.title}</h4>
        {KIND_LABEL[block.kind] && block.kind !== 'step' ? <span className="text-[11px] text-muted">{KIND_LABEL[block.kind]}</span> : null}
        {changed ? <Badge tone="accent">{changed}</Badge> : null}
        <button type="button" onClick={() => setWriting((w) => !w)} aria-label={`Comment on ${block.title}`} className="flex cursor-pointer items-center gap-1 rounded-[7px] border-0 bg-transparent px-1.5 py-1 text-[12px] font-semibold text-accent opacity-70 group-hover:opacity-100 hover:bg-surface-2">
          <MessageSquarePlus size={13} aria-hidden />Comment
        </button>
      </div>
      {block.body ? <div className="mt-1 min-w-0 text-[13px] [overflow-wrap:anywhere]"><Markdown source={block.body} /></div> : null}

      {comments.length ? (
        <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
          {comments.map((c) => (
            <li key={c.id} className={cn('rounded-[8px] border px-2.5 py-1.5 text-[12.5px]', c.resolved || c.sentAt ? 'border-border bg-surface-2 text-muted' : 'border-[color-mix(in_srgb,var(--warning)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_7%,var(--surface))] text-fg')}>
              <div className="flex items-start gap-2">
                <span className={cn('min-w-0 flex-1 whitespace-pre-wrap', c.resolved && 'line-through')}>{c.text}</span>
                {c.sentAt ? <Badge>sent{c.sentInVersion ? ` for v${c.sentInVersion}` : ''}</Badge> : null}
                {!c.sentAt ? (
                  <button type="button" aria-label={c.resolved ? 'Reopen the comment' : 'Resolve the comment'} title={c.resolved ? 'Reopen' : 'Resolve without re-planning'} onClick={() => void onComment({ op: 'update', id: c.id, resolved: !c.resolved })} className="cursor-pointer border-0 bg-transparent p-0.5 text-muted hover:text-good">
                    <Check size={13} aria-hidden />
                  </button>
                ) : null}
                <button type="button" aria-label="Delete the comment" title="Delete" onClick={() => void onComment({ op: 'delete', id: c.id })} className="cursor-pointer border-0 bg-transparent p-0.5 text-muted hover:text-critical">
                  <Trash2 size={13} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {writing ? (
        <form
          className="mt-2"
          onSubmit={async (e) => { e.preventDefault(); if (await onComment({ op: 'add', blockId: block.id, blockTitle: block.title, text })) { setText(''); setWriting(false); } }}
        >
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); if (e.key === 'Escape') setWriting(false); }}
            placeholder="What should change in this step? (⌘Enter to save)"
            aria-label={`Comment on ${block.title}`}
            className="min-h-[64px] text-[12.5px]"
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>Add comment</Button>
            <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
