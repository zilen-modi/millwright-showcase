import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { BoardState, TicketCard } from '@/lib/types';
import { useResource } from './useResource';

/**
 * One `/api/state` subscription for the whole app (board, console, command palette all
 * read it), refetched on every SSE `state` event — and the place where two silent state
 * changes become real notifications: a PR detected as merged, and a run that got blocked.
 */

interface BoardCtx {
  state: BoardState | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

const Ctx = createContext<BoardCtx | null>(null);

export function BoardProvider({ children }: { children: ReactNode }) {
  const { data, error, loading, refresh } = useResource<BoardState>((signal) => api.state(signal));
  const previous = useRef<Map<string, TicketCard> | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = new Map(data.tickets.map((t) => [t.key, t]));
    const prev = previous.current;
    previous.current = next;
    if (!prev) return; // first load is not a transition

    for (const [key, card] of next) {
      const before = prev.get(key);
      if (!before) continue;
      // Awaiting-merge → archived is exactly how the merge poller reports a merge.
      if (before.column === 'ship' && card.column === 'archived' && !card.manuallyArchived) {
        toast.success(`${key} merged`, { description: card.summary || 'PR merged on GitHub — moved to Archived.' });
      }
      if (!before.blocked && card.blocked) {
        toast.error(`${key} blocked at ${card.blockedStage || card.phase || 'unknown stage'}`, {
          description: card.blockedReason || 'The run halted on a guardrail.',
          duration: 10000,
        });
      }
    }
  }, [data]);

  const value = useMemo(() => ({ state: data, error, loading, refresh }), [data, error, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBoard() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBoard must be used inside <BoardProvider>');
  return v;
}
