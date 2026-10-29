import { describe, expect, it } from 'vitest';

import {
  acceptedSha,
  buildReviewPayload,
  buildRows,
  fingerprint,
  normaliseFindings,
  previousForRun,
  rightSideLines,
  setTriage,
  settleInherited,
} from '../scripts/findings-lib.mjs';

const FINDINGS = {
  headSha: 'abc123',
  findings: [
    {
      id: 'F1', severity: 'high', axis: 'correctness', blocking: true,
      title: 'Export skips the branch check',
      body: 'Any signed-in user can download every branch.',
      fix: 'Reuse scopeToBranch before the query.',
      evidence: [{ file: 'src/exports.ts', line: 12 }, { file: 'src/orders/list.ts', line: 18 }],
    },
    { id: 'F2', severity: 'medium', axis: 'reuse', title: 'Duplicated date helper', evidence: ['src/util/date.ts:40'] },
    { id: 'F3', severity: 'high', title: 'Pagination may be wrong', body: 'Not sure the offset is applied.' },
    { id: 'F4', severity: 'low', title: 'Rename', evidence: [{ file: 'src/other.ts', line: 3 }] },
    { severity: 'urgent', title: 'Bad severity' },
    { severity: 'low' },
  ],
};

const DIFF = `diff --git a/src/exports.ts b/src/exports.ts
--- a/src/exports.ts
+++ b/src/exports.ts
@@ -10,4 +10,5 @@ export function x() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
diff --git a/src/util/date.ts b/src/util/date.ts
new file mode 100644
--- /dev/null
+++ b/src/util/date.ts
@@ -0,0 +1,2 @@
+export const d = 1;
+export const e = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
`;

describe('normaliseFindings', () => {
  it('keeps valid findings and explains every one it drops', () => {
    const { findings, warnings, headSha } = normaliseFindings(FINDINGS);
    expect(headSha).toBe('abc123');
    expect(findings.map((f) => f.id)).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(warnings).toHaveLength(2);
  });

  it('accepts "file:line" strings as evidence', () => {
    const f2 = normaliseFindings(FINDINGS).findings.find((f) => f.id === 'F2');
    expect(f2.evidence).toEqual([{ file: 'src/util/date.ts', line: 40, note: '' }]);
  });

  it('turns a high or blocking finding with no file:line into a question', () => {
    const f3 = normaliseFindings(FINDINGS).findings.find((f) => f.id === 'F3');
    expect(f3.kind).toBe('question');
    expect(f3.blocking).toBe(false);
    expect(f3.demoted).toMatch(/no file:line/);
  });

  it('leaves an evidenced blocking finding alone', () => {
    const f1 = normaliseFindings(FINDINGS).findings.find((f) => f.id === 'F1');
    expect(f1.kind).toBe('issue');
    expect(f1.blocking).toBe(true);
  });

  it('reports a file with no findings array instead of throwing', () => {
    expect(normaliseFindings({}).warnings[0]).toMatch(/no findings array/);
  });
});

describe('fingerprint', () => {
  it('survives an id renumbering but not a change of place', () => {
    const a = { title: 'X', evidence: [{ file: 'a.ts', line: 1 }] };
    expect(fingerprint({ ...a, id: 'F9' })).toBe(fingerprint({ ...a, id: 'F1' }));
    expect(fingerprint({ ...a, evidence: [{ file: 'a.ts', line: 2 }] })).not.toBe(fingerprint(a));
  });
});

describe('buildRows', () => {
  it('folds refuted findings, keeps them, and sorts them last', () => {
    const { rows, counts } = buildRows({ findings: FINDINGS, verdicts: { F1: { verdict: 'refuted', reason: 'scoped in middleware' } } });
    const f1 = rows.find((r) => r.id === 'F1');
    expect(f1.folded).toBe(true);
    expect(f1.verdictReason).toBe('scoped in middleware');
    expect(rows[rows.length - 1].id).toBe('F1');
    expect(counts.folded).toBe(1);
    expect(counts.undecided).toBe(3);
  });

  it('reads verdicts as a list too, and marks the rest unverified', () => {
    const { rows } = buildRows({ findings: FINDINGS, verdicts: { verdicts: [{ id: 'F2', verdict: 'confirmed' }] } });
    expect(rows.find((r) => r.id === 'F2').verdict).toBe('confirmed');
    expect(rows.find((r) => r.id === 'F4').verdict).toBe('unverified');
  });

  it('applies triage by fingerprint, so it survives a re-run', () => {
    const f2 = normaliseFindings(FINDINGS).findings.find((f) => f.id === 'F2');
    const triage = setTriage(null, f2.fingerprint, { decision: 'accept' });
    const renumbered = { findings: FINDINGS.findings.map((f) => (f.id === 'F2' ? { ...f, id: 'F7' } : f)) };
    const { rows, counts } = buildRows({ findings: renumbered, triage });
    expect(rows.find((r) => r.id === 'F7').decision).toBe('accept');
    expect(counts.accept).toBe(1);
  });
});

describe('setTriage', () => {
  it('sets, edits and clears a decision', () => {
    let t = setTriage(null, 'fp', { decision: 'park' }, 't1');
    expect(t.entries.fp).toEqual({ decision: 'park', at: 't1' });
    t = setTriage(t, 'fp', { body: 'my words' }, 't2');
    expect(t.entries.fp).toEqual({ decision: 'park', body: 'my words', at: 't2' });
    t = setTriage(t, 'fp', { decision: null, body: '' }, 't3');
    expect(t.entries.fp).toBeUndefined();
  });

  it('refuses an unknown decision', () => {
    expect(() => setTriage(null, 'fp', { decision: 'approve' })).toThrow(/accept, park, reject/);
  });
});

describe('rightSideLines', () => {
  it('maps added and context lines, never removed ones or deleted files', () => {
    const map = rightSideLines(DIFF);
    expect([...map.get('src/exports.ts')]).toEqual([10, 11, 12, 13]);
    expect([...map.get('src/util/date.ts')]).toEqual([1, 2]);
    expect(map.has('src/gone.ts')).toBe(false);
  });
});

describe('buildReviewPayload', () => {
  const decide = (decisions, extra = {}) => {
    let triage = null;
    const { findings } = normaliseFindings(FINDINGS);
    for (const [id, decision] of Object.entries(decisions)) {
      triage = setTriage(triage, findings.find((f) => f.id === id).fingerprint, { decision, ...(extra[id] || {}) });
    }
    return buildRows({ findings: FINDINGS, triage }).rows;
  };

  it('posts only accepted findings, inline where the evidence is on the diff', () => {
    const rows = decide({ F1: 'accept', F2: 'accept', F4: 'reject' });
    const r = buildReviewPayload({ rows, commentable: rightSideLines(DIFF), commitId: 'abc123' });
    expect(r.payload.event).toBe('COMMENT');
    expect(r.payload.commit_id).toBe('abc123');
    expect(r.payload.comments).toEqual([
      expect.objectContaining({ path: 'src/exports.ts', line: 12, side: 'RIGHT' }),
    ]);
    // F2's line 40 is not on the diff, so it goes in the body with its location.
    expect(r.inBody.map((b) => b.id)).toEqual(['F2']);
    expect(r.payload.body).toContain('`src/util/date.ts:40`');
    expect(r.payload.body).not.toContain('Rename');
    expect(r.acceptedCount).toBe(2);
  });

  it('matches an evidence path that is a suffix of the diff path', () => {
    const rows = decide({ F1: 'accept' });
    const commentable = new Map([['backend/src/exports.ts', new Set([12])]]);
    const r = buildReviewPayload({ rows, commentable });
    expect(r.payload.comments[0].path).toBe('backend/src/exports.ts');
  });

  it('puts everything in the body when the PR moved since the review', () => {
    const rows = decide({ F1: 'accept' });
    const r = buildReviewPayload({ rows, commentable: null });
    expect(r.payload.comments).toEqual([]);
    expect(r.inBody).toHaveLength(1);
  });

  it("posts the operator's own wording when they edited a finding", () => {
    const rows = decide({ F1: 'accept' }, { F1: { body: 'Could this reuse scopeToBranch?' } });
    const r = buildReviewPayload({ rows, commentable: rightSideLines(DIFF) });
    expect(r.payload.comments[0].body).toBe('Could this reuse scopeToBranch?');
  });

  it('scrubs internal tooling names and reports what it cannot fix', () => {
    const rows = decide({ F1: 'accept' }, { F1: { body: 'Found by quality-agent.\nThe orchestrator saw it.' } });
    const r = buildReviewPayload({ rows, commentable: rightSideLines(DIFF) });
    expect(r.payload.comments[0].body).not.toMatch(/quality-agent/);
    expect(r.unresolved).toEqual([expect.objectContaining({ hit: 'orchestrator' })]);
  });

  it('changes acceptedSha when the accepted set or its wording changes', () => {
    const a = acceptedSha(decide({ F1: 'accept' }));
    expect(acceptedSha(decide({ F1: 'accept', F2: 'accept' }))).not.toBe(a);
    expect(acceptedSha(decide({ F1: 'accept' }, { F1: { body: 'other words' } }))).not.toBe(a);
    expect(acceptedSha(decide({ F1: 'accept', F4: 'park' }))).toBe(a);
  });
});

describe('re-review rounds', () => {
  const ROUND1 = {
    headSha: 'r1',
    findings: [
      { id: 'F1', severity: 'high', title: 'Export skips the branch check', evidence: [{ file: 'src/exports.ts', line: 12 }] },
      { id: 'F2', severity: 'medium', title: 'Duplicated date helper', evidence: ['src/util/date.ts:40'] },
      { id: 'F3', severity: 'low', title: 'Rename', evidence: ['src/other.ts:3'] },
      { id: 'F4', severity: 'medium', title: 'Missing test', evidence: ['src/exports.ts:30'] },
    ],
  };
  const fp1 = Object.fromEntries(normaliseFindings(ROUND1).findings.map((f) => [f.id, f.fingerprint]));
  // Round 1's decisions and post.
  let triage = setTriage(null, fp1.F1, { decision: 'accept', posted: { at: 't', url: 'https://x/review' } });
  triage = setTriage(triage, fp1.F2, { decision: 'reject' });
  triage = setTriage(triage, fp1.F3, { decision: 'park', body: 'my words' });

  // Round 2: the author moved the code. The run renumbers, re-words F1 and carries it over by
  // fingerprint, F3 keeps its title and file (heuristic match), F2 is fixed, F4 not mentioned.
  const ROUND2 = {
    headSha: 'r2',
    findings: [
      { id: 'F1', severity: 'medium', title: 'New: unbounded query', evidence: ['src/exports.ts:50'] },
      { id: 'F2', severity: 'high', title: 'Export still skips the branch check', carriesOver: fp1.F1, evidence: [{ file: 'src/exports.ts', line: 19 }] },
      { id: 'F3', severity: 'low', title: 'Rename', evidence: ['src/other.ts:9'] },
    ],
    resolved: [{ fingerprint: fp1.F2, status: 'fixed', reason: 'now imports the shared helper' }],
  };
  const state = buildRows({ findings: ROUND2, verdicts: { F1: { verdict: 'refuted' } }, triage, previous: ROUND1 });
  const byTitle = (t) => state.rows.find((r) => r.title === t);

  it('carries decision, wording and the posted mark to the same problem at its new line', () => {
    const still = byTitle('Export still skips the branch check');
    expect(still.since).toBe('still-open');
    expect(still.carriedFrom).toBe(fp1.F1);
    expect(still.decision).toBe('accept');
    expect(still.decisionInherited).toBe(true);
    expect(still.posted.url).toBe('https://x/review');
    expect(byTitle('Rename').editedBody).toBe('my words');
  });

  it('marks new findings, and applies verdicts only to this round', () => {
    const fresh = byTitle('New: unbounded query');
    expect(fresh.since).toBe('new');
    expect(fresh.decision).toBeNull();
    // the verdict for round 2's F1 lands on round 2's F1, not on what round 1 called F1
    expect(fresh.folded).toBe(true);
    expect(byTitle('Export still skips the branch check').folded).toBe(false);
  });

  it('lists what is gone, trusting only the run for "fixed"', () => {
    const r = Object.fromEntries(state.resolved.map((x) => [x.title, x]));
    expect(r['Duplicated date helper']).toMatchObject({ status: 'fixed', decision: 'reject' });
    expect(r['Missing test'].status).toBe('not-raised');
    expect(state.counts).toMatchObject({ new: 1, resolved: 2, posted: 1, toPost: 0 });
  });

  it('never posts a finding that is already on the PR', () => {
    const r = buildReviewPayload({ rows: state.rows, commentable: null });
    expect(r.acceptedCount).toBe(0);
    expect(r.fingerprints).toEqual([]);
  });

  it('settles inherited state so round 3 only needs round 2', () => {
    const settled = settleInherited(state, triage);
    const still = byTitle('Export still skips the branch check');
    expect(settled.entries[still.fingerprint]).toMatchObject({ decision: 'accept', posted: { url: 'https://x/review' } });
    // round 3 sees round 2 as "previous" and carries from round 2's fingerprint
    const round3 = buildRows({
      findings: { findings: [{ id: 'F1', severity: 'high', title: 'Branch check missing', carriesOver: still.fingerprint, evidence: ['src/exports.ts:21'] }] },
      triage: settled,
      previous: ROUND2,
    });
    expect(round3.rows[0]).toMatchObject({ decision: 'accept', since: 'still-open' });
    expect(round3.rows[0].posted).not.toBeNull();
  });

  it('ignores a carriesOver that names no previous finding', () => {
    const s = buildRows({ findings: { findings: [{ severity: 'low', title: 'X', carriesOver: 'nope', evidence: ['a.ts:1'] }] }, previous: ROUND1 });
    expect(s.rows[0].since).toBe('new');
  });

  it('tells the run each previous finding with its decision and posted state', () => {
    const p = previousForRun(state, 2);
    expect(p.round).toBe(2);
    expect(p.findings.find((f) => f.title === 'Export still skips the branch check')).toMatchObject({ decision: 'accept', posted: true, evidence: ['src/exports.ts:19'] });
  });
});
