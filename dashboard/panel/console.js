// Millwright console — run observability. A launcher, a live Runs list (stage stepper + status +
// blocked→Continue + per-run actions), and a bottom Logger that streams the focused run's log
// (history via /api/log + live SSE) or its structured event timeline. No framework, no assets.
const JIRA_BASE = 'https://acme.atlassian.net/browse/';
const STAGES = ['intake', 'route', 'preflight', 'context', 'plan', 'build', 'verify', 'review', 'ship'];

let lastData = null;
let launchMode = 'plan';
let focusKey = null;      // ticket whose log/events show in the bottom Logger
let logTab = 'log';       // 'log' | 'events'
const logBuf = [];        // streamed lines for the focused run

const $ = (id) => document.getElementById(id);
const runsEl = $('runs'), runsSub = $('runs-sub');
const live = $('live'), liveLabel = $('live-label');
const logPane = $('log-pane'), logFocus = $('log-focus');

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function fmtMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function fmtTokens(n) { return (Number(n) || 0).toLocaleString(); }
function fmtDur(s) { s = Number(s) || 0; return s < 60 ? s + 's' : `${Math.floor(s / 60)}m ${s % 60}s`; }
// Mirrors dashboard/run-outcome-lib.mjs' verdict for display: `code` alone is not the verdict,
// since a run whose slash command didn't resolve exits 0 having done nothing at all.
function runEndText(d) {
  if (d.status === 'cancelled') return `— run ${d.mode} cancelled —`;
  const failed = d.status ? d.status !== 'success' : Number(d.code) !== 0;
  if (failed) return `— run ${d.mode} FAILED (code ${d.code}) — ${d.failure || 'see the log above'} —`;
  return `— run ${d.mode} ended (code ${d.code}) —`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('HTTP ' + res.status)); }
  return res.json().catch(() => ({}));
}

// ---- runs list ----
function runRank(t) {
  if (t.running) return 0;
  if (t.blocked) return 1;
  if (t.planReady) return 2;
  if (t.column === 'archived') return 5;
  return 3;
}
function isWorked(t) { return t.running || t.blocked || t.planReady || (t.phase && t.phase !== '') || t.costUsd; }

function fetchState() {
  return fetch('/api/state').then((r) => r.json()).then((d) => { lastData = d; renderAuto(d.automation); renderRuns(); }).catch((e) => console.error('state', e));
}

function fmtClock(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toTimeString().slice(0, 5); }

// Automation bar: cron toggle + interval, run-now, pending badge, pause/kill-switch.
function renderAuto(a) {
  const box = document.getElementById('autobar');
  box.textContent = '';
  if (!a) return;
  if (a.paused) box.appendChild(el('div', 'auto-paused', '⏸ Paused — active runs cancelled and new runs are blocked. Resume to continue.'));

  const card = el('div', 'auto-card');
  const cron = el('div', 'auto-item');
  const sw = el('label', 'auto-switch');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!a.cron.enabled; cb.className = 'cfg-toggle';
  cb.addEventListener('change', () => postJson('/api/cron', { enabled: cb.checked }).then(fetchState).catch((e) => alert(e.message)));
  sw.appendChild(cb); sw.appendChild(el('span', null, 'Auto-scan queue'));
  cron.appendChild(sw);
  cron.appendChild(el('span', 'auto-lbl', 'every'));
  const iv = el('input', 'auto-int'); iv.type = 'number'; iv.min = '1'; iv.value = a.cron.intervalMinutes; iv.title = 'interval (minutes)';
  iv.addEventListener('change', () => { const n = Number(iv.value); if (n >= 1) postJson('/api/cron', { intervalMinutes: n }).then(fetchState).catch(() => {}); });
  cron.appendChild(iv); cron.appendChild(el('span', 'auto-lbl', 'min'));
  const status = a.cron.scanning ? 'scanning…'
    : a.cron.lastScanAt ? `last ${fmtClock(a.cron.lastScanAt)}${a.cron.nextRunAt ? ' · next ' + fmtClock(a.cron.nextRunAt) : ''}`
      : 'not scanned yet';
  cron.appendChild(el('span', 'auto-status', status));
  if (a.cron.error) cron.appendChild(el('span', 'auto-err', a.cron.error));
  card.appendChild(cron);

  const acts = el('div', 'auto-item');
  acts.appendChild(mkBtn('Run queue now', 'run', () => postJson('/api/queue-run', {}).then(fetchState).catch((e) => alert(e.message))));
  acts.appendChild(el('span', 'auto-badge', `${a.pendingCount} waiting`));
  const pauseBtn = mkBtn(a.paused ? 'Resume' : 'Pause', 'run' + (a.paused ? ' approve' : ' cancel'), () => {
    if (!a.paused && !confirm('Pause: cancel active runs and block new ones?')) return;
    postJson('/api/pause', { paused: !a.paused }).then(fetchState).catch((e) => alert(e.message));
  });
  acts.appendChild(pauseBtn);
  card.appendChild(acts);
  box.appendChild(card);
  renderPending(box, a);
}

// The live scan's "N waiting" keys (automation.pending) rendered as an actionable list.
// Each ticket gets a one-click "Move into queue" → starts intake→plan; it then leaves this
// list and shows up as an active run below. Keys already running or already tracked (have a
// ticket dir) are filtered out so nothing gets double-started.
function renderPending(box, a) {
  const tracked = new Set((lastData && lastData.tickets || []).map((t) => t.key));
  const active = new Set((lastData && lastData.running) || []);
  const pend = (a.pending || []).filter((k) => !tracked.has(k) && !active.has(k));
  if (!pend.length) return;
  const wrap = el('div', 'pending-list');
  const hd = el('div', 'pending-hd');
  hd.appendChild(el('span', 'pending-title', `Scanned · not started (${pend.length})`));
  hd.appendChild(el('span', 'pending-note', 'Move a ticket into the queue to start intake→plan — it stops for plan review before any code (no PR).'));
  wrap.appendChild(hd);
  for (const key of pend) {
    const row = el('div', 'pending-row');
    const link = el('a', 'pending-key', key); link.href = JIRA_BASE + key; link.target = '_blank'; link.rel = 'noopener';
    row.appendChild(link);
    const btns = el('div', 'pending-btns');
    btns.appendChild(mkBtn('Move into queue', 'run approve', () => triggerRun(key, 'plan'),
      'Start intake→plan for this ticket. It becomes an active run and stops for plan review before any code is written — no PR.'));
    row.appendChild(btns);
    wrap.appendChild(row);
  }
  box.appendChild(wrap);
}

function renderRuns() {
  if (!lastData) return;
  const tickets = (lastData.tickets || []).filter(isWorked);
  tickets.sort((a, b) => runRank(a) - runRank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const queued = (lastData.queue || []);
  runsEl.textContent = '';
  const nRun = tickets.filter((t) => t.running).length, nBlk = tickets.filter((t) => t.blocked).length;
  runsSub.textContent = `${tickets.length} active · ${nRun} running · ${nBlk} blocked`;

  if (!tickets.length && !queued.length) { runsEl.appendChild(el('div', 'muted pad', 'No runs yet — start one above.')); return; }
  for (const t of tickets) runsEl.appendChild(renderRun(t));
  for (const q of queued) runsEl.appendChild(renderQueued(q.key));
}

function statusOf(t) {
  if (t.running) return ['running', 'Running' + (t.runMode ? ' · ' + t.runMode : '')];
  if (t.blocked) return ['blocked', 'Blocked'];
  if (t.planReady) return ['planready', 'Plan ready'];
  if (t.column === 'archived') return ['done', 'Archived'];
  if (t.column === 'ship') return ['ship', 'Awaiting merge'];
  return ['idle', t.phase || 'idle'];
}

function renderRun(t) {
  const card = el('div', 'run' + (t.running ? ' running' : '') + (t.blocked ? ' blk' : '') + (focusKey === t.key ? ' focused' : ''));
  card.dataset.key = t.key;
  card.addEventListener('click', (e) => { if (e.target.closest('button, a')) return; focusRun(t.key); });

  const head = el('div', 'run-head');
  const keyA = el('a', 'run-key', t.key); keyA.href = JIRA_BASE + t.key; keyA.target = '_blank'; keyA.rel = 'noopener';
  head.appendChild(keyA);
  head.appendChild(el('span', 'run-sum', t.summary || t.key));
  const [sc, sl] = statusOf(t);
  const badge = el('span', 'sbadge s-' + sc);
  if (t.running) badge.appendChild(el('span', 'spin'));
  badge.appendChild(el('span', null, sl));
  head.appendChild(badge);
  if (t.costUsd) head.appendChild(el('span', 'run-cost', fmtMoney(t.costUsd)));
  if (t.prUrl) { const pr = el('a', 'run-pr', 'PR ↗'); pr.href = t.prUrl; pr.target = '_blank'; pr.rel = 'noopener'; head.appendChild(pr); }
  card.appendChild(head);

  card.appendChild(renderStepper(t));

  if (t.blocked) {
    const b = el('div', 'banner blocked');
    b.appendChild(el('span', 'bicon', '⛔'));
    const txt = el('div', 'btext');
    txt.appendChild(el('div', 'btitle', `Blocked at ${t.blockedStage || t.phase || '—'}`));
    if (t.blockedReason) txt.appendChild(el('div', 'bsub', t.blockedReason));
    b.appendChild(txt);
    card.appendChild(b);
  } else if (t.planReady) {
    const b = el('div', 'banner planready');
    b.appendChild(el('span', 'bicon', '◆'));
    b.appendChild(el('div', 'btext', 'Plan complete — review before build.'));
    card.appendChild(b);
  }

  card.appendChild(renderActions(t));
  return card;
}

function renderQueued(key) {
  const card = el('div', 'run queued');
  const head = el('div', 'run-head');
  const keyA = el('a', 'run-key', key); keyA.href = JIRA_BASE + key; keyA.target = '_blank'; keyA.rel = 'noopener';
  head.appendChild(keyA);
  head.appendChild(el('span', 'run-sum muted', 'labelled · not started'));
  head.appendChild(el('span', 'sbadge s-idle', 'queued'));
  card.appendChild(head);
  const bar = el('div', 'run-actions');
  bar.appendChild(mkBtn('Plan', 'run', () => triggerRun(key, 'plan')));
  bar.appendChild(mkBtn('Review', 'run', () => triggerRun(key, 'review')));
  card.appendChild(bar);
  return card;
}

function renderStepper(t) {
  const wrap = el('div', 'stepper');
  const doneIdx = t.lastCompleted ? STAGES.indexOf(t.lastCompleted) : -1;
  for (let i = 0; i < STAGES.length; i++) {
    const stg = STAGES[i];
    let st = 'pending';
    if (t.blocked && stg === t.blockedStage) st = 'blocked';
    else if (i <= doneIdx) st = 'done';
    else if (stg === t.phase) st = t.running ? 'active' : 'current';
    const node = el('div', 'step s-' + st);
    node.appendChild(el('span', 'sdot'));
    node.appendChild(el('span', 'slabel', stg));
    node.title = stg + ' — ' + st;
    wrap.appendChild(node);
  }
  return wrap;
}

function renderActions(t) {
  const bar = el('div', 'run-actions');
  if (t.running) {
    bar.appendChild(mkBtn('View log', 'run', () => focusRun(t.key)));
    bar.appendChild(mkBtn('Cancel', 'run cancel', () => cancelRun(t.key)));
    return bar;
  }
  if (t.blocked) {
    if (t.blockedReason) bar.appendChild(el('div', 'blocked-reason', t.blockedReason));
    bar.appendChild(mkBtn('Continue', 'run primary-run', () => continueRun(t.key), 'Resume from the blocked stage, optionally with a note. ' + SHIP_HINT));
    bar.appendChild(mkBtn('View log', 'run', () => focusRun(t.key)));
    bar.appendChild(mkBtn('Re-plan', 'run', () => replan(t.key)));
    bar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
    return bar;
  }
  if (t.planReady) {
    bar.appendChild(mkBtn('Review plan', 'run primary-run', () => focusRun(t.key, 'events'), 'Read the plan, add context, and re-plan or approve — below.'));
    bar.appendChild(mkBtn('Approve & Build', 'run approve', () => triggerRun(t.key, 'build'), SHIP_HINT));
    bar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
    return bar;
  }
  if (t.column === 'ship') {
    // Already shipped — it has an open PR awaiting merge. No "Ship" here (it would re-ship).
    bar.appendChild(mkBtn('Check merge', 'run', () => checkMerge(t.key), 'Ask GitHub whether this PR has been merged; if so, archive it.'));
    bar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
    return bar;
  }
  if (t.column === 'archived') { bar.appendChild(mkBtn('Unarchive', 'run', () => setArchived(t.key, false))); return bar; }
  bar.appendChild(mkBtn('Plan', 'run', () => triggerRun(t.key, 'plan')));
  bar.appendChild(mkBtn('Review', 'run', () => triggerRun(t.key, 'review'), SHIP_HINT));
  bar.appendChild(mkBtn('Ship', 'run ship', () => triggerRun(t.key, 'ship')));
  bar.appendChild(mkBtn('Archive', 'run archive', () => setArchived(t.key, true)));
  return bar;
}

function mkBtn(label, cls, onClick, title) { const b = el('button', cls, label); if (title) b.title = title; b.addEventListener('click', onClick); return b; }
const SHIP_HINT = 'Runs through review, then opens a ready-for-review PR automatically only if the rubric ≥ target (0.9); otherwise stops at review. Never merges.';

// ---- actions ----
async function triggerRun(key, mode, notes) {
  if (mode === 'ship' && !confirm('This opens a PR / writes to Jira. Continue?')) return;
  try {
    await postJson('/api/run', notes ? { key, mode, notes } : { key, mode });
    focusRun(key, 'log'); // jump to the live log so a stale plan-review/actions panel isn't left up
    fetchState();
  } catch (e) { alert('Could not start: ' + e.message); }
}
function replan(key) { const n = prompt('Optional feedback for the re-plan (saved to resume-notes.md; never on the command line):', ''); if (n === null) return; triggerRun(key, 'replan', n.trim() || undefined); }
// Continue used to fire blind — the only way to hand a blocked run any context was Re-plan,
// which throws away everything past PLAN even when the block happened at BUILD/VERIFY/SHIP.
function continueRun(key) { const n = prompt('Optional note for resuming (saved to resume-notes.md; read by whichever stage runs next, then deleted; never on the command line):', ''); if (n === null) return; triggerRun(key, 'continue', n.trim() || undefined); }
async function cancelRun(key) { try { await postJson('/api/cancel', { key }); } catch (e) { alert('Cancel failed: ' + e.message); } }
async function setArchived(key, on) { try { await postJson(on ? '/api/archive' : '/api/unarchive', { key }); fetchState(); } catch (e) { alert('Failed: ' + e.message); } }
async function checkMerge(key) {
  try {
    const r = await postJson('/api/check-merge', { key });
    if (r.state === 'MERGED') fetchState();
    else if (r.state === 'unverified') alert('Could not verify merge state: ' + (r.detail || 'unknown reason') + ' — nothing was assumed.');
    else alert(`PR is ${r.state} — not merged yet.`);
  } catch (e) { alert('Check failed: ' + e.message); }
}

// ---- bottom logger ----
async function focusRun(key, tab) {
  focusKey = key;
  if (tab) logTab = tab;
  logFocus.textContent = key;
  $('log-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === logTab));
  document.querySelectorAll('.run').forEach((r) => r.classList.toggle('focused', r.dataset.key === key));
  loadLogger();
  $('loggers').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadLogger() {
  if (!focusKey) return;
  if (logTab === 'events') return renderEvents();
  logBuf.length = 0;
  logPane.textContent = '';
  logPane.appendChild(el('div', 'muted pad', 'Loading log…'));
  try {
    const d = await fetch('/api/log?key=' + encodeURIComponent(focusKey)).then((r) => r.json());
    if (focusKey !== d.key) return;
    logBuf.push(...(d.lines || []));
  } catch { /* empty */ }
  renderLog();
}

function renderLog() {
  logPane.textContent = '';
  const pre = el('div', 'logview');
  if (!logBuf.length) pre.appendChild(el('div', 'muted', 'No log output yet.'));
  for (const line of logBuf) pre.appendChild(el('span', 'l', line));
  logPane.appendChild(pre);
  pre.scrollTop = pre.scrollHeight;
}

async function renderEvents() {
  logPane.textContent = '';
  logPane.appendChild(el('div', 'muted pad', 'Loading events…'));
  let d;
  try { d = await fetch('/api/ticket?key=' + encodeURIComponent(focusKey)).then((r) => r.json()); }
  catch (e) { logPane.textContent = ''; logPane.appendChild(el('div', 'muted pad', 'Failed: ' + e.message)); return; }
  logPane.textContent = '';
  const tl = d.timeline || [];
  if (d.planReady && d.artifacts && d.artifacts.plan) {
    const pr = el('div', 'plan-inline');
    pr.appendChild(el('div', 'pi-title', 'Plan review — approve, or add context to re-plan'));
    const body = el('pre', 'pi-body'); body.textContent = d.artifacts.plan; pr.appendChild(body);
    if (d.running) {
      // A run is already going — don't offer a second Approve/Re-plan; point at the live log.
      pr.appendChild(el('div', 'pi-running', '▶ A run is in progress — watch it in the Live log tab.'));
    } else {
      const ta = el('textarea', 'pi-notes');
      ta.placeholder = "What's off with this plan? Add context, constraints, or the approach you want — the re-plan reads it (saved to resume-notes.md; never on the command line)…";
      pr.appendChild(ta);
      const acts = el('div', 'pi-actions');
      acts.appendChild(mkBtn('Re-plan with this context', 'run primary-run', () => {
        if (!ta.value.trim() && !confirm('Re-plan with no added context?')) return;
        triggerRun(d.key, 'replan', ta.value.trim() || undefined);
      }));
      acts.appendChild(mkBtn('Approve & Build', 'run approve', () => triggerRun(d.key, 'build'), SHIP_HINT));
      pr.appendChild(acts);
    }
    logPane.appendChild(pr);
  } else if (d.blocked && !d.running) {
    // Same idea for a run halted anywhere past PLAN — Continue used to be the only button
    // here and it took no context, so the sole way to add any was Re-plan, which throws away
    // everything past PLAN even for a BUILD/VERIFY/SHIP block.
    const pr = el('div', 'plan-inline');
    pr.appendChild(el('div', 'pi-title', `Blocked at ${d.blockedStage || 'an unknown stage'}${d.blockedReason ? ' — ' + d.blockedReason : ''}`));
    const ta = el('textarea', 'pi-notes');
    ta.placeholder = 'What should whichever stage runs next know? (saved to resume-notes.md; read once, then deleted; never on the command line)…';
    pr.appendChild(ta);
    const acts = el('div', 'pi-actions');
    if (d.canContinue) {
      acts.appendChild(mkBtn('Continue with this note', 'run primary-run', () => triggerRun(d.key, 'continue', ta.value.trim() || undefined)));
    }
    acts.appendChild(mkBtn('Re-plan with this context', 'run', () => {
      if (!ta.value.trim() && !confirm('Re-plan with no added context?')) return;
      triggerRun(d.key, 'replan', ta.value.trim() || undefined);
    }));
    pr.appendChild(acts);
    logPane.appendChild(pr);
  }
  if (!tl.length) { logPane.appendChild(el('div', 'muted pad', 'No stage events yet.')); return; }
  const tbl = el('div', 'events');
  for (const r of tl) {
    const row = el('div', 'ev-row');
    row.appendChild(el('span', 'ev-stage', r.stage));
    row.appendChild(el('span', 'ev-status s-' + r.status, r.status));
    row.appendChild(el('span', 'ev-num', fmtDur(r.durationSec)));
    row.appendChild(el('span', 'ev-num', fmtTokens(r.tokensTotal) + ' tok'));
    if (r.notes) row.appendChild(el('span', 'ev-notes', r.notes));
    tbl.appendChild(row);
  }
  logPane.appendChild(tbl);
}

$('log-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (!b) return; logTab = b.dataset.tab; if (focusKey) focusRun(focusKey); });

// ---- launcher ----
const tktInput = $('tkt-input'), tktErr = $('tkt-err'), modeSeg = $('mode-seg');
modeSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (!b) return; launchMode = b.dataset.mode; modeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); });
function parseKey(raw) { const m = String(raw || '').match(/PROJ-\d+/i); return m ? m[0].toUpperCase() : null; }
async function launch() {
  const key = parseKey(tktInput.value);
  if (!key) { tktErr.textContent = 'Enter a ticket key like PROJ-1234, or paste a Jira URL.'; tktErr.hidden = false; return; }
  tktErr.hidden = true;
  try { await postJson('/api/run', { key, mode: launchMode }); tktInput.value = ''; focusRun(key); fetchState(); }
  catch (e) { tktErr.textContent = 'Could not start: ' + e.message; tktErr.hidden = false; }
}
$('start-btn').addEventListener('click', launch);
tktInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });

// ---- SSE ----
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { live.classList.add('on'); liveLabel.textContent = 'live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); liveLabel.textContent = 'reconnecting…'; });
  es.addEventListener('state', () => fetchState());
  es.addEventListener('log', (e) => {
    try { const d = JSON.parse(e.data); if (d.key === focusKey && logTab === 'log') { logBuf.push(d.line); const v = logPane.querySelector('.logview'); if (v) { v.appendChild(el('span', 'l', d.line)); v.scrollTop = v.scrollHeight; } else renderLog(); } } catch {}
  });
  es.addEventListener('run-end', (e) => {
    try { const d = JSON.parse(e.data); if (d.key === focusKey && logTab === 'log') { logBuf.push(runEndText(d)); renderLog(); } } catch {}
    fetchState();
  });
}

connect();
fetchState();
