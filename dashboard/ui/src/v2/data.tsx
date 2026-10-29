import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useBoard } from '@/hooks/board';
import { useResource } from '@/hooks/useResource';
import { useRuns } from '@/hooks/runs';
import { api } from '@/lib/api';
import type { PrInboxState, PrReviewsState } from '@/lib/types';
import type { ChannelData } from './channels';

const STARS_KEY = 'millwright.v2.stars';

function readStars(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STARS_KEY) || '[]') as string[]); } catch { return new Set(); }
}

interface V2Data extends ChannelData {
  inboxState: PrInboxState | null;
  refreshReviews: () => void;
  refreshInbox: () => void;
  toggleStar: (id: string) => void;
}

const Ctx = createContext<V2Data | null>(null);

/**
 * Everything the v2 channels list, on top of the shared board subscription: the review list,
 * the PR inbox and the operator's stars. Both resources are cache-only server reads that
 * refetch on the same SSE `state` tick as the board, so counts in the sidebar stay live.
 */
export function V2DataProvider({ children }: { children: ReactNode }) {
  const { state } = useBoard();
  const { failed } = useRuns();
  const reviews = useResource<PrReviewsState>((signal) => api.prReviews(signal));
  const inbox = useResource<PrInboxState>((signal) => api.prInbox(signal));
  const [starred, setStarred] = useState<Set<string>>(readStars);

  const toggleStar = useCallback((id: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(STARS_KEY, JSON.stringify([...next])); } catch { /* private mode: stars last the session */ }
      return next;
    });
  }, []);

  const value = useMemo<V2Data>(() => ({
    board: state,
    reviews: reviews.data?.reviews || [],
    inbox: inbox.data?.rows || [],
    inboxState: inbox.data,
    failed,
    starred,
    refreshReviews: reviews.refresh,
    refreshInbox: inbox.refresh,
    toggleStar,
  }), [state, reviews.data, reviews.refresh, inbox.data, inbox.refresh, failed, starred, toggleStar]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useV2() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useV2 must be used inside V2DataProvider');
  return v;
}
