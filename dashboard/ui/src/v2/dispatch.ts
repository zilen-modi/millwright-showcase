import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useRuns } from '@/hooks/runs';
import { postJson } from '@/lib/api';
import type { Command } from './commands';
import { useV2 } from './data';

/**
 * Run a ticket command through the same provider calls v1's buttons use, so the ship
 * confirmation, the ship-gate override and every toast behave identically in v2.
 */
export function useTicketDispatch() {
  const { run, cancel, setArchived, checkMerge } = useRuns();
  const startExplain = useStartExplain();
  return useCallback(async (key: string, command: Command, notes?: string) => {
    const a = command.action;
    if (a.type === 'run') return run(key, a.mode, notes ? { notes } : undefined);
    if (a.type === 'cancel') return cancel(key);
    if (a.type === 'archive') return setArchived(key, true);
    if (a.type === 'unarchive') return setArchived(key, false);
    if (a.type === 'check-merge') return checkMerge(key);
    if (a.type === 'explain') return startExplain(key);
    return undefined;
  }, [run, cancel, setArchived, checkMerge, startExplain]);
}

/** Start (or restart) a PR review - the same POST v1's Review / Retry / Re-run buttons make. */
export function useStartReview() {
  const { refreshReviews, refreshInbox } = useV2();
  return useCallback(async (prUrl: string, label: string) => {
    try {
      const r = await postJson<{ ref: string }>('/api/pr-review', { prUrl });
      toast.success(`${label} - review started`, { description: r.ref });
      refreshReviews(); refreshInbox();
      return r.ref;
    } catch (err) {
      toast.error(`${label} - could not start the review`, { description: err instanceof Error ? err.message : String(err), duration: 8000 });
      return null;
    }
  }, [refreshReviews, refreshInbox]);
}

/** Ask for a plain-language explainer of a ticket key, PR url or topic, then open it. */
export function useStartExplain() {
  const navigate = useNavigate();
  return useCallback(async (subject: string) => {
    try {
      const r = await postJson<{ slug: string }>('/api/explain', { subject });
      toast.success('Writing the explainer', { description: 'It appears in #explain when it is ready.' });
      navigate(`/v2/explain?e=${encodeURIComponent(r.slug)}`);
      return r.slug;
    } catch (err) {
      toast.error('Could not start the explainer', { description: err instanceof Error ? err.message : String(err), duration: 8000 });
      return null;
    }
  }, [navigate]);
}
