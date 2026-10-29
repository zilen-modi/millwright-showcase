import type { RunMode, TicketCard } from './types';

/**
 * What can this ticket do right now?
 *
 * One answer, used by both the board and the console. They used to decide separately and
 * disagreed on the same ticket: the board offered Ship on something already shipped and had no
 * Approve & Build, and BOTH hid Continue unless `blocked` was set — so a run killed mid-stage
 * (nothing marks those blocked) left a resumable ticket with no way to resume it. The server
 * accepts `continue` from any resumable stage, and now says so via `canContinue`.
 */
export interface TicketAction {
  mode: RunMode | 'build';
  label: string;
  variant?: 'primary' | 'approve' | 'ship' | 'muted' | 'danger';
  /** Set when the action would be refused; the UI shows it and explains why rather than
   *  offering a button that fails. */
  disabledReason?: string;
  hint?: string;
}

export function availableActions(card: TicketCard): TicketAction[] {
  // A queued entry has no ticket directory yet — there is nothing to review or ship.
  if (card.queued) {
    return [{ mode: 'plan', label: 'Plan', variant: 'primary', hint: 'Start the pipeline for this ticket' }];
  }
  if (card.column === 'archived') return [];

  const actions: TicketAction[] = [];

  // Tolerate a server older than this bundle: the panel rebuilds the UI on start, but the
  // process can outlive an edit. `undefined` means "this server cannot tell us", so fall back
  // to the behaviour it does support rather than hiding or disabling actions wrongly.
  const canContinue = card.canContinue ?? card.blocked ?? false;
  const shipUnknown = card.shipReady === undefined;

  // Resuming comes first when it is possible: it is almost always the right button, and it
  // picks up where the work stopped instead of redoing a stage.
  if (canContinue && !card.running) {
    actions.push({
      mode: 'continue',
      label: 'Continue',
      variant: 'primary',
      hint: card.blocked
        ? 'Resume from the blocked stage. Opens a PR only if the rubric receipt verifies.'
        : 'Resume from where this ticket stopped. Opens a PR only if the rubric receipt verifies.',
    });
  }

  if (card.planReady) {
    actions.push({
      mode: 'build',
      label: 'Approve & Build',
      variant: 'approve',
      hint: 'Accept the plan and build it',
    });
  }

  actions.push({ mode: 'plan', label: 'Plan', hint: 'Re-run planning from the start' });

  // Past planning, re-running just the build or just the plan has to be reachable. Without
  // these the only way back after a bad build was Plan or Review, neither of which is the
  // stage you wanted.
  if (!card.planReady && card.column !== 'intake') {
    actions.push({ mode: 'replan', label: 'Re-plan', hint: 'Rewrite the plan without rebuilding' });
    actions.push({ mode: 'build', label: 'Build', hint: 'Re-run the build stage' });
  }

  actions.push({ mode: 'review', label: 'Review', hint: 'Score the current tree and write a receipt' });

  actions.push({
    mode: 'ship',
    label: 'Ship',
    variant: 'ship',
    hint: 'Open a PR for the reviewed tree. Never merges.',
    // Offering Ship on a ticket the gate will refuse is what made the override look broken:
    // the button implied a capability the receipt did not support.
    disabledReason:
      shipUnknown || card.shipReady
        ? undefined
        : 'No passing rubric receipt yet — run Review first, or record a signed exception to ship anyway.',
  });

  return actions;
}
