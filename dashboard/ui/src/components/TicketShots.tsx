import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { TicketShot, TicketShots as Shots, TicketShotVariant } from '@/lib/types';

const KIND_LABEL: Record<TicketShot['kind'], string> = {
  figma: 'Design',
  story: 'Built',
  diff: 'Diff',
};

function Thumb({ shot, onOpen }: { shot: TicketShot | null; onOpen: (s: TicketShot) => void }) {
  if (!shot) {
    return (
      <div className="flex min-h-[64px] min-w-0 items-center justify-center rounded-[7px] border border-dashed border-border text-[11px] text-muted">
        none
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(shot)}
      title={`${shot.name} - click to enlarge`}
      className="block min-w-0 cursor-zoom-in overflow-hidden rounded-[7px] border border-border bg-surface-2 p-0"
    >
      <img src={shot.url} alt={`${KIND_LABEL[shot.kind]}: ${shot.name}`} loading="lazy" className="block h-auto w-full" />
    </button>
  );
}

/** Pair a variant's design and built shots by filename, so the two halves of a comparison sit
 *  in the same row. The two directories use the same names for the same screen (both hold
 *  `available-dark.png`), which is what makes the pairing exact rather than positional. */
function pairShots(v: TicketShotVariant) {
  const names = [...new Set([...v.figma, ...v.story].map((s) => s.name))].sort();
  return names.map((name) => ({
    name,
    figma: v.figma.find((s) => s.name === name) || null,
    story: v.story.find((s) => s.name === name) || null,
  }));
}

/** The report writes a reason for the run's own log: a severity glyph, absolute paths, the
 *  variant name and status this row already shows, and the same file named twice. Keep the
 *  sentence that says what actually happened. */
function tidyReason(reason: string): string {
  return reason
    .replace(/^[^\w]*/, '')
    .replace(/^[\w-]+\/[\w.-]+ story screenshot BLOCKED\s*[-\u2013\u2014]\s*/, '')
    // An absolute path here can contain spaces ("Work Space"), so anchor the leading slash to a
    // boundary instead of forbidding spaces, and keep only the file name.
    .replace(/(^|[\s'"])\/(?:[^\n'"]*\/)?([\w.-]+\.png)/g, '$1$2')
    .replace(/'([\w.-]+\.png)'/g, '$1')
    .replace(/,?\s*open [\w.-]+\.png/g, '')
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function VariantRow({ v, onOpen }: { v: TicketShotVariant; onOpen: (s: TicketShot) => void }) {
  const pairs = pairShots(v);
  const blocked = v.status === 'BLOCKED';
  // A variant whose design was pulled but never built or compared is the case worth naming: it
  // looks reviewed because a screenshot exists, and nothing actually checked it. When the report
  // says BLOCKED it already explains itself, so the vaguer badge would only add noise.
  const neverCompared = !blocked && !v.diff && v.figma.length > 0 && v.story.length === 0;

  return (
    <div className="border-t border-grid py-3 first:border-t-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-fg">{v.variant}</span>
        {v.status === 'PASS' ? <Badge tone="good">pass</Badge> : null}
        {v.status === 'FAIL' ? <Badge tone="critical">fail</Badge> : null}
        {blocked ? <Badge tone="warning">not compared</Badge> : null}
        {v.worstRatio != null ? (
          <span className="text-[11px] tabular-nums text-muted">{(v.worstRatio * 100).toFixed(2)}% differing</span>
        ) : null}
        {v.failedRegions.length ? (
          <span className="text-[11px] text-muted">at {v.failedRegions.join(', ')}</span>
        ) : null}
        {neverCompared ? <Badge tone="warning">design only - never compared</Badge> : null}
      </div>

      {blocked && v.reason ? (
        <p className="mt-0 mb-2 text-[11px] leading-relaxed text-fg-2">{tidyReason(v.reason)}</p>
      ) : null}

      {pairs.map((p) => (
        <div key={p.name} className="mb-2 last:mb-0">
          {pairs.length > 1 ? (
            <p className="m-0 mb-1 font-mono text-[10.5px] text-muted">{p.name.replace(/\.png$/, '')}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <figure className="m-0 min-w-0">
              <figcaption className="mb-1 text-[10px] font-bold uppercase tracking-[.05em] text-muted">Design</figcaption>
              <Thumb shot={p.figma} onOpen={onOpen} />
            </figure>
            <figure className="m-0 min-w-0">
              <figcaption className="mb-1 text-[10px] font-bold uppercase tracking-[.05em] text-muted">Built</figcaption>
              <Thumb shot={p.story} onOpen={onOpen} />
            </figure>
          </div>
        </div>
      ))}

      {v.diff ? (
        <figure className="m-0 mt-2 min-w-0">
          <figcaption className="mb-1 text-[10px] font-bold uppercase tracking-[.05em] text-muted">
            Pixel diff
          </figcaption>
          <div className="w-1/2 pr-1">
            <Thumb shot={v.diff} onOpen={onOpen} />
          </div>
        </figure>
      ) : null}
    </div>
  );
}

/** Design vs built vs pixel-diff screenshots for a UI ticket, so a change can be reviewed in
 *  the panel instead of by opening PNGs off disk. Renders nothing when a ticket has none. */
export function TicketShots({ shots }: { shots: Shots | null | undefined }) {
  const [open, setOpen] = useState<TicketShot | null>(null);
  if (!shots || !shots.variants.length) return null;

  const compared = shots.variants.filter((v) => v.diff).length;

  return (
    <section className="mt-4">
      <h3 className="m-0 mb-2 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[.05em] text-muted">
        Screens
        {shots.pass === true ? <Badge tone="good">visual diff passed</Badge> : null}
        {shots.pass === false ? <Badge tone="critical">visual diff failed</Badge> : null}
        <span className="font-normal normal-case tracking-normal">
          {compared} of {shots.variants.length} variant(s) compared
        </span>
      </h3>

      {compared < shots.variants.length ? (
        <p className="mt-0 mb-2 text-[11px] leading-relaxed text-muted">
          {shots.variants.length - compared} variant(s) have a design shot with nothing to compare
          it against, so no diff was ever run on them.
        </p>
      ) : null}

      <div className="rounded-panel border border-border bg-surface px-3">
        {shots.variants.map((v) => <VariantRow key={v.variant} v={v} onOpen={setOpen} />)}
      </div>

      <Dialog open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <DialogContent
          title={open ? `${KIND_LABEL[open.kind]}: ${open.name}` : ''}
          className="w-[min(1100px,94vw)]"
        >
          {open ? (
            <div className="mt-3 max-h-[76vh] overflow-auto rounded-[9px] border border-border bg-surface-2">
              <img src={open.url} alt={open.name} className="block h-auto w-full" />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
