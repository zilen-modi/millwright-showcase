import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Label, Textarea } from '@/components/ui/input';
import type { RunMode } from '@/lib/types';

export interface ShipGateBlock {
  key: string;
  mode: RunMode;
  /** The server's short headline, e.g. "ship gate: the rubric receipt could not be verified". */
  error: string;
  /** The readable sentence explaining exactly what is unverified — shown verbatim. */
  reason: string;
}

/**
 * The ship gate (contract §3) refusing a run is a first-class outcome, not a failure toast:
 * `reason` is the one sentence that tells the operator what is unverified and what to do
 * about it, so it is rendered verbatim and never truncated or paraphrased.
 *
 * The override is deliberately narrow — the server honours it for the manual `ship` mode
 * only — so this dialog offers it as an explicit second step that names the unverified
 * thing back to the operator before the button appears.
 */
export function ShipGateDialog({
  block,
  onDismiss,
  onOverride,
}: {
  block: ShipGateBlock | null;
  onDismiss: () => void;
  onOverride: (reason: string) => void;
}) {
  const [arming, setArming] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (block) { setArming(false); setReason(''); }
  }, [block]);

  return (
    <Dialog open={block !== null} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      {block ? (
        <DialogContent
          className="w-[min(640px,94vw)]"
          title={
            <span className="flex items-center gap-2">
              <ShieldAlert size={17} className="text-warning" aria-hidden />
              Ship gate — {block.key} was not started
            </span>
          }
          description={block.error}
        >
          <p
            data-testid="ship-gate-reason"
            className="mt-3.5 rounded-[10px] border border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3.5 py-3 text-[13px] leading-relaxed text-fg"
          >
            {block.reason}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            The receipt is <code className="font-mono">tickets/{block.key}/rubric.jsonl</code>, written only by
            <code className="font-mono"> scripts/loop.mjs</code>. Until the last line says <code className="font-mono">done</code> for
            the worktree's current HEAD, no <code className="font-mono">{block.mode}</code> run may open a PR.
          </p>

          {arming ? (
            <div className="mt-4 rounded-[10px] border border-[color-mix(in_srgb,var(--critical)_45%,var(--border))] bg-[color-mix(in_srgb,var(--critical)_8%,var(--surface))] p-3.5">
              <p className="m-0 text-[13px] font-semibold text-critical">
                You are about to open a PR for {block.key} with an unverified rubric score.
              </p>
              <p className="mt-1.5 mb-3 text-xs leading-relaxed text-fg-2">
                Specifically unverified: {block.reason} This runs manual <code className="font-mono">ship</code> mode
                (the only mode the server will override) and appends a
                {' '}<code className="font-mono">ship_gate_override</code> line to the ticket's events.jsonl.
              </p>
              <Label htmlFor="override-reason">Why is this safe? (recorded with the override)</Label>
              <Textarea
                id="override-reason"
                className="mt-1.5"
                value={reason}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. scored manually against HEAD after a rebase that only touched changelog files…"
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="secondary" size="md" onClick={onDismiss}>Close</Button>
            {arming ? (
              <Button
                variant="danger"
                size="md"
                disabled={reason.trim().length < 8}
                onClick={() => onOverride(reason.trim())}
              >
                Ship {block.key} without a verified receipt
              </Button>
            ) : (
              <Button variant="ship" size="md" onClick={() => setArming(true)}>
                Override as a manual ship…
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
