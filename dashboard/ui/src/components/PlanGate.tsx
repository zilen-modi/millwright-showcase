import { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/input';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { useRuns } from '@/hooks/runs';

const SHIP_HINT =
  'Runs build → verify → review, then opens a ready-for-review PR only if the rubric receipt verifies. Never merges.';

/**
 * The human-in-the-loop PLAN gate: read the plan, then approve → build, or send it back with
 * context. Re-plan notes are POSTed as a body field the server writes to `resume-notes.md` —
 * they never reach the spawned command's argv.
 */
export function PlanGate({
  ticketKey,
  plan,
  running,
  className,
}: {
  ticketKey: string;
  plan: string | null;
  running: boolean;
  className?: string;
}) {
  const { run } = useRuns();
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <section
      className={cn(
        'rounded-panel border p-4',
        'border-[color-mix(in_srgb,var(--ph-plan)_45%,var(--border))]',
        'bg-[color-mix(in_srgb,var(--ph-plan)_9%,var(--surface))]',
        className,
      )}
      aria-labelledby={`plangate-${ticketKey}`}
    >
      <h3 id={`plangate-${ticketKey}`} className="m-0 text-[13px] font-bold text-fg">
        Plan ready — awaiting your decision
      </h3>
      <p className="mt-1 mb-3 text-xs text-fg-2">
        Nothing has been built yet and no PR exists. Approve to start BUILD, or send the plan back
        with context.
      </p>

      <div className="max-h-[42vh] overflow-y-auto rounded-[10px] border border-border bg-surface px-3.5 py-2.5">
        <Markdown source={plan} empty="No plan.md on disk for this ticket." />
      </div>

      {running ? (
        <p className="mt-3 mb-0 text-[13px] font-semibold text-accent">
          A run is already in progress — watch it in the Console log.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="approve" size="md" title={SHIP_HINT} onClick={() => void run(ticketKey, 'build')}>
              <Check size={14} aria-hidden />
              Approve &amp; Build
            </Button>
            <Button
              variant="secondary"
              size="md"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <RefreshCw size={14} aria-hidden />
              Re-plan…
            </Button>
          </div>
          {open ? (
            <div className="mt-3">
              <Label htmlFor={`replan-${ticketKey}`}>Context for the re-plan</Label>
              <Textarea
                id={`replan-${ticketKey}`}
                className="mt-1.5"
                value={notes}
                autoFocus
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What's off with this plan? Constraints, the approach you want, files it missed… (saved to resume-notes.md; never passed on the command line)"
              />
              <Button
                className="mt-2"
                variant="primary"
                size="md"
                onClick={() => void run(ticketKey, 'replan', { notes: notes.trim() || undefined })}
              >
                Submit re-plan
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
