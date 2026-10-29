import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { postJson } from '@/lib/api';
import { Markdown } from '@/lib/markdown';
import type { FindingDecision, FindingRow, FindingsState } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEVERITY_TONE = { high: 'critical', medium: 'warning', low: 'neutral' } as const;
const SEVERITY_BAR = { high: 'var(--critical)', medium: 'var(--warning)', low: 'var(--muted)' } as const;

const VERDICT = {
  confirmed: { label: 'verified', tone: 'good' },
  uncertain: { label: 'uncertain', tone: 'warning' },
  unverified: { label: 'not verified', tone: 'neutral' },
  refuted: { label: 'refuted', tone: 'critical' },
} as const;

const DECISION_LABEL: Record<FindingDecision, string> = { accept: 'Accept', park: 'Park', reject: 'Reject' };

/** GitHub link to an evidence line at the reviewed commit, or null when either is unknown. */
function blobUrl(prUrl: string | null, sha: string | null, file: string, line: number) {
  if (!prUrl || !sha) return null;
  return `${prUrl.replace(/\/pull\/\d+\/?$/, '')}/blob/${sha}/${file}#L${line}`;
}

/**
 * The review's findings as rows the operator decides on. Only accepted rows are ever posted;
 * parked ones wait for a later look, rejected ones stay visible so the decision is auditable.
 * Findings the verifier refuted are folded underneath, not removed.
 */
export function FindingsTriage({
  reviewRef,
  findings,
  prUrl,
  locked,
  onChange,
}: {
  reviewRef: string;
  findings: FindingsState;
  prUrl: string | null;
  /** The run is still going: decisions would land on rows about to be rewritten. */
  locked: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (fingerprints: string[], change: { decision?: FindingDecision | null; body?: string }) => {
    setBusy(true);
    try {
      await postJson('/api/pr-review-triage', { ref: reviewRef, fingerprints, ...change });
      onChange();
    } catch (e) {
      toast.error('Could not save that', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [reviewRef, onChange]);

  const active = findings.rows.filter((r) => !r.folded);
  const folded = findings.rows.filter((r) => r.folded);
  const verifiedOpen = active.filter((r) => r.verdict === 'confirmed' && !r.decision);
  const { counts } = findings;

  const fixed = findings.resolved.filter((r) => r.status !== 'not-raised');
  const quiet = findings.resolved.filter((r) => r.status === 'not-raised');

  return (
    <section aria-label="Findings" className="mt-4">
      {findings.stale ? (
        <p role="status" className="mt-0 mb-2.5 rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_9%,var(--surface))] px-2.5 py-2 text-xs leading-snug text-fg-2">
          {locked
            ? <>A re-review is running. These are round {findings.round}&apos;s findings; the new round replaces them when it finishes and keeps your decisions on anything still open.</>
            : <>The last re-review did not produce new findings. These are round {findings.round}&apos;s, against an older commit.</>}
        </p>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-[.05em] text-muted">
          Findings{findings.round > 1 ? ` · round ${findings.round}` : ''}
        </h3>
        <span className="text-xs text-muted">
          {counts.undecided} to decide · {counts.accept} accepted · {counts.park} parked · {counts.reject} rejected
          {counts.posted ? ` · ${counts.posted} on the PR` : ''}
          {counts.folded ? ` · ${counts.folded} refuted` : ''}
        </span>
        <span className="flex-1" />
        {verifiedOpen.length ? (
          <Button
            size="sm"
            variant="approve"
            disabled={locked || busy}
            onClick={() => void send(verifiedOpen.map((r) => r.fingerprint), { decision: 'accept' })}
          >
            Accept {verifiedOpen.length} verified
          </Button>
        ) : null}
      </div>

      {findings.warnings.length ? (
        <p className="mt-0 mb-2 text-xs text-muted">{findings.warnings.join(' · ')}</p>
      ) : null}

      {findings.previousRound ? (
        <p className="mt-0 mb-2 text-xs text-fg-2">
          Since round {findings.previousRound}: <strong className="text-good">{fixed.length} fixed</strong>
          {' · '}{active.filter((r) => r.since === 'still-open').length} still open
          {' · '}<strong className="text-accent">{counts.new} new</strong>
          {quiet.length ? ` · ${quiet.length} not raised again` : ''}
        </p>
      ) : null}

      {active.length === 0 ? (
        <p className="m-0 rounded-panel border border-border bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
          {folded.length ? 'Every finding was refuted on a second look.' : 'No findings - the review found nothing to raise.'}
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {active.map((r) => (
            <FindingCard key={r.fingerprint} row={r} prUrl={prUrl} headSha={findings.headSha} disabled={locked || busy} send={send} />
          ))}
        </ul>
      )}

      {folded.length ? (
        <details className="mt-2.5 rounded-panel border border-border bg-surface-2 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-fg-2">
            Refuted on a second look ({folded.length})
          </summary>
          <p className="mt-1.5 mb-2 text-xs text-muted">
            A separate read-only check disproved these. They stay here in case it was wrong; accept one to post it anyway.
          </p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {folded.map((r) => (
              <FindingCard key={r.fingerprint} row={r} prUrl={prUrl} headSha={findings.headSha} disabled={locked || busy} send={send} />
            ))}
          </ul>
        </details>
      ) : null}

      {findings.resolved.length ? (
        <details className="mt-2.5 rounded-panel border border-border bg-surface-2 px-3 py-2" open={fixed.length > 0}>
          <summary className="cursor-pointer text-xs font-semibold text-fg-2">
            Gone since round {findings.previousRound} ({findings.resolved.length})
          </summary>
          <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
            {findings.resolved.map((r) => (
              <li key={r.fingerprint} className="text-[12.5px] leading-snug">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={r.status === 'fixed' ? 'good' : 'neutral'}>
                    {r.status === 'fixed' ? 'fixed' : r.status === 'no-longer-applies' ? 'no longer applies' : 'not raised again'}
                  </Badge>
                  <span className={cn('text-fg', r.status === 'fixed' && 'line-through decoration-muted')}>{r.title}</span>
                  {r.posted ? <span className="text-[11px] text-muted">· was on the PR</span> : null}
                  {r.decision ? <span className="text-[11px] text-muted">· you {r.decision === 'accept' ? 'accepted' : r.decision === 'park' ? 'parked' : 'rejected'} it</span> : null}
                </span>
                {r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
              </li>
            ))}
          </ul>
          {quiet.length ? (
            <p className="mt-2 mb-0 text-[11px] text-muted">
              &ldquo;Not raised again&rdquo; means the re-review neither found it nor said it was fixed. Re-run if one of those matters.
            </p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function FindingCard({
  row,
  prUrl,
  headSha,
  disabled,
  send,
}: {
  row: FindingRow;
  prUrl: string | null;
  headSha: string | null;
  disabled: boolean;
  send: (fps: string[], change: { decision?: FindingDecision | null; body?: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const verdict = VERDICT[row.verdict];
  const dimmed = row.decision === 'reject' || row.decision === 'park';

  return (
    <li
      className={cn(
        'phase-bar relative rounded-panel border border-border bg-surface py-2.5 pr-3 pl-4 shadow-card',
        dimmed && 'opacity-70',
        row.decision === 'accept' && 'border-[color-mix(in_srgb,var(--good)_45%,var(--border))]',
      )}
      style={{ ['--ph' as string]: SEVERITY_BAR[row.severity] }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[row.severity]}>{row.severity}</Badge>
        {row.kind === 'question' ? <Badge tone="accent">question</Badge> : null}
        {row.blocking ? <Badge tone="critical">blocks merge</Badge> : null}
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        {row.since === 'new' ? <Badge tone="accent">new</Badge> : row.since === 'still-open' ? <Badge>still open</Badge> : null}
        {row.posted ? (
          row.posted.url
            ? <a href={row.posted.url} target="_blank" rel="noopener" className="no-underline"><Badge tone="good">on the PR</Badge></a>
            : <Badge tone="good">on the PR</Badge>
        ) : null}
        <span className="text-[11px] text-muted">{row.axis}</span>
        {row.editedBody ? <span className="text-[11px] text-muted">· your wording</span> : null}
        {row.decisionInherited ? <span className="text-[11px] text-muted">· decided last round</span> : null}
        <span className="flex-1" />
        <span role="group" aria-label={`Decision for ${row.title}`} className="inline-flex overflow-hidden rounded-lg border border-border">
          {(['accept', 'park', 'reject'] as FindingDecision[]).map((d) => {
            const on = row.decision === d;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => void send([row.fingerprint], { decision: on ? null : d })}
                className={cn(
                  'cursor-pointer border-0 border-r border-border px-2.5 py-1 text-[11.5px] font-semibold last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50',
                  on
                    ? d === 'accept' ? 'bg-[color-mix(in_srgb,var(--good)_16%,var(--surface))] text-good'
                      : d === 'reject' ? 'bg-[color-mix(in_srgb,var(--critical)_12%,var(--surface))] text-critical'
                      : 'bg-surface-3 text-fg'
                    : 'bg-surface text-fg-2 hover:bg-surface-2',
                )}
              >
                {DECISION_LABEL[d]}
              </button>
            );
          })}
        </span>
      </div>

      <p className="mt-1.5 mb-0 text-[13.5px] font-semibold leading-snug text-fg">{row.title}</p>

      {editing ? (
        <div className="mt-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Your wording for ${row.title}`}
            className="min-h-[110px] font-mono text-[12px]"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || !draft.trim()}
              onClick={() => void send([row.fingerprint], { body: draft }).then(() => setEditing(false))}
            >
              Save wording
            </Button>
            {row.editedBody ? (
              <Button size="sm" disabled={disabled} onClick={() => void send([row.fingerprint], { body: '' }).then(() => setEditing(false))}>
                Use the original
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : row.editedBody ? (
        <div className="mt-1 text-[13px]"><Markdown source={row.editedBody} /></div>
      ) : (
        <>
          {row.body ? <div className="mt-1 text-[13px] text-fg-2"><Markdown source={row.body} /></div> : null}
          {row.fix ? <p className="mt-1 mb-0 text-[13px] text-fg-2"><span className="font-semibold text-fg">Suggested:</span> {row.fix}</p> : null}
        </>
      )}

      {row.evidence.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {row.evidence.map((e) => {
            const href = blobUrl(prUrl, headSha, e.file, e.line);
            const label = `${e.file}:${e.line}`;
            const cls = 'rounded-md border border-border bg-surface-2 px-1.5 py-px font-mono text-[11.5px] text-fg-2';
            return href
              ? <a key={label} href={href} target="_blank" rel="noopener" className={cn(cls, 'no-underline hover:text-accent')} title={e.note || undefined}>{label}</a>
              : <code key={label} className={cls} title={e.note || undefined}>{label}</code>;
          })}
        </div>
      ) : null}

      {row.verdictReason || row.demoted ? (
        <p className="mt-2 mb-0 text-xs leading-snug text-muted">
          {row.verdictReason ? <><span className="font-semibold text-fg-2">Second look:</span> {row.verdictReason}</> : null}
          {row.verdictReason && row.demoted ? ' · ' : null}
          {row.demoted ? <>Asked as a question: {row.demoted.replace(/, so it is asked as a question$/, '')}.</> : null}
        </p>
      ) : null}

      {!editing ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setDraft(row.editedBody || defaultText(row)); setEditing(true); }}
          className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Edit wording
        </button>
      ) : null}
    </li>
  );
}

/** Mirrors findings-lib's findingText so the editor starts from what would be posted. */
function defaultText(r: FindingRow) {
  if (r.kind === 'question') return [`**Question:** ${r.title}`, r.body].filter(Boolean).join('\n\n');
  return [`**${r.title}**`, r.body, r.fix ? `Suggested: ${r.fix}` : ''].filter(Boolean).join('\n\n');
}
