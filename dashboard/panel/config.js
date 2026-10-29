// Millwright config editor — showcases millwright/config/config.json and edits it in place.
// Generic: every non-`_` leaf becomes an input (bool→toggle, number→number, array→CSV, else text);
// `_comment`/`_*` keys render as inline docs. Structure + comments are preserved on save; the server
// validates against ConfigSchema before writing. No framework, no external assets.
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

let working = null; // the edit copy that gets POSTed

const form = $('cfg-form'), statusEl = $('cfg-status');
const live = $('live'), liveLabel = $('live-label');

function setByPath(obj, path, val) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = val;
}
function titleize(k) { return k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\s*\w/, (c) => c.toUpperCase()).trim(); }

// One editable leaf (scalar or string-array).
function field(k, v, path) {
  const row = el('div', 'cfg-field');
  row.appendChild(el('label', 'cfg-label', titleize(k)));
  let input;
  if (typeof v === 'boolean') {
    input = el('input'); input.type = 'checkbox'; input.checked = v; input.className = 'cfg-toggle';
    input.addEventListener('change', () => setByPath(working, path, input.checked));
  } else if (typeof v === 'number') {
    input = el('input', 'cfg-input'); input.type = 'number'; input.step = 'any'; input.value = String(v);
    input.addEventListener('input', () => { const n = Number(input.value); if (!Number.isNaN(n)) setByPath(working, path, n); });
  } else if (Array.isArray(v)) {
    input = el('input', 'cfg-input'); input.type = 'text'; input.value = v.join(', ');
    input.title = 'comma-separated';
    input.addEventListener('input', () => setByPath(working, path, input.value.split(',').map((s) => s.trim()).filter(Boolean)));
  } else {
    input = el('input', 'cfg-input'); input.type = 'text'; input.value = v == null ? '' : String(v);
    input.addEventListener('input', () => setByPath(working, path, input.value));
  }
  row.appendChild(input);
  return row;
}

// Render an object's contents into `container`: `_`keys → doc notes, nested objects → sub-fieldset.
function renderInto(container, obj, path) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) { container.appendChild(el('p', 'cfg-note', String(v))); continue; }
    const p = [...path, k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const fs = el('div', 'cfg-subsection');
      fs.appendChild(el('div', 'cfg-subtitle', titleize(k)));
      renderInto(fs, v, p);
      container.appendChild(fs);
    } else {
      container.appendChild(field(k, v, p));
    }
  }
}

function build(cfg) {
  form.textContent = '';
  $('cfg-desc').textContent = cfg._comment || 'Millwright runtime configuration.';
  $('cfg-path').textContent = 'millwright/config/config.json';
  const general = {};
  const objs = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (k === '_comment') continue;
    if (k.startsWith('_')) { general[k] = v; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) objs.push(k);
    else general[k] = v;
  }
  if (Object.keys(general).length) {
    const c = el('div', 'card cfg-card'); c.appendChild(el('h2', null, 'General'));
    renderInto(c, general, []); form.appendChild(c);
  }
  for (const k of objs) {
    const c = el('div', 'card cfg-card'); c.appendChild(el('h2', null, titleize(k)));
    renderInto(c, cfg[k], [k]); form.appendChild(c);
  }
}

async function load() {
  statusEl.textContent = '';
  const { config } = await fetch('/api/config').then((r) => r.json());
  working = JSON.parse(JSON.stringify(config)); // edit copy; preserves comments + structure
  build(working);
}

async function save() {
  statusEl.className = 'cfg-status';
  statusEl.textContent = 'Saving…';
  try {
    const res = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(working) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusEl.className = 'cfg-status err';
      statusEl.textContent = (d.error || 'Save failed') + (d.issues ? ' — ' + d.issues.join('; ') : '');
      return;
    }
    statusEl.className = 'cfg-status ok';
    statusEl.textContent = 'Saved ✓ (applies to the next run)';
  } catch (e) {
    statusEl.className = 'cfg-status err';
    statusEl.textContent = 'Save failed: ' + e.message;
  }
}

$('cfg-save').addEventListener('click', save);
$('cfg-reset').addEventListener('click', () => { load(); statusEl.textContent = ''; });

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { live.classList.add('on'); liveLabel.textContent = 'live'; });
  es.addEventListener('error', () => { live.classList.remove('on'); liveLabel.textContent = 'reconnecting…'; });
}

connect();
load();
