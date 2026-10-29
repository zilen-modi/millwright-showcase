// Millwright cost page — /api/cost KPIs, per-ticket + per-stage tables, budget bars.
// Refreshes live off the same SSE stream the board uses.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
function tokens(n) { return (Number(n) || 0).toLocaleString(); }
function dur(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s`;
}

const live = document.getElementById('live');
const liveLabel = document.getElementById('live-label');

let lastTickets = [];
let lastPrReviews = [];

const ticketFilterInput = document.getElementById('ticket-filter');
const ticketStatusFilter = document.getElementById('ticket-status-filter');
const prFilterInput = document.getElementById('pr-filter');
const prOwnerFilter = document.getElementById('pr-owner-filter');

async function load() {
  let data;
  try {
    const res = await fetch('/api/cost');
    data = await res.json();
  } catch (e) {
    console.error('cost fetch failed', e);
    return;
  }
  lastTickets = data.tickets || [];
  lastPrReviews = data.prReviews || [];
  renderKpis(data);
  populateTicketStatusOptions(lastTickets);
  renderTickets();
  renderPrReviews();
  renderStages(data.stages || []);
  renderBudget(data.budget || {});
}

function renderKpis(d) {
  const cap = d.budget && d.budget.capPerTicket;
  const prTotals = d.prReviewTotals || { cost: 0, tokens: 0, count: 0 };
  const kpis = [
    ['Total cost', money(d.totals.cost)],
    ['Total tokens', tokens(d.totals.tokens)],
    ['Tickets', String(d.totals.tickets)],
    ['Budget cap / ticket', cap ? money(cap) : '—'],
    ['PR review cost', money(prTotals.cost)],
    ['PR reviews', String(prTotals.count)],
  ];
  const wrap = document.getElementById('kpis');
  wrap.textContent = '';
  for (const [label, val] of kpis) {
    const k = el('div', 'kpi');
    k.appendChild(el('div', 'label', label));
    k.appendChild(el('div', 'val', val));
    wrap.appendChild(k);
  }
}

/** Rebuild the status filter's options from whatever statuses are actually present,
 * preserving the current selection when it's still a valid option. */
function populateTicketStatusOptions(tickets) {
  const statuses = [...new Set(tickets.map((t) => t.jiraStatus || t.status).filter(Boolean))].sort();
  const current = ticketStatusFilter.value;
  ticketStatusFilter.textContent = '';
  ticketStatusFilter.appendChild(new Option('All statuses', ''));
  ticketStatusFilter.appendChild(new Option('Running', '__running__'));
  for (const s of statuses) ticketStatusFilter.appendChild(new Option(s, s));
  if ([...ticketStatusFilter.options].some((o) => o.value === current)) ticketStatusFilter.value = current;
}

function renderTickets() {
  const tb = document.querySelector('#ticket-table tbody');
  tb.textContent = '';
  const q = ticketFilterInput.value.trim().toLowerCase();
  const statusFilter = ticketStatusFilter.value;
  const filtered = lastTickets.filter((t) => {
    if (q && !`${t.key} ${t.summary || ''}`.toLowerCase().includes(q)) return false;
    if (statusFilter === '__running__') return !!t.running;
    if (statusFilter && (t.jiraStatus || t.status) !== statusFilter) return false;
    return true;
  });
  // Latest ongoing first: running tickets on top, then most-recently-updated, cost as tiebreak.
  const sorted = [...filtered].sort((a, b) =>
    (b.running ? 1 : 0) - (a.running ? 1 : 0) ||
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) ||
    b.costUsd - a.costUsd);
  if (!sorted.length) {
    const tr = el('tr');
    const td = el('td', 'muted', lastTickets.length ? 'No tickets match the current filter.' : 'No tickets yet.');
    td.colSpan = 7;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  for (const t of sorted) {
    const tr = el('tr');
    if (t.running) tr.className = 'row-running';
    tr.appendChild(cell('key', t.key));
    tr.appendChild(cell(null, t.summary || t.key));
    tr.appendChild(cell('num', money(t.costUsd)));
    tr.appendChild(cell('num', tokens(t.tokens)));
    const st = el('td', 'cap');
    if (t.running) { st.appendChild(el('span', 'livedot')); st.appendChild(document.createTextNode(' running')); }
    else st.textContent = t.jiraStatus || t.status || '';
    tr.appendChild(st);
    tr.appendChild(cell('num', fmtWhen(t.updatedAt)));
    const prTd = el('td');
    if (t.prUrl) {
      const a = el('a', null, 'PR ↗'); a.href = t.prUrl; a.target = '_blank'; a.rel = 'noopener';
      prTd.appendChild(a);
    } else prTd.appendChild(el('span', 'muted', '—'));
    tr.appendChild(prTd);
    tb.appendChild(tr);
  }
}

function renderPrReviews() {
  const tb = document.querySelector('#pr-cost-table tbody');
  tb.textContent = '';
  const q = prFilterInput.value.trim().toLowerCase();
  const ownerFilter = prOwnerFilter.value;
  const filtered = lastPrReviews.filter((r) => {
    if (q && !`${r.ref} ${r.title || ''}`.toLowerCase().includes(q)) return false;
    if (ownerFilter === 'mine' && r.isOwn !== true) return false;
    if (ownerFilter === 'other' && r.isOwn !== false) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) =>
    (b.running ? 1 : 0) - (a.running ? 1 : 0) ||
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!sorted.length) {
    const tr = el('tr');
    const td = el('td', 'muted', lastPrReviews.length ? 'No PR reviews match the current filter.' : 'No PR reviews yet.');
    td.colSpan = 7;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  for (const r of sorted) {
    const tr = el('tr');
    if (r.running) tr.className = 'row-running';
    const prTd = el('td');
    if (r.prUrl) {
      const a = el('a', 'mono', '#' + r.ref.split('-').pop());
      a.href = r.prUrl; a.target = '_blank'; a.rel = 'noopener';
      prTd.appendChild(a);
    } else prTd.appendChild(el('span', 'muted', r.ref));
    tr.appendChild(prTd);
    tr.appendChild(cell(null, r.title || r.ref));
    tr.appendChild(cell('num', money(r.costUsd)));
    tr.appendChild(cell('num', tokens(r.tokens)));
    tr.appendChild(cell('cap', r.isOwn === true ? 'you' : r.isOwn === false ? 'other' : '—'));
    const resultTd = el('td');
    if (r.running) { resultTd.appendChild(el('span', 'livedot')); resultTd.appendChild(document.createTextNode(' running')); }
    else resultTd.appendChild(el('span', null, r.result || '—'));
    tr.appendChild(resultTd);
    tr.appendChild(cell('num', fmtWhen(r.updatedAt)));
    tb.appendChild(tr);
  }
}

ticketFilterInput.addEventListener('input', renderTickets);
ticketStatusFilter.addEventListener('change', renderTickets);
prFilterInput.addEventListener('input', renderPrReviews);
prOwnerFilter.addEventListener('change', renderPrReviews);

function renderStages(stages) {
  const tb = document.querySelector('#stage-table tbody');
  tb.textContent = '';
  for (const s of stages) {
    if (!s.count) continue; // hide stages with no recorded events
    const tr = el('tr');
    tr.appendChild(cell('cap', s.stage));
    tr.appendChild(cell('num', money(s.costUsd)));
    tr.appendChild(cell('num', tokens(s.tokens)));
    tr.appendChild(cell('num', String(s.count)));
    tr.appendChild(cell('num', dur(s.avgDurationSec)));
    tb.appendChild(tr);
  }
}

function renderBudget(budget) {
  const card = document.getElementById('budget-card');
  const bars = document.getElementById('budget-bars');
  const note = document.getElementById('cap-note');
  bars.textContent = '';
  if (!budget.capPerTicket || !(budget.tickets || []).length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  note.textContent = `(cap ${money(budget.capPerTicket)} per ticket)`;
  for (const row of budget.tickets) {
    const r = el('div', 'bar-row');
    r.appendChild(el('div', 'name', row.key));
    const track = el('div', 'bar-track');
    const fill = el('span', 'bar-fill' + (row.over ? ' over' : ''));
    fill.style.width = Math.min(100, Math.round((row.ratio || 0) * 100)) + '%';
    track.appendChild(fill);
    r.appendChild(track);
    r.appendChild(el('div', 'amt', money(row.spentUsd)));
    bars.appendChild(r);
  }
}

function cell(cls, text) { return el('td', cls, text); }
function fmtWhen(s) { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? String(s) : d.toISOString().slice(0, 16).replace('T', ' '); }

// Live refresh via SSE (shared stream).
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { live.classList.add('on'); liveLabel.textContent = 'live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); liveLabel.textContent = 'reconnecting…'; });
  es.addEventListener('state', () => load());
}

connect();
load();
