// Chat with a ticket: a question the operator asks in the thread, the answer a read-only run
// writes back, and the actions an answer may suggest. One file per side per message so each has
// one writer: the panel writes chat/<id>.q.json, the /ticket-chat run writes chat/<id>.a.json.
// An answer can only ever SUGGEST an action; the operator's click runs it.

import { randomBytes } from 'node:crypto';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
export const QUESTION_MAX = 4000;
export const ID_RE = /^[0-9]{13}-[a-f0-9]{6}$/;
export const SUGGESTABLE = ['replan', 'continue', 'build', 'plan', 'review'];

export function newId(now = Date.now()) {
  return `${String(now).padStart(13, '0')}-${randomBytes(3).toString('hex')}`;
}

export function question(text, now = new Date()) {
  const t = str(text);
  if (!t) throw new Error('Ask something first.');
  if (t.length > QUESTION_MAX) throw new Error(`Keep a question under ${QUESTION_MAX} characters.`);
  return { id: newId(now.getTime()), text: t, at: now.toISOString() };
}

/** What the run wrote, cleaned: text, citations, and only suggestions the panel can run. */
export function normaliseAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = str(raw.text);
  if (!text) return null;
  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : [])
    .filter((s) => s && SUGGESTABLE.includes(s.action))
    .slice(0, 3)
    .map((s) => ({ action: s.action, label: str(s.label) || null, notes: str(s.notes).slice(0, 4000) || null, why: str(s.why) || null }));
  const citations = (Array.isArray(raw.citations) ? raw.citations : []).map(str).filter(Boolean).slice(0, 20);
  return { text, suggestions, citations, at: str(raw.at) || null };
}

/** The conversation, oldest first, from the two files per message. */
export function thread(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && ID_RE.test(e.id) && e.q)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, question: e.q, answer: normaliseAnswer(e.a), pending: !e.a, failed: e.failed || null }));
}

/** The last few exchanges, given to the run so a follow-up question has context. */
export function historyForRun(entries, max = 6) {
  return thread(entries).filter((m) => m.answer).slice(-max).map((m) => ({ q: m.question.text, a: m.answer.text }));
}
