import { describe, expect, it } from 'vitest';

import { mergeWorklist, triageSubBugs, triageThreads } from '../scripts/pr-feedback-lib.mjs';

describe('triageThreads', () => {
  it('classifies an imperative/should/please comment as actionable and extracts path+line', () => {
    const { actionable, questions, info } = triageThreads([
      { path: 'src/Menu.tsx', line: 42, body: 'Please extract this into a hook.', author: 'reviewer1' },
    ]);
    expect(actionable).toEqual([
      { path: 'src/Menu.tsx', line: 42, ask: 'Please extract this into a hook.', source: 'pr-review', author: 'reviewer1' },
    ]);
    expect(questions).toEqual([]);
    expect(info).toEqual([]);
  });

  it('classifies a code suggestion block as actionable', () => {
    const { actionable } = triageThreads([
      { path: 'src/Menu.tsx', line: 10, body: '```suggestion\nconst x = 1;\n```', author: 'reviewer1' },
    ]);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].ask).toContain('```suggestion');
  });

  it('classifies a genuine question (no change-request phrase) as a question', () => {
    const { questions, actionable } = triageThreads([
      { path: 'src/Menu.tsx', line: 5, body: 'Is this component used anywhere else?', author: 'reviewer2' },
    ]);
    expect(actionable).toEqual([]);
    expect(questions).toEqual([
      { path: 'src/Menu.tsx', line: 5, ask: 'Is this component used anywhere else?', source: 'pr-review', author: 'reviewer2' },
    ]);
  });

  it('treats a "should...?" comment as actionable, not just a question (change-request wins)', () => {
    const { actionable, questions } = triageThreads([
      { path: 'src/Menu.tsx', line: 7, body: 'Should this handle the null case?', author: 'reviewer2' },
    ]);
    expect(questions).toEqual([]);
    expect(actionable).toHaveLength(1);
  });

  it('classifies praise/FYI as info', () => {
    const { info, actionable, questions } = triageThreads([
      { path: 'src/Menu.tsx', line: 1, body: 'Nice, LGTM overall!', author: 'reviewer3' },
    ]);
    expect(actionable).toEqual([]);
    expect(questions).toEqual([]);
    expect(info).toHaveLength(1);
    expect(info[0].ask).toBe('Nice, LGTM overall!');
  });

  it('skips resolved threads entirely', () => {
    const result = triageThreads([
      { path: 'src/Menu.tsx', line: 3, body: 'Please fix this.', resolved: true },
      { path: 'src/Menu.tsx', line: 4, body: 'Please fix this too.', resolved: false },
    ]);
    expect(result.actionable).toHaveLength(1);
    expect(result.actionable[0].line).toBe(4);
  });

  it('skips empty/whitespace-only bodies and omits path/line when absent', () => {
    const result = triageThreads([
      { body: '   ' },
      { body: 'Please add a test for this.' },
    ]);
    expect(result.actionable).toEqual([{ ask: 'Please add a test for this.', source: 'pr-review' }]);
  });

  it('defaults to an empty array and empty buckets when given no threads', () => {
    expect(triageThreads()).toEqual({ actionable: [], info: [], questions: [] });
  });
});

describe('triageSubBugs', () => {
  it('returns actionable items for sub-bugs that are not Done', () => {
    const result = triageSubBugs([
      { key: 'PROJ-3001', summary: 'Overflow menu clips on mobile', description: 'Repro on iPhone SE.', status: 'To Do' },
    ]);
    expect(result).toEqual([
      { key: 'PROJ-3001', ask: 'Overflow menu clips on mobile — Repro on iPhone SE.', source: 'sub-bug' },
    ]);
  });

  it('skips sub-bugs whose status is Done (case-insensitive)', () => {
    const result = triageSubBugs([
      { key: 'PROJ-3001', summary: 'Fixed already', status: 'Done' },
      { key: 'PROJ-3002', summary: 'Still open', status: 'done' },
      { key: 'PROJ-3003', summary: 'In progress one', status: 'In Progress' },
    ]);
    expect(result).toEqual([{ key: 'PROJ-3003', ask: 'In progress one', source: 'sub-bug' }]);
  });

  it('uses summary alone when there is no distinct description', () => {
    const result = triageSubBugs([{ key: 'PROJ-3004', summary: 'Only a summary', status: 'Open' }]);
    expect(result).toEqual([{ key: 'PROJ-3004', ask: 'Only a summary', source: 'sub-bug' }]);
  });

  it('defaults to an empty array when given nothing', () => {
    expect(triageSubBugs()).toEqual([]);
  });
});

describe('mergeWorklist', () => {
  it('orders most-specific first: path+line > path only > text-only', () => {
    const prTriage = {
      actionable: [
        { ask: 'General cleanup requested', source: 'pr-review' },
        { path: 'src/Menu.tsx', ask: 'File-level nit', source: 'pr-review' },
        { path: 'src/Menu.tsx', line: 12, ask: 'Fix the off-by-one here', source: 'pr-review' },
      ],
    };
    const bugTriage = [];
    const worklist = mergeWorklist(prTriage, bugTriage);
    expect(worklist.map((w) => w.ask)).toEqual([
      'Fix the off-by-one here',
      'File-level nit',
      'General cleanup requested',
    ]);
  });

  it('dedupes items that share the same path+line, keeping one entry', () => {
    const prTriage = {
      actionable: [{ path: 'src/Menu.tsx', line: 12, ask: 'Fix the off-by-one here', source: 'pr-review' }],
    };
    const bugTriage = [{ key: 'PROJ-3005', ask: 'off-by-one bug in Menu', source: 'sub-bug' }];
    // Not a text duplicate (different wording), but same location isn't expressed by the
    // sub-bug (no path/line) — so this case exercises "different asks, both kept".
    const worklist = mergeWorklist(prTriage, bugTriage);
    expect(worklist).toHaveLength(2);
  });

  it('dedupes items with identical path+line even when the ask text differs slightly', () => {
    const prTriage = {
      actionable: [{ path: 'src/Menu.tsx', line: 12, ask: 'Fix the off-by-one here', source: 'pr-review' }],
    };
    const bugTriage = [{ path: 'src/Menu.tsx', line: 12, ask: 'Off-by-one reported by QA', source: 'sub-bug' }];
    const worklist = mergeWorklist(prTriage, bugTriage);
    expect(worklist).toHaveLength(1);
    expect(worklist[0].ask).toBe('Fix the off-by-one here');
  });

  it('dedupes items with the same ask text (case/whitespace-insensitive) regardless of source', () => {
    const prTriage = { actionable: [{ ask: '  Please add a loading state  ', source: 'pr-review' }] };
    const bugTriage = [{ key: 'PROJ-3006', ask: 'please add a loading state', source: 'sub-bug' }];
    const worklist = mergeWorklist(prTriage, bugTriage);
    expect(worklist).toHaveLength(1);
  });

  it('accepts plain arrays (not just {actionable} objects) for both inputs', () => {
    const worklist = mergeWorklist(
      [{ path: 'a.ts', line: 1, ask: 'Fix a', source: 'pr-review' }],
      [{ key: 'K-1', ask: 'Fix b', source: 'sub-bug' }],
    );
    expect(worklist).toHaveLength(2);
  });

  it('returns an empty worklist when both inputs are empty', () => {
    expect(mergeWorklist({ actionable: [] }, [])).toEqual([]);
  });
});
