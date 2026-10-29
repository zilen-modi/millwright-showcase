#!/usr/bin/env node
// Obtain a browser session for the local stack, so a browser run can reach a real route.
//
// `localhost:3000` 307s every route to /login, and the gate is server-side: middleware reads the
// `authToken` cookie through `next/headers`, which request interception cannot reach. So a run
// needs a genuine cookie, and until now a human pasted one in by hand.
//
// Usage:
//   node scripts/session.mjs                       # log in, write .session/cookie.json
//   node scripts/session.mjs --verify              # is the stored session still usable?
//   node scripts/session.mjs --print-cookie        # the cookie VALUE only, for --cookie-file
//   node scripts/session.mjs --out <path>
//
// Credentials come from config/*.env (gitignored by pattern) as E2E_USERNAME / E2E_PASSWORD.
// They are never printed, never written to the session file, and never passed on a command line
// where `ps` would show them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEnvFile } from './env-file.mjs';
import {
  encryptAuthCookie,
  isSessionStale,
  loginUrl,
  redact,
  resolveSessionConfig,
  tokenExpiry,
  tokenFromLoginResponse,
} from './session-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));

const OUT = abs(arg('out', '.session/cookie.json'));

/** Load config/*.env into a plain object without mutating process.env - the values are secrets
 *  and the fewer places they live, the better. */
function readEnvFile() {
  const { path } = resolveEnvFile(ROOT);
  const out = {};
  if (!path || !existsSync(path)) return { env: out, path };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { env: out, path };
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { env: fileEnv, path: envPath } = readEnvFile();
// process.env wins, so a one-off run can override without editing the file.
const cfg = resolveSessionConfig({ ...fileEnv, ...process.env });
const SECRETS = [cfg.password, cfg.tokenSecret].filter(Boolean);
const safe = (v) => redact(v, SECRETS);

if (flag('verify') || flag('print-cookie')) {
  if (!existsSync(OUT)) die(`no session at ${OUT} - run: node scripts/session.mjs`);
  const stored = JSON.parse(readFileSync(OUT, 'utf8'));
  if (flag('print-cookie')) {
    process.stdout.write(stored.cookie ?? '');
    process.exit(stored.cookie ? 0 : 1);
  }
  const stale = isSessionStale(stored.jwt);
  console.log(stale ? '✗ session expired' : '✓ session valid', `- expires ${stored.expiresAt ?? 'unknown'}`);
  process.exit(stale ? 1 : 0);
}

if (!cfg.ok) {
  die(
    `missing ${cfg.missing.join(' and ')} - add a DEDICATED TEST ACCOUNT (never a personal login) ` +
      `to ${envPath}:\n` +
      cfg.missing.map((k) => `    ${k}=...`).join('\n') +
      `\n  See config/autopilot.env.example. That file is gitignored by pattern.`,
  );
}

const url = loginUrl(cfg.apiBase);
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
} catch (e) {
  die(`cannot reach ${url} - is the backend up on ${cfg.apiBase}? (${safe(e?.message || e)})`);
}

const bodyText = await res.text();
let body = null;
try {
  body = JSON.parse(bodyText);
} catch {
  /* non-JSON error page; handled below */
}

if (!res.ok) {
  // 429 is its own message: the route rate-limits to 5 attempts per 15 min per IP+user, so a
  // retry loop here would lock the test account out rather than fix anything.
  if (res.status === 429) die('login rate-limited (5 attempts / 15 min). Wait, do not retry.');
  die(`login failed ${res.status} at ${url}: ${safe(bodyText).slice(0, 300)}`);
}

const jwt = tokenFromLoginResponse(body);
if (!jwt) die(`login returned ${res.status} but no token in the body: ${safe(bodyText).slice(0, 300)}`);

const expMs = tokenExpiry(jwt);
const session = {
  // The cookie is the encrypted form the app reads; the jwt is kept only so --verify can read
  // `exp` without a round trip. Neither username nor password is ever stored here.
  cookie: encryptAuthCookie(jwt, cfg.tokenSecret),
  jwt,
  appBase: cfg.appBase,
  apiBase: cfg.apiBase,
  issuedAt: new Date().toISOString(),
  expiresAt: expMs ? new Date(expMs).toISOString() : null,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(session, null, 2)}\n`, 'utf8');

console.log(`✓ session for ${cfg.appBase} written to ${OUT}`);
console.log(`  expires ${session.expiresAt ?? 'unknown'}`);
