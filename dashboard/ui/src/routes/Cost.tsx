import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { LiveDot, Spinner } from '@/components/ui/spinner';
import { numCell, Table, TableScroll, Td, Th, Tr } from '@/components/ui/table';
import { useResource } from '@/hooks/useResource';
import { api } from '@/lib/api';
import { dateTime, duration, money, tokens } from '@/lib/format';
import { phaseStyle } from '@/lib/phase';
import type { CostState } from '@/lib/types';

export function Cost() {
  const { data, error, loading } = useResource<CostState>((signal) => api.cost(signal));
  const [ticketQuery, setTicketQuery] = useState('');
  const [ticketStatus, setTicketStatus] = useState('');
  const [prQuery, setPrQuery] = useState('');
  const [prOwner, setPrOwner] = useState('');

  const statuses = useMemo(
    () => [...new Set((data?.tickets || []).map((t) => t.jiraStatus || t.status).filter(Boolean))].sort(),
    [data],
  );

  const tickets = useMemo(() => {
    const q = ticketQuery.trim().toLowerCase();
    return (data?.tickets || [])
      .filter((t) => {
        if (q && !`${t.key} ${t.summary || ''}`.toLowerCase().includes(q)) return false;
        if (ticketStatus === '__running__') return !!t.running;
        if (ticketStatus && (t.jiraStatus || t.status) !== ticketStatus) return false;
        return true;
      })
      .sort((a, b) =>
        Number(b.running) - Number(a.running) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) ||
        b.costUsd - a.costUsd);
  }, [data, ticketQuery, ticketStatus]);

  const prReviews = useMemo(() => {
    const q = prQuery.trim().toLowerCase();
    return (data?.prReviews || [])
      .filter((r) => {
        if (q && !`${r.ref} ${r.title || ''}`.toLowerCase().includes(q)) return false;
        if (prOwner === 'mine' && r.isOwn !== true) return false;
        if (prOwner === 'other' && r.isOwn !== false) return false;
        return true;
      })
      .sort((a, b) =>
        Number(b.running) - Number(a.running) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }, [data, prQuery, prOwner]);

  if (error) return <p role="alert" className="text-[13px] text-critical">Could not load costs: {error}</p>;
  if (loading && !data) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Spinner label="Loading costs" /> Loading costs…
      </p>
    );
  }
  if (!data) return null;

  const cap = data.budget?.capPerTicket ?? null;
  const prTotals = data.prReviewTotals || { cost: 0, tokens: 0, count: 0 };
  const kpis: [string, string][] = [
    ['Total cost', money(data.totals.cost)],
    ['Total tokens', tokens(data.totals.tokens)],
    ['Tickets', String(data.totals.tickets)],
    ['Budget cap / ticket', cap ? money(cap) : '—'],
    ['PR review cost', money(prTotals.cost)],
    ['PR reviews', String(prTotals.count)],
  ];
  const reg = data.regression;
  if (reg) {
    // Guard the pending state explicitly — `(undefined * 100).toFixed(1)` renders "NaN%",
    // and a broken-looking number invites people to stop trusting the one metric that
    // actually tracks whether the gates work.
    kpis.push([
      'Escaped-defect rate',
      reg.pending || typeof reg.escapedDefectRate !== 'number'
        ? 'computing…'
        : `${(reg.escapedDefectRate * 100).toFixed(1)}%  (${reg.escaped}/${reg.shipped})`,
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        {kpis.map(([label, value]) => (
          <div key={label} className="rounded-panel border border-border bg-surface px-4 py-3 shadow-card">
            <div className="text-[11px] font-bold uppercase tracking-[.04em] text-muted">{label}</div>
            <div className="mt-1 text-[19px] font-bold tabular-nums tracking-[-.01em] text-fg">{value}</div>
          </div>
        ))}
      </div>

      {reg && !reg.pending && (reg.escaped ?? 0) > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Escaped defects</CardTitle>
            <span className="text-[11.5px] text-muted">
              {reg.stale ? 'cached · refreshing' : reg.computedAt ? `as of ${new Date(reg.computedAt).toLocaleTimeString()}` : null}
            </span>
          </CardHeader>
          <div className="flex flex-col gap-3 px-4 pb-4 text-[12.5px]">
            <p className="text-text2">
              {reg.escaped} of {reg.shipped} shipped tickets later produced a fidelity defect against a
              component they had shipped.
            </p>
            {reg.rubricCorrelation?.verdict ? (
              <p className="rounded-panel border border-border bg-surface-2 px-3 py-2 text-text2">
                {reg.rubricCorrelation.verdict}
              </p>
            ) : null}
            {(reg.byComponent || []).length ? (
              <ul className="flex flex-col gap-1">
                {(reg.byComponent || []).map((c) => (
                  <li key={c.component} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-fg">{c.component}</span>
                    <span className="text-muted">shipped by {c.shippedBy} —</span>
                    <span className="text-text2">{c.escapes.join(', ')}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Per-ticket cost</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input
              value={ticketQuery}
              onChange={(e) => setTicketQuery(e.target.value)}
              aria-label="Filter tickets by key or summary"
              placeholder="Filter by key or summary…"
              className="w-[220px] px-2.5 py-1.5 text-[12.5px]"
            />
            <Select
              value={ticketStatus}
              onChange={(e) => setTicketStatus(e.target.value)}
              aria-label="Filter tickets by status"
            >
              <option value="">All statuses</option>
              <option value="__running__">Running</option>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
        </CardHeader>
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Ticket</Th><Th>Summary</Th><Th className={numCell}>Cost</Th>
                <Th className={numCell}>Tokens</Th><Th>Status</Th><Th>Updated</Th><Th>PR</Th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr><Td colSpan={7} className="text-muted">
                  {data.tickets.length ? 'No tickets match the current filter.' : 'No tickets yet.'}
                </Td></tr>
              ) : tickets.map((t) => (
                <Tr key={t.key}>
                  <Td className="whitespace-nowrap font-mono text-xs font-bold text-accent">{t.key}</Td>
                  <Td>{t.summary || t.key}</Td>
                  <Td className={numCell}>{money(t.costUsd)}</Td>
                  <Td className={numCell}>{tokens(t.tokens)}</Td>
                  <Td className="capitalize">
                    {t.running
                      ? <span className="inline-flex items-center gap-1.5"><LiveDot /> running</span>
                      : (t.jiraStatus || t.status || '')}
                  </Td>
                  <Td className={numCell}>{dateTime(t.updatedAt)}</Td>
                  <Td>
                    {t.prUrl
                      ? <a href={t.prUrl} target="_blank" rel="noopener" className="text-accent">PR ↗</a>
                      : <span className="text-muted">—</span>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-PR-review cost</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input
              value={prQuery}
              onChange={(e) => setPrQuery(e.target.value)}
              aria-label="Filter PR reviews by ref or title"
              placeholder="Filter by PR ref or title…"
              className="w-[220px] px-2.5 py-1.5 text-[12.5px]"
            />
            <Select value={prOwner} onChange={(e) => setPrOwner(e.target.value)} aria-label="Filter PR reviews by owner">
              <option value="">All owners</option>
              <option value="mine">Mine</option>
              <option value="other">Others</option>
            </Select>
          </div>
        </CardHeader>
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>PR</Th><Th>Title</Th><Th className={numCell}>Cost</Th>
                <Th className={numCell}>Tokens</Th><Th>Owner</Th><Th>Result</Th><Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {prReviews.length === 0 ? (
                <tr><Td colSpan={7} className="text-muted">
                  {data.prReviews.length ? 'No PR reviews match the current filter.' : 'No PR reviews yet.'}
                </Td></tr>
              ) : prReviews.map((r) => (
                <Tr key={r.ref}>
                  <Td>
                    {r.prUrl
                      ? <a href={r.prUrl} target="_blank" rel="noopener" className="font-mono text-accent">#{r.ref.split('-').pop()}</a>
                      : <span className="font-mono text-muted">{r.ref}</span>}
                  </Td>
                  <Td>{r.title || r.ref}</Td>
                  <Td className={numCell}>{money(r.costUsd)}</Td>
                  <Td className={numCell}>{tokens(r.tokens)}</Td>
                  <Td>{r.isOwn === true ? 'you' : r.isOwn === false ? 'other' : '—'}</Td>
                  <Td>
                    {r.running
                      ? <span className="inline-flex items-center gap-1.5"><LiveDot /> running</span>
                      : (r.result || '—')}
                  </Td>
                  <Td className={numCell}>{dateTime(r.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      <Card>
        <CardHeader><CardTitle>Per-stage breakdown</CardTitle></CardHeader>
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Stage</Th><Th className={numCell}>Cost</Th><Th className={numCell}>Tokens</Th>
                <Th className={numCell}>Events</Th><Th className={numCell}>Avg duration</Th>
              </tr>
            </thead>
            <tbody>
              {data.stages.filter((s) => s.count > 0).map((s) => (
                <Tr key={s.stage}>
                  <Td>
                    <span className="inline-flex items-center gap-2" style={phaseStyle(s.stage)}>
                      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: 'var(--ph)' }} />
                      <span className="capitalize">{s.stage}</span>
                    </span>
                  </Td>
                  <Td className={numCell}>{money(s.costUsd)}</Td>
                  <Td className={numCell}>{tokens(s.tokens)}</Td>
                  <Td className={numCell}>{s.count}</Td>
                  <Td className={numCell}>{duration(s.avgDurationSec)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Card>

      {cap && data.budget.tickets.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Budget vs cap</CardTitle>
            <span className="text-xs text-muted">(cap {money(cap)} per ticket)</span>
          </CardHeader>
          <CardBody className="flex flex-col gap-1.5">
            {data.budget.tickets.map((row) => (
              <div key={row.key} className="flex items-center gap-2.5">
                <span className="w-[104px] shrink-0 font-mono text-[11.5px] text-fg-2">{row.key}</span>
                <div
                  className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3"
                  role="meter"
                  aria-valuenow={Math.round((row.ratio || 0) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${row.key} budget used`}
                >
                  <span
                    className={row.over ? 'block h-full bg-critical' : 'block h-full bg-accent'}
                    style={{ width: `${Math.min(100, Math.round((row.ratio || 0) * 100))}%` }}
                  />
                </div>
                <span className="w-[62px] shrink-0 text-right text-[11.5px] tabular-nums text-fg-2">
                  {money(row.spentUsd)}
                </span>
                {row.over ? <Badge tone="critical">over</Badge> : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {data.regression ? (
        <Card>
          <CardHeader>
            <CardTitle>Escaped defects</CardTitle>
            <span className="text-xs text-muted">
              {data.regression.escaped} of {data.regression.shipped} shipped components came back
            </span>
          </CardHeader>
          <TableScroll>
            <Table>
              <thead>
                <tr><Th>Component</Th><Th>Shipped by</Th><Th>Escapes</Th></tr>
              </thead>
              <tbody>
                {(data.regression.byComponent || []).map((c) => (
                  <Tr key={c.component}>
                    <Td>{c.component}</Td>
                    <Td className="font-mono text-xs">{c.shippedBy}</Td>
                    <Td className="font-mono text-xs">{c.escapes.join(', ')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      ) : null}
    </div>
  );
}
