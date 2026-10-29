import { describe, expect, it } from 'vitest';

import {
  INTERNAL_JARGON_RE,
  bodyFits,
  extractFindings,
  renderPrComment,
  scrubInternals,
} from '../scripts/review-comment-lib.mjs';

// Fixture 1: real excerpt from pr-reviews/acme-it-erp-erp-next-ui-monorepo-1058/review.md
// - "## Findings" + bare "### High" / "### Medium" / "### Low" / "### Verified clean"
// buckets, an inline "**Recommendation:**" sentence, bounded by a following "## Standards".
const FINDINGS_HIGH_MEDIUM_LOW = `## Findings

**Verdict:** Structurally solid - good abstraction, real DRY work, clean file placement, no shipped-broken defects.

### High

- **From Branch locks exactly where the ticket says it must stay editable** - \`transfer-kind.ts:2062-2063\` locks the field the moment \`hasRequestedFromBranch\` is true.
  → Either drop \`hasRequestedFromBranch\` from the lock condition so a new request transfer's From Branch stays editable regardless of origin.
- **Ship is never gated for the To branch** - PROJ-3537 AC18 requires Ship to be disabled for a request transfer's receiving branch.
  → Add an \`isShipAllowed\`-style method to \`TransferKindBehaviour\`.

### Medium

- **No component-level tests for the two new interactive pieces** - \`BomProductsModal.tsx\` has zero render/interaction tests.
  → Add RTL render tests for both.

### Low

- **CSS \`:disabled\` rules that can never fire** - \`TransferEntryBody.module.scss:47,53,66-68\`.
  → Swap the selectors to \`&[aria-disabled='true']\`.

### Verified clean

- BOM Products modal copy matches PROJ-3535 verbatim.
- File placement: every new file matches its sibling directory's existing convention.

**Recommendation:** fix the High bucket (both Spec gaps plus the comment-length lint hit) before merge. Medium is real debt worth a fast follow-up but doesn't block.

## Standards

Some other section entirely, not part of findings.
`;

// Fixture 2: real excerpt from pr-reviews/acme-it-erp-erp-next-ui-monorepo-790/review.md
// - first "##" is "## Verdict" (no findings word); the real findings live in a LATER
// "## Findings (most severe first)", with an inline bracket tag on each numbered heading.
const VERDICT_FIRST_WITH_NUMBERED_TAGS = `## Verdict

Solid, well-structured new component. No accessibility gaps found in the diff.

## Findings (most severe first)

### 1. [MEDIUM · dry] Roving-focus boilerplate duplicated between the two nav hooks
\`src/components/PanelNav/usePanelNavigation.ts:28\`

The PR established the precedent that roving-focus math belongs in a shared module
(\`getNextIndex\` → \`src/utils/roving.ts\`). But the surrounding scaffolding is
re-implemented almost identically in \`usePanelNavigation.ts\` and \`useMenuNavigation.ts\`.

**Suggestion:** extend \`src/utils/roving.ts\` with a small shared controller.

### 2. [LOW · dry] \`KEY\` constant object duplicated verbatim from \`Menu/constants.ts\`
\`src/components/PanelNav/constants.ts\`

Same \`ArrowUp/ArrowDown/.../Escape\` key-name map as \`Menu/constants.ts\`.

## Duplication scan (mechanical + peer-component comparison)

Not part of the findings section.
`;

// Fixture 3: real excerpt from pr-reviews/acme-it-erp-erp-next-ui-monorepo-820/review.md
// - "## Prioritized Findings" + "### 🟡 Medium" / "### ⚪ Low", an inline recommendation,
// and a bold-only "**Verified clean:**" divider (not a "###" heading) with its own bullets.
const PRIORITIZED_FINDINGS_MEDIUM_LOW = `## Prioritized Findings

**Verdict:** Solid, low-risk bug fix. No high-severity issues.

### 🟡 Medium
- **Repeated Storybook decorator, 6 files** - each hand-rolls an identical \`containerWidth\` decorator.
  → Extract \`columnWidthDecorator(defaultWidth)\` into \`widthBounds.tsx\`.

### ⚪ Low
- **5-line comment block**, \`table-cell.scss.test.ts:13\` - exceeds the repo's 3-line comment convention.
  → Trim to one line covering the non-obvious "why".

**Recommendation:** Nothing here blocks merge. The medium finding is worth a quick follow-up.

**Verified clean:**
- Core width-bounds logic - well factored, not duplicated.
- Accessibility: 0 broader a11y failures.

## Reusability & Code Quality

Not part of the findings section.
`;

// Fixture 4: real excerpt from pr-reviews/acme-it-erp-erp-next-ui-monorepo-808/review.md
// - no heading anywhere matches /findings/i; the first "##" ("Reusability & Code Quality")
// has only non-severity "###" sub-headings, so nothing can be classified at all.
const NO_FINDINGS_SECTION = `## Reusability & Code Quality

Solid PR, follows the UI kit's established conventions closely.

### Duplication scan (jscpd, scoped to the 16 changed files)

Ran \`node autopilot/scripts/dup-scan.mjs\` scoped to this PR's changed files only.

### PR template "Code Review Checklist" - independently verified

Verified the two items in this agent's scope.

### Other observations (non-blocking)

Test coverage is strong.
`;

describe('extractFindings', () => {
  it('parses "## Findings" with bare "### High"/"### Medium"/"### Low" buckets', () => {
    const result = extractFindings(FINDINGS_HIGH_MEDIUM_LOW);

    expect(result.buckets.high).toHaveLength(2);
    expect(result.buckets.high[0].text).toContain('From Branch locks exactly');
    expect(result.buckets.high[0].fix).toContain("Either drop `hasRequestedFromBranch`");
    expect(result.buckets.high[1].text).toContain('Ship is never gated for the To branch');

    expect(result.buckets.medium).toHaveLength(1);
    expect(result.buckets.medium[0].text).toContain('No component-level tests');

    expect(result.buckets.low).toHaveLength(1);
    expect(result.buckets.low[0].text).toContain('CSS `:disabled` rules');

    expect(result.recommendation).toContain('fix the High bucket');
    expect(result.warnings).toEqual([]);
  });

  it('does not fall back when a "##" heading matches /findings/i, even behind an earlier "## Verdict"', () => {
    const result = extractFindings(VERDICT_FIRST_WITH_NUMBERED_TAGS);

    // the fallback warning must NOT fire - a real "## Findings ..." heading exists.
    expect(result.warnings).toEqual([]);
  });

  it('treats an inline bracket tag on a numbered "###" heading as that finding\'s own bucket + title', () => {
    const result = extractFindings(VERDICT_FIRST_WITH_NUMBERED_TAGS);

    expect(result.buckets.medium).toHaveLength(1);
    expect(result.buckets.medium[0].text).toContain('Roving-focus boilerplate duplicated between the two nav hooks');
    expect(result.buckets.medium[0].text).toContain('usePanelNavigation.ts');

    expect(result.buckets.low).toHaveLength(1);
    expect(result.buckets.low[0].text).toContain('KEY` constant object duplicated verbatim');
  });

  it('parses "## Prioritized Findings" with emoji "### 🟡 Medium"/"### ⚪ Low" buckets and an inline recommendation', () => {
    const result = extractFindings(PRIORITIZED_FINDINGS_MEDIUM_LOW);

    expect(result.buckets.high).toEqual([]);
    expect(result.buckets.medium).toHaveLength(1);
    expect(result.buckets.medium[0].text).toContain('Repeated Storybook decorator');
    expect(result.buckets.medium[0].fix).toContain('columnWidthDecorator');

    expect(result.buckets.low).toHaveLength(1);
    expect(result.buckets.low[0].text).toContain('5-line comment block');

    expect(result.recommendation).toContain('Nothing here blocks merge');

    // the "**Verified clean:**" bold divider is not a severity bucket, so its bullets
    // must not leak into the "low" bucket just because "### ⚪ Low" preceded it.
    expect(result.buckets.low).toHaveLength(1);
    expect(result.unclassified.some((u) => u.includes('Core width-bounds logic'))).toBe(true);
  });

  it('returns zero findings PLUS a non-empty warning when nothing can be classified (no findings section at all)', () => {
    const result = extractFindings(NO_FINDINGS_SECTION);

    expect(result.buckets).toEqual({ high: [], medium: [], low: [] });
    expect(result.unclassified).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/no severity buckets/i);
  });

  it('lets an inline "[medium]" tag on a bullet override its enclosing "### High" bucket', () => {
    const reviewMd = `## Findings

### High
- First real high-severity finding, nothing overridden here.
- **[medium]** Second finding is actually medium severity per its own inline tag.
`;
    const result = extractFindings(reviewMd);

    expect(result.buckets.high).toHaveLength(1);
    expect(result.buckets.high[0].text).toContain('First real high-severity finding');

    expect(result.buckets.medium).toHaveLength(1);
    expect(result.buckets.medium[0].text).toContain('Second finding is actually medium severity');
  });
});

describe('scrubInternals', () => {
  it('substitutes "conventions-lint.mjs" with the unbranded phrase (real string from -790)', () => {
    const { text } = scrubInternals(
      "Over-long comment block, flagged by `conventions-lint.mjs` (auto-fixable, unambiguous on an own PR).",
    );
    expect(text).toContain("the repo's lint rules");
    expect(text).not.toContain('conventions-lint');
  });

  it('substitutes "dup-scan"/"jscpd" and strips a leading internal-tool path prefix (real strings)', () => {
    const dupScan = scrubInternals('Ran `node autopilot/scripts/dup-scan.mjs` scoped to this PR\'s changed files only.');
    expect(dupScan.text).toContain('a duplication scan');
    expect(dupScan.text).not.toMatch(/autopilot/);
    expect(dupScan.text).not.toContain('dup-scan');

    const jscpd = scrubInternals('Duplication scan (jscpd, scoped to the 16 changed files)');
    expect(jscpd.text).toContain('a duplication scan');
    expect(jscpd.text).not.toMatch(/jscpd/i);

    const millwright = scrubInternals(
      '`node millwright/scripts/conventions-lint.mjs` flagged 11 violations of otherwise-locked rules.',
    );
    expect(millwright.text).not.toContain('millwright/');
    expect(millwright.text).toContain("the repo's lint rules");
  });

  it('strips severity/status emoji from real headings and bullets', () => {
    const { text } = scrubInternals('### 🔴 High\n- ✅ Verified clean\n- 🔒 mechanical rule');
    expect(text).not.toMatch(/🔴|✅|🔒/u);
    expect(text).toContain('### High');
  });

  it('deletes whole lines naming an internal agent (real strings)', () => {
    const { text } = scrubInternals(
      [
        'Kept finding.',
        'Three more `conventions-lint` hits, found when `quality-agent` re-ran the lint against full file contents.',
        'Another kept line.',
      ].join('\n'),
    );
    expect(text).not.toContain('quality-agent');
    expect(text).toContain('Kept finding.');
    expect(text).toContain('Another kept line.');
  });

  it('deletes lines containing codeQualityScore, unmeasured, or visualDiff (real strings)', () => {
    const score = scrubInternals('`codeQualityScore: 0.75`. Starting from 1.0: -0.06 duplicated logic.');
    expect(score.text).not.toContain('codeQualityScore');

    const unmeasured = scrubInternals(
      "no pre-existing equivalent elsewhere to reuse instead. `unmeasured` -> measured, none found.",
    );
    expect(unmeasured.text).not.toContain('unmeasured');

    const visualDiff = scrubInternals("same discipline as `review-agent`'s `visualDiffSkipReason`: all files checked.");
    expect(visualDiff.text).not.toContain('visualDiff');
  });

  it('deletes report-only lines and identity-check lines (real strings)', () => {
    const reportOnly = scrubInternals('Not my PR - report-only, no GitHub writes made.');
    expect(reportOnly.text).not.toContain('report-only');

    const identity = scrubInternals(
      'Identity check: PR author `teammate_acme` vs authenticated user `work-account` - not my PR.',
    );
    expect(identity.text).not.toContain('Identity check');
    expect(identity.text).not.toContain('teammate_acme');
  });

  it('deletes a line containing rubric', () => {
    const { text } = scrubInternals('Scored against the internal rubric before posting.');
    expect(text).not.toContain('rubric');
  });

  it('reports leftover internal jargon it cannot clean in unresolved[], with the matched text and line number', () => {
    const { text, unresolved } = scrubInternals(
      ['Line one is fine.', 'Judged on user impact per the review-pr playbook, nothing else changed.'].join('\n'),
    );
    expect(text).toContain('playbook');
    expect(unresolved).toEqual([{ line: 2, hit: 'playbook' }]);
  });

  it('exports INTERNAL_JARGON_RE and it matches the same token scrubInternals flags', () => {
    expect(INTERNAL_JARGON_RE.test('checked out into a worktree first')).toBe(true);
  });
});

describe('renderPrComment', () => {
  const buckets = {
    high: [{ text: 'A high finding with `file.ts:12` reference.', fix: 'Do the safe thing.' }],
    medium: [{ text: 'A medium finding, no fix suggested.', fix: null }],
    low: [{ text: 'A low finding.', fix: null }],
  };

  it('renders a "→" fix as a nested "- Suggested:" sub-bullet', () => {
    const out = renderPrComment({ buckets, severities: ['high'] });
    expect(out).toContain('- A high finding with `file.ts:12` reference.');
    expect(out).toContain('  - Suggested: Do the safe thing.');
  });

  it('filters by the requested severities only, in the requested order', () => {
    const out = renderPrComment({ buckets, severities: ['low', 'high'] });
    const lowIndex = out.indexOf('**Low**');
    const highIndex = out.indexOf('**High**');
    expect(lowIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeGreaterThan(lowIndex);
    expect(out).not.toContain('**Medium**');
  });

  it('appends the recommendation when findings are present', () => {
    const out = renderPrComment({ buckets, severities: ['high'], recommendation: 'Fix before merge.' });
    expect(out.trim().endsWith('Fix before merge.')).toBe(true);
  });

  it('never includes tool naming or emoji in the rendered body', () => {
    const out = renderPrComment({ buckets, severities: ['high', 'medium', 'low'] });
    expect(out).not.toMatch(/generated with|co-authored-by/i);
    expect(out).not.toMatch(/🤖/u);
  });

  it('returns an empty string when the selected severities contain zero findings', () => {
    const empty = renderPrComment({ buckets: { high: [], medium: [], low: [] }, severities: ['high', 'medium'] });
    expect(empty).toBe('');

    const noneSelected = renderPrComment({ buckets, severities: [] });
    expect(noneSelected).toBe('');
  });
});

describe('bodyFits', () => {
  it('reports ok:true with a byte count for a small body', () => {
    const result = bodyFits('a short comment');
    expect(result.ok).toBe(true);
    expect(result.limit).toBe(65536);
    expect(result.bytes).toBe(Buffer.byteLength('a short comment', 'utf8'));
  });

  it('reports ok:false with a Buffer.byteLength-computed byte count for an over-limit body, counting non-ASCII correctly', () => {
    // "→" is 3 bytes in UTF-8 but 1 UTF-16 code unit - use it to prove .length is not used.
    const arrow = '→';
    const body = arrow.repeat(30000);
    const result = bodyFits(body);

    expect(result.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(result.bytes).toBeGreaterThan(body.length);
    expect(result.ok).toBe(false);
  });
});

describe('publishing hygiene', () => {
  // `**[medium] Lead**  detail` opened its bold before the tag, so stripping the tag used to
  // leave an orphan `**` and ship unbalanced markdown to a PR.
  it('keeps bold balanced when an inline severity tag is stripped', () => {
    const md = [
      '## Findings',
      '',
      '### High',
      '- **[medium] Schema accepts a blank date, but the calendar hides it.** `helpers.ts:335` is the cause.',
      '',
    ].join('\n');
    const { buckets } = extractFindings(md);
    const text = buckets.medium[0].text;
    expect((text.match(/\*\*/g) || []).length % 2).toBe(0);
    expect(text.startsWith('**')).toBe(true);
  });

  it('renders an em dash as " - " for human-visible output', () => {
    const { text } = scrubInternals('the calendar hides it — the mismatch this exists to remove');
    expect(text).not.toMatch(/\u2014/);
    expect(text).toContain(' - the mismatch');
  });
});
