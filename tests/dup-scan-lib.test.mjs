import { describe, expect, it } from 'vitest';

import { normalizeJscpdReport, filterByChangedFiles } from '../scripts/dup-scan-lib.mjs';

describe('normalizeJscpdReport', () => {
  it('reshapes jscpd raw duplicates into the minimal stable shape', () => {
    const raw = {
      duplicates: [
        {
          format: 'typescript',
          lines: 15,
          tokens: 42,
          fragment: 'const x = 1;',
          firstFile: { name: 'src/a.tsx', start: 10, end: 24 },
          secondFile: { name: 'src/b.tsx', start: 5, end: 19 },
        },
      ],
    };
    expect(normalizeJscpdReport(raw)).toEqual({
      duplicates: [
        {
          files: ['src/a.tsx', 'src/b.tsx'],
          lines: [
            [10, 24],
            [5, 19],
          ],
          tokens: 42,
          fragment: 'const x = 1;',
        },
      ],
    });
  });

  it('drops entries missing either file name rather than throwing', () => {
    const raw = { duplicates: [{ firstFile: { name: 'a.ts', start: 1, end: 2 }, secondFile: {} }] };
    expect(normalizeJscpdReport(raw)).toEqual({ duplicates: [] });
  });

  it('is tolerant of a missing/malformed duplicates array', () => {
    expect(normalizeJscpdReport({})).toEqual({ duplicates: [] });
    expect(normalizeJscpdReport(null)).toEqual({ duplicates: [] });
    expect(normalizeJscpdReport({ duplicates: 'not-an-array' })).toEqual({ duplicates: [] });
  });

  it('defaults missing/non-numeric tokens to 0 and missing fragment to an empty string', () => {
    const raw = {
      duplicates: [{ firstFile: { name: 'a.ts', start: 1, end: 2 }, secondFile: { name: 'b.ts', start: 3, end: 4 } }],
    };
    expect(normalizeJscpdReport(raw).duplicates[0]).toMatchObject({ tokens: 0, fragment: '' });
  });
});

describe('filterByChangedFiles', () => {
  const duplicates = [
    { files: ['src/a.tsx', 'src/b.tsx'], lines: [[1, 2], [3, 4]], tokens: 10, fragment: '' },
    { files: ['src/unrelated1.tsx', 'src/unrelated2.tsx'], lines: [[1, 2], [3, 4]], tokens: 10, fragment: '' },
  ];

  it('keeps only duplicates touching at least one changed file', () => {
    expect(filterByChangedFiles(duplicates, ['src/a.tsx'])).toEqual([duplicates[0]]);
  });

  it('returns nothing when no changed files are given (never blame a PR with an empty diff)', () => {
    expect(filterByChangedFiles(duplicates, [])).toEqual([]);
    expect(filterByChangedFiles(duplicates, undefined)).toEqual([]);
  });

  it('returns nothing when the changed files match none of the flagged duplicates', () => {
    expect(filterByChangedFiles(duplicates, ['src/totally-different.tsx'])).toEqual([]);
  });
});
