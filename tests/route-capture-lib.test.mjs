import { describe, expect, it } from 'vitest';

import {
  buildRoutePlan,
  matchFixture,
  missingInputs,
  routeUrl,
  variantSlug,
} from '../scripts/route-capture-lib.mjs';
import { buildDiffManifest, captureCoverage } from '../scripts/story-capture-lib.mjs';

describe('routeUrl', () => {
  it('joins a base and a route', () => {
    expect(routeUrl('http://localhost:3100', '/inventory/kit-inquiry')).toBe(
      'http://localhost:3100/inventory/kit-inquiry',
    );
  });

  it('keeps a query already on the route', () => {
    expect(routeUrl('http://localhost:3100', '/kit/79001?branch=01')).toBe(
      'http://localhost:3100/kit/79001?branch=01',
    );
  });

  it('sorts added params so the URL is reproducible', () => {
    const a = routeUrl('http://x', '/p', { query: { zeta: 1, alpha: 2 } });
    const b = routeUrl('http://x', '/p', { query: { alpha: 2, zeta: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('http://x/p?alpha=2&zeta=1');
  });

  it('merges an inline query with added params', () => {
    expect(routeUrl('http://x', '/p?branch=01', { query: { view: 'full' } }))
      .toBe('http://x/p?branch=01&view=full');
  });

  it('tolerates a trailing slash on the base and a missing one on the route', () => {
    expect(routeUrl('http://x/', 'p')).toBe('http://x/p');
  });

  it('refuses missing inputs rather than building a broken URL', () => {
    expect(() => routeUrl('', '/p')).toThrow(/baseUrl/);
    expect(() => routeUrl('http://x', '')).toThrow(/route/);
  });
});

describe('buildRoutePlan', () => {
  const dirs = { storyDir: 'tickets/K/story', figmaDir: 'tickets/K/figma', baseUrl: 'http://x' };

  it('pairs each slug with its story and figma PNG', () => {
    const [p] = buildRoutePlan([{ variant: 'state-loaded-light', route: '/a' }], dirs);
    expect(p.storyPng).toBe('tickets/K/story/state-loaded-light.png');
    expect(p.figmaPng).toBe('tickets/K/figma/state-loaded-light.png');
    expect(p.url).toBe('http://x/a');
  });

  it('preserves a null selector, which means capture the viewport', () => {
    const [p] = buildRoutePlan([{ variant: 'full', route: '/a' }], dirs);
    expect(p.selector).toBeNull();
  });

  it('keeps an explicit selector', () => {
    const [p] = buildRoutePlan([{ variant: 'row', route: '/a', selector: '[class*="Header"]' }], dirs);
    expect(p.selector).toBe('[class*="Header"]');
  });

  it('expands one route across themes, so a dark regression cannot hide', () => {
    const plan = buildRoutePlan([{ variant: 'row', route: '/a' }], { ...dirs, themes: ['light', 'dark'] });
    expect(plan.map((p) => p.slug)).toEqual(['row-light', 'row-dark']);
  });

  it("an entry's own theme overrides the sweep", () => {
    const plan = buildRoutePlan([{ variant: 'row', route: '/a', theme: 'dark' }], { ...dirs, themes: ['light', 'dark'] });
    expect(plan.map((p) => p.slug)).toEqual(['row-dark']);
  });

  it('drops entries with no route and tolerates junk', () => {
    expect(buildRoutePlan([{ variant: 'x' }, null, undefined], dirs)).toEqual([]);
    expect(buildRoutePlan(null, dirs)).toEqual([]);
  });

  it('produces plan entries story-capture-lib can consume unchanged', () => {
    const plan = buildRoutePlan(
      [{ variant: 'a', route: '/a' }, { variant: 'b', route: '/b' }],
      dirs,
    );
    const { manifest, skipped } = buildDiffManifest('K', plan, {
      captured: ['a', 'b'],
      figmaPresent: ['a'],
    });
    expect(manifest).toEqual([{ key: 'K', variant: 'a', figma: 'tickets/K/figma/a.png', story: 'tickets/K/story/a.png' }]);
    expect(skipped).toEqual([{ variant: 'b', slug: 'b', reason: 'no Figma reference PNG' }]);
    expect(captureCoverage(plan.map((p) => p.slug), manifest)).toMatchObject({ status: 'partial', complete: false });
  });
});

describe('variantSlug', () => {
  it('makes a Figma node name path-safe', () => {
    expect(variantSlug('State=Focus, Size=Large')).toBe('state-focus-size-large');
  });

  it('appends a theme and survives an empty label', () => {
    expect(variantSlug('Row', 'dark')).toBe('row-dark');
    expect(variantSlug('')).toBe('variant');
  });
});

describe('matchFixture', () => {
  const fixtures = {
    exact: { '/api/v1/me': { userId: 'u' }, '/api/v1/feature-flags': [{ id: 'F', enabled: true }] },
    patterns: [{ pattern: '^/api/inventory/v1/products/[^/]+/kit-inquiry$', body: { productId: '79001' } }],
  };

  it('matches an exact path', () => {
    expect(matchFixture(fixtures, '/api/v1/me')).toMatchObject({ matched: true, body: { userId: 'u' } });
  });

  it('matches a pattern with a dynamic segment', () => {
    expect(matchFixture(fixtures, '/api/inventory/v1/products/79001/kit-inquiry'))
      .toMatchObject({ matched: true, body: { productId: '79001' } });
  });

  it('reports no match rather than inventing an empty body', () => {
    // A 404 the operator can see beats a silent {} that renders as an empty screen.
    expect(matchFixture(fixtures, '/api/v1/unknown')).toEqual({ matched: false, key: null, body: null });
  });

  it('prefers an exact path over a pattern that would also match', () => {
    const f = {
      exact: { '/api/a/b': 'exact' },
      patterns: [{ pattern: '^/api/a/.*$', body: 'loose' }],
    };
    expect(matchFixture(f, '/api/a/b').body).toBe('exact');
  });

  it('skips an invalid pattern instead of throwing', () => {
    const f = { exact: {}, patterns: [{ pattern: '([' }, { pattern: '^/ok$', body: 1 }] };
    expect(matchFixture(f, '/ok').body).toBe(1);
  });

  it('tolerates absent fixtures', () => {
    expect(matchFixture(undefined, '/x').matched).toBe(false);
    expect(matchFixture({}, '/x').matched).toBe(false);
  });

  it('distinguishes a fixture whose body is legitimately null', () => {
    expect(matchFixture({ exact: { '/x': null } }, '/x')).toEqual({ matched: true, key: '/x', body: null });
  });
});

describe('missingInputs', () => {
  it('is empty when everything is present', () => {
    expect(missingInputs({ appBase: 'http://x', routes: [{ route: '/a' }], figmaDir: 'f' })).toEqual([]);
  });

  it('names each missing input, so the failure is not a blank screenshot', () => {
    const missing = missingInputs({});
    expect(missing).toHaveLength(3);
    expect(missing.join(' ')).toMatch(/--app-base/);
    expect(missing.join(' ')).toMatch(/--routes/);
    expect(missing.join(' ')).toMatch(/--figma-dir/);
  });

  it('treats an empty route list as missing, not as zero work done', () => {
    expect(missingInputs({ appBase: 'http://x', routes: [], figmaDir: 'f' }))
      .toEqual([expect.stringMatching(/--routes/)]);
  });
});
