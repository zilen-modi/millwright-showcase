// Millwright Review tab — paste a GitHub PR URL, get a code-quality review. No framework,
// no external assets; mirrors kanban.js's helpers/detail-drawer/SSE pattern (each panel
// page keeps its own small copy rather than a shared module — see the existing 4 pages).
let lastData = null;
let detailRef = null; // ref currently shown in the side drawer, or null

const live = document.getElementById('live');
const liveLabel = document.getElementById('live-label');
const tableBody = document.querySelector('#review-table tbody');
const urlInput = document.getElementById('pr-url-input');
const submitBtn = document.getElementById('pr-review-submit');
const errEl = document.getElementById('pr-review-err');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function mkBtn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toISOString().slice(0, 10);
}

// ---- untrusted-content-safe markdown (escape first, then a tiny transform) — same
// approach as kanban.js's renderMarkdown, duplicated rather than shared per that page's
// own convention. ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inlineMd(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function renderMarkdown(md) {
  if (md == null) return '<p class="muted">Not present.</p>';
  const lines = escapeHtml(md).split('\n');
  let html = '', inCode = false, inList = null; // inList: null | 'ul' | 'ol'
  // A paragraph/list-item's wrapped continuation lines arrive as separate physical
  // lines — buffer them and join with a space before emitting one <p>/<li>, instead of
  // emitting one per line (which shreds any multi-line finding into disconnected
  // one-line fragments — the actual bug this rewrite fixes).
  let buf = [];
  // Every H2 becomes a collapsible <details> wrapping everything until the next H1/H2 —
  // these reports are long, and showing headings-only by default (except a literal
  // "Summary" heading, or the first section if there is no such heading) makes the
  // default view actually short instead of a wall of text. H1 stays a plain title, not
  // a collapse boundary (it appears once, it's just the doc title).
  let sectionOpen = false;
  let anySectionSeen = false;
  const flush = () => {
    if (!buf.length) return;
    const text = inlineMd(buf.join(' '));
    html += inList ? `<li>${text}</li>` : `<p>${text}</p>`;
    buf = [];
  };
  const closeList = () => { flush(); if (inList) { html += `</${inList}>`; inList = null; } };
  const closeSection = () => { closeList(); if (sectionOpen) { html += '</details>'; sectionOpen = false; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flush();
      if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; } else { html += '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += raw + '\n'; continue; }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const headingHtml = inlineMd(h[2]);
      if (level === 1) {
        closeSection();
        html += `<h1>${headingHtml}</h1>`;
      } else if (level === 2) {
        closeSection();
        const isSummary = /summary/i.test(h[2]);
        const openAttr = isSummary || !anySectionSeen ? ' open' : '';
        html += `<details class="md-section"${openAttr}><summary>${headingHtml}</summary>`;
        sectionOpen = true;
        anySectionSeen = true;
      } else {
        closeList();
        html += `<h${level}>${headingHtml}</h${level}>`;
      }
      continue;
    }
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      flush();
      if (inList !== kind) { closeList(); html += `<${kind}>`; inList = kind; }
      buf.push((ul || ol)[1]);
      continue;
    }
    // GFM table — a `| ... |` row immediately followed by a `|---|---|` separator marks
    // the header; every `| ... |` row after that (until a blank line or non-table line)
    // is a body row. Without this, table rows have no other case to fall into above and
    // land in the generic continuation-line bucket below, which flush() joins with a
    // single space — the whole table collapses into one run-on paragraph of pipe chars.
    if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flush(); closeList();
      const headerCells = splitTableRow(trimmed);
      // Collect the body before emitting: columnWidths measures the real cell content, so the
      // colgroup cannot be written until every row is known.
      const bodyRows = [];
      i += 2; // skip header + separator, resume the loop from the first body row
      for (; i < lines.length; i++) {
        const bodyTrimmed = lines[i].trim();
        if (!isTableRow(bodyTrimmed)) break;
        bodyRows.push(splitTableRow(bodyTrimmed));
      }
      const widths = columnWidths(headerCells, bodyRows);
      const colgroup = widths ? '<colgroup>' + widths.map((w) => `<col style="width:${w}px">`).join('') + '</colgroup>' : '';
      const minWidth = widths ? widths.reduce((a, w) => a + w, 0) : 0;
      html += '<div class="table-wrap"><table' + (minWidth ? ` style="min-width:${minWidth}px"` : '') + '>'
        + colgroup + '<thead><tr>' + headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const cells of bodyRows) {
        html += '<tr>' + cells.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table></div>';
      i--; // the for-loop's own increment re-checks the line that broke us out above
      continue;
    }
    if (trimmed === '') { closeList(); continue; }
    // Continuation line — belongs to whichever paragraph/list-item is being built.
    buf.push(trimmed);
  }
  flush();
  if (inCode) html += '</code></pre>';
  closeSection();
  return html;
}
function isTableRow(line) { return /^\|.*\|$/.test(line); }
function isTableSeparator(line) { return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line); }
function splitTableRow(line) {
  // GFM lets a cell contain a literal pipe as `\|` (e.g. a quoted grep pattern) — split
  // only on pipes NOT preceded by a backslash, then unescape `\|` back to `|` per cell.
  // A naive `.split('|')` shreds any cell containing an escaped pipe into extra columns.
  return line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
/**
 * Column widths in PIXELS, measured from the column's own content. Kept in step with
 * dashboard/ui/src/lib/markdown.tsx, which is the renderer that actually serves - see the
 * long comment there for why percentages and count-based widths both fail.
 */
const PX_PER_CHAR = 6.6;
const COL_MIN_PX = 72;
const COL_MAX_PX = 340;
const PROSE_TARGET_CHARS = 52;
const TABLE_TARGET_PX = 760;

/** Rendered width of a cell, not source width: `code` fences and ** markers are not drawn. */
function plainCellText(cell) {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .trim();
}

function columnWidths(headers, rows) {
  const n = headers.length;
  if (n <= 1) return null;
  const clamp = (px) => Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, px));
  const floors = [];
  const wants = [];
  for (let c = 0; c < n; c++) {
    const cells = [headers[c], ...rows.map((r) => r[c] || '')].map(plainCellText);
    let longestWord = 0, longestCell = 0;
    for (const cell of cells) {
      longestCell = Math.max(longestCell, cell.length);
      for (const w of cell.split(/\s+/)) longestWord = Math.max(longestWord, w.length);
    }
    floors.push(clamp(longestWord * PX_PER_CHAR));
    wants.push(clamp(Math.min(longestCell, PROSE_TARGET_CHARS) * PX_PER_CHAR));
  }
  const total = wants.reduce((a, w) => a + w, 0);
  if (total <= TABLE_TARGET_PX) return wants.map(Math.round);
  const slack = wants.map((w, c) => Math.max(0, w - floors[c]));
  const slackTotal = slack.reduce((a, w) => a + w, 0);
  if (slackTotal === 0) return wants.map(Math.round);
  const shrink = Math.min(total - TABLE_TARGET_PX, slackTotal) / slackTotal;
  return wants.map((w, c) => Math.round(w - slack[c] * shrink));
}

// ---- list ----

async function fetchReviews() {
  try {
    const res = await fetch('/api/pr-reviews');
    lastData = await res.json();
    renderTable();
  } catch (e) {
    console.error('pr-reviews fetch failed', e);
  }
}

function ownerLabel(isOwn) {
  if (isOwn === true) return 'you';
  if (isOwn === false) return 'other';
  return '—';
}

function renderTable() {
  tableBody.textContent = '';
  const reviews = lastData?.reviews || [];
  if (!reviews.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'No reviews yet — paste a PR URL above.');
    td.colSpan = 5;
    tr.appendChild(td);
    tableBody.appendChild(tr);
    return;
  }
  for (const r of reviews) {
    const tr = el('tr');
    if (r.running) tr.classList.add('row-running');
    tr.addEventListener('click', () => openDetail(r.ref));

    const prTd = el('td');
    if (r.prUrl) {
      const a = el('a', null, '#' + r.ref.split('-').pop());
      a.href = r.prUrl; a.target = '_blank'; a.rel = 'noopener';
      a.addEventListener('click', (e) => e.stopPropagation());
      prTd.appendChild(a);
    } else {
      prTd.appendChild(el('span', 'muted', r.ref));
    }
    tr.appendChild(prTd);

    tr.appendChild(el('td', null, r.title || r.ref));
    tr.appendChild(el('td', 'cap', ownerLabel(r.isOwn)));

    const resultTd = el('td');
    if (r.running) resultTd.appendChild(el('span', 'pill', 'running…'));
    else if (r.result) resultTd.appendChild(el('span', 'pill', r.result));
    else resultTd.appendChild(el('span', 'muted', '—'));
    tr.appendChild(resultTd);

    tr.appendChild(el('td', 'muted', fmtDate(r.updatedAt)));
    tableBody.appendChild(tr);
  }
}

// ---- submit ----

function showErr(msg) {
  if (!msg) { errEl.hidden = true; errEl.textContent = ''; return; }
  errEl.hidden = false;
  errEl.textContent = msg;
}

async function submitReview() {
  const prUrl = urlInput.value.trim();
  showErr('');
  if (!prUrl) return showErr('Paste a PR URL first.');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/pr-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { showErr(body.error || `HTTP ${res.status}`); return; }
    urlInput.value = '';
    fetchReviews();
    openDetail(body.ref);
  } catch (e) {
    showErr(e.message);
  } finally {
    submitBtn.disabled = false;
  }
}
submitBtn.addEventListener('click', submitReview);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitReview(); });

// ---- detail drawer (JS-constructed, mirrors kanban.js's overlay pattern) ----

const overlay = el('div', 'overlay');
overlay.hidden = true;
const drawerEl = el('aside', 'detail-drawer');
overlay.appendChild(drawerEl);
document.body.appendChild(overlay);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeDetail(); });

function closeDetail() { detailRef = null; overlay.hidden = true; drawerEl.textContent = ''; }

async function openDetail(ref) {
  detailRef = ref;
  overlay.hidden = false;
  drawerEl.textContent = '';
  drawerEl.appendChild(el('div', 'muted', 'Loading ' + ref + '…'));
  let d;
  try {
    const res = await fetch('/api/pr-review?ref=' + encodeURIComponent(ref));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ('HTTP ' + res.status));
    d = await res.json();
  } catch (e) {
    if (detailRef !== ref) return;
    drawerEl.textContent = '';
    drawerEl.appendChild(el('div', 'muted', 'Failed to load: ' + e.message));
    return;
  }
  if (detailRef !== ref) return; // superseded by another open / a close
  renderDetail(d);
}

function renderDetail(d) {
  drawerEl.textContent = '';

  const bar = el('div', 'd-bar');
  const titleWrap = el('div', 'd-title-wrap');
  if (d.prUrl) {
    const a = el('a', 'd-key', d.ref);
    a.href = d.prUrl; a.target = '_blank'; a.rel = 'noopener';
    titleWrap.appendChild(a);
  } else {
    titleWrap.appendChild(el('span', 'd-key', d.ref));
  }
  titleWrap.appendChild(el('span', 'd-summary', d.title || d.ref));
  bar.appendChild(titleWrap);
  bar.appendChild(mkBtn('×', 'd-close', closeDetail));
  drawerEl.appendChild(bar);

  const meta = el('div', 'meta');
  meta.appendChild(el('span', 'pill cap', ownerLabel(d.isOwn)));
  if (d.result) meta.appendChild(el('span', 'pill', d.result));
  if (d.running) meta.appendChild(el('span', 'pill', 'running…'));
  drawerEl.appendChild(meta);

  const reviewSec = el('div', 'd-section');
  reviewSec.appendChild(el('h3', null, 'Review'));
  const reviewBody = el('div', 'md');
  reviewBody.innerHTML = renderMarkdown(d.artifacts?.review);
  reviewSec.appendChild(reviewBody);
  drawerEl.appendChild(reviewSec);

  if (d.artifacts?.quality) {
    const qSec = el('div', 'd-section');
    qSec.appendChild(el('h3', null, 'quality-inputs.json'));
    const pre = el('pre', 'pi-body');
    try { pre.textContent = JSON.stringify(JSON.parse(d.artifacts.quality), null, 2); }
    catch { pre.textContent = d.artifacts.quality; }
    qSec.appendChild(pre);
    drawerEl.appendChild(qSec);
  }

  const logSec = el('div', 'd-section');
  logSec.appendChild(el('h3', null, 'Log'));
  const logView = el('div', 'logdrawer live-log');
  logView.hidden = false;
  if (d.artifacts?.log) {
    for (const line of d.artifacts.log.split('\n')) if (line) logView.appendChild(el('span', 'l', line));
  } else {
    logView.appendChild(el('span', 'l muted', 'No log yet.'));
  }
  logSec.appendChild(logView);
  drawerEl.appendChild(logSec);
}

/** Append a live log line to the open drawer's log view, if it's open for this ref. */
function appendLog(ref, line) {
  if (detailRef !== ref) return;
  const view = drawerEl.querySelector('.live-log');
  if (!view) return;
  view.appendChild(el('span', 'l', line));
  view.scrollTop = view.scrollHeight;
}

// ---- SSE ----
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { live.classList.add('on'); liveLabel.textContent = 'live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); liveLabel.textContent = 'reconnecting…'; });
  es.addEventListener('state', () => { fetchReviews(); if (detailRef) openDetail(detailRef); });
  es.addEventListener('log', (e) => { try { const d = JSON.parse(e.data); appendLog(d.key, d.line); } catch {} });
  es.addEventListener('run-end', () => { fetchReviews(); if (detailRef) openDetail(detailRef); });
}

connect();
fetchReviews();
