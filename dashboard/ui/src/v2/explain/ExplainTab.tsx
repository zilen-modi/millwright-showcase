import { BookOpen, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';

import { LogView } from '@/components/LogView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useResource } from '@/hooks/useResource';
import { logLines, money } from '@/lib/format';
import { Markdown } from '@/lib/markdown';
import { useStartExplain } from '../dispatch';
import { ago } from '../rows';

export interface ExplainerCard {
  slug: string;
  subject: { type: 'ticket' | 'pr' | 'topic'; id: string; label: string } | null;
  title: string;
  summary: string | null;
  result: string | null;
  failure: string | null;
  running: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  costUsd: number;
  hasText: boolean;
}
export interface ExplainersState { explainers: ExplainerCard[]; capacity: { running: number; max: number } }
interface ExplainerDetail extends ExplainerCard { markdown: string | null; log: string | null }

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export function useExplainers() {
  return useResource<ExplainersState>((signal) => getJson('/api/explainers', signal));
}

/** The explainer slug for a ticket key or PR url, when one has been written. */
export function useExplainerFor(subjectId: string | null | undefined): string | null {
  const { data } = useExplainers();
  if (!subjectId) return null;
  return data?.explainers.find((e) => e.subject?.id === subjectId && (e.hasText || e.running))?.slug || null;
}

/** An explainer's sections by `## ` heading, so the old/new comparison can sit side by side. */
export function splitSections(md: string): { title: string; heading: string; sections: { heading: string; body: string }[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !title) { title = h1[1].trim(); continue; }
    if (h2) { if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() }); current = { heading: h2[1].trim(), body: [] }; continue; }
    if (current) current.body.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
  return { title, heading: title, sections };
}

/** Split "### Old ERP ... ### New ERP ..." into its two sides; null when the section has another shape. */
export function oldNew(body: string): { old: string; next: string } | null {
  const m = body.match(/###\s+Old ERP\s*\n([\s\S]*?)\n###\s+New ERP\s*\n([\s\S]*)$/i);
  return m ? { old: m[1].trim(), next: m[2].trim() } : null;
}

/** `PROGRAM:123` citations in the old-ERP text, for links into Atlas. */
export function oldCitations(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Z][A-Z0-9.$_-]{1,40}):(\d+)`/g)) out.add(m[1]);
  return [...out].slice(0, 12);
}

const ATLAS_UI = 'http://localhost:3217';

/** The page itself, laid out for reading: larger type, the comparison side by side. */
export function ExplainView({ markdown }: { markdown: string }) {
  const { title, sections } = splitSections(markdown);
  return (
    <article className="mx-auto max-w-[760px] text-[15px] leading-relaxed [&_.md]:text-[14.5px] [&_.md]:leading-relaxed">
      {title ? <h1 className="m-0 mb-3 text-[22px] font-bold leading-tight tracking-[-.015em] text-fg">{title}</h1> : null}
      {sections.map((s) => {
        const split = /old erp vs new erp/i.test(s.heading) ? oldNew(s.body) : null;
        const short = /short version/i.test(s.heading);
        return (
          <section key={s.heading} className="mt-5 border-t border-border pt-4 first:mt-0 first:border-0 first:pt-0">
            <h2 className="m-0 mb-2 text-[15px] font-bold text-fg">{s.heading}</h2>
            {split ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Side label="Old ERP">{split.old}</Side>
                  <Side label="New ERP">{split.next}</Side>
                </div>
                {oldCitations(split.old).length ? (
                  <p className="mt-2 mb-0 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                    Open in Atlas:
                    {oldCitations(split.old).map((p) => (
                      <a key={p} href={`${ATLAS_UI}/program/${encodeURIComponent(p)}`} target="_blank" rel="noopener" className="rounded-[6px] border border-border px-1.5 py-px font-mono text-[11.5px] text-accent hover:border-border-strong">{p}</a>
                    ))}
                  </p>
                ) : null}
              </>
            ) : short ? (
              <div className="rounded-panel bg-accent-soft px-4 py-3 text-fg"><Markdown source={s.body} /></div>
            ) : (
              <Markdown source={s.body} />
            )}
          </section>
        );
      })}
    </article>
  );
}

function Side({ label, children }: { label: string; children: string }) {
  return (
    <div className="rounded-panel border border-border bg-surface-2 px-3.5 py-3">
      <p className="m-0 mb-1 text-[11.5px] font-bold uppercase tracking-[.05em] text-muted">{label}</p>
      <Markdown source={children} />
    </div>
  );
}

/** An explainer with its status and actions - used as a thread and as a ticket/review tab. */
export function ExplainTab({ slug, header }: { slug: string; header?: (d: ExplainerDetail | null) => ReactNode }) {
  const fetcher = useCallback((signal: AbortSignal) => getJson<ExplainerDetail>(`/api/explainer?slug=${encodeURIComponent(slug)}`, signal), [slug]);
  const { data, error } = useResource<ExplainerDetail>(fetcher, [slug]);
  const d = data && data.slug === slug ? data : null;
  const start = useStartExplain();
  const html = `/api/explainer-html?slug=${encodeURIComponent(slug)}`;

  return (
    <div>
      {header?.(d)}
      {error ? <p className="text-[13px] text-critical">Could not load the explainer: {error}</p> : null}
      {!d ? <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Loading" /> Loading…</p> : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {d.running ? <Badge tone="accent"><Spinner className="h-2.5 w-2.5 border" />writing</Badge>
              : d.result === 'failed' ? <Badge tone="critical">failed</Badge>
              : d.hasText ? <Badge tone="good"><BookOpen size={11} aria-hidden />ready</Badge> : null}
            {d.updatedAt ? <span className="text-[12px] text-muted">written {ago(d.updatedAt)} ago{d.costUsd ? ` · ${money(d.costUsd)}` : ''}</span> : null}
            <span className="flex-1" />
            {d.hasText ? (
              <>
                <a href={html} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-[7px] px-2 py-1 text-[12px] font-semibold text-accent hover:bg-surface-2"><ExternalLink size={12} aria-hidden />Open page</a>
                <a href={`${html}&download=1`} className="inline-flex items-center gap-1 rounded-[7px] px-2 py-1 text-[12px] font-semibold text-accent hover:bg-surface-2"><Download size={12} aria-hidden />Save page</a>
              </>
            ) : null}
            {d.subject && !d.running ? (
              <Button size="sm" onClick={() => void start(d.subject!.id)}><RefreshCw size={12} aria-hidden />{d.hasText ? 'Redo' : 'Try again'}</Button>
            ) : null}
          </div>
          {d.result === 'failed' && d.failure ? <p role="alert" className="mt-0 rounded-lg border border-[color-mix(in_srgb,var(--critical)_40%,var(--border))] bg-[color-mix(in_srgb,var(--critical)_9%,var(--surface))] px-2.5 py-2 text-[12.5px] text-fg-2">{d.failure}</p> : null}
          {d.markdown ? <ExplainView markdown={d.markdown} /> : d.running ? (
            <>
              <p className="text-[13px] text-muted">Reading the old ERP through Atlas and the new ERP's code. This usually takes a few minutes.</p>
              <LogView className="max-h-[240px]" label="Explainer log" lines={logLines(d.log).slice(-60)} empty="Starting…" />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
