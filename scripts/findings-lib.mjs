// Structured PR-review findings: the contract between the /review-pr run, the finding
// verifier and the panel's triage + "post as one GitHub review" flow.
//
// Three files, one writer each, all under pr-reviews/<ref>/:
//   findings.json  - the review run (what it found, with file:line evidence)
//   verdicts.json  - the review run, from the read-only verifier's answers (refute or confirm)
//   triage.json    - the panel only (the operator's accept / park / reject, keyed by fingerprint)
// A re-review starts a new round: the panel moves the last round's findings + verdicts into
// rounds/<n>/ (so a verdict can never attach to the next round's renumbered F1) and hands the
// run previous-findings.json. The run links a finding to its earlier self with `carriesOver`,
// which is how a decision or a post survives the author moving the code.
// Everything here is pure so the rules that decide what reaches GitHub are testable offline.

import { createHash } from 'node:crypto';

import { scrubInternals } from './review-comment-lib.mjs';

export const SEVERITIES = ['high', 'medium', 'low'];
export const DECISIONS = ['accept', 'park', 'reject'];
export const VERDICTS = ['confirmed', 'refuted', 'uncertain'];
const KINDS = ['issue', 'question'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function cleanPath(p) {
  return str(p).replace(/^\.\//, '').replace(/^[ab]\//, '');
}

function normaliseEvidence(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const e of list) {
    if (typeof e === 'string') {
      // "src/a.ts:42" is how agents write it when they forget the object shape.
      const m = e.match(/^(.+?):(\d+)(?:-\d+)?$/);
      if (m) out.push({ file: cleanPath(m[1]), line: Number(m[2]), note: '' });
      continue;
    }
    const file = cleanPath(e?.file ?? e?.path);
    const line = Number(e?.line);
    if (file && Number.isInteger(line) && line > 0) out.push({ file, line, note: str(e?.note) });
  }
  return out;
}

/** A finding's identity across re-runs: the same claim at the same place keeps its triage
 * decision even when the run renumbers its ids. */
export function fingerprint(f) {
  const at = f.evidence?.[0] ? `${f.evidence[0].file}:${f.evidence[0].line}` : '';
  return createHash('sha256').update(`${str(f.title).toLowerCase()}|${at}`).digest('hex').slice(0, 16);
}

/** Read findings.json leniently: it is written by an agent, so a malformed entry is dropped
 * with a warning instead of hiding every other finding. */
export function normaliseFindings(raw) {
  const warnings = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : null;
  if (!list) return { headSha: null, findings: [], warnings: ['findings.json has no findings array'] };
  const findings = [];
  const seen = new Set();
  list.forEach((f, i) => {
    const title = str(f?.title);
    const severity = str(f?.severity).toLowerCase();
    if (!title) { warnings.push(`finding ${i + 1} has no title and was skipped`); return; }
    if (!SEVERITIES.includes(severity)) { warnings.push(`"${title}" has severity "${f?.severity}" and was skipped`); return; }
    let id = str(f?.id) || `F${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const finding = {
      id,
      severity,
      axis: str(f?.axis).toLowerCase() || 'standards',
      kind: KINDS.includes(str(f?.kind).toLowerCase()) ? str(f.kind).toLowerCase() : 'issue',
      title,
      body: str(f?.body),
      fix: str(f?.fix),
      blocking: f?.blocking === true,
      evidence: normaliseEvidence(f?.evidence),
      carriesOver: str(f?.carriesOver) || null,
      demoted: null,
    };
    // The evidence rule: a finding that would block a merge must point at a line. Without one
    // it is a question for the author, not a defect.
    if (finding.kind === 'issue' && (finding.blocking || severity === 'high') && !finding.evidence.length) {
      finding.kind = 'question';
      finding.blocking = false;
      finding.demoted = 'no file:line evidence, so it is asked as a question';
    }
    finding.fingerprint = fingerprint(finding);
    findings.push(finding);
  });
  const resolved = (Array.isArray(raw?.resolved) ? raw.resolved : [])
    .map((r) => ({ fingerprint: str(r?.fingerprint), status: str(r?.status).toLowerCase(), reason: str(r?.reason) }))
    .filter((r) => r.fingerprint);
  return { headSha: str(raw?.headSha) || null, findings, resolved, warnings };
}

const sameProblem = (a, b) => {
  const t = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return t(a.title) === t(b.title) && (a.evidence[0]?.file || '') === (b.evidence[0]?.file || '');
};



/** verdicts.json as {id: {verdict, reason}} or {verdicts: [{id, verdict, reason}]}. */
export function normaliseVerdicts(raw) {
  const out = new Map();
  const list = Array.isArray(raw?.verdicts) ? raw.verdicts
    : Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' ? Object.entries(raw).map(([id, v]) => ({ id, ...(v || {}) }))
    : [];
  for (const v of list) {
    const id = str(v?.id);
    const verdict = str(v?.verdict).toLowerCase();
    if (id && VERDICTS.includes(verdict)) out.set(id, { verdict, reason: str(v?.reason) });
  }
  return out;
}

/** triage.json is {entries: {<fingerprint>: {decision?, body?, posted?: {at, url}, at}}}. */
export function normaliseTriage(raw) {
  const out = new Map();
  for (const [fp, e] of Object.entries(raw?.entries || {})) {
    const decision = DECISIONS.includes(e?.decision) ? e.decision : null;
    const body = str(e?.body) || null;
    const posted = e?.posted && typeof e.posted === 'object' ? { at: str(e.posted.at) || null, url: str(e.posted.url) || null } : null;
    if (decision || body || posted) out.set(fp, { decision, body, posted, at: str(e?.at) || null });
  }
  return out;
}

const RESOLVED_STATUSES = ['fixed', 'no-longer-applies'];

/**
 * The rows the panel shows: findings + verifier verdict + the operator's decision. A refuted
 * finding is folded away, never deleted - the operator can still open and accept it.
 *
 * With `previous` (the last round's findings.json) a re-review also says what changed: each
 * row is `new` or `still-open`, a still-open row inherits the earlier decision, wording and
 * posted state, and every earlier finding not raised again lands in `resolved`.
 */
export function buildRows({ findings: findingsRaw, verdicts: verdictsRaw, triage: triageRaw, previous: previousRaw = null }) {
  const { headSha, findings, resolved: resolvedNotes, warnings } = normaliseFindings(findingsRaw);
  const verdicts = normaliseVerdicts(verdictsRaw);
  const triage = normaliseTriage(triageRaw);
  const prev = previousRaw ? normaliseFindings(previousRaw).findings : null;
  const prevByFp = new Map((prev || []).map((p) => [p.fingerprint, p]));
  const claimed = new Set();

  const order = (r) => (r.folded ? 10 : 0) + SEVERITIES.indexOf(r.severity) + (r.kind === 'question' ? 0.5 : 0);
  const rows = findings.map((f) => {
    let carriedFrom = null;
    if (prev) {
      if (f.carriesOver && prevByFp.has(f.carriesOver) && !claimed.has(f.carriesOver)) carriedFrom = f.carriesOver;
      else carriedFrom = prev.find((p) => !claimed.has(p.fingerprint) && sameProblem(p, f))?.fingerprint || null;
      if (carriedFrom) claimed.add(carriedFrom);
    }
    const v = verdicts.get(f.id);
    const own = triage.get(f.fingerprint);
    const inh = carriedFrom ? triage.get(carriedFrom) : null;
    return {
      ...f,
      verdict: v?.verdict || 'unverified',
      verdictReason: v?.reason || '',
      folded: v?.verdict === 'refuted',
      since: prev ? (carriedFrom ? 'still-open' : 'new') : null,
      carriedFrom,
      decision: own?.decision || inh?.decision || null,
      decisionInherited: !own?.decision && !!inh?.decision,
      editedBody: own?.body || inh?.body || null,
      posted: own?.posted || inh?.posted || null,
    };
  }).sort((a, b) => order(a) - order(b));

  const notes = new Map(resolvedNotes.map((r) => [r.fingerprint, r]));
  const resolved = (prev || []).filter((p) => !claimed.has(p.fingerprint)).map((p) => {
    const n = notes.get(p.fingerprint);
    const t = triage.get(p.fingerprint);
    return {
      fingerprint: p.fingerprint,
      title: p.title,
      severity: p.severity,
      evidence: p.evidence,
      // Only the run's own word counts as "fixed"; silence is just "not raised again".
      status: n && RESOLVED_STATUSES.includes(n.status) ? n.status : 'not-raised',
      reason: n?.reason || '',
      decision: t?.decision || null,
      posted: t?.posted || null,
    };
  });

  const counts = { total: rows.length, folded: rows.filter((r) => r.folded).length, undecided: 0 };
  for (const d of DECISIONS) counts[d] = rows.filter((r) => r.decision === d).length;
  counts.undecided = rows.filter((r) => !r.decision && !r.folded).length;
  counts.posted = rows.filter((r) => r.posted).length;
  counts.toPost = rows.filter((r) => r.decision === 'accept' && !r.posted).length;
  counts.new = rows.filter((r) => r.since === 'new').length;
  counts.resolved = resolved.length;
  return { headSha, rows, resolved, warnings, counts };
}

/** Apply one triage change, returning the new triage.json content. `decision: null` clears it. */
export function setTriage(triageRaw, fp, { decision, body, posted } = {}, at = new Date().toISOString()) {
  const entries = { ...(triageRaw?.entries || {}) };
  const prev = entries[fp] || {};
  const next = { ...prev, at };
  if (decision !== undefined) {
    if (decision === null) delete next.decision;
    else if (DECISIONS.includes(decision)) next.decision = decision;
    else throw new Error(`decision must be one of ${DECISIONS.join(', ')} or null`);
  }
  if (body !== undefined) {
    if (str(body)) next.body = str(body);
    else delete next.body;
  }
  if (posted !== undefined) next.posted = posted;
  if (!next.decision && !next.body && !next.posted) delete entries[fp];
  else entries[fp] = next;
  return { version: 1, entries };
}

/** Before a round is archived: write every inherited decision, wording and posted mark under the
 * row's own fingerprint, so the next round can carry it on from this one rather than needing
 * to see every round back to the first. */
export function settleInherited(rowsState, triageRaw) {
  let triage = triageRaw || { version: 1, entries: {} };
  const own = normaliseTriage(triageRaw);
  for (const r of rowsState?.rows || []) {
    const mine = own.get(r.fingerprint);
    const change = {};
    if (r.decision && !mine?.decision) change.decision = r.decision;
    if (r.editedBody && !mine?.body) change.body = r.editedBody;
    if (r.posted && !mine?.posted) change.posted = r.posted;
    if (Object.keys(change).length) triage = setTriage(triage, r.fingerprint, change, mine?.at || undefined);
  }
  return triage;
}

/** What the run is told about the last round: enough to link, not the whole report. */
export function previousForRun(rowsState, round) {
  return {
    round,
    headSha: rowsState?.headSha || null,
    findings: (rowsState?.rows || []).map((r) => ({
      fingerprint: r.fingerprint,
      severity: r.severity,
      kind: r.kind,
      title: r.title,
      evidence: r.evidence.map((e) => `${e.file}:${e.line}`),
      verdict: r.verdict,
      decision: r.decision,
      posted: !!r.posted,
    })),
  };
}

/** Lines a review comment may sit on: the right-hand side of each hunk (added or context
 * lines). GitHub rejects the whole review with a 422 if any comment is outside these. */
export function rightSideLines(diff) {
  const map = new Map();
  let file = null;
  let right = 0;
  let inHunk = false;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : cleanPath(p);
      if (file && !map.has(file)) map.set(file, new Set());
      inHunk = false;
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { right = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || !file) continue;
    if (line.startsWith('+') || line.startsWith(' ')) { map.get(file).add(right); right += 1; }
  }
  return map;
}

/** Match an evidence path to a diff path: exact, else the one diff path it is a suffix of. */
function resolveDiffPath(commentable, file) {
  if (commentable.has(file)) return file;
  const hits = [...commentable.keys()].filter((p) => p.endsWith(`/${file}`));
  return hits.length === 1 ? hits[0] : null;
}

/** The text a finding is posted as - the operator's own wording when they edited it. */
export function findingText(row) {
  if (row.editedBody) return row.editedBody;
  if (row.kind === 'question') return [`**Question:** ${row.title}`, row.body].filter(Boolean).join('\n\n');
  return [`**${row.title}**`, row.body, row.fix ? `Suggested: ${row.fix}` : ''].filter(Boolean).join('\n\n');
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Accepted and not already on the PR - a finding posted in an earlier round stays posted. */
const toPost = (r) => r.decision === 'accept' && !r.posted;

/** What the accepted set is, independent of the diff: the preview and the post must agree on it. */
export function acceptedSha(rows) {
  const accepted = rows.filter(toPost)
    .map((r) => [r.fingerprint, findingText(r)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify(accepted));
}

/**
 * Build the GitHub review for the accepted findings. Each one goes inline at its first piece
 * of evidence that sits on the diff; the rest are listed in the review body with their
 * file:line. `commentable` null (the PR moved since it was reviewed) puts everything in the body.
 * The event is always COMMENT: approving or requesting changes stays a human act on GitHub.
 */
export function buildReviewPayload({ rows, commentable, commitId, summary }) {
  const accepted = rows.filter(toPost);
  const unresolved = [];
  const scrub = (text, where) => {
    const s = scrubInternals(text);
    for (const u of s.unresolved) unresolved.push({ where, line: u.line, hit: u.hit });
    return s.text;
  };
  const comments = [];
  const inBody = [];
  for (const r of accepted) {
    const text = scrub(findingText(r), r.title);
    let anchor = null;
    if (commentable) {
      for (const e of r.evidence) {
        const path = resolveDiffPath(commentable, e.file);
        if (path && commentable.get(path).has(e.line)) { anchor = { path, line: e.line }; break; }
      }
    }
    if (anchor) comments.push({ path: anchor.path, line: anchor.line, side: 'RIGHT', body: text, id: r.id });
    else inBody.push({ id: r.id, text, at: r.evidence[0] ? `${r.evidence[0].file}:${r.evidence[0].line}` : null });
  }
  const intro = str(summary) || (accepted.length ? 'A few things worth a look before merge.' : '');
  const listed = inBody.map((b) => {
    const [first, ...rest] = b.text.split('\n');
    const lead = b.at ? `${first} (\`${b.at}\`)` : first;
    return [`- ${lead}`, ...rest.filter((l) => l.trim()).map((l) => `  ${l}`)].join('\n');
  });
  const body = scrub([intro, listed.length ? listed.join('\n') : ''].filter(Boolean).join('\n\n'), 'summary');
  return {
    payload: {
      ...(commitId ? { commit_id: commitId } : {}),
      event: 'COMMENT',
      body,
      comments: comments.map(({ path, line, side, body: b }) => ({ path, line, side, body: b })),
    },
    inline: comments.map((c) => ({ id: c.id, path: c.path, line: c.line, body: c.body })),
    inBody: inBody.map((b) => ({ id: b.id, at: b.at, body: b.text })),
    fingerprints: accepted.map((r) => r.fingerprint),
    acceptedCount: accepted.length,
    acceptedSha: acceptedSha(rows),
    unresolved,
  };
}
