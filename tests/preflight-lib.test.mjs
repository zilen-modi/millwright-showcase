import { describe, expect, it } from 'vitest';

import { preflightVerdict } from '../scripts/preflight-lib.mjs';

describe('preflightVerdict', () => {
  it('CLEAR-TO-BUILD when nothing references the ticket or files', () => {
    const v = preflightVerdict({ refCommits: [], refBranches: [], fileCommits: [], keys: ['PROJ-1'] });
    expect(v.verdict).toBe('CLEAR-TO-BUILD');
    expect(v.likelyExisting).toBe(false);
    expect(v.signals).toEqual([]);
  });

  it('REVIEW-BEFORE-BUILD from entry-file history even with zero key refs (the PROJ-2954 case)', () => {
    const v = preflightVerdict({ refCommits: [], refBranches: [], fileCommits: ['abc fix menu'], keys: ['PROJ-2954', 'PROJ-2823'] });
    expect(v.verdict).toBe('REVIEW-BEFORE-BUILD');
    expect(v.likelyExisting).toBe(true);
    expect(v.signals.some((s) => s.includes('entry files'))).toBe(true);
  });

  it('flags branch references', () => {
    const v = preflightVerdict({ refBranches: ['fix/PROJ-1'], keys: ['PROJ-1'] });
    expect(v.verdict).toBe('REVIEW-BEFORE-BUILD');
    expect(v.signals.some((s) => s.includes('branch'))).toBe(true);
  });
});
