// Reviewing a plan step by step instead of as one wall of markdown: the plan split into its
// headed blocks, comments pinned to a block, the re-plan notes those comments become, a diff
// between plan versions, and the questions the planner asks before it writes. Pure; the panel
// owns tickets/<KEY>/plan-review.json and plans/v<n>.md, the pipeline owns plan.md.

import { createHash } from 'node:crypto';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
export const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);
const slug = (s) => str(s).toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section';

/**
 * The plan as blocks, one per `##` / `###` heading. A block's id is the slug path of its
 * headings, so a comment on "frontend > Step 3: wire the modal" still finds its block after a
 * re-plan that keeps the heading. Text before the first heading is the `intro` block.
 */
export function splitPlan(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let h2 = null;
  let cur = { id: 'intro', level: 1, title: 'Introduction', path: [], body: [] };
  const seen = new Map();
  const push = () => {
    const body = cur.body.join('\n').trim();
    if (body || cur.level > 1) blocks.push({ ...cur, body, kind: kindOf(cur.title, h2) });
  };
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{2,3})\s+(.*)$/);
    if (!m) { cur.body.push(line); continue; }
    push();
    const level = m[1].length;
    const title = m[2].trim();
    if (level === 2) h2 = title;
    const path = level === 2 ? [title] : [h2 || '', title];
    let id = path.filter(Boolean).map(slug).join('--');
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    cur = { id, level, title, path, body: [] };
  }
  push();
  return blocks;
}

function kindOf(title, parent) {
  const t = `${parent || ''} ${title}`.toLowerCase();
  if (/summary/.test(title.toLowerCase())) return 'summary';
  if (/acceptance|ac[- ]coverage|\bacs?\b/.test(t)) return 'ac';
  if (/parity|legacy/.test(t)) return 'parity';
  if (/question/.test(t)) return 'questions';
  if (/risk/.test(t)) return 'risk';
  if (/test/.test(t)) return 'tests';
  return /step|file|change/.test(t) ? 'step' : 'section';
}

/** `- [ ] AC1 ...` / `- [x] ...` lines anywhere in the plan, for the approval checklist. */
export function checklist(md) {
  return String(md ?? '').split('\n').map((l) => l.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ done: m[1] !== ' ', text: m[2].trim() }));
}

// ---- comments ----

/** tickets/<KEY>/plan-review.json: {comments: [{id, blockId, blockTitle, text, at, sentAt, sentInVersion, resolved}]} */
export function normaliseReview(raw) {
  const comments = (Array.isArray(raw?.comments) ? raw.comments : []).filter((c) => c && str(c.id) && str(c.text)).map((c) => ({
    id: str(c.id), blockId: str(c.blockId), blockTitle: str(c.blockTitle), text: str(c.text), at: str(c.at) || null,
    sentAt: str(c.sentAt) || null, sentInVersion: Number.isInteger(c.sentInVersion) ? c.sentInVersion : null, resolved: c.resolved === true,
  }));
  return { comments };
}

export const COMMENT_MAX = 2000;

export function addComment(raw, { blockId, blockTitle, text }, now = new Date()) {
  const r = normaliseReview(raw);
  const t = str(text);
  if (!t) throw new Error('the comment is empty');
  if (t.length > COMMENT_MAX) throw new Error(`keep a comment under ${COMMENT_MAX} characters`);
  const id = sha(`${blockId}|${t}|${now.toISOString()}`).slice(0, 10);
  return { comments: [...r.comments, { id, blockId: str(blockId) || 'intro', blockTitle: str(blockTitle), text: t, at: now.toISOString(), sentAt: null, sentInVersion: null, resolved: false }] };
}

export function updateComment(raw, id, patch) {
  const r = normaliseReview(raw);
  if (!r.comments.some((c) => c.id === id)) throw new Error(`no comment ${id}`);
  if (patch.delete) return { comments: r.comments.filter((c) => c.id !== id) };
  return {
    comments: r.comments.map((c) => (c.id !== id ? c : {
      ...c,
      ...(patch.text !== undefined ? { text: str(patch.text) } : {}),
      ...(patch.resolved !== undefined ? { resolved: !!patch.resolved } : {}),
    })),
  };
}

/** Comments still to act on: not resolved and not yet sent with a re-plan. */
export const openComments = (raw) => normaliseReview(raw).comments.filter((c) => !c.resolved && !c.sentAt);

/** The re-plan notes the open comments become, each tied to the step it is about. */
export function replanNotes(raw, extra = '') {
  const open = openComments(raw);
  const parts = open.map((c) => `- On "${c.blockTitle || c.blockId}": ${c.text}`);
  const tail = str(extra);
  if (!parts.length && !tail) return '';
  return [
    'Re-plan with these review comments on the current plan. Change only what they ask for and keep every other step as it is.',
    ...parts,
    ...(tail ? ['', tail] : []),
  ].join('\n');
}

export function markSent(raw, version, now = new Date()) {
  const r = normaliseReview(raw);
  return { comments: r.comments.map((c) => (c.resolved || c.sentAt ? c : { ...c, sentAt: now.toISOString(), sentInVersion: version })) };
}

// ---- versions ----

/** Whether plan.md is a new version, given the shas already saved. */
export function nextVersion(savedShas, md) {
  const s = sha(md);
  if (!str(md)) return null;
  const i = savedShas.indexOf(s);
  return i === -1 ? { version: savedShas.length + 1, sha: s, isNew: true } : { version: i + 1, sha: s, isNew: false };
}

/** Line diff (LCS). Plans are a few hundred lines, so O(n*m) is fine; above that it falls back
 * to "everything changed" rather than stalling the server. */
export function lineDiff(a, b, limit = 2_000_000) {
  const x = String(a ?? '').split('\n');
  const y = String(b ?? '').split('\n');
  if (x.length * y.length > limit) return [...x.map((t) => ({ type: 'del', text: t })), ...y.map((t) => ({ type: 'add', text: t }))];
  const n = x.length; const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ type: 'same', text: x[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: x[i] }); i += 1; }
    else { out.push({ type: 'add', text: y[j] }); j += 1; }
  }
  while (i < n) out.push({ type: 'del', text: x[i++] });
  while (j < m) out.push({ type: 'add', text: y[j++] });
  return out;
}

/** Which blocks changed between two versions, by id - for "changed since v1" badges. */
export function changedBlocks(prevMd, nextMd) {
  const prev = new Map(splitPlan(prevMd).map((b) => [b.id, b.body]));
  const out = { added: [], changed: [], removed: [] };
  const nextIds = new Set();
  for (const b of splitPlan(nextMd)) {
    nextIds.add(b.id);
    if (!prev.has(b.id)) out.added.push(b.id);
    else if (prev.get(b.id) !== b.body) out.changed.push(b.id);
  }
  for (const id of prev.keys()) if (!nextIds.has(id)) out.removed.push(id);
  return out;
}

// ---- planner questions ----

/** tickets/<KEY>/questions.json, written by the PLAN stage when it needs a person:
 * {questions: [{id, question, why?, options?: [string]}]} */
export function normaliseQuestions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : [];
  return list.filter((q) => q && str(q.question)).slice(0, 12).map((q, i) => ({
    id: str(q.id) || `Q${i + 1}`,
    question: str(q.question),
    why: str(q.why) || null,
    options: Array.isArray(q.options) ? q.options.map(str).filter(Boolean).slice(0, 6) : [],
  }));
}

export const ANSWER_MAX = 2000;

/** Answers keyed by question id -> the answers.json the next PLAN run reads, plus notes text. */
export function answersFile(questions, answers, now = new Date()) {
  const qs = normaliseQuestions(questions);
  const out = [];
  for (const q of qs) {
    const a = str(answers?.[q.id]);
    if (a.length > ANSWER_MAX) throw new Error(`keep each answer under ${ANSWER_MAX} characters`);
    if (a) out.push({ id: q.id, question: q.question, answer: a });
  }
  if (!out.length) throw new Error('answer at least one question');
  const notes = ['Answers to the planning questions:', ...out.map((x) => `- ${x.question}\n  Answer: ${x.answer}`)].join('\n');
  return { file: { at: now.toISOString(), answers: out }, notes, unanswered: qs.filter((q) => !str(answers?.[q.id])).map((q) => q.id) };
}
