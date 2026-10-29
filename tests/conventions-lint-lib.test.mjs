import { describe, expect, it } from 'vitest';

import { classifyLines, lintProse, lintSources, sourcesFromUnixDiff } from '../scripts/conventions-lint-lib.mjs';

function violationsFor(rule, result) {
  return result.violations.filter((v) => v.rule === rule);
}

describe('classifyLines', () => {
  it('splits a line comment from any code before it', () => {
    const lines = classifyLines('color: #fff; // note');
    expect(lines[0].code).toBe('color: #fff; ');
    expect(lines[0].comment).toBe('// note');
  });

  it('tracks a block comment across multiple lines', () => {
    const lines = classifyLines('a /* start\nmiddle\nend */ b');
    expect(lines[0].code).toBe('a ');
    expect(lines[0].comment).toBe('/* start');
    expect(lines[1].code).toBe('');
    expect(lines[1].comment).toBe('middle');
    expect(lines[2].code).toBe(' b');
    expect(lines[2].comment).toBe('end */');
  });

  it('handles a single-line block comment followed by code', () => {
    const lines = classifyLines('/* note */ color: #fff;');
    expect(lines[0].comment).toBe('/* note */');
    expect(lines[0].code).toBe(' color: #fff;');
  });
});

describe('no-raw-hex', () => {
  it('flags a raw hex bound to a real declaration', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.module.scss', text: '.tag {\n  color: #0f62fe;\n}' }]);
    const hits = violationsFor('no-raw-hex', result);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'src/components/Tag/Tag.module.scss', line: 2 });
    expect(hits[0].detail).toContain('#0f62fe');
  });

  it('does NOT flag a hex documented inside a // comment (real false positive, Multiselect.module.scss:245)', () => {
    const line = '// 1px vertical divider, h16. No token lands on the literal #a8a8a8;';
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/src/components/Multiselect/Multiselect.module.scss', text: line }]);
    expect(violationsFor('no-raw-hex', result)).toHaveLength(0);
  });

  it('does NOT flag a hex inside a /* */ block comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.module.scss', text: '/* was #ffffff, now themed */\n.tag { color: var(--tag-bg); }' }]);
    expect(violationsFor('no-raw-hex', result)).toHaveLength(0);
  });

  it('does NOT flag a hex in a token-definition file', () => {
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss', text: '$tag-neutral-background: #f4f4f4;' }]);
    expect(violationsFor('no-raw-hex', result)).toHaveLength(0);
  });

  it('does NOT flag a hex in a non-style file (e.g. JSON/markdown)', () => {
    const result = lintSources([{ path: 'src/components/Tag/tokens.json', text: '{"bg": "#ffffff"}' }]);
    expect(violationsFor('no-raw-hex', result)).toHaveLength(0);
  });

  it('does NOT flag a resolved-value assertion in a *.scss.test.ts spec (real false positive, wizardFocus.scss.test.ts)', () => {
    const text = "expect(css).toMatch(/\\.scrim[^{]*\\{[^}]*background-color:\\s*#000000/);";
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/tests/components/WizardFocus/wizardFocus.scss.test.ts', text }]);
    expect(violationsFor('no-raw-hex', result)).toHaveLength(0);
  });
});

describe('no-figma-refs', () => {
  it('flags "Figma" inside a comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// per Figma this should be bold' }]);
    const hits = violationsFor('no-figma-refs', result);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail.toLowerCase()).toContain('per figma');
  });

  it('flags a Figma node id inside a comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// matches spec node 3091-1058' }]);
    const hits = violationsFor('no-figma-refs', result);
    // both the "spec node" phrase and the node id shape match on this line
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.detail.includes('3091-1058'))).toBe(true);
  });

  it('flags a Figma node id inside a test title', () => {
    const result = lintSources([{ path: 'tests/components/Tag/Tag.test.tsx', text: "it('matches node 1346:2928', () => {});" }]);
    const hits = violationsFor('no-figma-refs', result);
    expect(hits.some((h) => h.detail.includes('1346:2928'))).toBe(true);
    expect(hits[0].detail).toContain('test title');
  });

  it('does NOT flag "Figma" appearing in real code (not a comment or test title)', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: 'const figmaExportUrl = buildUrl();' }]);
    expect(violationsFor('no-figma-refs', result)).toHaveLength(0);
  });

  it('does NOT flag an ordinary number pair that is not a node-id shape (near miss)', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// max-width clamps between 16 and 32' }]);
    expect(violationsFor('no-figma-refs', result)).toHaveLength(0);
  });
});

describe('no-todo-fixme', () => {
  it('flags a TODO comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// TODO: handle empty state' }]);
    const hits = violationsFor('no-todo-fixme', result);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it('flags a FIXME comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// FIXME: this leaks a listener' }]);
    expect(violationsFor('no-todo-fixme', result)).toHaveLength(1);
  });

  it('does NOT flag an identifier that merely contains the substring (near miss)', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: 'const TodoModal = () => null;' }]);
    expect(violationsFor('no-todo-fixme', result)).toHaveLength(0);
  });
});

describe('comment-max-3-lines', () => {
  it('flags a // comment block longer than 3 consecutive lines', () => {
    const text = ['// one', '// two', '// three', '// four'].join('\n');
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text }]);
    const hits = violationsFor('comment-max-3-lines', result);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].detail).toContain('4 lines');
  });

  it('does NOT flag a 3-line // comment block (near miss, exactly at the limit)', () => {
    const text = ['// one', '// two', '// three', 'const x = 1;'].join('\n');
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text }]);
    expect(violationsFor('comment-max-3-lines', result)).toHaveLength(0);
  });

  it('does NOT flag a long /** */ JSDoc block (only // blocks are in scope)', () => {
    const text = ['/**', ' * one', ' * two', ' * three', ' * four', ' */', 'const x = 1;'].join('\n');
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text }]);
    expect(violationsFor('comment-max-3-lines', result)).toHaveLength(0);
  });

  it('does NOT flag a trailing inline // comment repeated on consecutive code lines', () => {
    const text = ['const a = 1; // one', 'const b = 2; // two', 'const c = 3; // three', 'const d = 4; // four'].join('\n');
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text }]);
    expect(violationsFor('comment-max-3-lines', result)).toHaveLength(0);
  });
});

describe('flat-component-structure', () => {
  it('flags a nested components/ subdirectory inside a component dir', () => {
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/src/components/Tag/components/Icon.tsx', text: '' }]);
    const hits = violationsFor('flat-component-structure', result);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBeNull();
  });

  it('flags a nested hooks/ subdirectory inside a component dir', () => {
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/src/components/Combobox/hooks/useTypeahead.ts', text: '' }]);
    expect(violationsFor('flat-component-structure', result)).toHaveLength(1);
  });

  it('does NOT flag the top-level components/ directory itself (near miss)', () => {
    const result = lintSources([{ path: 'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.tsx', text: '' }]);
    expect(violationsFor('flat-component-structure', result)).toHaveLength(0);
  });

  it('does NOT flag an unrelated "hooks" file that is not nested under a component dir', () => {
    const result = lintSources([{ path: 'src/hooks/useTypeahead.ts', text: '' }]);
    expect(violationsFor('flat-component-structure', result)).toHaveLength(0);
  });
});

describe('no-tool-branding', () => {
  it('flags "Autopilot" inside a comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// Generated with Autopilot' }]);
    expect(violationsFor('no-tool-branding', result).length).toBeGreaterThanOrEqual(1);
  });

  it('flags the robot emoji inside a comment', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: '// shipped 🤖' }]);
    expect(violationsFor('no-tool-branding', result)).toHaveLength(1);
  });

  it('flags "Co-authored-by" inside a test title', () => {
    const result = lintSources([{ path: 'tests/components/Tag/Tag.test.tsx', text: "it('Co-authored-by note', () => {});" }]);
    expect(violationsFor('no-tool-branding', result)).toHaveLength(1);
  });

  it('does NOT flag "Autopilot" appearing in real code (near miss)', () => {
    const result = lintSources([{ path: 'src/components/Tag/Tag.tsx', text: "const AUTOPILOT_FLAG = 'x';" }]);
    expect(violationsFor('no-tool-branding', result)).toHaveLength(0);
  });
});

describe('branch-name-shape', () => {
  it('does not run when no branch is given', () => {
    const result = lintSources([{ path: 'src/a.ts', text: '' }]);
    expect(violationsFor('branch-name-shape', result)).toHaveLength(0);
  });

  it('accepts a correctly-shaped branch name', () => {
    const result = lintSources([], { branch: 'fix/PROJ-2996-tag-iconleft-control' });
    expect(violationsFor('branch-name-shape', result)).toHaveLength(0);
  });

  it('flags the bare autopilot/PROJ-n default (real regression, PROJ-2996/2997)', () => {
    const result = lintSources([], { branch: 'autopilot/PROJ-2996' });
    const hits = violationsFor('branch-name-shape', result);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('autopilot/PROJ-2996');
  });

  it('flags a branch missing the kebab description', () => {
    const result = lintSources([], { branch: 'fix/PROJ-2996' });
    expect(violationsFor('branch-name-shape', result)).toHaveLength(1);
  });
});

describe('lintSources aggregate', () => {
  it('returns count === violations.length across multiple rules/files', () => {
    const result = lintSources([
      { path: 'src/components/Tag/Tag.module.scss', text: 'color: #0f62fe;' },
      { path: 'src/components/Tag/Tag.tsx', text: '// TODO: cleanup' },
    ]);
    expect(result.count).toBe(result.violations.length);
    expect(result.count).toBe(2);
  });

  it('returns a clean result for real, convention-following code', () => {
    const result = lintSources([
      { path: 'src/components/Tag/Tag.module.scss', text: '.tag {\n  color: var(--tag-neutral-background);\n}' },
      { path: 'src/components/Tag/Tag.tsx', text: 'export function Tag() {\n  return null;\n}' },
    ]);
    expect(result).toEqual({ count: 0, violations: [] });
  });

  it('tolerates a malformed/empty sources array rather than throwing', () => {
    expect(lintSources(undefined)).toEqual({ count: 0, violations: [] });
    expect(lintSources(null)).toEqual({ count: 0, violations: [] });
    expect(lintSources([])).toEqual({ count: 0, violations: [] });
    expect(lintSources([{ path: 'a.ts' }, null, { text: 'no path' }])).toEqual({ count: 0, violations: [] });
  });
});

describe('sourcesFromUnixDiff', () => {
  it('extracts only added lines per file, keyed by the new-file path', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const kept = 1;',
      '-const removed = 2;',
      '+const added = 3;',
      '+// TODO: added comment',
    ].join('\n');
    const sources = sourcesFromUnixDiff(patch);
    expect(sources).toEqual([{ path: 'src/a.ts', text: 'const added = 3;\n// TODO: added comment' }]);
  });

  it('skips a deleted file (new path is /dev/null)', () => {
    const patch = ['diff --git a/src/gone.ts b/src/gone.ts', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-const x = 1;'].join('\n');
    expect(sourcesFromUnixDiff(patch)).toEqual([]);
  });

  it('is tolerant of empty/malformed input', () => {
    expect(sourcesFromUnixDiff('')).toEqual([]);
    expect(sourcesFromUnixDiff(undefined)).toEqual([]);
  });
});

describe('lintProse', () => {
  it('flags branding in bare prose, which lintSources cannot see', () => {
    const body = 'Autopilot found two issues in this diff.';
    expect(lintProse(body).count).toBe(1);
    expect(lintProse(body).violations[0].rule).toBe('no-tool-branding');
    // The same text as a source file has no comment or test title, so lintSources is silent.
    expect(lintSources([{ path: 'a.md', text: body }]).count).toBe(0);
  });

  it('does not flag a finding that legitimately reports a TODO', () => {
    expect(lintProse('This leaves a TODO in the reducer that nothing tracks.').count).toBe(0);
  });

  // A PR comment is where a design citation belongs, so the whole no-figma-refs rule is off
  // here. These are the three real lines that blocked publishing on the PR 1056 review, plus
  // the design words and node ids that are now deliberately allowed.
  it.each([
    '- **FE omits a required query param** - `bom/endpoints.ts:29-35` never sends `branch`.',
    '- **New lookup chain has zero coverage** - `useTransferProductGrid.ts:459-472` is untested.',
    '- **Ambiguous error state** - `BomListModal.tsx:88-89` / `constants.ts:5`.',
    'Matches the Figma spec.',
    'Per Figma this should be 12px.',
    'The spec node says otherwise.',
    'Per Figma 3091-1058 the padding is 12px.',
    'Figma disagrees with `Modal.tsx:88-89`.',
    'Node 1346:2928 shows a 16px gap.',
  ])('allows design citations in a PR comment: %s', (line) => {
    expect(lintProse(line)).toEqual({ count: 0, violations: [] });
  });

  it('still blocks the same Figma reference inside code, where the rule does apply', () => {
    const r = lintSources([{ path: 'a.ts', text: '// Per Figma 3091-1058 the padding is 12px.' }]);
    expect(r.violations.map((v) => v.rule)).toContain('no-figma-refs');
  });

  it('flags branding on a line that also names Figma', () => {
    const r = lintProse('Autopilot checked this against Figma 3091-1058.');
    expect(r.violations.map((v) => v.rule)).toEqual(['no-tool-branding']);
  });

  it('reports 1-based line numbers and the given path', () => {
    const r = lintProse('clean line\nAutopilot wrote this', { path: 'draft.md' });
    expect(r.violations[0].line).toBe(2);
    expect(r.violations[0].file).toBe('draft.md');
  });

  it('is tolerant of empty input', () => {
    expect(lintProse('')).toEqual({ count: 0, violations: [] });
    expect(lintProse(undefined)).toEqual({ count: 0, violations: [] });
    expect(lintProse(null)).toEqual({ count: 0, violations: [] });
  });
});
