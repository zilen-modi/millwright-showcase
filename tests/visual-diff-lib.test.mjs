import { describe, expect, it } from 'vitest';

import { alignDims, chunkGrid, compareChunks, regionLabel } from '../scripts/visual-diff-lib.mjs';

/** Build a solid-color WxH RGBA image, optionally painting one rectangular region a
 * different color so tests can assert exactly which grid chunk picks up the diff. */
function makeImage(width, height, baseColor, patch) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inPatch = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
      const [r, g, b, a] = inPatch ? patch.color : baseColor;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

describe('alignDims', () => {
  it('crops both images down to the common WxH', () => {
    const a = makeImage(10, 10, [255, 255, 255, 255]);
    const b = makeImage(8, 6, [255, 255, 255, 255]);
    const { width, height, a: ca, b: cb } = alignDims(a, b);
    expect(width).toBe(8);
    expect(height).toBe(6);
    expect(ca.width).toBe(8);
    expect(ca.height).toBe(6);
    expect(cb.width).toBe(8);
    expect(cb.height).toBe(6);
  });

  it('leaves already-matching dims untouched', () => {
    const a = makeImage(4, 4, [0, 0, 0, 255]);
    const b = makeImage(4, 4, [0, 0, 0, 255]);
    const { a: ca, b: cb } = alignDims(a, b);
    expect(ca).toBe(a);
    expect(cb).toBe(b);
  });
});

describe('chunkGrid', () => {
  it('produces cols x rows regions covering the full image', () => {
    const grid = chunkGrid(100, 60, 2, 2);
    expect(grid).toHaveLength(4);
    expect(grid[0]).toEqual({ x: 0, y: 0, w: 50, h: 30 });
    // last col/row absorb any remainder
    const totalW = grid[0].w + grid[1].w;
    const totalH = grid[0].h + grid[2].h;
    expect(totalW).toBe(100);
    expect(totalH).toBe(60);
  });

  it('handles remainders that do not divide evenly', () => {
    const grid = chunkGrid(101, 61, 3, 3);
    expect(grid).toHaveLength(9);
    const lastCol = grid[2];
    const lastRow = grid[6];
    expect(lastCol.x + lastCol.w).toBe(101);
    expect(lastRow.y + lastRow.h).toBe(61);
  });
});

describe('regionLabel', () => {
  it('labels a 3x3 grid with position names', () => {
    expect(regionLabel(0, 3, 3)).toBe('top-left');
    expect(regionLabel(2, 3, 3)).toBe('top-right');
    expect(regionLabel(4, 3, 3)).toBe('center');
    expect(regionLabel(6, 3, 3)).toBe('bottom-left');
    expect(regionLabel(8, 3, 3)).toBe('bottom-right');
  });
});

describe('compareChunks', () => {
  it('passes when the two images are identical', () => {
    const img = makeImage(40, 40, [10, 20, 30, 255]);
    const grid = chunkGrid(40, 40, 2, 2);
    const result = compareChunks(img, img, grid, { cols: 2, rows: 2 });
    expect(result.pass).toBe(true);
    expect(result.failedRegions).toEqual([]);
    expect(result.worstRatio).toBe(0);
  });

  it('flags exactly the region that differs', () => {
    // 40x40 image, 2x2 grid -> each chunk is 20x20. Patch the top-right quadrant only.
    const a = makeImage(40, 40, [0, 0, 0, 255]);
    const b = makeImage(40, 40, [0, 0, 0, 255], { x: 20, y: 0, w: 20, h: 20, color: [255, 255, 255, 255] });
    const grid = chunkGrid(40, 40, 2, 2);
    const result = compareChunks(a, b, grid, { cols: 2, rows: 2 });
    expect(result.pass).toBe(false);
    expect(result.failedRegions).toEqual(['top-right']);
    const failedChunk = result.chunks.find((c) => c.label === 'top-right');
    expect(failedChunk.diffRatio).toBeGreaterThan(0.9);
    const otherChunks = result.chunks.filter((c) => c.label !== 'top-right');
    for (const c of otherChunks) expect(c.fail).toBe(false);
  });

  it('throws if images do not share dimensions (caller must alignDims first)', () => {
    const a = makeImage(10, 10, [0, 0, 0, 255]);
    const b = makeImage(8, 8, [0, 0, 0, 255]);
    const grid = chunkGrid(8, 8, 1, 1);
    expect(() => compareChunks(a, b, grid, {})).toThrow(/alignDims/);
  });
});
