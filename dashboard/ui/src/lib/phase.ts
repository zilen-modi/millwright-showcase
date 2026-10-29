import type { ColumnKey } from './types';

/** The board reads phase by colour (panel.css `--ph-*`). One map, consumed as an inline
 *  `--ph` custom property so any descendant can tint itself without a per-phase class. */
const PHASE_VAR: Record<string, string> = {
  queued: 'var(--ph-queued)',
  intake: 'var(--ph-intake)',
  route: 'var(--ph-route)',
  preflight: 'var(--ph-route)',
  context: 'var(--ph-intake)',
  plan: 'var(--ph-plan)',
  build: 'var(--ph-build)',
  verify: 'var(--ph-verify)',
  review: 'var(--ph-review)',
  ship: 'var(--ph-ship)',
  merged: 'var(--ph-ship)',
  archived: 'var(--ph-archived)',
};

export function phaseColor(phase: string | null | undefined): string {
  return PHASE_VAR[String(phase || '').toLowerCase()] || 'var(--muted)';
}

/** Style object setting the `--ph` custom property for a subtree. */
export function phaseStyle(phase: string | null | undefined) {
  return { '--ph': phaseColor(phase) } as React.CSSProperties;
}

export const STAGE_ORDER = [
  'intake', 'route', 'preflight', 'context', 'plan', 'build', 'verify', 'review', 'ship',
] as const;

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  queued: 'Queued',
  intake: 'Intake',
  route: 'Route',
  plan: 'Plan',
  build: 'Build',
  verify: 'Verify',
  review: 'Review',
  ship: 'Ship · awaiting merge',
  archived: 'Archived',
};
