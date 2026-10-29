import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normaliseFindings, setTriage } from '../scripts/findings-lib.mjs';
import { archiveReviewRound, loadFindingRows, reviewRounds } from '../dashboard/review-rounds-lib.mjs';

const ROUND1 = {
  headSha: 'r1',
  findings: [
    { id: 'F1', severity: 'high', title: 'Export skips the branch check', evidence: ['src/exports.ts:12'] },
    { id: 'F2', severity: 'medium', title: 'Duplicated date helper', evidence: ['src/util/date.ts:40'] },
  ],
};
const fp = Object.fromEntries(normaliseFindings(ROUND1).findings.map((f) => [f.id, f.fingerprint]));

let dir;
const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
const read = (...p) => JSON.parse(readFileSync(join(dir, ...p), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-rounds-'));
  put('findings.json', ROUND1);
  put('verdicts.json', { F1: { verdict: 'confirmed' }, F2: { verdict: 'refuted' } });
  put('review.md', '## Findings\n');
  put('triage.json', setTriage(null, fp.F1, { decision: 'accept', posted: { at: 't', url: 'u' } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('archiveReviewRound', () => {
  it('does nothing for a review with no structured findings', () => {
    rmSync(join(dir, 'findings.json'));
    expect(archiveReviewRound(dir)).toBeNull();
    expect(reviewRounds(dir)).toEqual([]);
  });

  it('moves findings and verdicts out, keeps review.md, and briefs the next run', () => {
    expect(archiveReviewRound(dir)).toBe(1);
    expect(existsSync(join(dir, 'findings.json'))).toBe(false);
    expect(existsSync(join(dir, 'verdicts.json'))).toBe(false);
    expect(existsSync(join(dir, 'review.md'))).toBe(true);
    expect(read('rounds', '1', 'verdicts.json').F2.verdict).toBe('refuted');
    const prev = read('previous-findings.json');
    expect(prev.round).toBe(1);
    expect(prev.findings.find((f) => f.fingerprint === fp.F1)).toMatchObject({ decision: 'accept', posted: true });
  });

  it('shows the archived round as stale while the re-review runs', () => {
    archiveReviewRound(dir);
    const s = loadFindingRows(dir);
    expect(s).toMatchObject({ stale: true, round: 1, previousRound: null });
    expect(s.rows.find((r) => r.id === 'F2').folded).toBe(true);
  });

  it('never applies the old round verdicts to the new round', () => {
    archiveReviewRound(dir);
    // round 2: different F2, no verifier output yet
    put('findings.json', { headSha: 'r2', findings: [
      { id: 'F1', severity: 'high', title: 'Branch check still missing', carriesOver: fp.F1, evidence: ['src/exports.ts:19'] },
      { id: 'F2', severity: 'high', title: 'A brand new real problem', evidence: ['src/new.ts:5'] },
    ], resolved: [{ fingerprint: fp.F2, status: 'fixed', reason: 'helper shared now' }] });
    const s = loadFindingRows(dir);
    expect(s).toMatchObject({ stale: false, round: 2, previousRound: 1 });
    const fresh = s.rows.find((r) => r.title === 'A brand new real problem');
    expect(fresh.folded).toBe(false);
    expect(fresh.verdict).toBe('unverified');
    expect(s.rows.find((r) => r.title === 'Branch check still missing')).toMatchObject({ decision: 'accept', since: 'still-open' });
    expect(s.resolved[0]).toMatchObject({ status: 'fixed' });
  });

  it('carries a decision through three rounds', () => {
    archiveReviewRound(dir);
    put('findings.json', { headSha: 'r2', findings: [
      { id: 'F1', severity: 'high', title: 'Branch check still missing', carriesOver: fp.F1, evidence: ['src/exports.ts:19'] },
    ] });
    const round2fp = loadFindingRows(dir).rows[0].fingerprint;
    expect(archiveReviewRound(dir)).toBe(2);
    put('findings.json', { headSha: 'r3', findings: [
      { id: 'F1', severity: 'high', title: 'Branch check missing again', carriesOver: round2fp, evidence: ['src/exports.ts:23'] },
    ] });
    const s = loadFindingRows(dir);
    expect(s).toMatchObject({ round: 3, previousRound: 2 });
    expect(s.rows[0]).toMatchObject({ decision: 'accept', since: 'still-open' });
    expect(s.rows[0].posted).toMatchObject({ url: 'u' });
    expect(reviewRounds(dir)).toEqual([1, 2]);
  });

  it('a failed re-review leaves nothing to archive, and the next one keeps the brief', () => {
    archiveReviewRound(dir);
    const brief = readFileSync(join(dir, 'previous-findings.json'), 'utf8');
    expect(archiveReviewRound(dir)).toBeNull();
    expect(readFileSync(join(dir, 'previous-findings.json'), 'utf8')).toBe(brief);
  });
});
