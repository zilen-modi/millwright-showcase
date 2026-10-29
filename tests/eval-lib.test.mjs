import { describe, expect, it } from 'vitest';

import { scoreDiff, summarizeEval, parseUnixDiff, weightsRespectPassBar } from '../scripts/eval-lib.mjs';

const TAG_EXPECT = {
  filesTouched: [
    'packages/erp-next-ui-kit-v2/src/components/Tag/',
    'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
  ],
  mustContain: [{ file: '_tag.scss', token: 'tag-neutral-background' }],
  noRawHexInComponents: true,
  testCountDelta: 'positive',
};

describe('scoreDiff', () => {
  it('perfect match scores 1.0 and passes', () => {
    const produced = {
      filesChanged: [
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx',
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss',
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
      ],
      additions: 120,
      deletions: 4,
      containsByFile: {
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss': [
          '$tag-neutral-background: var(--color-neutral-100);',
        ],
      },
      testCountDelta: 6,
    };
    const result = scoreDiff(produced, TAG_EXPECT);
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it('wrong files touched scores low', () => {
    const produced = {
      filesChanged: ['packages/erp-next-ui-kit-v2/src/components/Checkbox/Checkbox.tsx'],
      additions: 10,
      deletions: 0,
      containsByFile: {},
      testCountDelta: 0,
    };
    const result = scoreDiff(produced, TAG_EXPECT);
    expect(result.score).toBeLessThan(0.5);
    expect(result.pass).toBe(false);
    const fileCheck = result.checks.find((c) => c.name === 'file-overlap');
    expect(fileCheck.pass).toBe(false);
  });

  it('missing mustContain token fails that check and overall', () => {
    const produced = {
      filesChanged: [
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx',
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
      ],
      additions: 80,
      deletions: 2,
      containsByFile: {
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss': ['$tag-red-background: var(--color-red-100);'],
      },
      testCountDelta: 4,
    };
    const result = scoreDiff(produced, TAG_EXPECT);
    const mustContainCheck = result.checks.find((c) => c.name === 'must-contain');
    expect(mustContainCheck.pass).toBe(false);
    expect(mustContainCheck.detail).toContain('tag-neutral-background');
    expect(result.pass).toBe(false);
  });

  it('raw hex present in components fails noRawHexInComponents when required', () => {
    const produced = {
      filesChanged: [
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx',
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
      ],
      additions: 80,
      deletions: 2,
      containsByFile: {
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss': ['.dot { background: #ff0000; }'],
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss': [
          '$tag-neutral-background: var(--color-neutral-100);',
        ],
      },
      testCountDelta: 4,
    };
    const result = scoreDiff(produced, TAG_EXPECT);
    const hexCheck = result.checks.find((c) => c.name === 'no-raw-hex-in-components');
    expect(hexCheck.pass).toBe(false);
    expect(hexCheck.detail).toContain('Tag.module.scss');
    expect(result.pass).toBe(false);
  });

  it('does not flag hex-free component files or files outside src/components', () => {
    const produced = {
      filesChanged: ['packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx'],
      additions: 5,
      deletions: 0,
      containsByFile: {
        'packages/erp-next-ui-kit-v2/src/other/legacy.scss': ['.old { color: #123456; }'],
      },
      testCountDelta: 0,
    };
    const result = scoreDiff(produced, { noRawHexInComponents: true });
    const hexCheck = result.checks.find((c) => c.name === 'no-raw-hex-in-components');
    expect(hexCheck.pass).toBe(true);
  });

  it('testCountDelta sign mismatch fails that check', () => {
    const produced = {
      filesChanged: [
        'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx',
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
      ],
      additions: 80,
      deletions: 90,
      containsByFile: {
        'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss': [
          '$tag-neutral-background: var(--color-neutral-100);',
        ],
      },
      testCountDelta: -2,
    };
    const result = scoreDiff(produced, TAG_EXPECT);
    const testCheck = result.checks.find((c) => c.name === 'test-count-delta');
    expect(testCheck.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('unspecified expectations auto-pass (no filesTouched/mustContain/hex/testCountDelta requirement)', () => {
    const result = scoreDiff({ filesChanged: ['anything.ts'], testCountDelta: 0 }, {});
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
  });
});

describe('summarizeEval', () => {
  it('counts total/passed/failed and lists worst failing keys ascending by score', () => {
    const results = [
      { key: 'A', score: 1, pass: true, checks: [] },
      { key: 'B', score: 0.3, pass: false, checks: [] },
      { key: 'C', score: 0.6, pass: false, checks: [] },
      { key: 'D', score: 0.9, pass: true, checks: [] },
    ];
    const summary = summarizeEval(results);
    expect(summary).toEqual({ total: 4, passed: 2, failed: 2, worst: ['B', 'C'] });
  });

  it('handles an empty result set', () => {
    expect(summarizeEval([])).toEqual({ total: 0, passed: 0, failed: 0, worst: [] });
  });

  it('handles undefined input gracefully', () => {
    expect(summarizeEval()).toEqual({ total: 0, passed: 0, failed: 0, worst: [] });
  });
});

describe('parseUnixDiff', () => {
  it('extracts files changed, +/- counts, and per-file added lines', () => {
    const patch = `diff --git a/src/components/Tag/Tag.tsx b/src/components/Tag/Tag.tsx
index 1111111..2222222 100644
--- a/src/components/Tag/Tag.tsx
+++ b/src/components/Tag/Tag.tsx
@@ -1,2 +1,4 @@
+import React from 'react';
+export const Tag = () => null;
-export const Old = () => null;
 // unchanged
diff --git a/src/components/Tag/Tag.test.tsx b/src/components/Tag/Tag.test.tsx
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/components/Tag/Tag.test.tsx
@@ -0,0 +1,3 @@
+import { it, expect } from 'vitest';
+it('renders', () => { expect(true).toBe(true); });
+// trailing
`;
    const produced = parseUnixDiff(patch);
    expect(produced.filesChanged).toEqual(['src/components/Tag/Tag.tsx', 'src/components/Tag/Tag.test.tsx']);
    expect(produced.additions).toBe(5);
    expect(produced.deletions).toBe(1);
    expect(produced.containsByFile['src/components/Tag/Tag.tsx']).toEqual([
      "import React from 'react';",
      'export const Tag = () => null;',
    ]);
    expect(produced.testCountDelta).toBe(1);
  });

  it('returns empty-but-valid shape for empty input', () => {
    const produced = parseUnixDiff('');
    expect(produced).toEqual({ filesChanged: [], additions: 0, deletions: 0, containsByFile: {}, testCountDelta: 0 });
  });
});

describe('conventions check', () => {
  const COMPONENT = 'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss';
  const clean = () => ({ count: 0, violations: [] });
  const dirty = () => ({ count: 1, violations: [{ rule: 'no-todo-fixme', file: COMPONENT, line: 3, detail: 'TODO in shipped source' }] });

  it('passes when the injected linter reports no violations', () => {
    const result = scoreDiff({ containsByFile: { [COMPONENT]: ['padding: 4px;'] } }, { conventionsClean: true }, { lintSources: clean });
    expect(result.checks.find((c) => c.name === 'conventions').pass).toBe(true);
  });

  it('fails the whole diff when the linter reports a violation', () => {
    const result = scoreDiff({ containsByFile: { [COMPONENT]: ['// TODO: fix'] } }, { conventionsClean: true }, { lintSources: dirty });
    const check = result.checks.find((c) => c.name === 'conventions');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('no-todo-fixme');
    expect(result.pass).toBe(false);
  });

  // An unrunnable gate that waves everything through is the exact failure this harness
  // exists to catch, so a missing linter must fail closed rather than score 1.
  it('fails closed when the check is required but no linter was supplied', () => {
    const result = scoreDiff({ containsByFile: {} }, { conventionsClean: true }, {});
    const check = result.checks.find((c) => c.name === 'conventions');
    expect(check.pass).toBe(false);
    expect(check.detail).toContain('no linter');
  });

  it('is skipped, not failed, when the golden entry does not require it', () => {
    const result = scoreDiff({ containsByFile: {} }, {}, {});
    expect(result.checks.find((c) => c.name === 'conventions').pass).toBe(true);
  });
});

describe('raw-hex check ignores comments', () => {
  const SCSS = 'packages/erp-next-ui-kit-v2/src/components/Multiselect/Multiselect.module.scss';

  // Real shipped line from PROJ-2899 that the old blind line scan failed on.
  it('does not flag a hex documented inside a comment', () => {
    const produced = { containsByFile: { [SCSS]: ['// 1px vertical divider, h16. No token lands on the literal #a8a8a8;'] } };
    const result = scoreDiff(produced, { noRawHexInComponents: true });
    expect(result.checks.find((c) => c.name === 'no-raw-hex-in-components').pass).toBe(true);
  });

  it('still flags a hex actually bound to a property', () => {
    const produced = { containsByFile: { [SCSS]: ['  border-color: #a8a8a8;'] } };
    const result = scoreDiff(produced, { noRawHexInComponents: true });
    expect(result.checks.find((c) => c.name === 'no-raw-hex-in-components').pass).toBe(false);
  });
});

describe('weight invariant', () => {
  it('every hard gate outweighs the slack below the pass bar', () => {
    expect(weightsRespectPassBar()).toBe(true);
  });

  it('detects a gate weighted too low to gate anything', () => {
    expect(weightsRespectPassBar({ mustContain: 0.1, noRawHexInComponents: 0.3, testCountDelta: 0.3, conventions: 0.3 })).toBe(false);
  });
});
