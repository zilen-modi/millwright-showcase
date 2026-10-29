// The thread composer's slash commands. Built from the same rules v1's buttons use
// (availableActions, the review post gate), so a command is never offered that the button
// would refuse - and a refused one says why instead of disappearing.

import { availableActions } from '../lib/ticketActions';
import type { PrReviewDetail, RunMode, TicketCard } from '../lib/types';

export type CommandAction =
  | { type: 'run'; mode: RunMode }
  | { type: 'cancel' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'check-merge' }
  | { type: 'explain' }
  | { type: 'ask' }
  | { type: 'rerun' }
  | { type: 'post' }
  | { type: 'accept-verified' };

export interface Command {
  name: string;
  label: string;
  /** Everything after the command is sent as notes (continue, replan). */
  takesNotes?: boolean;
  disabledReason?: string;
  hint?: string;
  action: CommandAction;
}

const RUN_NAMES: Record<string, string> = { plan: 'plan', build: 'build', replan: 'replan', review: 'review', ship: 'ship', continue: 'continue' };

export function ticketCommands(t: TicketCard): Command[] {
  const out: Command[] = [];
  if (t.running) {
    out.push({ name: 'cancel', label: 'Cancel the run', action: { type: 'cancel' }, hint: `Stops the ${t.runMode || 'current'} run` });
  } else if (t.column === 'archived') {
    out.push({ name: 'unarchive', label: 'Unarchive', action: { type: 'unarchive' } });
  } else {
    const seen = new Set<string>();
    for (const a of availableActions(t)) {
      const name = RUN_NAMES[a.mode];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        label: a.label,
        takesNotes: a.mode === 'continue' || a.mode === 'replan',
        disabledReason: a.disabledReason,
        hint: a.hint,
        action: { type: 'run', mode: a.mode as RunMode },
      });
    }
    // v1's queued row offers Review beside Plan; availableActions only knows Plan for it.
    if (t.queued && !seen.has('review')) out.push({ name: 'review', label: 'Review', action: { type: 'run', mode: 'review' } });
    if (t.column === 'ship') out.push({ name: 'check-merge', label: 'Check whether the PR merged', action: { type: 'check-merge' } });
    if (!t.queued) out.push({ name: 'archive', label: 'Archive', action: { type: 'archive' } });
  }
  if (!t.queued) {
    out.push({ name: 'ask', label: 'Ask about this ticket', takesNotes: true, action: { type: 'ask' }, hint: 'A read-only answer from the ticket, its code and the old ERP' });
    out.push({ name: 'explain', label: 'Explain this in plain words', action: { type: 'explain' }, hint: 'Old ERP vs new ERP, written for anyone' });
  }
  return out;
}

/** Why a review may not be posted, mirroring PrReview.tsx's drawer gate. null = it may. */
export function reviewPostBlocked(d: PrReviewDetail): string | null {
  if (d.running) return 'The review is still running.';
  if (!d.artifacts.review?.trim()) return 'This review produced no report to post.';
  if (d.retryable) return 'This run did not finish cleanly - re-run it before posting a partial report.';
  if (d.resultUnrecorded) return 'This run was killed before its outcome was recorded - re-run it before posting.';
  if (d.isOwn === true && d.result === 'pushed-fix') return 'The findings were already fixed and pushed to this branch.';
  const f = d.findings;
  if (f && !f.counts.toPost) {
    return f.counts.posted && f.counts.accept ? 'Everything you accepted is already on the PR.' : 'Accept at least one finding to post it.';
  }
  return null;
}

export function reviewCommands(d: PrReviewDetail): Command[] {
  const out: Command[] = [];
  const blocked = reviewPostBlocked(d);
  out.push({
    name: 'post',
    label: d.findings ? `Post ${d.findings.counts.toPost || ''} accepted as a review`.replace('  ', ' ') : 'Post the findings as a comment',
    disabledReason: blocked || undefined,
    action: { type: 'post' },
  });
  if (d.findings) {
    const verified = d.findings.rows.filter((r) => !r.folded && r.verdict === 'confirmed' && !r.decision).length;
    out.push({
      name: 'accept-verified',
      label: `Accept ${verified} verified`,
      disabledReason: d.running ? 'The review is still running.' : verified ? undefined : 'No verified findings are waiting for a decision.',
      action: { type: 'accept-verified' },
    });
  }
  out.push({
    name: 'rerun',
    label: d.retryable ? 'Retry the review' : 'Re-run the review',
    disabledReason: d.running ? 'The review is still running.' : d.prUrl ? undefined : 'No PR url is known for this review.',
    action: { type: 'rerun' },
  });
  out.push({ name: 'explain', label: 'Explain this PR in plain words', action: { type: 'explain' }, hint: 'Old ERP vs new ERP, written for anyone' });
  return out;
}

export interface Parsed { name: string | null; args: string }

/** `/continue the type error is stale` -> {name: 'continue', args: 'the type error is stale'}. */
export function parseComposer(text: string): Parsed {
  const m = text.trimStart().match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return { name: null, args: text.trim() };
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/** Commands matching what has been typed so far, for the composer's suggestion list. */
export function suggest(text: string, commands: Command[]): Command[] {
  const t = text.trimStart();
  if (!t.startsWith('/')) return [];
  const typed = t.slice(1).split(/\s/)[0].toLowerCase();
  if (/\s/.test(t.slice(1)) && commands.some((c) => c.name === typed)) return [];
  return commands.filter((c) => c.name.startsWith(typed));
}

export type Resolved = { command: Command; args: string } | { error: string };

/** What pressing Enter would do. Plain text with no command is a question to the ticket when
 * /ask is offered (a thread reply reads as a question); otherwise notes for the obvious command
 * (continue when it is offered, else replan). */
export function resolve(text: string, commands: Command[]): Resolved {
  const { name, args } = parseComposer(text);
  if (!name) {
    if (!args) return { error: 'Type a message or a /command.' };
    const ask = commands.find((c) => c.name === 'ask' && !c.disabledReason);
    if (ask) return { command: ask, args };
    const target = commands.find((c) => c.name === 'continue' && !c.disabledReason)
      || commands.find((c) => c.name === 'replan' && !c.disabledReason);
    if (!target) return { error: 'Plain notes go with /continue or /replan, and neither is available now. Start with a /command.' };
    return { command: target, args };
  }
  const command = commands.find((c) => c.name === name);
  if (!command) return { error: `/${name} is not available here. Try: ${commands.map((c) => `/${c.name}`).join(' ')}` };
  if (command.disabledReason) return { error: command.disabledReason };
  if (args && !command.takesNotes) return { error: `/${name} does not take notes.` };
  if (!args && command.name === 'ask') return { error: 'Type the question after /ask.' };
  return { command, args };
}
