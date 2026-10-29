import { describe, expect, it } from 'vitest';

import {
  isOwnPr,
  isRetryableReview,
  parsePrRef,
  prRefId,
  prUrlFromRef,
  recoverPrUrlFromRef,
} from '../scripts/pr-ref-lib.mjs';

describe('parsePrRef', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrRef('https://github.com/acme-it-erp/erp-next-ui-monorepo/pull/764')).toEqual({
      owner: 'acme-it-erp',
      repo: 'erp-next-ui-monorepo',
      number: 764,
    });
  });

  it('accepts an optional trailing slash', () => {
    expect(parsePrRef('https://github.com/acme-it-erp/erp-next-backend/pull/12/')).toEqual({
      owner: 'acme-it-erp',
      repo: 'erp-next-backend',
      number: 12,
    });
  });

  it('rejects a trailing /files (force the canonical form, do not silently strip)', () => {
    expect(parsePrRef('https://github.com/acme-it-erp/erp-next-backend/pull/12/files')).toBeNull();
  });

  it('rejects a diff query string', () => {
    expect(parsePrRef('https://github.com/acme-it-erp/erp-next-backend/pull/12?diff=split')).toBeNull();
  });

  it('rejects a non-github host', () => {
    expect(parsePrRef('https://gitlab.com/acme-it-erp/erp-next-backend/pull/12')).toBeNull();
  });

  it('rejects a non-numeric PR number', () => {
    expect(parsePrRef('https://github.com/acme-it-erp/erp-next-backend/pull/abc')).toBeNull();
  });

  it('rejects garbage / empty / non-string input without throwing', () => {
    expect(parsePrRef('not a url')).toBeNull();
    expect(parsePrRef('')).toBeNull();
    expect(parsePrRef(undefined)).toBeNull();
    expect(parsePrRef(null)).toBeNull();
  });
});

describe('isOwnPr', () => {
  it('matches case-insensitively (GitHub logins are case-insensitive)', () => {
    expect(isOwnPr('Zilen-Modi', 'zilen-modi')).toBe(true);
  });

  it('does not match a different login', () => {
    expect(isOwnPr('zilen-modi', 'someone-else')).toBe(false);
  });

  it('is never "own" when either side is missing/empty — no default-to-mine', () => {
    expect(isOwnPr('', 'zilen-modi')).toBe(false);
    expect(isOwnPr('zilen-modi', '')).toBe(false);
    expect(isOwnPr(undefined, undefined)).toBe(false);
    expect(isOwnPr(null, null)).toBe(false);
  });
});

describe('prRefId / prUrlFromRef', () => {
  const ref = { owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo', number: 806 };

  it('builds the pr-reviews directory id', () => {
    expect(prRefId(ref)).toBe('acme-it-erp-erp-next-ui-monorepo-806');
  });

  it('is NOT reversible — which is why the URL must be persisted for a retry', () => {
    // Both owner and repo contain '-', so the id cannot be split back into its parts.
    const id = prRefId(ref);
    expect(id.split('-').length).toBeGreaterThan(3);
    expect(id.split('-').pop()).toBe('806'); // only the number is recoverable
  });

  it('rebuilds the canonical URL from parsed parts', () => {
    expect(prUrlFromRef(ref)).toBe('https://github.com/acme-it-erp/erp-next-ui-monorepo/pull/806');
  });

  it('round-trips a canonical URL and normalizes a noncanonical one', () => {
    const url = 'https://github.com/acme-it-erp/erp-next-ui-monorepo/pull/806';
    expect(prUrlFromRef(parsePrRef(url))).toBe(url);
    // a trailing slash is accepted by the parser but never reaches argv
    expect(prUrlFromRef(parsePrRef(url + '/'))).toBe(url);
  });
});

describe('isRetryableReview', () => {
  it('never offers a retry while the run is live', () => {
    expect(isRetryableReview({ running: true, result: 'failed' })).toBe(false);
    expect(isRetryableReview({ running: true, result: null })).toBe(false);
  });

  it('offers a retry for the results that mean "did not finish"', () => {
    expect(isRetryableReview({ running: false, result: 'failed' })).toBe(true);
    expect(isRetryableReview({ running: false, result: 'cancelled' })).toBe(true);
    expect(isRetryableReview({ running: false, result: 'blocked' })).toBe(true);
    expect(isRetryableReview({ running: false, result: 'FAILED' })).toBe(true); // case-insensitive
  });

  it('offers a retry when no status was ever written — the run died early', () => {
    expect(isRetryableReview({ running: false, result: null })).toBe(true);
    expect(isRetryableReview({ running: false })).toBe(true);
    expect(isRetryableReview()).toBe(true);
  });

  it('offers a retry for a ZOMBIE — "in-progress" with nothing actually running', () => {
    // Real case (pr-reviews/acme-it-erp-erp-next-ui-monorepo-814): the skill stamps
    // "in-progress" up front, the run then died, and the card read as live forever.
    expect(isRetryableReview({ running: false, result: 'in-progress' })).toBe(true);
  });

  it('treats an unrecognised result as retryable rather than as a completed review', () => {
    // status.json is LLM-written prose-driven output; drift must not be read as success.
    expect(isRetryableReview({ running: false, result: 'whatever-it-invented' })).toBe(true);
  });

  it('does not offer a retry for a review that genuinely completed', () => {
    expect(isRetryableReview({ running: false, result: 'pushed-fix' })).toBe(false);
    expect(isRetryableReview({ running: false, result: 'report-only' })).toBe(false);
  });
});

describe('recoverPrUrlFromRef', () => {
  // Harvested from the reviews that DO have a persisted prUrl.
  const known = [
    { owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo' },
    { owner: 'acme-it-erp', repo: 'erp-next-ui-monorepo' }, // duplicates must not read as ambiguity
  ];

  it('recovers the URL for a legacy ref with no persisted prUrl (the real #818 case)', () => {
    expect(recoverPrUrlFromRef('acme-it-erp-erp-next-ui-monorepo-818', known))
      .toBe('https://github.com/acme-it-erp/erp-next-ui-monorepo/pull/818');
  });

  it('returns null when no known pair matches the ref', () => {
    expect(recoverPrUrlFromRef('someone-else-other-repo-5', known)).toBeNull();
  });

  it('refuses to guess when two different repos both match', () => {
    const ambiguous = [
      { owner: 'a', repo: 'b-c' },
      { owner: 'a-b', repo: 'c' }, // both yield the prefix "a-b-c-"
    ];
    expect(recoverPrUrlFromRef('a-b-c-7', ambiguous)).toBeNull();
  });

  it('requires the trailing segment to be all digits', () => {
    expect(recoverPrUrlFromRef('acme-it-erp-erp-next-ui-monorepo-feature', known)).toBeNull();
  });

  it('is safe against junk input, including `.map(fn)` passing the element index', () => {
    expect(recoverPrUrlFromRef('acme-it-erp-erp-next-ui-monorepo-818', 3)).toBeNull();
    expect(recoverPrUrlFromRef('x')).toBeNull();
    expect(recoverPrUrlFromRef(null, known)).toBeNull();
    expect(recoverPrUrlFromRef('a-b-1', [{ owner: '', repo: '' }, null])).toBeNull();
  });
});
