import { useState, type FormEvent } from 'react';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedList, SegmentedTrigger, Tabs } from '@/components/ui/tabs';
import { useRuns } from '@/hooks/runs';
import { parseTicketKey } from '@/lib/api';
import type { RunMode } from '@/lib/types';

/** The "start work on a ticket" bar, shared by Console and Board (the legacy pages had two
 *  copies of it). Accepts a bare key or a pasted Jira URL; the server re-validates. */
export function Launcher({ autoFocus = false }: { autoFocus?: boolean }) {
  const { run } = useRuns();
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<RunMode>('plan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const key = parseTicketKey(raw);
    if (!key) {
      setError('Enter a ticket key like PROJ-1234, or paste a Jira URL.');
      return;
    }
    setError(null);
    setBusy(true);
    const ok = await run(key, mode);
    setBusy(false);
    if (ok) setRaw('');
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-panel border border-border bg-surface p-4 shadow-card"
      aria-label="Start work on a ticket"
    >
      <p className="m-0 mb-2.5 text-[11px] font-bold uppercase tracking-[.05em] text-muted">
        Start work on a ticket
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <Input
          value={raw}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          aria-label="Ticket key or Jira URL"
          aria-invalid={error ? true : undefined}
          onChange={(e) => { setRaw(e.target.value); if (error) setError(null); }}
          placeholder="Paste a ticket key (PROJ-1234) or a Jira URL…"
          className="min-w-[240px] flex-1"
        />
        <Tabs value={mode} onValueChange={(v) => setMode(v as RunMode)}>
          <SegmentedList aria-label="Run mode">
            <SegmentedTrigger value="plan">Plan</SegmentedTrigger>
            <SegmentedTrigger value="review">Review</SegmentedTrigger>
          </SegmentedList>
        </Tabs>
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          <Play size={14} aria-hidden />
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 mb-0 text-xs font-semibold text-critical">{error}</p>
      ) : (
        <p className="mt-2 mb-0 text-xs text-muted">
          Plan stops at the human gate before any code. Review runs the full pipeline and opens a
          PR only if the rubric receipt verifies.
        </p>
      )}
    </form>
  );
}
