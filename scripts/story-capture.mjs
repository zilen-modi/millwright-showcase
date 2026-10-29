#!/usr/bin/env node
// Headless Storybook capture — the missing half of the REVIEW-stage visual gate (Goal A4).
//
// The pipeline has always described its per-variant screenshot diff as "an objective
// gate, not an eyeball", and `scripts/visual-diff.mjs` has always been able to compare
// PNGs. What never existed was anything that could PRODUCE the story-side PNGs without a
// human driving a browser — so across 25 shipped tickets not one visual-diff report was
// ever written, and every UI ticket reached for `visualDiffSkipReason` instead. Since
// Goal A3 turned a skip into an EXCLUDED dimension (a lower ceiling) rather than a free
// 1.0, that escape route now costs score, and this script is the way out of it.
//
// Usage:
//   node scripts/story-capture.mjs --key PROJ-3025 --stories <plan.json> \
//     [--storybook http://127.0.0.1:6007] [--static <storybook-static dir>] \
//     [--themes light,dark] [--figma-dir tickets/<KEY>/figma] \
//     [--out-dir tickets/<KEY>/story] [--manifest-out tickets/<KEY>/visual-diff-manifest.json] \
//     [--width 1280] [--height 800] [--dry-run]
//
// --stories is a JSON array of { variant, storyId, theme?, globals?, selector?, viewport? }.
// Get storyIds from Storybook's index (`/index.json`) or the story file's title+name.
//
// Writes one PNG per variant×theme into --out-dir and a visual-diff manifest naming only
// the pairs that ACTUALLY exist on both sides, then prints the coverage verdict. Feed the
// manifest straight to visual-diff.mjs:
//   node scripts/visual-diff.mjs --manifest tickets/<KEY>/visual-diff-manifest.json
//
// Pure logic (URL building, pairing, coverage) lives in story-capture-lib.mjs and is
// unit-tested; this file is the browser + IO wrapper.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { buildCapturePlan, buildDiffManifest, captureCoverage } from './story-capture-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const KEY = arg('key');
const STORIES_PATH = arg('stories');
if (!KEY || !STORIES_PATH) {
  console.error('story-capture: --key <KEY> and --stories <plan.json> are required');
  process.exit(2);
}

const DRY_RUN = flag('dry-run');
const STATIC_DIR = arg('static');
const THEMES = arg('themes', 'light,dark').split(',').map((t) => t.trim()).filter(Boolean);
const WIDTH = Number(arg('width', '1280'));
const HEIGHT = Number(arg('height', '800'));

const ticketDir = join(ROOT, 'tickets', KEY);
const OUT_DIR = abs(arg('out-dir', join(ticketDir, 'story')));
const FIGMA_DIR = abs(arg('figma-dir', join(ticketDir, 'figma')));
const MANIFEST_OUT = abs(arg('manifest-out', join(ticketDir, 'visual-diff-manifest.json')));

function abs(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Playwright is imported lazily and its absence is a HARD, actionable failure — never a
 * silent skip. A capture step that quietly does nothing is exactly how the visual gate
 * came to be described as mandatory while never once running. */
async function loadPlaywright() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    console.error('⛔ REVIEW BLOCKED — story capture unavailable: playwright is not installed.');
    console.error('   The per-variant visual diff cannot run, so this ticket cannot claim visual fidelity.');
    console.error('   Fix (once, in millwright/):  npm i -D playwright && npx playwright install chromium');
    console.error('   Do NOT work around this with visualDiffSkipReason — a skip is refused when the');
    console.error("   ticket's design.md enumerated variant nodes, and only lowers the score ceiling otherwise.");
    process.exit(1);
  }
}

async function readJsonGuarded(label, path) {
  const text = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  return JSON.parse(acknowledgeOrThrow(text));
}

/** Serve a `storybook build` output directory over loopback so stories load with the same
 * origin semantics as a live dev server. Preferred over `storybook dev` in CI/headless:
 * no watcher, no port races, and the build is a fixed artefact. */
async function serveStatic(dir) {
  const { createServer } = await import('node:http');
  const { extname } = await import('node:path');
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const file = join(dir, rel || 'index.html');
    if (!file.startsWith(resolve(dir))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const stories = await readJsonGuarded('story-capture plan', STORIES_PATH);
  if (!Array.isArray(stories) || stories.length === 0) {
    console.error('story-capture: --stories must be a non-empty JSON array of { variant, storyId }');
    process.exit(2);
  }

  let baseUrl = arg('storybook', 'http://127.0.0.1:6007');
  let stopServer = null;
  if (STATIC_DIR) {
    if (!existsSync(STATIC_DIR)) {
      console.error(`⛔ story capture BLOCKED — --static "${STATIC_DIR}" does not exist.`);
      console.error('   Build it first:  yarn --cwd <repo>/packages/erp-next-ui-kit-v2 build-storybook');
      process.exit(1);
    }
    const served = await serveStatic(STATIC_DIR);
    baseUrl = served.baseUrl;
    stopServer = served.close;
  }

  const plan = buildCapturePlan(stories, { storyDir: OUT_DIR, figmaDir: FIGMA_DIR, baseUrl, themes: THEMES });
  console.log(`\nStory capture — ${KEY}`);
  console.log(`  source:   ${STATIC_DIR ? `static build ${STATIC_DIR} (served at ${baseUrl})` : baseUrl}`);
  console.log(`  variants: ${plan.length} (${stories.length} stor(y/ies) × themes ${THEMES.join(', ')})`);

  if (DRY_RUN) {
    for (const p of plan) console.log(`   · ${p.slug} ← ${p.url}`);
    console.log('\n  --dry-run: no browser launched, nothing written.');
    if (stopServer) await stopServer();
    return;
  }

  const chromium = await loadPlaywright();
  mkdirSync(OUT_DIR, { recursive: true });

  const captured = [];
  const failures = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    for (const p of plan) {
      const page = await context.newPage();
      try {
        await page.goto(p.url, { waitUntil: 'networkidle', timeout: 30000 });
        const target = await page.waitForSelector(p.selector, { timeout: 15000, state: 'attached' });
        // Storybook mounts the root before the story paints; without settling first, a
        // capture races the render and diffs a half-drawn component.
        await page.waitForTimeout(250);
        await target.screenshot({ path: p.storyPng });
        captured.push(p.slug);
        console.log(`   ✓ ${p.slug}`);
      } catch (e) {
        failures.push({ slug: p.slug, error: e?.message || String(e) });
        console.log(`   ✗ ${p.slug} — ${e?.message || e}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (stopServer) await stopServer();
  }

  const figmaPresent = plan.filter((p) => existsSync(p.figmaPng)).map((p) => p.slug);
  const { manifest, skipped } = buildDiffManifest(KEY, plan, { captured, figmaPresent });
  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));

  const coverage = captureCoverage(plan.map((p) => p.slug), manifest);
  console.log(`\n  captured: ${captured.length}/${plan.length}`);
  console.log(`  manifest: ${manifest.length} comparable pair(s) → ${MANIFEST_OUT}`);
  if (skipped.length) {
    console.log('  skipped (NOT counted as passing):');
    for (const s of skipped) console.log(`   · ${s.slug} — ${s.reason}`);
  }
  console.log(`  coverage: ${coverage.status} (${coverage.covered}/${coverage.expected})`);

  if (manifest.length === 0) {
    console.error('\n⛔ No comparable pairs — there is nothing for visual-diff.mjs to check.');
    console.error('   Capture the Figma reference PNGs into the --figma-dir with matching slugs.');
    process.exit(1);
  }
  console.log(`\n  Next: node scripts/visual-diff.mjs --manifest ${MANIFEST_OUT}`);
  // Partial coverage exits non-zero on purpose: some evidence reads as "we checked",
  // and the uncaptured variants are exactly where a regression hides.
  if (!coverage.complete) process.exit(1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
