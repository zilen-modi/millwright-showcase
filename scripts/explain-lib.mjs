// Plain-language explainers ("explain this like I'm new here"): which subject a request names,
// the folder it lives in, and the standalone HTML page it exports to. Pure, so the rules that
// decide what reaches a path or a spawned prompt are tested without a server.

import { parsePrRef, prRefId, prUrlFromRef } from './pr-ref-lib.mjs';

const KEY_RE = /^PROJ-\d+$/i;
// Letters (any script), digits, spaces and a little punctuation. Nothing that reads as a path,
// a flag or a shell metacharacter - the slug, never this text, is what reaches argv.
const TOPIC_RE = /^[\p{L}\p{N}][\p{L}\p{N} '&/.,()?!:-]*$/u;
export const TOPIC_MAX = 120;
export const SLUG_RE = /^(?:proj-\d+|pr-[a-z0-9._-]+|topic-[a-z0-9-]+)$/;

/**
 * What the operator asked to explain: a ticket key, a GitHub PR url, or a topic in words.
 * Returns {type, id, slug, label} or {error}.
 */
export function parseSubject(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return { error: 'Say what to explain: a ticket key, a PR link or a topic.' };
  const key = text.match(/PROJ-\d+/i)?.[0];
  if (key && (KEY_RE.test(text) || /atlassian\.net\/browse\//i.test(text))) {
    const k = key.toUpperCase();
    return { type: 'ticket', id: k, slug: k.toLowerCase(), label: k };
  }
  if (/^https?:\/\//i.test(text)) {
    const pr = parsePrRef(text);
    if (!pr) return { error: 'That link is not a GitHub pull request or a Jira ticket.' };
    return { type: 'pr', id: prUrlFromRef(pr), slug: `pr-${prRefId(pr).toLowerCase()}`, label: `${pr.repo}#${pr.number}` };
  }
  if (text.length > TOPIC_MAX) return { error: `Keep the topic under ${TOPIC_MAX} characters.` };
  if (!TOPIC_RE.test(text)) return { error: 'Use words for a topic - letters, numbers and spaces.' };
  const kebab = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  if (!kebab) return { error: 'Use words for a topic - letters, numbers and spaces.' };
  return { type: 'topic', id: text, slug: `topic-${kebab}`, label: text };
}

export const isSlug = (s) => typeof s === 'string' && s.length <= 90 && SLUG_RE.test(s);

// ---- standalone HTML export ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Inline markdown on already-escaped text: `code`, **bold**, *italic*, [text](https?://url). */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
}

/** A small, escaping markdown renderer: headings, paragraphs, lists, tables, code fences,
 * quotes. Everything that is not markup is escaped, so the page can never run script. */
export function markdownToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '')));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${t}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** The "Save page" artifact: one self-contained HTML file, no external requests, readable in
 * light and dark, printable. */
export function renderExplainerHtml({ title, markdown, subject, generatedAt }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--surface:#fff;--text:#111827;--text2:#374151;--muted:#6b7280;--border:#e3e7ed;--accent:#2f5bea;--soft:#eef2ff;--code:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#161a21;--text:#e9edf3;--text2:#c6ccd6;--muted:#8b94a3;--border:#262c37;--accent:#7c9bff;--soft:#1b2440;--code:#1c212a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 64px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px 36px}
.eyebrow{color:var(--muted);font-size:13px;margin:0 0 6px}
h1{font-size:30px;line-height:1.2;margin:0 0 6px;letter-spacing:-.015em}
h2{font-size:21px;margin:30px 0 8px;padding-top:18px;border-top:1px solid var(--border)}
h3{font-size:17px;margin:18px 0 6px}
h4{font-size:15px;margin:14px 0 4px}
p,li{color:var(--text2)}
code{font:13.5px ui-monospace,"SF Mono",Menlo,monospace;background:var(--code);border-radius:6px;padding:1px 6px;color:var(--accent)}
pre{background:var(--code);border-radius:10px;padding:12px 14px;overflow-x:auto}
pre code{background:none;padding:0;color:var(--text)}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:15px}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--code)}
blockquote{margin:12px 0;padding:10px 14px;background:var(--soft);border-radius:10px;color:var(--text)}
a{color:var(--accent)}
footer{color:var(--muted);font-size:13px;margin-top:18px;text-align:center}
@media (max-width:600px){.card{padding:22px 18px}h1{font-size:25px}}
@media print{body{background:#fff}.card{border:0;padding:0}}
</style>
</head>
<body>
<main>
<div class="card">
<p class="eyebrow">Explained simply${subject ? ` · ${esc(subject)}` : ''}</p>
<h1>${esc(title)}</h1>
${markdownToHtml(String(markdown ?? '').replace(/^#\s+.*\n/, ''))}
</div>
<footer>Written ${esc(String(generatedAt || '').slice(0, 10))} from the legacy ERP's code (via Atlas) and the new ERP's repositories.</footer>
</main>
</body>
</html>
`;
}
