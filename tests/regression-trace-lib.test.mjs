import { describe, expect, it } from 'vitest';

import {
  CANONICAL_COMPONENTS,
  componentsFromFilePaths,
  componentsFromTitle,
  extractTicketType,
  extractDescriptionText,
  classifyFidelityDefect,
  buildComponentShipMap,
  traceRegressions,
  correlateRubricEscapes,
} from '../scripts/regression-trace-lib.mjs';

// Fixture text below is trimmed/paraphrased from the real tickets/<KEY>/ticket.md files in
// this repo (same title + header shape, same "## Design" boilerplate pattern) so the
// classifier is exercised against the real shape of the data, not an idealized one.

const TAG_TICKET = `# PROJ-2825 — Update Tag Component
**Type:** Story · **Status:** READY FOR DEVELOPMENT · **Priority:** Medium
**Epic / Parent:** PROJ-2622 — UI Kit 2.0

## Goal
Build/update Tag and Tag Group to match Design Guide V2.
`;

const RADIO_FONT_ESCAPE = `# PROJ-3012 — [UI] Radio button: Value and Group Label Font-family mismatch between Storybook implementation and Figma design
**Type** · Sub-Bug | **Status** · Backlog | **Parent** · PROJ-2832

## Summary
The Radio button's Value text and Group Label render with the default system font stack
instead of binding the Poppins font-family specified in the Figma Design Guide V2.

## Acceptance criteria
- [ ] Radio button value text uses Poppins 400 (body-short) typography in Storybook
`;

const RADIO_GEOMETRY_ESCAPE = `# PROJ-3014 — Radio button: Height and width mismatch between Storybook implementation and Figma design
**Type** · Sub-Bug | **Status** · Backlog | **Parent** · PROJ-2832

## Summary
Radio control geometry does not match the Figma spec: rendered ring is ~23px, Figma spec is 17.5px.
`;

const MULTISELECT_PADDING_ESCAPE = `# PROJ-3022 — [UX] MultiSelect: Padding and Border Width Discrepancy with Figma Design
**Type** · Sub-Bug · **Status** · Backlog · **Parent** · PROJ-2899 — Create/Update Multiselect Component

## Summary
Field padding and border width do not match the Figma design across sizes.
`;

const TAG_COLOR_ESCAPE = `# PROJ-3025 — [UI] Color mismatches with Figma
Sub-Bug · Backlog · Medium · Parent: PROJ-2825 — Update Tag Component

## Acceptance criteria
- [ ] Dark-theme swatches match the Figma colour tokens for every Tag colour.
`;

const TAG_PADDING_ESCAPE = `# PROJ-3028 — [UI] Top, Bottom padding values are different
Type · Sub-Bug | Status · Backlog | Parent · PROJ-2825 — Update Tag Component

## Problem
The Tag component's vertical padding (top/bottom) is currently 0px across all sizes, but the
Figma design specifies non-zero vertical padding.
`;

// PROJ-3027 (TagGroup overflow a11y-label escape) is deliberately NOT reproduced as a
// "heuristic fires" fixture: its defect text ("Add proper aria-label to the '+N' overflow
// tag") never says "Figma" outside the boilerplate Design section this module strips, so
// the lexical heuristic legitimately misses it. It's still exercised below via golden-set
// ground truth, which is the honest way this classifier catches it.
const TAGGROUP_OVERFLOW_A11Y_ESCAPE = `# PROJ-3027 — [UI] Need an example in Tag group to view a list of truncated tags with an overflowed tag group
Sub-Bug · Backlog · Medium · Parent: PROJ-2825 (Update Tag Component)

## Acceptance criteria
- [ ] Create a Storybook example showing a list of truncated tags with tag group overflow
- [ ] Add proper aria-label to the "+N" overflow tag for assistive technology

## Design
Figma node IDs (from parent PROJ-2825):
- Tag set: 719-2
`;

const KEYBOARD_BUG_NOT_ESCAPE = `# PROJ-3016 — [FUNC][ACCESSIBILITY] Radio button: Pressing ENTER does not select the radiobutton
Sub-Bug · Backlog · Medium · Parent: PROJ-2832

## Acceptance criteria
- [ ] Radio button selects when Enter key is pressed

## Design
None (behaviour bug — no visual/token changes required).
`;

const STORYBOOK_CONTROL_BUG_NOT_ESCAPE = `# PROJ-2996 — [UI] iconLeft option can't be configured in story book
**Type:** Sub-Bug · **Status:** Backlog · **Parent:** PROJ-2825 — Update Tag Component

## Problem summary
The iconLeft control is not configurable in the Storybook instance for the Tag component.
`;

const DEMO_WIRING_BUG_NOT_ESCAPE = `# PROJ-3026 — [Functional] Clicking on action/dismiss icon doesn't remove the tag
Type · Sub-Bug | Status · Backlog | Parent · PROJ-2825 — Update Tag Component

## Summary
Clicking the dismiss (x) action control fires the dismiss event but does not remove the tag.

## Acceptance Criteria
- [ ] Dismiss control has an accessible label

## Design
- Figma – Tag Set: Node 719-2
- Figma – Colors: Node 1782-2
`;

const NEW_TREE_TICKET = `# PROJ-2682 — Create Tree Component
Story · READY FOR DEVELOPMENT · Medium · Parent: PROJ-2622 — UI Kit 2.0

## Acceptance criteria
- [ ] Every row renders from the Branch node item component.
`;

const NEW_NOTIFICATION_TICKET = `# PROJ-2998 — Create Notification & Callout Component
**Type** · Story | **Status** · READY FOR DEVELOPMENT | **Epic** · PROJ-2622 (UI Kit 2.0)
`;

describe('extractTicketType', () => {
  it('reads the **Type:** label form', () => {
    expect(extractTicketType(TAG_TICKET)).toBe('Story');
  });
  it('reads the **Type** · value form', () => {
    expect(extractTicketType(RADIO_FONT_ESCAPE)).toBe('Sub-Bug');
  });
  it('reads the unlabelled metadata-line form', () => {
    expect(extractTicketType(TAG_COLOR_ESCAPE)).toBe('Sub-Bug');
  });
  it('returns null when there is no ticket.md at all', () => {
    expect(extractTicketType(null)).toBeNull();
    expect(extractTicketType('')).toBeNull();
  });
});

describe('extractDescriptionText', () => {
  it('drops the boilerplate Design section but keeps Summary/AC', () => {
    const text = extractDescriptionText(DEMO_WIRING_BUG_NOT_ESCAPE);
    expect(text).toContain('accessible label');
    expect(text).not.toContain('719-2');
    expect(text).not.toContain('figma'); // only appeared inside the stripped Design section
  });

  it('keeps a Figma mention that is inside an included section', () => {
    const text = extractDescriptionText(RADIO_FONT_ESCAPE);
    expect(text).toContain('figma');
    expect(text).toContain('poppins');
  });
});

describe('classifyFidelityDefect — known escapes fire', () => {
  const cases = [
    ['PROJ-3012 radio font', RADIO_FONT_ESCAPE],
    ['PROJ-3014 radio geometry', RADIO_GEOMETRY_ESCAPE],
    ['PROJ-3022 multiselect padding', MULTISELECT_PADDING_ESCAPE],
    ['PROJ-3025 tag dark colours', TAG_COLOR_ESCAPE],
    ['PROJ-3028 tag vertical padding', TAG_PADDING_ESCAPE],
  ];
  for (const [label, md] of cases) {
    it(`fires for ${label}`, () => {
      const type = extractTicketType(md);
      const descriptionText = extractDescriptionText(md);
      const { isFidelityDefect, reasons } = classifyFidelityDefect({ type, descriptionText });
      expect(isFidelityDefect).toBe(true);
      expect(reasons.join(' ')).toMatch(/figma/i);
    });
  }

  it('does NOT independently fire for PROJ-3027 (a11y-label escape) — a documented heuristic limit', () => {
    const type = extractTicketType(TAGGROUP_OVERFLOW_A11Y_ESCAPE);
    const descriptionText = extractDescriptionText(TAGGROUP_OVERFLOW_A11Y_ESCAPE);
    const { isFidelityDefect } = classifyFidelityDefect({ type, descriptionText });
    expect(isFidelityDefect).toBe(false);
  });
});

describe('classifyFidelityDefect — non-escapes do not fire', () => {
  const cases = [
    ['PROJ-3016 keyboard/a11y bug (explicitly no visual change)', KEYBOARD_BUG_NOT_ESCAPE],
    ['PROJ-2996 storybook-controls bug', STORYBOOK_CONTROL_BUG_NOT_ESCAPE],
    ['PROJ-3026 demo-wiring bug (Figma only in stripped Design section)', DEMO_WIRING_BUG_NOT_ESCAPE],
  ];
  for (const [label, md] of cases) {
    it(`does not fire for ${label}`, () => {
      const type = extractTicketType(md);
      const descriptionText = extractDescriptionText(md);
      const { isFidelityDefect } = classifyFidelityDefect({ type, descriptionText });
      expect(isFidelityDefect).toBe(false);
    });
  }

  it('does not fire for genuinely new work (Story type short-circuits)', () => {
    for (const md of [NEW_TREE_TICKET, NEW_NOTIFICATION_TICKET]) {
      const type = extractTicketType(md);
      const descriptionText = extractDescriptionText(md);
      expect(classifyFidelityDefect({ type, descriptionText }).isFidelityDefect).toBe(false);
    }
  });
});

describe('componentsFromFilePaths', () => {
  it('extracts canonical component names from real diff-shaped paths', () => {
    const paths = [
      'packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss',
      'packages/erp-next-ui-kit-v2/stories/Components/Tag/Tag.stories.tsx',
      'packages/erp-next-ui-kit-v2/tests/components/TagGroup/TagGroup.test.tsx',
      'packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss',
    ];
    expect(componentsFromFilePaths(paths)).toEqual(['Tag', 'TagGroup']);
  });

  it('ignores paths for unknown/non-component directories', () => {
    expect(componentsFromFilePaths(['frontend/src/app/page.tsx', 'docs/journey-events.md'])).toEqual([]);
  });

  it('works over prose that merely quotes a path (route.md style)', () => {
    const prose = 'Entry points: `src/components/Multiselect/Multiselect.module.scss` needs a padding fix.';
    expect(componentsFromFilePaths(prose)).toEqual(['Multiselect']);
  });
});

describe('componentsFromTitle', () => {
  it('matches multi-word canonical names regardless of spacing/casing', () => {
    expect(componentsFromTitle('Radio button: Height and width mismatch')).toEqual(['RadioButton']);
    expect(componentsFromTitle('Type=action triggers overflow in Tags')).toEqual(['Tag']);
  });

  it('is empty for titles with no known component noun', () => {
    expect(componentsFromTitle('Improve CI pipeline caching')).toEqual([]);
  });
});

describe('CANONICAL_COMPONENTS', () => {
  it('includes every component referenced by the fixtures above', () => {
    for (const name of ['Tag', 'TagGroup', 'RadioButton', 'Checkbox', 'Multiselect', 'Tree', 'Notification', 'Callout']) {
      expect(CANONICAL_COMPONENTS).toContain(name);
    }
  });
});

describe('buildComponentShipMap', () => {
  it('assigns the earliest (lowest ticket-number) merged ticket as shipper', () => {
    const tickets = [
      { key: 'PROJ-2899', merged: true, components: ['Multiselect'] },
      { key: 'PROJ-3022', merged: true, components: ['Multiselect'] }, // later fix, same component
      { key: 'PROJ-2825', merged: true, components: ['Tag', 'TagGroup'] },
    ];
    const map = buildComponentShipMap(tickets);
    expect(map.get('Multiselect')).toEqual({ component: 'Multiselect', shippedBy: 'PROJ-2899' });
    expect(map.get('Tag')).toEqual({ component: 'Tag', shippedBy: 'PROJ-2825' });
  });

  it('ignores tickets that never merged', () => {
    const tickets = [{ key: 'PROJ-1', merged: false, components: ['Tag'] }];
    expect(buildComponentShipMap(tickets).has('Tag')).toBe(false);
  });
});

describe('traceRegressions — end to end', () => {
  function ticket(key, { merged = true, components = [], type = null, descriptionText = '', rubricScore } = {}) {
    return { key, merged, components, type, descriptionText, rubricScore };
  }

  it('reproduces every known escape from GOALS.md and never flags the new-work tickets', () => {
    const tickets = [
      // shippers
      ticket('PROJ-2825', { components: ['Tag', 'TagGroup'], type: 'Story' }),
      ticket('PROJ-2832', { components: ['RadioButton', 'Checkbox'], type: null }),
      ticket('PROJ-2899', { components: ['Multiselect'], type: 'Story' }),
      ticket('PROJ-2682', { components: ['Tree'], type: 'Story', rubricScore: 0.993 }), // genuinely new
      ticket('PROJ-2998', { components: ['Notification', 'Callout'], type: 'Story', rubricScore: 1 }), // genuinely new
      // escapes (golden-set curated + heuristic-detected)
      ticket('PROJ-3012', {
        components: ['RadioButton'],
        type: extractTicketType(RADIO_FONT_ESCAPE),
        descriptionText: extractDescriptionText(RADIO_FONT_ESCAPE),
        rubricScore: 0.965,
      }),
      ticket('PROJ-3014', {
        merged: false, // shipped, not yet merged — still counts as an escape
        components: ['RadioButton'],
        type: extractTicketType(RADIO_GEOMETRY_ESCAPE),
        descriptionText: extractDescriptionText(RADIO_GEOMETRY_ESCAPE),
        rubricScore: 1,
      }),
      ticket('PROJ-3022', {
        components: ['Multiselect'],
        type: extractTicketType(MULTISELECT_PADDING_ESCAPE),
        descriptionText: extractDescriptionText(MULTISELECT_PADDING_ESCAPE),
      }),
      ticket('PROJ-3025', {
        components: ['Tag'],
        type: extractTicketType(TAG_COLOR_ESCAPE),
        descriptionText: extractDescriptionText(TAG_COLOR_ESCAPE),
        rubricScore: 1,
      }),
      ticket('PROJ-3027', {
        components: ['TagGroup'],
        type: extractTicketType(TAGGROUP_OVERFLOW_A11Y_ESCAPE),
        descriptionText: extractDescriptionText(TAGGROUP_OVERFLOW_A11Y_ESCAPE),
        rubricScore: 1,
      }),
      ticket('PROJ-3028', {
        components: ['Tag'],
        type: extractTicketType(TAG_PADDING_ESCAPE),
        descriptionText: extractDescriptionText(TAG_PADDING_ESCAPE),
      }),
      // non-escapes: bug fixes against shipped components that must NOT count
      ticket('PROJ-3016', {
        components: ['RadioButton'],
        type: extractTicketType(KEYBOARD_BUG_NOT_ESCAPE),
        descriptionText: extractDescriptionText(KEYBOARD_BUG_NOT_ESCAPE),
        rubricScore: 1,
      }),
      ticket('PROJ-2996', {
        components: ['Tag'],
        type: extractTicketType(STORYBOOK_CONTROL_BUG_NOT_ESCAPE),
        descriptionText: extractDescriptionText(STORYBOOK_CONTROL_BUG_NOT_ESCAPE),
      }),
      ticket('PROJ-3026', {
        components: ['Tag'],
        type: extractTicketType(DEMO_WIRING_BUG_NOT_ESCAPE),
        descriptionText: extractDescriptionText(DEMO_WIRING_BUG_NOT_ESCAPE),
        rubricScore: 1,
      }),
    ];

    const golden = {
      'PROJ-3012': { escapeAgainst: 'RadioButton', lesson: 'typography binds via the type-style mixin' },
      'PROJ-3014': { escapeAgainst: 'RadioButton', lesson: 'control geometry per-variant' },
      'PROJ-3022': { escapeAgainst: 'Multiselect', lesson: 'per-size field padding' },
      'PROJ-3025': { escapeAgainst: 'Tag', lesson: 'dark-theme swatches are their own variant' },
      'PROJ-3027': { escapeAgainst: 'TagGroup', lesson: 'overflow label is an accessible name' },
      'PROJ-3028': { escapeAgainst: 'Tag', lesson: 'per-size vertical padding' },
    };

    const result = traceRegressions({ tickets, goldenByKey: golden });

    expect(result.escapedKeys.sort()).toEqual(
      ['PROJ-3012', 'PROJ-3014', 'PROJ-3022', 'PROJ-3025', 'PROJ-3027', 'PROJ-3028'].sort(),
    );
    expect(result.escapedKeys).not.toContain('PROJ-2682');
    expect(result.escapedKeys).not.toContain('PROJ-2998');
    expect(result.escapedKeys).not.toContain('PROJ-3016');
    expect(result.escapedKeys).not.toContain('PROJ-2996');
    expect(result.escapedKeys).not.toContain('PROJ-3026');

    const tag = result.byComponent.find((c) => c.component === 'Tag');
    expect(tag.shippedBy).toBe('PROJ-2825');
    expect(tag.escapes.sort()).toEqual(['PROJ-3025', 'PROJ-3028']);
    expect(tag.nonEscapes.sort()).toEqual(['PROJ-2996', 'PROJ-3026']);

    const taggroup = result.byComponent.find((c) => c.component === 'TagGroup');
    expect(taggroup.escapes).toEqual(['PROJ-3027']);
    // PROJ-3027 has no independent lexical signal (see the fixture note above) — golden-only.
    expect(result.escapeDetails.find((e) => e.key === 'PROJ-3027').source).toBe('golden-only');
    // PROJ-3012 etc. DO have an independent lexical signal, corroborating golden ground truth.
    expect(result.escapeDetails.find((e) => e.key === 'PROJ-3012').source).toBe('golden+heuristic');

    const radio = result.byComponent.find((c) => c.component === 'RadioButton');
    expect(radio.shippedBy).toBe('PROJ-2832');
    expect(radio.escapes.sort()).toEqual(['PROJ-3012', 'PROJ-3014']);
    expect(radio.nonEscapes).toEqual(['PROJ-3016']);

    const tree = result.byComponent.find((c) => c.component === 'Tree');
    expect(tree.escapes).toEqual([]);
    const notification = result.byComponent.find((c) => c.component === 'Notification');
    expect(notification.escapes).toEqual([]);

    // shipped counts merged tickets only — PROJ-3014 (shipped, not merged) is excluded.
    expect(result.shipped).toBe(tickets.filter((t) => t.merged).length);
    expect(result.escaped).toBe(6);
    expect(result.escapedDefectRate).toBeCloseTo(6 / result.shipped, 2);
  });

  it('does not flag a ticket as an escape against a component it only side-touches while shipping something else (PROJ-2908 shape)', () => {
    // PROJ-2908 (Combobox) legitimately touches Multiselect/Menu for keyboard-parity
    // reasons in the same PR. Its own text (no ticket.md; falls back to build notes)
    // happens to contain "Figma" + "border", which would fire the lexical heuristic in
    // isolation — but it should never be attributed as a defect against Multiselect,
    // because it is itself shipping Combobox in the same pass.
    const tickets = [
      ticket('PROJ-2899', { components: ['Multiselect'], type: 'Story' }),
      ticket('PROJ-2908', {
        components: ['Combobox', 'Multiselect'],
        type: null,
        descriptionText: 'match combobox/menu focus behaviour; border-radius parity fix per figma spec',
      }),
    ];
    const result = traceRegressions({ tickets, goldenByKey: {} });
    expect(result.escapedKeys).toEqual([]);
    const multiselect = result.byComponent.find((c) => c.component === 'Multiselect');
    expect(multiselect.escapes).toEqual([]);
    expect(multiselect.nonEscapes).toEqual(['PROJ-2908']);
    expect(result.consideredDetails.find((d) => d.key === 'PROJ-2908').reasons.join(' ')).toMatch(/ships a different component/);
  });

  it('discovers a heuristic-only escape with no golden-set entry (e.g. a future ticket)', () => {
    const tickets = [
      ticket('PROJ-100', { components: ['Checkbox'], type: 'Story' }),
      ticket('PROJ-200', {
        components: ['Checkbox'],
        type: 'Sub-Bug',
        descriptionText: extractDescriptionText(
          '# PROJ-200 — Checkbox padding wrong\n## Problem\n+1px padding needed to match Figma.',
        ),
      }),
    ];
    const result = traceRegressions({ tickets, goldenByKey: {} });
    expect(result.escapedKeys).toEqual(['PROJ-200']);
    expect(result.escapeDetails[0].source).toBe('heuristic-only');
  });
});

describe('correlateRubricEscapes', () => {
  it('reports missing shipper scores rather than silently averaging around them', () => {
    const byComponent = [
      { component: 'Tag', shippedBy: 'PROJ-2825', escapes: ['PROJ-3025', 'PROJ-3028'], nonEscapes: [] },
      { component: 'Tree', shippedBy: 'PROJ-2682', escapes: [], nonEscapes: [] },
    ];
    const tickets = [
      { key: 'PROJ-2825', rubricScore: undefined },
      { key: 'PROJ-2682', rubricScore: 0.993 },
      { key: 'PROJ-3025', rubricScore: 1 },
      { key: 'PROJ-3028', rubricScore: undefined },
    ];
    const stats = correlateRubricEscapes({ tickets, byComponent });
    expect(stats.shipperScoresForEscapedComponents).toEqual([{ component: 'Tag', shippedBy: 'PROJ-2825', rubricScore: null }]);
    expect(stats.shippersMissingScore).toEqual(['PROJ-2825']);
    expect(stats.escapeFixTickets.meanScore).toBe(1); // only PROJ-3025 had a score; PROJ-3028 is missing, not zero
    expect(stats.ticketsMissingRubricScore).toBe(2);
  });
});
