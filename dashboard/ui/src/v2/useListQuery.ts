import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { parseQuery, writeQuery, type ListQuery, type QueryDefaults } from './query';

/** A channel's search, filters, sort, group and view, held in the URL so back/forward,
 * reloads and shared links all land on the same list. */
export function useListQuery(defaults: QueryDefaults) {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parseQuery(params, defaults), [params, defaults]);

  const update = useCallback((patch: Partial<ListQuery>) => {
    setParams((prev) => writeQuery(prev, { ...parseQuery(prev, defaults), ...patch }, defaults), { replace: true });
  }, [setParams, defaults]);

  const toggleFilter = useCallback((facet: string, value: string) => {
    const current = query.filters[facet] || [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    update({ filters: { ...query.filters, [facet]: next } });
  }, [query.filters, update]);

  const clear = useCallback(() => update({ q: '', filters: {} }), [update]);

  return { query, update, toggleFilter, clear };
}

/** The open thread, also in the URL: ?t=<ticket key>, ?r=<review ref>, ?e=<explainer slug>,
 * ?w=<checkout id>. */
export type ThreadRef = { kind: 'ticket' | 'review' | 'explainer' | 'worktree'; id: string } | null;
const PARAM = { ticket: 't', review: 'r', explainer: 'e', worktree: 'w' } as const;

export function useThread() {
  const [params, setParams] = useSearchParams();
  const thread: ThreadRef = params.get('t') ? { kind: 'ticket', id: params.get('t')! }
    : params.get('r') ? { kind: 'review', id: params.get('r')! }
    : params.get('e') ? { kind: 'explainer', id: params.get('e')! }
    : params.get('w') ? { kind: 'worktree', id: params.get('w')! }
    : null;

  const open = useCallback((next: ThreadRef) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      for (const p of Object.values(PARAM)) out.delete(p);
      if (next) out.set(PARAM[next.kind], next.id);
      return out;
    });
  }, [setParams]);

  return { thread, open, close: useCallback(() => open(null), [open]) };
}
