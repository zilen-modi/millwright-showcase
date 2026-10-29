#!/usr/bin/env node
// Automates the REVIEW-stage design-diff: compares a rendered Storybook story screenshot
// against its Figma node screenshot, per variant, region by region. This script only
// COMPARES pre-captured PNGs (see VISUAL-DIFF.md for how the REVIEW agent captures
// them) — pure image-diff logic lives in visual-diff-lib.mjs (unit-tested). Every file
// read is guarded (guard.mjs / guard-lib.mjs) so a missing/corrupt PNG is an acknowledged
// BLOCKED result, never a raw stack trace.
//
// Usage:
//   node scripts/visual-diff.mjs --manifest manifest.json [--cols 3] [--rows 3]
//     [--threshold 0.1] [--region-threshold 0.03] [--out report.json] [--diff-dir dir]
//
// manifest.json: [{ key, variant, figma: "<png path>", story: "<png path>" }]
//
// Writes a JSON report, prints a readable PASS/FAIL/BLOCKED summary per variant (naming
// which grid regions differ), optionally writes "<variant>.diff.png" per pair, and
// exits non-zero if any variant fails or is blocked (so it can gate the REVIEW stage).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';
import { alignDims, chunkGrid, compareChunks } from './visual-diff-lib.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const MANIFEST_PATH = arg('manifest');
if (!MANIFEST_PATH) {
  console.error('visual-diff: --manifest <file.json> is required');
  process.exit(2);
}
const COLS = Number(arg('cols', '3'));
const ROWS = Number(arg('rows', '3'));
const THRESHOLD = Number(arg('threshold', '0.1'));
const REGION_THRESHOLD = Number(arg('region-threshold', '0.03'));
const OUT = arg('out', join(dirname(resolve(MANIFEST_PATH)), 'visual-diff-report.json'));
const DIFF_DIR = arg('diff-dir', join(dirname(resolve(MANIFEST_PATH)), 'diffs'));

/** Guarded decode of a PNG file into {width, height, data}. Returns a withGuard-shaped
 * result — never throws — so a missing/corrupt file becomes an acknowledged BLOCKED
 * entry in the report instead of crashing the whole run. */
async function readPng(label, path) {
  return withGuard(
    label,
    () => {
      const buf = readFileSync(path);
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: png.data };
    },
    { source: path, retries: 0, timeoutMs: 5000 },
  );
}

async function loadManifest() {
  const result = await withGuard(
    'visual-diff manifest',
    () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
    { source: MANIFEST_PATH, retries: 0, timeoutMs: 5000 },
  );
  return acknowledgeOrThrow(result); // a missing/corrupt manifest halts the whole run
}

function writeDiffPng(imgA, imgB, outPath) {
  const { width, height } = imgA;
  const diff = new Uint8Array(width * height * 4);
  pixelmatch(imgA.data, imgB.data, diff, width, height, { threshold: THRESHOLD });
  const png = new PNG({ width, height });
  png.data.set(diff);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(png));
  return outPath;
}

async function compareOne(entry) {
  const { key, variant, figma, story } = entry;
  const label = `${key || ''}/${variant}`.replace(/^\//, '');

  const [figmaResult, storyResult] = await Promise.all([
    readPng(`${label} figma screenshot`, figma),
    readPng(`${label} story screenshot`, story),
  ]);

  for (const result of [figmaResult, storyResult]) {
    if (!result.ok) {
      const line = acknowledgement(result);
      console.error(line);
      return { key, variant, status: 'BLOCKED', reason: line, worstRatio: null, failedRegions: [] };
    }
  }

  const { a, b, width, height } = alignDims(figmaResult.value, storyResult.value);
  const grid = chunkGrid(width, height, COLS, ROWS);
  const { pass, failedRegions, worstRatio } = compareChunks(a, b, grid, {
    threshold: THRESHOLD,
    regionThreshold: REGION_THRESHOLD,
    cols: COLS,
    rows: ROWS,
  });

  let diffImage = null;
  try {
    diffImage = writeDiffPng(a, b, join(DIFF_DIR, `${variant}.diff.png`));
  } catch (e) {
    console.warn(`  ! ${label}: could not write diff png (${e.message})`);
  }

  return {
    key,
    variant,
    status: pass ? 'PASS' : 'FAIL',
    worstRatio: +worstRatio.toFixed(4),
    failedRegions,
    diffImage,
  };
}

async function main() {
  const manifest = await loadManifest();
  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.error('visual-diff: manifest must be a non-empty array of {key, variant, figma, story}');
    process.exit(2);
  }

  const variants = [];
  for (const entry of manifest) {
    variants.push(await compareOne(entry));
  }

  const overallOk = variants.every((v) => v.status === 'PASS');
  const report = { generatedAt: new Date().toISOString(), manifest: MANIFEST_PATH, variants, pass: overallOk };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`\nVisual diff — ${variants.length} variant(s):`);
  for (const v of variants) {
    if (v.status === 'PASS') {
      console.log(`  PASS  ${v.variant} (worst region diff ${(v.worstRatio * 100).toFixed(1)}%)`);
    } else if (v.status === 'FAIL') {
      console.log(`  FAIL  ${v.variant} — regions differ: ${v.failedRegions.join(', ')}`);
    } else {
      console.log(`  BLOCKED  ${v.variant} — ${v.reason}`);
    }
  }
  console.log(`\nReport written to ${OUT}`);

  if (!overallOk) process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
