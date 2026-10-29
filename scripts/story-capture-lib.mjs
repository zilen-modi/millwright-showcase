// Pure logic for the headless Storybook capture step (story-capture.mjs is the browser
// + IO wrapper). Building an iframe URL, pairing captured stories with their Figma PNGs,
// and assembling the visual-diff manifest are all decidable without a browser, so they
// live here and are unit-tested.
//
// Why this module exists at all: REVIEW's per-variant screenshot diff is described as
// "an objective gate, not an eyeball", yet across 25 shipped tickets it produced ZERO
// reports — because nothing could capture a story headlessly, so every run reached for
// `visualDiffSkipReason` instead. Since A3 turned a skip into an EXCLUDED dimension
// (lower ceiling) rather than a free 1.0, capture has to actually work.

/** Storybook renders a single story in isolation at `iframe.html?id=<storyId>`. Theme
 * comes from @storybook/addon-themes, which reads the `globals` query param. Extra
 * globals are appended in stable (sorted) order so a URL is reproducible — these end up
 * in report paths and diffs, and churn there is noise. */
export function storyUrl(baseUrl, storyId, { theme, globals } = {}) {
  if (!baseUrl) throw new Error('storyUrl: baseUrl is required');
  if (!storyId) throw new Error('storyUrl: storyId is required');
  const base = baseUrl.replace(/\/+$/, '');
  const all = { ...(globals || {}) };
  if (theme) all.theme = theme;
  const keys = Object.keys(all).sort();
  const params = [`id=${encodeURIComponent(storyId)}`];
  if (keys.length) {
    params.push(`globals=${encodeURIComponent(keys.map((k) => `${k}:${all[k]}`).join(';'))}`);
  }
  return `${base}/iframe.html?${params.join('&')}`;
}

/** A filesystem-safe, stable name for one captured variant. Variant labels come from
 * Figma node names ("State=Focus, Size=Large"), which are full of characters that break
 * paths and shells. */
export function variantSlug(variant, theme) {
  const base = String(variant || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = base || 'variant';
  return theme ? `${slug}-${theme}` : slug;
}

/** Normalize a capture plan entry. `stories` entries are `{ variant, storyId, theme?,
 * globals?, selector?, viewport? }`; a plan entry adds where its PNGs live. Each
 * variant may be captured in several themes, which become separate entries — a
 * dark-theme regression is invisible if only light is captured (the PROJ-3025 case). */
export function buildCapturePlan(stories, { storyDir, figmaDir, baseUrl, themes } = {}) {
  const list = Array.isArray(stories) ? stories : [];
  const plan = [];
  for (const s of list) {
    if (!s || !s.storyId) continue;
    const variantThemes = s.theme ? [s.theme] : themes && themes.length ? themes : [null];
    for (const theme of variantThemes) {
      const slug = variantSlug(s.variant || s.storyId, theme);
      plan.push({
        variant: s.variant || s.storyId,
        slug,
        storyId: s.storyId,
        theme: theme || null,
        selector: s.selector || '#storybook-root',
        viewport: s.viewport || null,
        url: baseUrl ? storyUrl(baseUrl, s.storyId, { theme, globals: s.globals }) : null,
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

/** Turn capture results into the manifest `visual-diff.mjs` consumes:
 * `[{ key, variant, figma, story }]`. A variant whose capture failed, or whose Figma
 * reference PNG is missing, is DROPPED from the manifest and reported in `skipped` —
 * never silently emitted with a path that doesn't exist. A pair that cannot be compared
 * must be visibly absent rather than quietly counted. */
export function buildDiffManifest(key, plan, { captured, figmaPresent } = {}) {
  const ok = new Set(captured || []);
  const haveFigma = new Set(figmaPresent || []);
  const manifest = [];
  const skipped = [];
  for (const p of plan || []) {
    const missing = [];
    if (!ok.has(p.slug)) missing.push('story capture failed');
    if (!haveFigma.has(p.slug)) missing.push('no Figma reference PNG');
    if (missing.length) {
      skipped.push({ variant: p.variant, slug: p.slug, reason: missing.join('; ') });
      continue;
    }
    manifest.push({ key, variant: p.variant, figma: p.figmaPng, story: p.storyPng });
  }
  return { manifest, skipped };
}

/** Did the capture cover the variants CONTEXT enumerated from Figma? REVIEW is only
 * allowed to skip the visual dimension when there was genuinely nothing to diff, so the
 * gate needs to know whether coverage is complete, partial, or empty. `partial` is the
 * dangerous middle: some evidence exists, which reads as "we checked" while the
 * uncaptured variants are exactly where a regression hides. */
export function captureCoverage(enumeratedVariants, manifest) {
  const expected = (enumeratedVariants || []).length;
  const covered = (manifest || []).length;
  if (expected === 0) return { expected: 0, covered, status: 'none', complete: false };
  if (covered === 0) return { expected, covered: 0, status: 'empty', complete: false };
  if (covered < expected) return { expected, covered, status: 'partial', complete: false };
  return { expected, covered, status: 'complete', complete: true };
}
