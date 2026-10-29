// Pure logic for route-based screenshot capture - the sibling of story-capture-lib.mjs for
// apps that have no Storybook (route-capture.mjs is the browser + IO wrapper).
//
// Why this exists: story-capture.mjs can only reach a component through a Storybook story.
// PROJ-3403 is the case that proves the gap - every file it touches lives in the Next.js
// `frontend/` package, which ships no `.storybook` and zero `*.stories.*`, so the capture
// planned 0 variants and the REVIEW gate reported 4/4 BLOCKED. The screens exist only as
// App Router routes, so the only way to render them is the real dev server.
//
// Manifest assembly and coverage are NOT duplicated here: the plan entries this module
// produces are shape-compatible with story-capture-lib's, so `buildDiffManifest` and
// `captureCoverage` are reused verbatim.

/** A route URL with a stable query string. Sorted keys keep the URL reproducible - it ends
 *  up in report paths, and churn there is noise. `route` may already carry a query. */
export function routeUrl(baseUrl, route, { query } = {}) {
  if (!baseUrl) throw new Error('routeUrl: baseUrl is required');
  if (!route) throw new Error('routeUrl: route is required');
  const base = baseUrl.replace(/\/+$/, '');
  const [path, inlineQuery] = String(route).split('?');
  const params = new URLSearchParams(inlineQuery || '');
  for (const key of Object.keys(query || {}).sort()) params.set(key, String(query[key]));
  const qs = params.toString();
  return `${base}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
}

/** A filesystem-safe, stable name for one captured variant. Matches story-capture-lib's
 *  `variantSlug` so a ticket can mix both capture paths without two naming schemes. */
export function variantSlug(variant, theme) {
  const base = String(variant || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = base || 'variant';
  return theme ? `${slug}-${theme}` : slug;
}

/**
 * Normalize a route capture plan. Entries are
 * `{ variant, route, selector?, theme?, query?, viewport? }`.
 *
 * `selector` is optional and means something specific: null captures the VIEWPORT, which is
 * how a whole-screen reference is matched. A design reference is usually a crop of one
 * region, so most entries name the element that region corresponds to.
 */
export function buildRoutePlan(routes, { storyDir, figmaDir, baseUrl, themes } = {}) {
  const list = Array.isArray(routes) ? routes : [];
  const plan = [];
  for (const r of list) {
    if (!r || !r.route) continue;
    const variantThemes = r.theme ? [r.theme] : themes && themes.length ? themes : [null];
    for (const theme of variantThemes) {
      const slug = variantSlug(r.variant || r.route, theme);
      plan.push({
        variant: r.variant || r.route,
        slug,
        route: r.route,
        theme: theme || null,
        // null is meaningful (viewport capture), so it must survive rather than default.
        selector: r.selector === undefined ? null : r.selector,
        viewport: r.viewport || null,
        url: baseUrl ? routeUrl(baseUrl, r.route, { query: r.query }) : null,
        storyPng: joinPath(storyDir, `${slug}.png`),
        figmaPng: joinPath(figmaDir, `${slug}.png`),
      });
    }
  }
  return plan;
}

function joinPath(dir, file) {
  if (!dir) return file;
  return `${String(dir).replace(/\/+$/, '')}/${file}`;
}

/**
 * Resolve one fixture route to its response body.
 *
 * The capture needs a real HTTP server rather than browser request interception, because a
 * Next.js app fetches during SSR too - PROJ-3403's feature-flag gate calls the backend from
 * inside the Next process, where Playwright's `page.route` cannot see it. `exact` wins over
 * `pattern` so a specific path is never shadowed by a looser regex.
 */
export function matchFixture(fixtures, pathname) {
  const exact = (fixtures && fixtures.exact) || {};
  if (Object.prototype.hasOwnProperty.call(exact, pathname)) {
    return { matched: true, key: pathname, body: exact[pathname] };
  }
  for (const entry of (fixtures && fixtures.patterns) || []) {
    if (!entry || !entry.pattern) continue;
    let re;
    try { re = new RegExp(entry.pattern); } catch { continue; }
    if (re.test(pathname)) return { matched: true, key: entry.pattern, body: entry.body };
  }
  return { matched: false, key: null, body: null };
}

/**
 * Which capture inputs are missing. Called before a browser launches so the failure names
 * the cause instead of surfacing as a blank or redirected screenshot - the two ways this
 * capture path fails silently.
 */
export function missingInputs({ appBase, routes, figmaDir } = {}) {
  const missing = [];
  if (!appBase) missing.push('an app base URL (--app-base) - nothing to capture from');
  if (!Array.isArray(routes) || routes.length === 0) missing.push('a non-empty route plan (--routes)');
  if (!figmaDir) missing.push('a design reference directory (--figma-dir) - with no reference there is nothing to diff against');
  return missing;
}
