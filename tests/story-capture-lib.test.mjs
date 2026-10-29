import { describe, expect, it } from 'vitest';

import {
  storyUrl,
  variantSlug,
  buildCapturePlan,
  buildDiffManifest,
  captureCoverage,
} from '../scripts/story-capture-lib.mjs';

describe('storyUrl', () => {
  it('builds an isolated iframe URL for a story', () => {
    expect(storyUrl('http://127.0.0.1:6007', 'components-tag--default')).toBe(
      'http://127.0.0.1:6007/iframe.html?id=components-tag--default',
    );
  });

  it('passes the theme through addon-themes globals', () => {
    expect(storyUrl('http://127.0.0.1:6007', 'components-tag--default', { theme: 'dark' })).toBe(
      'http://127.0.0.1:6007/iframe.html?id=components-tag--default&globals=theme%3Adark',
    );
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(storyUrl('http://127.0.0.1:6007/', 'x--y')).toBe('http://127.0.0.1:6007/iframe.html?id=x--y');
  });

  it('orders globals deterministically so a URL is reproducible', () => {
    const a = storyUrl('http://h', 'x--y', { theme: 'dark', globals: { locale: 'en', density: 'compact' } });
    const b = storyUrl('http://h', 'x--y', { globals: { density: 'compact', locale: 'en' }, theme: 'dark' });
    expect(a).toBe(b);
    expect(a).toContain('density%3Acompact%3Blocale%3Aen%3Btheme%3Adark');
  });

  it('rejects a missing storyId rather than capturing the wrong thing', () => {
    expect(() => storyUrl('http://h')).toThrow(/storyId/);
  });
});

describe('variantSlug', () => {
  it('makes a Figma variant label path-safe', () => {
    expect(variantSlug('State=Focus, Size=Large')).toBe('state-focus-size-large');
  });

  it('appends the theme so light and dark never collide', () => {
    expect(variantSlug('Default', 'dark')).toBe('default-dark');
    expect(variantSlug('Default', 'light')).toBe('default-light');
  });

  it('falls back to a usable name for an empty label', () => {
    expect(variantSlug('')).toBe('variant');
  });
});

describe('buildCapturePlan', () => {
  const stories = [
    { variant: 'Default', storyId: 'components-tag--default' },
    { variant: 'Dismissible', storyId: 'components-tag--dismissible' },
  ];

  it('expands every variant across every requested theme', () => {
    const plan = buildCapturePlan(stories, {
      baseUrl: 'http://127.0.0.1:6007',
      storyDir: 'tickets/PROJ-3025/story',
      figmaDir: 'tickets/PROJ-3025/figma',
      themes: ['light', 'dark'],
    });
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => p.slug)).toEqual([
      'default-light',
      'default-dark',
      'dismissible-light',
      'dismissible-dark',
    ]);
    expect(plan[1].storyPng).toBe('tickets/PROJ-3025/story/default-dark.png');
    expect(plan[1].figmaPng).toBe('tickets/PROJ-3025/figma/default-dark.png');
    expect(plan[1].url).toContain('globals=theme%3Adark');
  });

  it('honours a per-story theme over the global theme list', () => {
    const plan = buildCapturePlan([{ variant: 'OnlyDark', storyId: 's--d', theme: 'dark' }], { themes: ['light', 'dark'] });
    expect(plan).toHaveLength(1);
    expect(plan[0].theme).toBe('dark');
  });

  it('defaults to the Storybook root selector', () => {
    const plan = buildCapturePlan(stories, {});
    expect(plan[0].selector).toBe('#storybook-root');
  });

  it('drops entries with no storyId instead of capturing a blank page', () => {
    const plan = buildCapturePlan([{ variant: 'Broken' }, ...stories], {});
    expect(plan).toHaveLength(2);
  });
});

describe('buildDiffManifest', () => {
  const plan = buildCapturePlan(
    [
      { variant: 'Default', storyId: 'a--d' },
      { variant: 'Focus', storyId: 'a--f' },
    ],
    { storyDir: 'story', figmaDir: 'figma' },
  );

  it('emits a visual-diff manifest for fully-paired variants', () => {
    const { manifest, skipped } = buildDiffManifest('PROJ-3025', plan, {
      captured: ['default', 'focus'],
      figmaPresent: ['default', 'focus'],
    });
    expect(skipped).toEqual([]);
    expect(manifest).toEqual([
      { key: 'PROJ-3025', variant: 'Default', figma: 'figma/default.png', story: 'story/default.png' },
      { key: 'PROJ-3025', variant: 'Focus', figma: 'figma/focus.png', story: 'story/focus.png' },
    ]);
  });

  // A manifest entry pointing at a file that does not exist would surface as a BLOCKED
  // variant downstream; dropping it with a reason keeps the failure legible.
  it('drops and reports a variant whose capture failed', () => {
    const { manifest, skipped } = buildDiffManifest('K', plan, { captured: ['default'], figmaPresent: ['default', 'focus'] });
    expect(manifest).toHaveLength(1);
    expect(skipped).toEqual([{ variant: 'Focus', slug: 'focus', reason: 'story capture failed' }]);
  });

  it('drops and reports a variant with no Figma reference', () => {
    const { manifest, skipped } = buildDiffManifest('K', plan, { captured: ['default', 'focus'], figmaPresent: ['default'] });
    expect(manifest).toHaveLength(1);
    expect(skipped[0].reason).toBe('no Figma reference PNG');
  });

  it('reports both reasons when a variant is missing on each side', () => {
    const { manifest, skipped } = buildDiffManifest('K', plan, { captured: [], figmaPresent: [] });
    expect(manifest).toEqual([]);
    expect(skipped[0].reason).toBe('story capture failed; no Figma reference PNG');
  });
});

describe('captureCoverage', () => {
  const m = (n) => Array.from({ length: n }, (_, i) => ({ variant: `v${i}` }));

  it('is complete when every enumerated variant was captured', () => {
    expect(captureCoverage(['a', 'b'], m(2))).toEqual({ expected: 2, covered: 2, status: 'complete', complete: true });
  });

  // The dangerous middle: some evidence exists, which reads as "we checked", while the
  // uncaptured variants are exactly where a regression hides.
  it('flags partial coverage rather than treating it as done', () => {
    expect(captureCoverage(['a', 'b', 'c'], m(1))).toEqual({ expected: 3, covered: 1, status: 'partial', complete: false });
  });

  it('flags an empty capture against enumerated variants', () => {
    expect(captureCoverage(['a'], [])).toEqual({ expected: 1, covered: 0, status: 'empty', complete: false });
  });

  it('reports "none" when CONTEXT enumerated no variants at all', () => {
    expect(captureCoverage([], [])).toEqual({ expected: 0, covered: 0, status: 'none', complete: false });
  });
});
