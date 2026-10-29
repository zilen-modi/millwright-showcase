#!/usr/bin/env node
// HEADLESS Jira path for Autopilot — a credential-holding wrapper around the Jira REST v3 API.
//
// Why this exists: when the pipeline runs headless (panel-spawned `claude -p`, AUTOPILOT_HEADLESS=1)
// the Atlassian MCP is unreliable/denied, so Jira reads+writes go through THIS script instead. The
// INTERACTIVE path still uses the MCP. The API token is read from millwright/config/autopilot.env
// INSIDE this process, so it never enters the model's context / argv — the model only ever sees the
// JSON this script prints on stdout.
//
// SECURITY: the token is NEVER printed and is redacted from any error text before logging; the
// Basic-auth header is never echoed. Creds come from the env file (or process.env, which overrides).
//
// GUARDRAILS: every request is wrapped in withGuard (scripts/guard.mjs) — timeout + classified
// retry (network/timeout/rate-limit retried; auth/not-found never) — so a failed call exits 1 with
// the structured ⛔ acknowledgement instead of silently returning partial data.
//
// Usage:
//   node millwright/scripts/jira.mjs get <KEY>
//   node millwright/scripts/jira.mjs comment <KEY> <file|->
//   node millwright/scripts/jira.mjs transitions <KEY>
//   node millwright/scripts/jira.mjs transition <KEY> <nameOrId>
//   node millwright/scripts/jira.mjs search <jql>
//   node millwright/scripts/jira.mjs whoami
//   node millwright/scripts/jira.mjs create-subtask <PARENT> <summary> [--assignee me] [--desc <file>]
//
// Config: millwright/config/autopilot.env (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).
// Missing/incomplete creds → exit 2 pointing at millwright/config/autopilot.env.example.
// Other errors → `✗ <redacted message>` on stderr, exit 1.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { withGuard } from './guard.mjs';
import { acknowledgement } from './guard-lib.mjs';
import { resolveEnvFile, resolveEnvExample } from './env-file.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..'); // millwright/
const { path: ENV_PATH } = resolveEnvFile(ROOT);
const ENV_EXAMPLE = resolveEnvExample(ROOT);

// ---- tiny inline .env parser (no dependency) ----
// KEY=VALUE per line; ignores blanks and `#` comments; strips a trailing inline `# ...`
// comment and surrounding quotes. process.env wins over the file.
function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1);
    // strip an unquoted trailing inline comment (`VALUE   # note`)
    if (val && !/^\s*["']/.test(val)) {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash);
    }
    val = val.trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

// A safe, non-secret fingerprint for a credential value — long enough to tell two
// different values apart (length + last 4 chars) without materially aiding an
// attacker, matching the pattern GitHub/AWS CLIs use for token fingerprinting.
function fingerprint(v) {
  if (!v) return '(empty)';
  return `len ${v.length}, ...${v.slice(-4)}`;
}

// `process.env` wins over the file (see the module comment) — an intentional quick-
// override escape hatch. That precedence is also the exact failure mode that cost a
// full debugging session once: a stale exported JIRA_API_TOKEN in a shell profile
// silently shadowed a correct, working token in the file, and neither a human nor an
// orchestrating agent could tell which source was actually in effect without this
// line. Always print it (to stderr, safe to log) so that's never true again.
function loadCreds() {
  const file = parseEnvFile(ENV_PATH);
  const sourceOf = (key) => (process.env[key] ? 'env' : file[key] ? 'file' : 'missing');
  const baseUrl = process.env.JIRA_BASE_URL || file.JIRA_BASE_URL || '';
  const email = process.env.JIRA_EMAIL || file.JIRA_EMAIL || '';
  const token = process.env.JIRA_API_TOKEN || file.JIRA_API_TOKEN || '';
  console.error(
    `[jira.mjs] creds — JIRA_BASE_URL: ${sourceOf('JIRA_BASE_URL')} (${fingerprint(baseUrl)}); ` +
    `JIRA_EMAIL: ${sourceOf('JIRA_EMAIL')} (${email || '(empty)'}); ` +
    `JIRA_API_TOKEN: ${sourceOf('JIRA_API_TOKEN')} (${fingerprint(token)})`,
  );
  const missing = [];
  if (!baseUrl) missing.push('JIRA_BASE_URL');
  if (!email) missing.push('JIRA_EMAIL');
  if (!token) missing.push('JIRA_API_TOKEN');
  if (missing.length) {
    console.error(
      `✗ headless Jira creds missing (${missing.join(', ')}).\n` +
      `  Copy ${ENV_EXAMPLE} → ${ENV_PATH} and fill in the values.\n` +
      `  (Atlassian API token: https://id.atlassian.com/manage-profile/security/api-tokens)`,
    );
    process.exit(2);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, token };
}

// Redact the token (and its base64 auth form) from any string before it is ever logged.
function makeRedactor(token, authB64) {
  const needles = [token, authB64].filter(Boolean);
  return (s) => {
    let out = String(s ?? '');
    for (const n of needles) {
      if (n) out = out.split(n).join('«redacted»');
    }
    // also redact a raw "Basic <...>" header if it ever leaks into a message
    out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic «redacted»');
    return out;
  };
}

let redact = (s) => String(s ?? ''); // replaced once creds are loaded

// ---- ADF → plaintext (recursive; text nodes; newline on paragraph/heading/listItem) ----
function adfToText(node) {
  if (!node || typeof node !== 'object') return '';
  let out = '';
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n.type === 'text' && typeof n.text === 'string') {
      out += n.text;
    }
    if (n.type === 'hardBreak') out += '\n';
    if (Array.isArray(n.content)) walk(n.content);
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out += '\n';
  };
  walk(node);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Wrap a plaintext string into a minimal ADF document (paragraph per line).
function textToAdf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

// ---- REST client ----
// EVERY outbound Jira call goes through withGuard (scripts/guard.mjs) — the SKILL's
// non-negotiable rule for external fetches, and this is the most network-dependent script in
// the repo. guard-lib's classifier decides retryability from the error we throw below:
// network / timeout / 429 rate-limit are retried with backoff; 401/403 auth and 404 not-found
// are AbortError'd immediately (retrying a bad token only wastes time and hides a real config
// problem). A guarded failure ends the process with the structured ⛔ acknowledgement line —
// it never returns partial or fabricated data to the caller.
const REQUEST_TIMEOUT_MS = 20000; // per attempt; the guard's own race is set slightly higher
const GUARD_TIMEOUT_MS = 25000;
const RETRIES = 2;

function makeClient({ baseUrl, email, token }) {
  const authB64 = Buffer.from(`${email}:${token}`).toString('base64');
  redact = makeRedactor(token, authB64);

  // One attempt. Throws an error carrying `status` so classifyError sees the real HTTP code
  // instead of regex-matching digits out of the message.
  const attempt = async (path, { method = 'GET', body } = {}) => {
    const url = `${baseUrl}/rest/api/3${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${authB64}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        // Abort the socket as well as the guard's race — without this a hung request keeps
        // the event loop alive after the timeout has already been reported.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(redact(`network error calling Jira ${method} ${path}: ${e?.message || e}`));
    }
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = json?.errorMessages?.join('; ')
        || (json?.errors && Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join('; '))
        || raw
        || res.statusText;
      const err = new Error(redact(`Jira ${method} ${path} → ${res.status}: ${detail}`));
      err.status = res.status; // exact classification (auth / rate-limit / not-found)
      throw err;
    }
    return json;
  };

  const api = async (path, opts = {}) => {
    const method = opts.method || 'GET';
    const result = await withGuard(`jira ${method} ${path}`, () => attempt(path, opts), {
      source: `Jira ${method} ${path}`,
      retries: RETRIES,
      timeoutMs: GUARD_TIMEOUT_MS,
    });
    if (!result.ok) {
      // Redact before the acknowledgement is ever printed — guard.mjs's own
      // acknowledgeOrThrow would log the raw message, and this process holds a credential.
      throw new Error(redact(acknowledgement(result)));
    }
    return result.value;
  };

  return { api };
}

// ---- field normalizers ----
const userLite = (u) => (u ? { accountId: u.accountId, displayName: u.displayName } : null);

function normalizeIssue(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary || '',
    description: f.description ? adfToText(f.description) : '',
    status: f.status?.name || '',
    issueType: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    labels: Array.isArray(f.labels) ? f.labels : [],
    assignee: userLite(f.assignee),
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
    subtasks: Array.isArray(f.subtasks)
      ? f.subtasks.map((s) => ({ key: s.key, summary: s.fields?.summary || '', status: s.fields?.status?.name || '' }))
      : [],
    issueLinks: Array.isArray(f.issuelinks)
      ? f.issuelinks.map((l) => {
          const rel = l.inwardIssue ? l.type?.inward : l.type?.outward;
          const other = l.inwardIssue || l.outwardIssue;
          return { type: rel || l.type?.name || '', key: other?.key || '', summary: other?.fields?.summary || '' };
        })
      : [],
    comments: Array.isArray(f.comment?.comments)
      ? f.comment.comments.map((c) => ({
          id: c.id,
          author: userLite(c.author),
          created: c.created,
          body: c.body ? adfToText(c.body) : '',
        }))
      : [],
  };
}

// ---- subcommands ----
async function cmdGet(client, key) {
  if (!key) usageError('get <KEY>');
  const fields = 'summary,description,status,issuetype,priority,labels,assignee,parent,subtasks,issuelinks,comment';
  const issue = await client.api(`/issue/${encodeURIComponent(key)}?fields=${fields}`);
  print(normalizeIssue(issue));
}

async function cmdComment(client, key, fileArg) {
  if (!key || !fileArg) usageError('comment <KEY> <file|->');
  const text = readInput(fileArg);
  const res = await client.api(`/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: { body: textToAdf(text) },
  });
  print({ id: res.id, key });
}

async function cmdTransitions(client, key) {
  if (!key) usageError('transitions <KEY>');
  const res = await client.api(`/issue/${encodeURIComponent(key)}/transitions`);
  const out = (res.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name || '' }));
  print(out);
}

async function cmdTransition(client, key, nameOrId) {
  if (!key || !nameOrId) usageError('transition <KEY> <nameOrId>');
  const res = await client.api(`/issue/${encodeURIComponent(key)}/transitions`);
  const transitions = res.transitions || [];
  const wanted = String(nameOrId).toLowerCase();
  const match = transitions.find((t) => t.id === nameOrId)
    || transitions.find((t) => (t.name || '').toLowerCase() === wanted);
  if (!match) {
    const available = transitions.map((t) => `${t.name} (${t.id})`).join(', ') || '(none)';
    throw new Error(`no transition matching "${nameOrId}" on ${key}. Available: ${available}`);
  }
  await client.api(`/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: { transition: { id: match.id } },
  });
  // re-read to report the resulting status
  const issue = await client.api(`/issue/${encodeURIComponent(key)}?fields=status`);
  print({ key, transitioned: match.name, status: issue.fields?.status?.name || '' });
}

async function cmdSearch(client, jql) {
  if (!jql) usageError('search <jql>');
  const res = await client.api('/search/jql', {
    method: 'POST',
    body: { jql, fields: ['summary', 'status', 'priority', 'issuetype', 'parent', 'assignee', 'labels', 'updated', 'created'], maxResults: 50 },
  });
  // The queue triages from these, so it can show what a ticket is before anyone plans it.
  const out = (res.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || '',
    status: i.fields?.status?.name || '',
    priority: i.fields?.priority?.name || null,
    type: i.fields?.issuetype?.name || null,
    epic: i.fields?.parent ? { key: i.fields.parent.key, summary: i.fields.parent.fields?.summary || '' } : null,
    assignee: i.fields?.assignee?.displayName || null,
    labels: i.fields?.labels || [],
    updated: i.fields?.updated || null,
    created: i.fields?.created || null,
  }));
  print(out);
}

async function cmdWhoami(client) {
  const me = await client.api('/myself');
  print({ accountId: me.accountId, displayName: me.displayName, emailAddress: me.emailAddress });
}

async function cmdCreateSubtask(client, parentKey, summary, rest) {
  if (!parentKey || !summary) usageError('create-subtask <PARENT> <summary> [--assignee me] [--desc <file>]');
  const assigneeMe = flagValue(rest, '--assignee') === 'me';
  const descFile = flagValue(rest, '--desc');

  const parent = await client.api(`/issue/${encodeURIComponent(parentKey)}?fields=project`);
  const projectId = parent.fields?.project?.id;
  const projectKey = parent.fields?.project?.key;
  if (!projectId && !projectKey) throw new Error(`could not resolve project for parent ${parentKey}`);

  const fields = {
    project: projectId ? { id: projectId } : { key: projectKey },
    parent: { key: parentKey },
    summary,
    issuetype: { name: 'Sub-task' },
  };
  if (descFile) fields.description = textToAdf(readInput(descFile));
  if (assigneeMe) {
    const me = await client.api('/myself');
    fields.assignee = { accountId: me.accountId };
  }
  const res = await client.api('/issue', { method: 'POST', body: { fields } });
  print({ key: res.key, parent: parentKey });
}

// ---- helpers ----
function readInput(fileArg) {
  if (fileArg === '-') {
    try {
      return readFileSync(0, 'utf8'); // stdin
    } catch {
      return '';
    }
  }
  return readFileSync(fileArg, 'utf8');
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : undefined;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function usageError(usage) {
  console.error(`✗ usage: node millwright/scripts/jira.mjs ${usage}`);
  process.exit(2);
}

// ---- main ----
async function main() {
  const [sub, ...args] = process.argv.slice(2);
  if (!sub) {
    console.error('✗ usage: node millwright/scripts/jira.mjs <get|comment|transitions|transition|search|whoami|create-subtask> …');
    process.exit(2);
  }
  const creds = loadCreds(); // exits 2 if incomplete
  const client = makeClient(creds);

  switch (sub) {
    case 'get': return cmdGet(client, args[0]);
    case 'comment': return cmdComment(client, args[0], args[1]);
    case 'transitions': return cmdTransitions(client, args[0]);
    case 'transition': return cmdTransition(client, args[0], args[1]);
    case 'search': return cmdSearch(client, args[0]);
    case 'whoami': return cmdWhoami(client);
    case 'create-subtask': return cmdCreateSubtask(client, args[0], args[1], args.slice(2));
    default:
      console.error(`✗ unknown subcommand "${sub}"`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`✗ ${redact(e?.message || e)}`);
  process.exit(1);
});
