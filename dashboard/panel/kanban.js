// Millwright board — live phase-kanban with manual archive, a ticket detail drawer, and a
// human-in-the-loop PLAN gate (approve → build / re-plan). No framework, no external assets.
const JIRA_BASE = 'https://acme.atlassian.net/browse/';

// Client-side state that must survive a full re-render.
const logs = new Map(); // key -> [lines]
const openDrawers = new Set(); // keys whose live-log drawer (on-card) is expanded
const collapsedCols = new Set(['archived']); // archived collapsed by default
let lastData = null;
let detailKey = null; // ticket key currently shown in the side drawer, or null

const board = document.getElementById('board');
const live = document.getElementById('live');
const liveLabel = document.getElementById('live-label');

// Mirrors dashboard/run-outcome-lib.mjs' verdict for display. These legacy pages are classic
// scripts with no module system (each re-declares its own helpers), so it is inlined per page.
function runEndText(d) {
  if (d.status === 'cancelled') return `— run ${d.mode} cancelled —`;
  const failed = d.status ? d.status !== 'success' : Number(d.code) !== 0;
  if (failed) return `— run ${d.mode} FAILED (code ${d.code}) — ${d.failure || 'see the log above'} —`;
  return `— run ${d.mode} ended (code ${d.code}) —`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function fmtMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function fmtTokens(n) { return (Number(n) || 0).toLocaleString(); }
function fmtDur(sec) { sec = Number(sec) || 0; return sec < 60 ? sec + 's' : `${Math.floor(sec / 60)}m ${sec % 60}s`; }
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toISOString().slice(0, 10);
}

// ---- untrusted-content-safe markdown (escape first, then a tiny transform) ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inlineMd(s) {
  // operates on already-escaped text — the markers only wrap safe content
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function renderMarkdown(md) {
  if (md == null) return '<p class="muted">Not present.</p>';
  const lines = escapeHtml(md).split('\n');
  let html = '', inCode = false, inList = null; // inList: null | 'ul' | 'ol'
  // A paragraph/list-item's wrapped continuation lines arrive as separate physical
  // lines — buffer them and join with a space before emitting one <p>/<li>, instead of
  // emitting one per line (which shreds any multi-line finding into disconnected
  // one-line fragments).
  let buf = [];
  // Every H2 becomes a collapsible <details> wrapping everything until the next H1/H2 —
  // these reports/plans are long, and showing headings-only by default (except a literal
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

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    lastData = await res.json();
    render();
  } catch (e) {
    console.error('state fetch failed', e);
  }
}

function render() {
  if (!lastData) return;
  const scrollLeft = board.scrollLeft;
  board.textContent = '';

  const byCol = new Map(lastData.columns.map((c) => [c.key, []]));
  for (const t of lastData.tickets) {
    if (!byCol.has(t.column)) byCol.set(t.column, []);
    byCol.get(t.column).push(t);
  }
  for (const q of lastData.queue || []) {
    byCol.get('queued')?.push({ key: q.key, summary: q.key, phase: 'queued', column: 'queued', queued: true });
  }

  for (const col of lastData.columns) {
    const cards = byCol.get(col.key) || [];
    const colEl = el('div', 'col' + (col.key === 'archived' ? ' archived' : ''));
    colEl.dataset.col = col.key;
    if (collapsedCols.has(col.key)) colEl.classList.add('collapsed');

    const head = el('div', 'col-head');
    head.appendChild(el('span', 'cdot'));
    head.appendChild(el('span', null, col.label));
    head.appendChild(el('span', 'count', String(cards.length)));
    const caret = el('span', 'caret', collapsedCols.has(col.key) ? '▸ show' : '▾ hide');
    caret.addEventListener('click', () => {
      collapsedCols.has(col.key) ? collapsedCols.delete(col.key) : collapsedCols.add(col.key);
      render();
    });
    head.appendChild(caret);
    colEl.appendChild(head);

    const cardsEl = el('div', 'cards');
    if (!cards.length) cardsEl.appendChild(el('div', 'col-empty', '—'));
    for (const t of cards) cardsEl.appendChild(renderCard(t));
    colEl.appendChild(cardsEl);
    board.appendChild(colEl);
  }
  board.scrollLeft = scrollLeft;
}

function renderCard(t) {
  const card = el('div', 'tcard' + (t.running ? ' running' : ''));
  card.dataset.key = t.key;
  card.dataset.phasecol = t.column;

  // Clicking the card body (not a button/link/log control) opens the detail drawer.
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .logtoggle, .logdrawer')) return;
    openDetail(t.key);
  });

  const top = el('div', 'top');
  const keyLink = el('a', 'key', t.key);
  keyLink.href = JIRA_BASE + t.key;
  keyLink.target = '_blank';
  keyLink.rel = 'noopener';
  top.appendChild(keyLink);
  if (t.updatedAt) top.appendChild(el('span', 'updated', fmtDate(t.updatedAt)));
  card.appendChild(top);

  card.appendChild(el('div', 'summary', t.summary || t.key));

  const meta = el('div', 'meta');
  if (t.planReady) meta.appendChild(el('span', 'pill planready', 'Plan ready — review'));
  if (t.phase) meta.appendChild(el('span', 'pill phase', t.phase));
  if (typeof t.rubricScore === 'number') meta.appendChild(el('span', 'pill rubric', 'rubric ' + t.rubricScore.toFixed(2)));
  if (t.costUsd) meta.appendChild(el('span', 'pill cost', fmtMoney(t.costUsd)));
  if (t.jiraStatus) meta.appendChild(el('span', 'pill jira', t.jiraStatus));
  if (t.prUrl) {
    const pr = el('a', 'pill', 'PR ↗');
    pr.href = t.prUrl; pr.target = '_blank'; pr.rel = 'noopener';
    meta.appendChild(pr);
  }
  card.appendChild(meta);

  const runbar = el('div', 'runbar');
  if (t.running) {
    const state = el('span', 'runstate');
    state.appendChild(el('span', 'spin'));
    state.appendChild(el('span', null, 'running…'));
    runbar.appendChild(state);
    runbar.appendChild(mkBtn('Cancel', 'run cancel', () => cancelRun(t.key)));
  } else if (t.column === 'archived') {
    runbar.appendChild(mkBtn('Unarchive', 'run', () => setArchived(t.key, false)));
  } else if (t.column === 'ship') {
    // Already shipped — open PR awaiting merge; no re-ship button.
    runbar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
  } else if (!t.queued) {
    runbar.appendChild(mkBtn('Plan', 'run', () => triggerRun(t.key, 'plan')));
    runbar.appendChild(mkBtn('Review', 'run', () => triggerRun(t.key, 'review')));
    runbar.appendChild(mkBtn('Ship', 'run ship', () => triggerRun(t.key, 'ship')));
    runbar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
  }
  card.appendChild(runbar);

  // Live logs live on the Console (/) now — link there for a running ticket instead of an on-card drawer.
  if (t.running) {
    const hint = el('a', 'loghint', 'live log in Console →');
    hint.href = '/';
    card.appendChild(hint);
  }
  return card;
}

function mkBtn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}

// ---- actions ----
async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || ('HTTP ' + res.status));
  }
  return res.json().catch(() => ({}));
}

async function triggerRun(key, mode, notes) {
  if (mode === 'ship' && !confirm('This opens a PR / writes to Jira. Continue?')) return;
  try {
    await postJson('/api/run', notes ? { key, mode, notes } : { key, mode });
    logs.set(key, logs.get(key) || []);
    openDrawers.add(key); // auto-open on-card log drawer so output is visible
    fetchState();
    if (detailKey === key) openDetail(key); // refresh the drawer's run state
  } catch (e) {
    alert('Could not start run: ' + e.message);
  }
}

async function cancelRun(key) {
  try { await postJson('/api/cancel', { key }); } catch (e) { alert('Cancel failed: ' + e.message); }
}

async function setArchived(key, archived) {
  try {
    await postJson(archived ? '/api/archive' : '/api/unarchive', { key });
    fetchState();
    if (detailKey === key) openDetail(key);
  } catch (e) {
    alert((archived ? 'Archive' : 'Unarchive') + ' failed: ' + e.message);
  }
}

// Append a log line without a full re-render (keeps the drawer scrolled to the tail).
function appendLog(key, line) {
  const arr = logs.get(key) || [];
  arr.push(line);
  logs.set(key, arr);
  for (const drawer of document.querySelectorAll(`.logdrawer[data-logkey="${CSS.escape(key)}"]`)) {
    if (!drawer.hidden) { drawer.appendChild(el('span', 'l', line)); drawer.scrollTop = drawer.scrollHeight; }
  }
}

// ---- detail drawer ----
const overlay = el('div', 'overlay');
overlay.hidden = true;
const drawerEl = el('aside', 'detail-drawer');
overlay.appendChild(drawerEl);
document.body.appendChild(overlay);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeDetail(); });

function closeDetail() { detailKey = null; overlay.hidden = true; drawerEl.textContent = ''; }

async function openDetail(key) {
  detailKey = key;
  overlay.hidden = false;
  drawerEl.textContent = '';
  drawerEl.appendChild(el('div', 'muted', 'Loading ' + key + '…'));
  let d;
  try {
    const res = await fetch('/api/ticket?key=' + encodeURIComponent(key));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ('HTTP ' + res.status));
    d = await res.json();
  } catch (e) {
    if (detailKey !== key) return;
    drawerEl.textContent = '';
    drawerEl.appendChild(el('div', 'muted', 'Failed to load: ' + e.message));
    return;
  }
  if (detailKey !== key) return; // superseded by another open / a close
  renderDetail(d);
}

function renderDetail(d) {
  drawerEl.textContent = '';

  const bar = el('div', 'd-bar');
  const titleWrap = el('div', 'd-title-wrap');
  const keyLink = el('a', 'd-key', d.key);
  keyLink.href = JIRA_BASE + d.key; keyLink.target = '_blank'; keyLink.rel = 'noopener';
  titleWrap.appendChild(keyLink);
  titleWrap.appendChild(el('span', 'd-summary', d.summary || d.key));
  bar.appendChild(titleWrap);
  bar.appendChild(mkBtn('×', 'd-close', closeDetail));
  drawerEl.appendChild(bar);

  const meta = el('div', 'meta');
  if (d.phase) meta.appendChild(el('span', 'pill phase', d.phase));
  if (typeof d.rubricScore === 'number') meta.appendChild(el('span', 'pill rubric', 'rubric ' + d.rubricScore.toFixed(2)));
  if (d.costUsd) meta.appendChild(el('span', 'pill cost', fmtMoney(d.costUsd) + ' · ' + fmtTokens(d.tokens) + ' tok'));
  if (d.jiraStatus) meta.appendChild(el('span', 'pill jira', d.jiraStatus));
  if (d.manuallyArchived) meta.appendChild(el('span', 'pill', 'archived'));
  if (d.prUrl) {
    const pr = el('a', 'pill', 'PR ↗'); pr.href = d.prUrl; pr.target = '_blank'; pr.rel = 'noopener';
    meta.appendChild(pr);
  }
  drawerEl.appendChild(meta);

  if (d.planReady) drawerEl.appendChild(renderPlanReview(d));

  // Timeline
  const tl = el('div', 'd-section');
  tl.appendChild(el('h3', null, 'Timeline'));
  if (!d.timeline.length) tl.appendChild(el('div', 'muted', 'No stage events yet.'));
  for (const r of d.timeline) {
    const row = el('div', 'tl-row');
    row.appendChild(el('span', 'tl-stage cap', r.stage));
    row.appendChild(el('span', 'tl-status s-' + r.status, r.status));
    row.appendChild(el('span', 'tl-num', fmtDur(r.durationSec)));
    row.appendChild(el('span', 'tl-num', fmtTokens(r.tokensTotal) + ' tok'));
    if (r.notes) row.appendChild(el('span', 'tl-notes', r.notes));
    tl.appendChild(row);
  }
  drawerEl.appendChild(tl);

  // Artifact tabs
  drawerEl.appendChild(renderTabs(d.artifacts));
}

function renderPlanReview(d) {
  const sec = el('div', 'd-section planreview');
  sec.appendChild(el('h3', null, 'Plan review — awaiting your decision'));
  const body = el('div', 'md');
  body.innerHTML = renderMarkdown(d.artifacts.plan); // plan is HTML-escaped inside renderMarkdown
  sec.appendChild(body);

  const actions = el('div', 'pr-actions');
  actions.appendChild(mkBtn('Approve & Build', 'run approve', () => triggerRun(d.key, 'build')));
  const fb = el('div', 'replan-fb');
  fb.hidden = true;
  actions.appendChild(mkBtn('Re-plan', 'run', () => { fb.hidden = !fb.hidden; }));
  sec.appendChild(actions);

  const ta = el('textarea', 'replan-notes');
  ta.placeholder = 'Optional feedback for the re-plan (saved to resume-notes.md; never passed on the command line)…';
  fb.appendChild(ta);
  fb.appendChild(mkBtn('Submit re-plan', 'run', () => triggerRun(d.key, 'replan', ta.value.trim() || undefined)));
  sec.appendChild(fb);
  return sec;
}

function renderTabs(artifacts) {
  const tabs = [
    ['Plan', artifacts.plan], ['Design', artifacts.design], ['Context', artifacts.context],
    ['Review', artifacts.review], ['Ticket', artifacts.ticket],
  ];
  const sec = el('div', 'd-section');
  const bar = el('div', 'tabbar');
  const body = el('div', 'md tabbody');
  tabs.forEach(([label, content], i) => {
    const btn = el('button', 'tab' + (i === 0 ? ' active' : ''), label);
    if (content == null) btn.classList.add('empty');
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      body.innerHTML = renderMarkdown(content);
    });
    bar.appendChild(btn);
  });
  body.innerHTML = renderMarkdown(tabs[0][1]);
  sec.appendChild(bar);
  sec.appendChild(body);
  return sec;
}

// ---- launcher + active runs ----
const tktInput = document.getElementById('tkt-input');
const tktErr = document.getElementById('tkt-err');
const modeSeg = document.getElementById('mode-seg');
const startBtn = document.getElementById('start-btn');
const activeRunsEl = document.getElementById('activeruns');
const activeRuns = new Map(); // key -> { mode, ended, code }
const openArun = new Set();   // keys whose active-run log drawer is expanded
let launchMode = 'plan';

modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  launchMode = b.dataset.mode;
  modeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
});

// Accept a bare key or any string containing one (e.g. a Jira URL). Server re-validates.
function parseKey(raw) {
  const m = String(raw || '').match(/PROJ-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

async function launch() {
  const key = parseKey(tktInput.value);
  if (!key) { tktErr.textContent = 'Enter a ticket key like PROJ-1234, or paste a Jira URL.'; tktErr.hidden = false; return; }
  tktErr.hidden = true;
  try {
    await postJson('/api/run', { key, mode: launchMode });
    logs.set(key, logs.get(key) || []);
    activeRuns.set(key, { mode: launchMode, ended: false, code: null });
    openArun.add(key);
    tktInput.value = '';
    renderActiveRuns();
    fetchState();
  } catch (e) {
    tktErr.textContent = 'Could not start: ' + e.message; tktErr.hidden = false;
  }
}
startBtn.addEventListener('click', launch);
tktInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });

function renderActiveRuns() {
  activeRunsEl.textContent = '';
  for (const [key, info] of activeRuns) {
    const row = el('div', 'arun');
    const head = el('div', 'arun-head');
    if (!info.ended) head.appendChild(el('span', 'spin'));
    head.appendChild(el('span', 'arun-key', key));
    head.appendChild(el('span', 'arun-mode', info.ended ? `${info.mode} · ended (${info.code})` : info.mode));
    const toggle = el('span', 'arun-toggle', (openArun.has(key) ? '▾ ' : '▸ ') + 'log');
    const dismiss = el('span', 'arun-dismiss', '×');
    head.appendChild(toggle);
    head.appendChild(dismiss);
    row.appendChild(head);

    const drawer = el('div', 'logdrawer');
    drawer.dataset.logkey = key;
    drawer.hidden = !openArun.has(key);
    for (const line of logs.get(key) || []) drawer.appendChild(el('span', 'l', line));
    row.appendChild(drawer);

    toggle.addEventListener('click', () => {
      const open = drawer.hidden; drawer.hidden = !open;
      open ? openArun.add(key) : openArun.delete(key);
      toggle.textContent = (open ? '▾ ' : '▸ ') + 'log';
      if (open) requestAnimationFrame(() => { drawer.scrollTop = drawer.scrollHeight; });
    });
    dismiss.addEventListener('click', () => { activeRuns.delete(key); openArun.delete(key); renderActiveRuns(); });

    activeRunsEl.appendChild(row);
    if (openArun.has(key)) requestAnimationFrame(() => { drawer.scrollTop = drawer.scrollHeight; });
  }
}

// ---- SSE ----
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { live.classList.add('on'); liveLabel.textContent = 'live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); liveLabel.textContent = 'reconnecting…'; });
  es.addEventListener('state', () => { fetchState(); if (detailKey) openDetail(detailKey); });
  es.addEventListener('log', (e) => { try { const d = JSON.parse(e.data); appendLog(d.key, d.line); } catch {} });
  es.addEventListener('run-end', (e) => {
    let d = null;
    // `code` is not the verdict — a run whose slash command didn't resolve exits 0 having done
    // nothing. `status`/`failure` come from the server's evidence-based check.
    try { d = JSON.parse(e.data); appendLog(d.key, runEndText(d)); } catch {}
    if (d && activeRuns.has(d.key)) { const r = activeRuns.get(d.key); r.ended = true; r.code = d.code; renderActiveRuns(); }
    fetchState();
    if (detailKey) openDetail(detailKey);
  });
}

connect();
fetchState();
