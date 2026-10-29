# Visual diff — REVIEW flow

Automates the design-diff step of the REVIEW stage: compares a rendered Storybook
story against its matching Figma node screenshot, per variant, region by region, so a
"looks close enough" glance can't hide a localized mismatch (wrong corner radius,
missing icon, wrong token color in one quadrant, etc).

`scripts/visual-diff.mjs` only **compares** pre-captured PNGs — it does not drive a
browser or Figma itself (no Playwright dependency). Capture is the reviewer's job:

## 1. Capture the Figma screenshot per variant

For each variant node the plan/ticket calls out, use the Figma MCP `get_screenshot`
tool to get a rendered PNG URL for that node, then `curl` it to disk:

```bash
curl -sL "<url from get_screenshot>" -o figma/<variant>.png
```

Do this once per variant node — never diff a whole frame against a single story; the
whole point is per-variant, per-region comparison.

## 2. Capture the matching Storybook screenshot

Screenshot the matching Storybook story (same variant/args) to a same-named file:

```
story/<variant>.png
```

Keep framing consistent between the two captures (same crop/zoom) — `visual-diff.mjs`
aligns mismatched dimensions by cropping to the common top-left WxH, so a different
DPR or extra margin will look like extra diff rather than being resolved automatically.

## 3. Build the manifest

A JSON array of `{ key, variant, figma, story }`:

```json
[
  { "key": "PROJ-1234", "variant": "default", "figma": "figma/default.png", "story": "story/default.png" },
  { "key": "PROJ-1234", "variant": "disabled", "figma": "figma/disabled.png", "story": "story/disabled.png" }
]
```

## 4. Run the comparison and gate on it

```bash
node scripts/visual-diff.mjs --manifest manifest.json
```

Optional flags: `--cols` / `--rows` (grid size, default 3x3), `--threshold` (pixelmatch
per-pixel color threshold, default 0.1), `--region-threshold` (fraction of differing
pixels in a region before it's a FAIL, default 0.03), `--out` (report JSON path,
default `visual-diff-report.json` next to the manifest), `--diff-dir` (where
`<variant>.diff.png` artifacts are written, default `diffs/` next to the manifest).

Each variant resolves to one of:

- **PASS** — every grid region is within threshold.
- **FAIL** — one or more regions exceed the threshold; the summary names them (e.g.
  "top-right, center") and a `<variant>.diff.png` highlights the differing pixels.
- **BLOCKED** — a PNG was missing or failed to decode. This is **not** treated as a
  pass — a missing screenshot is acknowledged (via `guard.mjs`/`guard-lib.mjs`) and
  reported, never silently skipped.

The script exits non-zero if any variant is FAIL or BLOCKED, so it can gate the
REVIEW stage directly. A non-zero exit feeds the repair loop: fix the flagged
region(s) (or re-capture a missing/corrupt screenshot) and re-run.
