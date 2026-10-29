import { HelpCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { useRuns } from '@/hooks/runs';
import type { PlanReview, TicketCard } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The planner stopped to ask: one card per question, options as one-click answers, and a single
 * "Send answers and continue" that resumes the plan stage with them (through /api/run, so every
 * gate still applies).
 */
export function Questions({ card, review }: { card: TicketCard; review: PlanReview }) {
  const { run, pending } = useRuns();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answered = review.questions.filter((q) => answers[q.id]?.trim()).length;
  const busy = card.running || !!pending[card.key];

  if (!review.awaitingAnswers) {
    if (!review.answers.length) return null;
    return (
      <div className="mb-3 rounded-panel border border-border bg-surface-2 px-3.5 py-2.5 text-[12.5px]">
        <p className="m-0 mb-1 font-semibold text-fg-2">Your answers to the planner</p>
        <ul className="m-0 grid list-none gap-1 p-0">
          {review.answers.map((a) => <li key={a.id}><span className="text-muted">{a.question}</span> <span className="text-fg">{a.answer}</span></li>)}
        </ul>
      </div>
    );
  }

  return (
    <section aria-label="Questions from the planner" className="mb-3 rounded-panel border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-surface p-3.5">
      <p className="m-0 flex items-center gap-1.5 text-[13.5px] font-semibold text-fg">
        <HelpCircle size={15} aria-hidden className="text-accent" />
        The planner has {review.questions.length} question{review.questions.length === 1 ? '' : 's'} before it writes the plan
      </p>
      <p className="m-0 mt-0.5 text-[12.5px] text-muted">Only you can answer these. Unanswered ones are left to the planner's judgement.</p>
      <ol className="m-0 mt-3 grid list-none gap-3 p-0">
        {review.questions.map((q, i) => (
          <li key={q.id}>
            <p className="m-0 text-[13px] font-semibold text-fg">{i + 1}. {q.question}</p>
            {q.why ? <p className="m-0 mt-0.5 text-[12px] text-muted">{q.why}</p> : null}
            {q.options.length ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={answers[q.id] === o}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                    className={cn('cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium', answers[q.id] === o ? 'border-accent bg-accent-soft text-accent' : 'border-border-strong bg-surface text-fg-2 hover:bg-surface-2')}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
            <Textarea
              value={answers[q.id] || ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              placeholder={q.options.length ? 'Or write your own answer' : 'Your answer'}
              aria-label={`Answer to: ${q.question}`}
              className="mt-1.5 min-h-[48px] text-[12.5px]"
            />
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" disabled={!answered || busy} onClick={() => void run(card.key, 'continue', { answers })}>
          Send {answered} answer{answered === 1 ? '' : 's'} and continue planning
        </Button>
        <span className="text-[12px] text-muted">{answered} of {review.questions.length} answered</span>
      </div>
    </section>
  );
}
