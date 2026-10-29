#!/usr/bin/env node
// The functional browser gate: drive real flows against the running stack and write a receipt.
//
// Why this exists: REVIEW has been asserting live-DOM facts in prose - "driven in a real
// browser", "focus lands on <body>" - with nothing behind them. Every other rubric dimension is
// recomputed by loop.mjs from an artifact. This makes the functional one the same: flows run,
// `tickets/<KEY>/e2e-report.json` records a verdict per flow, and loop.mjs recomputes the rate.
//
// Usage:
//   node scripts/e2e.mjs --key PROJ-3907 --flows tickets/PROJ-3907/e2e-flows.json
//   node scripts/e2e.mjs --key K --flows f.json --app-base http://localhost:3000 \
//     [--session .session/cookie.json] [--out tickets/K/e2e-report.json] \
//     [--headed] [--timeout-ms 15000] [--settle-ms 400] [--allow-writes] [--validate-only]
//
// Flow spec: [{ name, writes?, steps: [{ action, ... }] }]. Actions: goto, click, fill, press,
// select, hover, wait, expectVisible, expectHidden, expectText, expectUrl, screenshot, submit.
// `submit` can persist server-side, so it needs `"writes": true` on the flow AND --allow-writes
// on the command: the spec says what it intends, the operator says it may.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildE2eReport,
  failureSummary,
  passRateFromE2eReport,
  specWrites,
  stepUrl,
  validateSpec,
} from './e2e-lib.mjs';
import { isSessionStale, redact, resolveSessionConfig, sessionCookie } from './session-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));

const KEY = arg('key');
const FLOWS_PATH = arg('flows');
if (!KEY || !FLOWS_PATH) {
  console.error('usage: node scripts/e2e.mjs --key <KEY> --flows <spec.json> [--app-base URL]');
  process.exit(2);
}

const TIMEOUT_MS = Number(arg('timeout-ms', 15000));
const SETTLE_MS = Number(arg('settle-ms', 400));
const OUT = abs(arg('out', `tickets/${KEY}/e2e-report.json`));
const SESSION_PATH = abs(arg('session', '.session/cookie.json'));

const spec = JSON.parse(readFileSync(abs(FLOWS_PATH), 'utf8'));
const { ok, errors, flows } = validateSpec(spec);
if (!ok) {
  console.error(`✗ ${abs(FLOWS_PATH)} is not a valid flow spec:`);
  for (const e of errors) console.error(`    ${e}`);
  process.exit(2);
}
if (flag('validate-only')) {
  console.log(`✓ ${flows.length} flow(s) valid${specWrites(flows) ? ' (spec writes to the backend)' : ''}`);
  process.exit(0);
}

// Two independent consents for a destructive run: the spec declares intent, the operator allows
// it. Either one alone is not enough - a spec can be written by an agent.
if (specWrites(flows) && !flag('allow-writes')) {
  console.error('✗ this spec contains write steps. Re-run with --allow-writes to permit them.');
  console.error('  Writes hit the real backend as the test account and are not undone afterwards.');
  process.exit(2);
}

const session = existsSync(SESSION_PATH) ? JSON.parse(readFileSync(SESSION_PATH, 'utf8')) : null;
const cfg = resolveSessionConfig(process.env);

// --app-base is REQUIRED and deliberately not defaulted. :3000 is a shared dev server running
// whatever branch the operator last checked out, so inheriting it points a per-ticket gate at
// arbitrary code: PROJ-3907's flows were first run against fix/PROJ-4137, which does not
// contain the 3907 change at all, and reported a confident 0/5. A wrong-branch run does not look
// like a broken environment - it looks exactly like a failing application, which is the one
// result this gate must never invent. Nothing can detect the mismatch over HTTP, so the base is
// stated rather than guessed.
if (!arg('app-base')) {
  console.error('✗ --app-base is required. Name the server running THIS ticket\'s branch, e.g.');
  console.error('    --app-base http://localhost:3100');
  console.error('  Do not point a ticket run at a shared :3000 unless that is genuinely serving');
  console.error('  the ticket\'s worktree - a wrong-branch run reports FAIL, not BLOCKED.');
  process.exit(2);
}
const APP_BASE = arg('app-base').replace(/\/+$/, '');
const safe = (v) => redact(v, [cfg.password, cfg.tokenSecret, session?.jwt].filter(Boolean));

/** Every flow BLOCKED with one reason - an infrastructure failure, which must read as unmeasured
 *  rather than as an app that failed its tests. */
function blockedReport(reason) {
  return buildE2eReport({
    key: KEY,
    appBase: APP_BASE,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    results: flows.map((f) => ({ name: f.name, status: 'BLOCKED', error: reason })),
  });
}

function write(report) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (!session?.cookie) {
  write(blockedReport(`no session at ${SESSION_PATH} - run: node scripts/session.mjs`));
  console.error(`✗ no session at ${SESSION_PATH}. Flows recorded BLOCKED (unmeasured, not failed).`);
  console.error('  Run: node scripts/session.mjs');
  process.exit(1);
}
if (isSessionStale(session.jwt)) {
  write(blockedReport('session expired - re-run scripts/session.mjs'));
  console.error('✗ session expired. Flows recorded BLOCKED. Run: node scripts/session.mjs');
  process.exit(1);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: !flag('headed') });
const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
await context.addCookies([sessionCookie(session.cookie, APP_BASE)]);
context.setDefaultTimeout(TIMEOUT_MS);

/** One step. Throws with a human-readable message; the caller records which index failed. */
async function runStep(page, step) {
  const sel = step.selector;
  switch (step.action) {
    case 'goto': {
      const url = stepUrl(APP_BASE, step.route);
      const asked = new URL(url).pathname;
      await page.goto(url, { waitUntil: 'networkidle' });
      // The app can bounce a route client-side AFTER networkidle - a feature-flag or permission
      // gate resolves once the token has been read - so sampling the path immediately sees the
      // requested route and misses the redirect that follows.
      await page.waitForTimeout(Math.max(SETTLE_MS, 1200));
      const landed = new URL(page.url()).pathname;

      // Landing somewhere else means the flow never reached its subject, so nothing can be
      // concluded about the code: that is UNMEASURED, not a failing application. PROJ-3907's
      // first two runs reported a confident 0/5 when the real causes were a wrong branch and
      // then an account with every module behind a flag ("Coming Soon"). A ticket whose AC is
      // genuinely about redirect behaviour should assert it with expectUrl, not by navigating
      // and hoping.
      if (landed !== asked && !(step.expectPath && landed === step.expectPath)) {
        const why = landed.startsWith('/login')
          ? 'the session was not accepted'
          : 'the route is gated - check the feature flag, the account\'s permissions, and that this server runs the ticket\'s branch';
        const err = new Error(`redirected ${asked} -> ${landed}: ${why}`);
        err.blocked = true;
        throw err;
      }
      break;
    }
    case 'click': await page.click(sel); break;
    case 'submit': await page.click(sel); break;
    case 'fill': await page.fill(sel, step.value); break;
    case 'press': await page.press(sel, step.key ?? 'Enter'); break;
    case 'select': await page.selectOption(sel, step.value); break;
    case 'hover': await page.hover(sel); break;
    case 'wait': await page.waitForTimeout(Number(step.ms ?? SETTLE_MS)); break;
    case 'expectVisible': await page.waitForSelector(sel, { state: 'visible' }); break;
    case 'expectHidden': await page.waitForSelector(sel, { state: 'hidden' }); break;
    case 'expectText': {
      const text = (await page.textContent(sel)) ?? '';
      if (!text.includes(step.text)) throw new Error(`"${sel}" reads ${JSON.stringify(text.trim().slice(0, 120))}, expected to contain ${JSON.stringify(step.text)}`);
      break;
    }
    case 'expectUrl': {
      const path = new URL(page.url()).pathname;
      if (path !== step.path) throw new Error(`url is ${path}, expected ${step.path}`);
      break;
    }
    case 'screenshot': {
      const file = abs(step.path ?? `tickets/${KEY}/e2e/${Date.now()}.png`);
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      break;
    }
    default: throw new Error(`unknown action "${step.action}"`);
  }
}

const startedAt = new Date().toISOString();
const results = [];

for (const flow of flows) {
  // A fresh page per flow: flows must not depend on each other's leftover state, or a failure
  // in one silently changes the meaning of the next.
  const page = await context.newPage();
  const began = Date.now();
  const steps = [];
  let status = 'PASS';
  let failedStep = null;
  let error = null;
  /** The path this flow last navigated to - what "drifted" is measured against. */
  let wantPath = null;

  for (const [i, step] of flow.steps.entries()) {
    const stepBegan = Date.now();
    try {
      if (step.action === 'goto') wantPath = new URL(stepUrl(APP_BASE, step.route)).pathname;
      await runStep(page, step);
      if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS);
      steps.push({ i, action: step.action, status: 'PASS', ms: Date.now() - stepBegan });
    } catch (e) {
      // A gate can bounce the route at any moment, not just inside goto's settle window - the
      // redirect is racy, so a flow can clear the navigation check and then be moved while a
      // selector is still being waited on. Whatever the timing, if the page is no longer on the
      // route the flow asked for, the step failed somewhere the flow was never meant to be and
      // its result says nothing about the code.
      let drifted = false;
      if (!e?.blocked && wantPath) {
        try {
          const now = new URL(page.url()).pathname;
          if (now !== wantPath) {
            drifted = true;
            e.message = `${e?.message || e}\n  (page had drifted ${wantPath} -> ${now}: the route is gated, so this step never reached its subject)`;
          }
        } catch { /* page closed or unparsable url - fall through as a normal failure */ }
      }
      // `blocked` means the flow never reached what it was meant to exercise, so it is recorded
      // as not-run rather than as a verdict. passRateFromE2eReport excludes BLOCKED entirely,
      // and loop.mjs turns an all-BLOCKED report into `unmeasured`.
      status = e?.blocked || drifted ? 'BLOCKED' : 'FAIL';
      failedStep = i;
      error = safe(e?.message || String(e)).split('\n')[0].slice(0, 300);
      steps.push({ i, action: step.action, status, ms: Date.now() - stepBegan, error });
      break; // the rest of the flow is meaningless once a step failed
    }
  }

  results.push({ name: flow.name, status, durationMs: Date.now() - began, steps, failedStep, error });
  console.log(`${status === 'PASS' ? '✓' : status === 'BLOCKED' ? '⚠' : '✗'} ${flow.name}${error ? ` - ${error}` : ''}`);
  await page.close();
}

await browser.close();

const report = buildE2eReport({ key: KEY, appBase: APP_BASE, results, startedAt, finishedAt: new Date().toISOString() });
write(report);

const rate = passRateFromE2eReport(report);
console.log(`\n  ${results.filter((r) => r.status === 'PASS').length}/${results.length} flows passed` +
  `${rate === null ? ' (nothing ran - UNMEASURED)' : ` - rate ${rate.toFixed(3)}`}`);
console.log(`  wrote ${OUT}`);
for (const line of failureSummary(report)) console.log(`  ✗ ${line}`);

process.exit(report.pass ? 0 : 1);
