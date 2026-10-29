import { describe, expect, it } from 'vitest';

import { historyForRun, normaliseAnswer, question, thread } from '../scripts/chat-lib.mjs';
import {
  addComment, answersFile, changedBlocks, checklist, lineDiff, markSent, nextVersion, normaliseQuestions,
  openComments, replanNotes, splitPlan, updateComment,
} from '../scripts/plan-review-lib.mjs';
import {
  estimateCost, normaliseScanRows, setQueueTriage, summaryTag, triageView,
} from '../scripts/queue-lib.mjs';

const NOW = new Date('2026-10-29T12:00:00Z');

describe('queue', () => {
  const items = normaliseScanRows([
    { key: 'PROJ-1', summary: '[UI] Modal', status: 'To Do', priority: 'High', updated: '2026-10-20T00:00:00Z', epic: { key: 'PROJ-9', summary: 'Transfers' } },
    { key: 'PROJ-2', summary: '[FUNC] Save', status: 'To Do', updated: '2026-10-21T00:00:00Z' },
    { key: 'PROJ-3', summary: 'Plain', updated: '2026-10-22T00:00:00Z' },
    { key: 'not-a-key' },
  ]);

  it('keeps the scan details and drops junk rows', () => {
    expect(items.map((i) => i.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(items[0]).toMatchObject({ priority: 'High', epic: { key: 'PROJ-9' } });
    expect(normaliseScanRows([{ key: 'PROJ-4' }])[0]).toMatchObject({ summary: '', labels: [] }); // old-format scans
  });

  it('a skip lasts until Jira changes the ticket, a snooze until its date', () => {
    let t = setQueueTriage(null, { keys: ['PROJ-1'], action: 'skip', items }, NOW);
    t = setQueueTriage(t, { keys: ['PROJ-2'], action: 'snooze', until: '2026-11-01T00:00:00Z' }, NOW);
    let v = triageView(items, t, { now: NOW });
    expect(v.visible.map((i) => i.key)).toEqual(['PROJ-3']);
    expect(v.hidden.map((i) => `${i.key}:${i.hiddenBy}`)).toEqual(['PROJ-1:skip', 'PROJ-2:snooze']);
    const changed = items.map((i) => (i.key === 'PROJ-1' ? { ...i, updated: '2026-10-28T00:00:00Z' } : i));
    v = triageView(changed, t, { now: new Date('2026-11-02T00:00:00Z') });
    expect(v.visible.map((i) => i.key).sort()).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(v.visible.find((i) => i.key === 'PROJ-1').changedSinceSkip).toBe(true);
  });

  it('restores, refuses a past snooze, orders, and leaves tracked keys out', () => {
    let t = setQueueTriage(null, { keys: ['PROJ-1'], action: 'skip', items }, NOW);
    t = setQueueTriage(t, { keys: ['PROJ-1'], action: 'restore' }, NOW);
    expect(t.skipped).toEqual({});
    expect(() => setQueueTriage(t, { keys: ['PROJ-1'], action: 'snooze', until: '2020-01-01' }, NOW)).toThrow(/future/);
    expect(() => setQueueTriage(t, { action: 'delete' })).toThrow(/one of/);
    t = setQueueTriage(t, { action: 'order', order: ['PROJ-3', 'PROJ-1', 'PROJ-3'] });
    expect(t.order).toEqual(['PROJ-3', 'PROJ-1']);
    const v = triageView(items, t, { now: NOW, tracked: new Set(['PROJ-2']) });
    expect(v.visible.map((i) => i.key)).toEqual(['PROJ-3', 'PROJ-1']);
  });

  it('estimates from tickets with the same tag when there are enough, else all', () => {
    const hist = [
      { summary: '[UI] a', costUsd: 2 }, { summary: '[UI] b', costUsd: 4 }, { summary: 'PROJ-5 — [UI] c', costUsd: 10 },
      { summary: '[FUNC] d', costUsd: 20 }, { summary: 'x', costUsd: 0 },
    ];
    expect(summaryTag('PROJ-5 — [UI] Modal')).toBe('UI');
    expect(summaryTag('[Ver 1.1.0-qa.33][FUNC][V2] Inventory history')).toBe('FUNC');
    expect(summaryTag('Plain [UI] later')).toBeNull();
    expect(estimateCost('[UI] new', hist)).toEqual({ median: 4, p75: 10, n: 3, basis: 'UI' });
    expect(estimateCost('[FUNC] new', hist)).toMatchObject({ n: 4, basis: 'all tickets', median: 7 });
    expect(estimateCost('x', [])).toBeNull();
  });
});

const PLAN = `Intro line.

## Summary
- Build the modal

## erp-next-ui-monorepo
### Step 1: add the modal
Create Modal.tsx
### Step 2: wire it
\`\`\`
## not a heading inside a fence
\`\`\`

## AC coverage
- [x] AC1 opens the modal
- [ ] AC2 validates input

## Legacy parity
- Matches W4ORDMAINT:1840
`;

describe('plan review', () => {
  it('splits the plan into stable, typed blocks and ignores headings in code', () => {
    const b = splitPlan(PLAN);
    expect(b.map((x) => x.id)).toEqual(['intro', 'summary', 'erp-next-ui-monorepo', 'erp-next-ui-monorepo--step-1-add-the-modal', 'erp-next-ui-monorepo--step-2-wire-it', 'ac-coverage', 'legacy-parity']);
    expect(b.find((x) => x.id === 'ac-coverage').kind).toBe('ac');
    expect(b.find((x) => x.id === 'legacy-parity').kind).toBe('parity');
    expect(b.find((x) => x.id.endsWith('step-2-wire-it')).body).toContain('## not a heading inside a fence');
    expect(checklist(PLAN)).toEqual([{ done: true, text: 'AC1 opens the modal' }, { done: false, text: 'AC2 validates input' }]);
  });

  it('turns open comments into re-plan notes, then marks them sent', () => {
    let r = addComment(null, { blockId: 'erp-next-ui-monorepo--step-2-wire-it', blockTitle: 'Step 2: wire it', text: 'Use the existing useTransfer hook' }, NOW);
    r = addComment(r, { blockId: 'summary', blockTitle: 'Summary', text: 'Drop the print button' }, new Date(NOW.getTime() + 1));
    const third = addComment(r, { blockId: 'summary', blockTitle: 'Summary', text: 'nit' }, new Date(NOW.getTime() + 2));
    r = updateComment(third, third.comments[2].id, { resolved: true });
    expect(openComments(r)).toHaveLength(2);
    const notes = replanNotes(r, 'Also keep it under 200 lines.');
    expect(notes).toContain('- On "Step 2: wire it": Use the existing useTransfer hook');
    expect(notes).not.toContain('nit');
    expect(notes).toMatch(/Also keep it under 200 lines\.$/);
    r = markSent(r, 2, NOW);
    expect(openComments(r)).toEqual([]);
    expect(r.comments.filter((c) => c.sentInVersion === 2)).toHaveLength(2);
    expect(replanNotes(r)).toBe('');
    expect(() => addComment(r, { blockId: 'x', text: '  ' })).toThrow(/empty/);
  });

  it('versions plan.md by content and diffs versions', () => {
    const v1 = nextVersion([], PLAN);
    expect(v1).toMatchObject({ version: 1, isNew: true });
    expect(nextVersion([v1.sha], PLAN)).toMatchObject({ version: 1, isNew: false });
    const PLAN2 = PLAN.replace('Create Modal.tsx', 'Create TransferModal.tsx').replace('## Legacy parity', '## Risks\n- none\n\n## Legacy parity');
    expect(nextVersion([v1.sha], PLAN2)).toMatchObject({ version: 2, isNew: true });
    const d = lineDiff(PLAN, PLAN2);
    expect(d.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['Create Modal.tsx']);
    expect(d.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['Create TransferModal.tsx', '## Risks', '- none', '']);
    expect(changedBlocks(PLAN, PLAN2)).toEqual({ added: ['risks'], changed: ['erp-next-ui-monorepo--step-1-add-the-modal'], removed: [] });
    expect(nextVersion([], '   ')).toBeNull();
  });

  it('reads planner questions and turns answers into the answers file and notes', () => {
    const qs = normaliseQuestions({ questions: [{ question: 'Who can override?', why: 'AC3 is silent', options: ['Managers', 'Anyone'] }, { id: 'Q9', question: 'Max lines?' }, { nope: 1 }] });
    expect(qs.map((q) => q.id)).toEqual(['Q1', 'Q9']);
    const r = answersFile(qs, { Q1: 'Managers only', Q9: '' }, NOW);
    expect(r.file.answers).toEqual([{ id: 'Q1', question: 'Who can override?', answer: 'Managers only' }]);
    expect(r.unanswered).toEqual(['Q9']);
    expect(r.notes).toContain('Answer: Managers only');
    expect(() => answersFile(qs, {}, NOW)).toThrow(/at least one/);
  });
});

describe('ticket chat', () => {
  it('validates questions', () => {
    expect(question('  why did verify fail? ', NOW)).toMatchObject({ text: 'why did verify fail?', at: NOW.toISOString() });
    expect(question('x', NOW).id).toMatch(/^\d{13}-[a-f0-9]{6}$/);
    expect(() => question('   ')).toThrow(/Ask/);
    expect(() => question('a'.repeat(4001))).toThrow(/under/);
  });

  it('keeps only suggestions the panel can run', () => {
    const a = normaliseAnswer({
      text: 'Verify failed on a stale type.',
      citations: ['verify.md:12'],
      suggestions: [{ action: 'continue', notes: 'regenerate types first' }, { action: 'ship' }, { action: 'rm -rf' }],
    });
    expect(a.suggestions).toEqual([{ action: 'continue', label: null, notes: 'regenerate types first', why: null }]);
    expect(normaliseAnswer({ text: '' })).toBeNull();
  });

  it('orders the conversation and marks unanswered questions pending', () => {
    const e = [
      { id: '0000000000002-aaaaaa', q: { text: 'second' } },
      { id: '0000000000001-bbbbbb', q: { text: 'first' }, a: { text: 'one' } },
      { id: '../../etc', q: { text: 'bad' } },
    ];
    const t = thread(e);
    expect(t.map((m) => m.question.text)).toEqual(['first', 'second']);
    expect(t[1].pending).toBe(true);
    expect(historyForRun(e)).toEqual([{ q: 'first', a: 'one' }]);
  });
});
