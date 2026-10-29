// Pure image-diff logic for the Figma-vs-Storybook visual regression check, extracted
// for unit testing (no file I/O, no pngjs decode/encode here — visual-diff.mjs owns
// that). Given two decoded RGBA images ({width, height, data}), we align their
// dimensions, cut a grid of regions, and pixelmatch each region independently so a
// single localized difference doesn't get diluted/hidden inside a whole-image diff.
import pixelmatch from 'pixelmatch';

/** Crop/letterbox both images down to their common WxH so mismatched capture sizes
 * (e.g. a Figma export vs a browser screenshot at a different DPR) still compare
 * region-by-region instead of erroring or silently stretching. Crops from the
 * top-left corner — callers should capture both with consistent framing. */
export function alignDims(a, b) {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  return { a: cropTo(a, width, height), b: cropTo(b, width, height), width, height };
}

function cropTo(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcStart = y * img.width * 4;
    const destStart = y * width * 4;
    data.set(img.data.subarray(srcStart, srcStart + width * 4), destStart);
  }
  return { width, height, data };
}

/** Split a width x height canvas into a cols x rows grid of {x,y,w,h} regions,
 * row-major (top-left to bottom-right), absorbing any remainder into the last
 * column/row so the grid always covers the full image exactly. */
export function chunkGrid(width, height, cols, rows) {
  const baseW = Math.floor(width / cols);
  const baseH = Math.floor(height / rows);
  const grid = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * baseW;
      const y = row * baseH;
      const w = col === cols - 1 ? width - x : baseW;
      const h = row === rows - 1 ? height - y : baseH;
      grid.push({ x, y, w, h });
    }
  }
  return grid;
}

/** Human-readable label for a grid cell's position, used in reports/summaries. */
export function regionLabel(index, cols, rows) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const vLabel = rows === 1 ? '' : row === 0 ? 'top' : row === rows - 1 ? 'bottom' : 'middle';
  const hLabel = cols === 1 ? '' : col === 0 ? 'left' : col === cols - 1 ? 'right' : 'center';
  if (rows === 1 && cols === 1) return 'whole';
  if (!vLabel) return hLabel;
  if (!hLabel) return vLabel;
  if (vLabel === 'middle' && hLabel === 'center') return 'center';
  return `${vLabel}-${hLabel}`;
}

/** Extract one region's pixels into a standalone RGBA buffer pixelmatch can diff. */
function extractRegion(img, { x, y, w, h }) {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * img.width + x) * 4;
    const destStart = row * w * 4;
    data.set(img.data.subarray(srcStart, srcStart + w * 4), destStart);
  }
  return data;
}

/** Pixelmatch two same-sized decoded images per grid region. `threshold` is
 * pixelmatch's per-pixel color-match threshold (0-1, default 0.1); `regionThreshold`
 * is the fraction of differing pixels within a region above which that region is
 * considered a FAIL (default 0.03 — 3%). Returns per-chunk results plus an overall
 * verdict. Assumes `imgA`/`imgB` are already the same width/height (see alignDims). */
export function compareChunks(imgA, imgB, grid, { threshold = 0.1, regionThreshold = 0.03, cols, rows } = {}) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error('compareChunks: images must share dimensions — call alignDims first');
  }
  const chunks = grid.map((region, i) => {
    const a = extractRegion(imgA, region);
    const b = extractRegion(imgB, region);
    const diffPixels = pixelmatch(a, b, null, region.w, region.h, { threshold });
    const totalPixels = region.w * region.h;
    const diffRatio = totalPixels ? diffPixels / totalPixels : 0;
    const fail = diffRatio > regionThreshold;
    const label = cols && rows ? regionLabel(i, cols, rows) : `chunk-${i}`;
    return { region, index: i, label, diffPixels, diffRatio, fail };
  });
  const failedRegions = chunks.filter((c) => c.fail);
  const worstRatio = chunks.reduce((max, c) => Math.max(max, c.diffRatio), 0);
  return {
    pass: failedRegions.length === 0,
    worstRatio,
    failedRegions: failedRegions.map((c) => c.label),
    chunks,
  };
}
