#!/usr/bin/env node
// Route-based screenshot capture - the capture path for apps with no Storybook.
//
// story-capture.mjs can only reach a component through a story. PROJ-3403 is the case that
// proved the gap: every file it touches is in the Next.js `frontend/` package, which ships no
// `.storybook` and zero `*.stories.*`. story-capture planned 0 variants, visual-diff reported
// 4/4 BLOCKED, and the ticket halted `stop-unverified` with the visual dimension unmeasured.
// Those screens exist only as App Router routes, so the only way to render them is the real app.
//
// Usage:
//   node scripts/route-capture.mjs --key PROJ-3403 --app-base http://localhost:3100 \
//     --routes <plan.json> [--fixtures <fixtures.json>] [--fixture-port 3101] \
//     [--cookie-file <file>] [--cookie-name authToken] \
//     [--width 1512] [--height 982] [--dpr 1] [--settle-ms 1800] \
//     [--figma-dir tickets/<KEY>/figma] [--out-dir tickets/<KEY>/story] \
//     [--manifest-out tickets/<KEY>/visual-diff-manifest.json] [--dry-run]
//
// --routes is a JSON array of { variant, route, selector?, theme?, query? }. A null/absent
// `selector` captures the VIEWPORT; name a selector to capture the element a design crop
// corresponds to.
//
// Sizing matters: visual-diff.mjs CROPS to the smaller image rather than scaling, so
// --width/--dpr must reproduce the design frame's pixel width or every diff is measuring
// misalignment it introduced itself. A 1512-wide reference wants --width 1512 --dpr 1.
//
// Pure logic lives in route-capture-lib.mjs and is unit-tested; this file is browser + IO.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withGuard, acknowledgeOrThrow } from './guard.mjs';
import { buildDiffManifest, captureCoverage } from './story-capture-lib.mjs';
import { buildRoutePlan, matchFixture, missingInputs } from './route-capture-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);
const abs = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

const KEY = arg('key');
const ROUTES_PATH = arg('routes');
const APP_BASE = arg('app-base');
if (!KEY) {
  console.error('route-capture: --key <KEY> is required');
  process.exit(2);
}

const DRY_RUN = flag('dry-run');
const THEMES = (arg('themes', '') || '').split(',').map((t) => t.trim()).filter(Boolean);
const WIDTH = Number(arg('width', '1512'));
const HEIGHT = Number(arg('height', '982'));
const DPR = Number(arg('dpr', '1'));
const SETTLE_MS = Number(arg('settle-ms', '1800'));
const FIXTURES_PATH = arg('fixtures');
const FIXTURE_PORT = Number(arg('fixture-port', '0'));
const COOKIE_FILE = arg('cookie-file');
const COOKIE_NAME = arg('cookie-name', 'authToken');

const ticketDir = join(ROOT, 'tickets', KEY);
const OUT_DIR = abs(arg('out-dir', join(ticketDir, 'story')));
const FIGMA_DIR = abs(arg('figma-dir', join(ticketDir, 'figma')));
const MANIFEST_OUT = abs(arg('manifest-out', join(ticketDir, 'visual-diff-manifest.json')));

/** Playwright's absence is a HARD, actionable failure, never a silent skip - a capture step
 * that quietly does nothing is how the visual gate came to be called mandatory while never
 * once running. Same contract as story-capture.mjs. */
async function loadPlaywright() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    console.error('⛔ REVIEW BLOCKED - route capture unavailable: playwright is not installed.');
    console.error('   Fix (once, in millwright/):  npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}

async function readJsonGuarded(label, path) {
  const text = await withGuard(label, () => readFileSync(path, 'utf8'), { source: path, retries: 0, timeoutMs: 5000 });
  return JSON.parse(acknowledgeOrThrow(text));
}

/**
 * Serve fixture responses over loopback.
 *
 * A real server, not Playwright request interception, because a Next.js app also fetches
 * during SSR: PROJ-3403's feature-flag gate runs `requireFlagOrNotFound` inside the Next
 * process, and `page.route` cannot see that request. Interception would gate the route to a
 * 404 while every browser-side call looked fine.
 */
async function serveFixtures(fixtures, port) {
  const { createServer } = await import('node:http');
  const misses = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    const head = {
      'content-type': 'application/json; charset=utf-8',
      // credentials:'include' forbids a wildcard origin, so echo the caller's.
      ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {}),
      'access-control-allow-headers': 'authorization,content-type,x-screen,x-tab-id,x-correlation-id',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, head).end(); return; }
    const hit = matchFixture(fixtures, url.pathname);
    if (!hit.matched) {
      misses.add(`${req.method} ${url.pathname}`);
      res.writeHead(404, head).end(JSON.stringify({ success: false, message: 'no fixture' }));
      return;
    }
    // The app unwraps `{success, data}`; a fixture may opt out with `__raw`.
    const body = fixtures.raw ? hit.body : { success: true, data: hit.body };
    res.writeHead(200, head).end(JSON.stringify(body));
  });
  // A port clash has to name itself: the unhandled 'error' event otherwise surfaces as a raw
  // EADDRINUSE stack, which reads like a bug in the capture rather than "something already
  // serves that port" - usually a fixture server left running from a previous session.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`⛔ route capture BLOCKED - port ${port} is already serving something else.`);
      console.error('   Either stop it, pass a different --fixture-port, or drop --fixtures');
      console.error('   entirely if what is already on that port is serving these fixtures.');
      process.exit(2);
    }
    throw e;
  });
  return { port: server.address().port, misses, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const routes = ROUTES_PATH ? await readJsonGuarded('route-capture plan', ROUTES_PATH) : null;
  const missing = missingInputs({ appBase: APP_BASE, routes, figmaDir: FIGMA_DIR });
  if (missing.length) {
    console.error('⛔ route capture BLOCKED - missing:');
    for (const m of missing) console.error(`   · ${m}`);
    process.exit(2);
  }

  let fixtureServer = null;
  if (FIXTURES_PATH) {
    const fixtures = await readJsonGuarded('route-capture fixtures', FIXTURES_PATH);
    fixtureServer = await serveFixtures(fixtures, FIXTURE_PORT);
    console.log(`  fixtures: ${FIXTURES_PATH} served at http://127.0.0.1:${fixtureServer.port}`);
    console.log('            point the app\'s API base at that origin, or pass --fixture-port to pin it');
  }

  const plan = buildRoutePlan(routes, { storyDir: OUT_DIR, figmaDir: FIGMA_DIR, baseUrl: APP_BASE, themes: THEMES });
  console.log(`\nRoute capture - ${KEY}`);
  console.log(`  app:      ${APP_BASE}`);
  console.log(`  viewport: ${WIDTH}x${HEIGHT} @${DPR}x  (must match the design frame's pixel width - visual-diff crops, it does not scale)`);
  console.log(`  variants: ${plan.length}`);

  if (DRY_RUN) {
    for (const p of plan) console.log(`   · ${p.slug} ← ${p.url}${p.selector ? `  [${p.selector}]` : '  [viewport]'}`);
    console.log('\n  --dry-run: no browser launched, nothing written.');
    if (fixtureServer) await fixtureServer.close();
    return;
  }

  const chromium = await loadPlaywright();
  mkdirSync(OUT_DIR, { recursive: true });

  const captured = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
    if (COOKIE_FILE) {
      const value = readFileSync(abs(COOKIE_FILE), 'utf8').trim();
      await context.addCookies([{ name: COOKIE_NAME, value, url: APP_BASE }]);
      console.log(`  session:  ${COOKIE_NAME} cookie set from ${COOKIE_FILE}`);
    }
    for (const p of plan) {
      const page = await context.newPage();
      try {
        await page.goto(p.url, { waitUntil: 'networkidle', timeout: 60000 });
        // A redirect means the app refused the route - an auth gate, a feature flag, a missing
        // permission. Capturing anyway writes a screenshot of the WRONG screen that a diff then
        // reports as a design regression, which is the worst possible failure here.
        const landed = new URL(page.url()).pathname;
        const asked = new URL(p.url).pathname;
        if (landed !== asked) throw new Error(`redirected to ${landed} - the app refused ${asked}`);
        await page.waitForTimeout(SETTLE_MS);
        // Whatever the app autofocused draws a focus ring that no design reference has, and
        // the ring alone is enough to fail the region it lands in.
        await page.evaluate(() => {
          const el = document.activeElement;
          if (el && el !== document.body && typeof el.blur === 'function') el.blur();
        });
        const shot = { animations: 'disabled', caret: 'hide' };
        if (p.selector) {
          const el = page.locator(p.selector).first();
          await el.waitFor({ state: 'visible', timeout: 15000 });
          await el.screenshot({ path: p.storyPng, ...shot });
        } else {
          await page.screenshot({ path: p.storyPng, ...shot });
        }
        captured.push(p.slug);
        console.log(`   ✓ ${p.slug}`);
      } catch (e) {
        console.log(`   ✗ ${p.slug} - ${e?.message?.split('\n')[0] || e}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (fixtureServer?.misses.size) {
    // A 404 the app swallowed is the usual reason a screen renders empty or bounces.
    console.log('\n  fixture MISSES (the app asked, nothing answered):');
    for (const m of [...fixtureServer.misses].sort()) console.log(`   · ${m}`);
  }
  if (fixtureServer) await fixtureServer.close();

  const figmaPresent = plan.filter((p) => existsSync(p.figmaPng)).map((p) => p.slug);
  const { manifest, skipped } = buildDiffManifest(KEY, plan, { captured, figmaPresent });
  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));

  const coverage = captureCoverage(plan.map((p) => p.slug), manifest);
  console.log(`\n  captured: ${captured.length}/${plan.length}`);
  console.log(`  manifest: ${manifest.length} comparable pair(s) → ${MANIFEST_OUT}`);
  if (skipped.length) {
    console.log('  skipped (NOT counted as passing):');
    for (const s of skipped) console.log(`   · ${s.slug} - ${s.reason}`);
  }
  console.log(`  coverage: ${coverage.status} (${coverage.covered}/${coverage.expected})`);

  if (manifest.length === 0) {
    console.error('\n⛔ No comparable pairs - there is nothing for visual-diff.mjs to check.');
    process.exit(1);
  }
  console.log(`\n  Next: node scripts/visual-diff.mjs --manifest ${MANIFEST_OUT}`);
  if (!coverage.complete) process.exit(1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
