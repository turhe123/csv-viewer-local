// app.js — Large CSV Viewer and Search. Everything runs on this device; parsing happens in worker.js.
// Rows stay in memory as arrays of strings. Sorting and filtering only build index arrays (Uint32Array)
// of row positions, and the table is virtualised: a pool of ~60 row elements positioned by transform.
/* global Papa */
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const ROW_H = 34;
const POOL_MIN = 60;
const OVERSCAN = 8;
const MAX_SPACER = 8_000_000; // px; browsers cap element heights, larger views are scaled
let BIG_FILE = 300 * 1024 * 1024; // bytes; tests lower it through setBigFileLimit()
const PREVIEW_ROWS = 100_000;
const ACCEPT_EXT = /\.(csv|tsv|tab|txt|psv|dat)$/i;
const ACCEPT_MIME = /^(text\/(csv|plain|tab-separated-values|x-csv)|application\/(csv|vnd\.ms-excel))$/i;
const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
const ISO = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const $ = (id) => document.getElementById(id);
const el = {
  zone: $('dropzone'), input: $('file-input'), results: $('results'), toolbar: $('toolbar'),
  fileName: $('file-name'), openAnother: $('open-another'), search: $('search'), delimiter: $('delimiter'),
  hasHeader: $('has-header'), decimalComma: $('decimal-comma'), addFilter: $('add-filter'), toggleCols: $('toggle-cols'),
  download: $('download-csv'), filterBar: $('filter-bar'), colPanel: $('col-panel'), gridWrap: $('grid-wrap'),
  grid: $('grid'), inner: $('grid-inner'), head: $('grid-head'), body: $('grid-body'), empty: $('grid-empty'),
  drawer: $('drawer'), drawerTitle: $('drawer-title'), drawerList: $('drawer-list'), copyRow: $('copy-row'),
  closeDrawer: $('close-drawer'), pop: $('col-pop'),
};

const S = {
  file: null, raw: [], delimiter: '', detected: ',', encoding: 'utf-8', truncated: false,
  hasHeader: true, decimalComma: false, ncols: 0, headers: [], hidden: new Set(), vis: [], widths: [],
  sortCol: -1, sortDir: 0, sorted: null, view: new Uint32Array(0), query: '', filters: [],
  sel: null, // { pos, ci } — position in the view and index into S.vis
  lower: [], num: [], type: [], version: 0,
};

let pool = [];
let headH = 40;
let rnW = 56;
let colLeft = [];
let worker = null;
let parseId = 0;
let raf = 0;

/* ---------- helpers ---------- */

const fmt = (n) => n.toLocaleString('en-US');
const dataStart = () => (S.hasHeader ? 1 : 0);
const dataCount = () => Math.max(0, S.raw.length - dataStart());
const cell = (r, c) => S.raw[r][c] ?? '';
const pct = (x) => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`; // floors, so 99.9% never shows as 100%

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showError(message) {
  const a = make('div', 'alert alert--error', message);
  a.setAttribute('role', 'alert');
  el.results.querySelectorAll('.alert--error').forEach((x) => x.remove());
  el.results.prepend(a);
  a.scrollIntoView({ block: 'nearest' });
}

function clearResults() { el.results.replaceChildren(); }

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = make('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(`${label} copied`);
}

/* ---------- loading ---------- */

function handleFiles(files) {
  const ok = files.filter((f) => ACCEPT_EXT.test(f.name) || (!/\.[a-z0-9]+$/i.test(f.name) && ACCEPT_MIME.test(f.type)));
  const bad = files.filter((f) => !ok.includes(f));
  clearResults();
  if (bad.length) {
    const names = bad.map((f) => f.name).join(', ');
    showError(`${bad.length === 1 ? 'This file is' : 'These files are'} not CSV or TSV: ${names}. Open a .csv, .tsv or .txt file with rows of values.`);
  }
  if (!ok.length) return null;
  if (ok.length > 1) toast(`Opened ${ok[0].name}. One file is shown at a time.`);
  return openFile(ok[0]);
}

function openFile(file) {
  S.file = file;
  S.delimiter = '';
  el.delimiter.value = '';
  closeDrawer();
  closePop();
  if (file.size > BIG_FILE) return askBigFile(file);
  return parse(file, 0);
}

function askBigFile(file) {
  return new Promise((resolve) => {
    const box = make('div', 'alert big-file');
    box.append(make('p', '', `${file.name} is ${formatBytes(file.size)}. Files above 300 MB can run out of memory, especially on phones. You can preview the first ${fmt(PREVIEW_ROWS)} rows or try to load everything.`));
    const row = make('div', 'row');
    const preview = make('button', 'btn btn--primary btn--small', `Preview first ${fmt(PREVIEW_ROWS)} rows`);
    const all = make('button', 'btn btn--small', 'Load the whole file');
    preview.type = all.type = 'button';
    preview.addEventListener('click', () => { box.remove(); resolve(parse(file, PREVIEW_ROWS)); });
    all.addEventListener('click', () => { box.remove(); resolve(parse(file, 0)); });
    row.append(preview, all);
    box.append(row);
    el.results.append(box);
    box.scrollIntoView({ block: 'nearest' });
    preview.focus();
  });
}

function parse(file, maxRows) {
  if (worker) worker.terminate();
  const id = ++parseId;
  const raw = [];
  let header = true;
  let detected = ',';

  el.results.querySelectorAll('.result, .progress-box').forEach((x) => x.remove());
  const box = make('div', 'progress-box');
  const label = make('p', 'progress-box__label', `Reading ${file.name}…`);
  const bar = make('div', 'progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Reading the file');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = make('span');
  bar.append(fill);
  box.append(label, bar);
  el.results.append(box);

  return new Promise((resolve) => {
    worker = new Worker('worker.js');
    const fail = (msg) => {
      if (id !== parseId) return;
      box.remove();
      worker.terminate();
      worker = null;
      if (!S.raw.length) showEmpty(); else updateStats();
      showError(msg);
      resolve(false);
    };
    worker.onerror = (e) => { e.preventDefault(); fail('The file could not be read. It may be damaged or use an unsupported text encoding.'); };
    worker.onmessage = (e) => {
      if (id !== parseId) return;
      const m = e.data;
      if (m.type === 'progress') {
        const p = m.done / m.total;
        fill.style.width = `${p * 100}%`;
        bar.setAttribute('aria-valuenow', String(Math.floor(p * 100)));
        label.textContent = `Reading ${file.name}… ${pct(p)} · ${fmt(raw.length)} rows`;
      } else if (m.type === 'meta') {
        header = m.header;
        detected = m.delimiter;
      } else if (m.type === 'rows') {
        const rows = m.rows;
        for (let i = 0; i < rows.length; i++) raw.push(rows[i]);
      } else if (m.type === 'restart') {
        raw.length = 0;
        label.textContent = `Not UTF-8, reading ${file.name} as Windows-1252…`;
      } else if (m.type === 'error') {
        fail(m.message);
      } else if (m.type === 'done') {
        worker.terminate();
        worker = null;
        box.remove();
        if (!raw.length) { fail('This file is empty, there are no rows to show.'); return; }
        S.encoding = m.encoding;
        S.truncated = m.truncated;
        S.detected = S.delimiter || detected;
        loaded(raw, header);
        resolve(true);
      }
    };
    worker.postMessage({ file, delimiter: S.delimiter, maxRows });
  });
}

function loaded(raw, header) {
  let ncols = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i].length > ncols) ncols = raw[i].length;
  for (let i = 0; i < raw.length; i++) { const r = raw[i]; while (r.length < ncols) r.push(''); } // pad ragged rows
  if (raw.length === 1) header = false;
  Object.assign(S, {
    raw, ncols, hasHeader: header, hidden: new Set(), sortCol: -1, sortDir: 0, sorted: null,
    query: '', filters: [], sel: null, lower: [], num: [], type: [],
  });
  el.search.value = '';
  el.hasHeader.checked = header;
  el.decimalComma.checked = S.decimalComma;
  el.fileName.textContent = S.file.name;
  el.fileName.title = S.file.name;
  el.delimiter.options[0].textContent = `Auto (${DELIM_NAMES[S.detected] || JSON.stringify(S.detected)})`;
  el.zone.hidden = true;
  el.toolbar.hidden = false;
  el.gridWrap.hidden = false;
  el.colPanel.hidden = true;
  el.toggleCols.setAttribute('aria-expanded', 'false');
  renderFilters();
  setupColumns();
  applyView();
  const card = el.results.querySelector('.result');
  if (card) card.scrollIntoView({ block: 'nearest' });
  toast(`${fmt(dataCount())} rows opened, nothing was uploaded`);
}

function showEmpty() {
  el.zone.hidden = false;
  el.toolbar.hidden = true;
  el.gridWrap.hidden = true;
}

/* ---------- columns ---------- */

function computeHeaders() {
  const first = S.raw[0];
  S.headers = [];
  for (let c = 0; c < S.ncols; c++) {
    const name = S.hasHeader ? String(first[c] ?? '').trim() : '';
    S.headers.push(name || `Column ${c + 1}`);
  }
}

function setupColumns() {
  computeHeaders();
  S.widths = S.headers.map((h, c) => {
    let chars = 0;
    const end = Math.min(S.raw.length, dataStart() + 300);
    for (let r = dataStart(); r < end; r++) { const n = cell(r, c).length; if (n > chars) chars = n; }
    const body = 26 + Math.min(chars, 42) * 8.2;
    const headW = 58 + Math.min(h.length, 30) * 7.8;
    return Math.round(Math.max(76, Math.min(380, Math.max(body, headW))));
  });
  S.vis = [];
  for (let c = 0; c < S.ncols; c++) if (!S.hidden.has(c)) S.vis.push(c);
  rnW = Math.max(52, String(dataCount()).length * 9 + 22);
  colLeft = [];
  let x = rnW;
  for (const c of S.vis) { colLeft.push(x); x += S.widths[c]; }
  el.inner.style.setProperty('--cols', `${rnW}px ${S.vis.map((c) => `${S.widths[c]}px`).join(' ')}`);
  el.inner.style.width = `${x}px`;
  buildHead();
  buildPool();
  renderColPanel();
}

function buildHead() {
  el.head.replaceChildren();
  const rn = make('div', 'grid__rn grid__hcell', '#');
  rn.setAttribute('role', 'columnheader');
  el.head.append(rn);
  S.vis.forEach((c) => {
    const h = make('div', 'grid__hcell');
    h.setAttribute('role', 'columnheader');
    h.setAttribute('aria-sort', S.sortCol === c ? (S.sortDir > 0 ? 'ascending' : 'descending') : 'none');
    const sort = make('button', 'hcell__sort');
    sort.type = 'button';
    sort.dataset.col = c;
    sort.title = `Sort by ${S.headers[c]}`;
    const name = make('span', 'hcell__name', S.headers[c]);
    const arrow = make('span', 'hcell__arrow', S.sortCol === c ? (S.sortDir > 0 ? '▲' : '▼') : '');
    arrow.setAttribute('aria-hidden', 'true');
    sort.append(name, arrow);
    const info = make('button', 'hcell__info', 'i');
    info.type = 'button';
    info.dataset.col = c;
    info.setAttribute('aria-label', `Details for column ${S.headers[c]}`);
    h.append(sort, info);
    el.head.append(h);
  });
  headH = el.head.offsetHeight || 40;
}

function buildPool() {
  el.body.replaceChildren();
  const size = Math.max(POOL_MIN, Math.ceil((el.grid.clientHeight || 600) / ROW_H) + OVERSCAN * 2 + 2);
  pool = [];
  for (let k = 0; k < size; k++) {
    const row = make('div', 'grid__row');
    row.setAttribute('role', 'row');
    row.hidden = true;
    const rn = make('div', 'grid__rn');
    row.append(rn);
    S.vis.forEach((c, ci) => {
      const d = make('div', 'grid__cell');
      d.setAttribute('role', 'gridcell');
      d.dataset.ci = ci;
      row.append(d);
    });
    row._r = -1;
    el.body.append(row);
    pool.push(row);
  }
  S.version++;
}

function renderColPanel() {
  el.colPanel.replaceChildren();
  const head = make('div', 'col-panel__head');
  head.append(make('strong', '', `Columns (${S.vis.length} of ${S.ncols} shown)`));
  const all = make('button', 'btn btn--small', 'Show all');
  all.type = 'button';
  all.addEventListener('click', () => { S.hidden.clear(); columnsChanged(); });
  head.append(all);
  const list = make('div', 'col-panel__list');
  S.headers.forEach((h, c) => {
    const lab = make('label', 'check');
    const box = make('input');
    box.type = 'checkbox';
    box.checked = !S.hidden.has(c);
    box.addEventListener('change', () => {
      if (box.checked) S.hidden.delete(c);
      else if (S.vis.length > 1) S.hidden.add(c);
      else { box.checked = true; toast('At least one column stays visible'); return; }
      columnsChanged();
    });
    lab.append(box, make('span', '', h));
    list.append(lab);
  });
  el.colPanel.append(head, list);
}

function columnsChanged() {
  const focusedCol = document.activeElement && el.colPanel.contains(document.activeElement)
    ? [...el.colPanel.querySelectorAll('input')].indexOf(document.activeElement) : -1;
  S.sel = null;
  setupColumns();
  applyFilter();
  if (focusedCol >= 0) el.colPanel.querySelectorAll('input')[focusedCol]?.focus();
}

/* ---------- typed keys, sorting, filtering ---------- */

function parseNum(s) {
  let t = s.trim();
  if (!t) return NaN;
  t = t.replace(/^[$€£]\s*/, '').replace(/\s*%$/, '').replace(/[\s ']/g, '');
  if (S.decimalComma) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

function colType(c) {
  if (S.type[c]) return S.type[c];
  const start = dataStart();
  const n = dataCount();
  const step = Math.max(1, Math.floor(n / 2000));
  let seen = 0, nums = 0, dates = 0;
  for (let i = 0; i < n; i += step) {
    const v = cell(start + i, c).trim();
    if (!v) continue;
    seen++;
    if (ISO.test(v)) dates++;
    else if (!Number.isNaN(parseNum(v))) nums++;
  }
  let t = 'text';
  if (seen && dates / seen >= 0.95) t = 'date';
  else if (seen && nums / seen >= 0.95) t = 'number';
  S.type[c] = t;
  return t;
}

function numKeys(c) {
  if (S.num[c]) return S.num[c];
  const t = colType(c);
  const k = new Float64Array(S.raw.length);
  for (let r = 0; r < S.raw.length; r++) {
    const v = cell(r, c);
    k[r] = t === 'date' ? (ISO.test(v.trim()) ? Date.parse(v.trim().replace(' ', 'T')) : NaN) : parseNum(v);
  }
  S.num[c] = k;
  return k;
}

function lowerKeys(c) {
  if (S.lower[c]) return S.lower[c];
  const k = new Array(S.raw.length);
  for (let r = 0; r < S.raw.length; r++) k[r] = cell(r, c).toLowerCase();
  S.lower[c] = k;
  return k;
}

function baseOrder() {
  if (S.sorted) return S.sorted;
  const start = dataStart();
  const a = new Uint32Array(dataCount());
  for (let i = 0; i < a.length; i++) a[i] = start + i;
  const c = S.sortCol;
  const dir = S.sortDir;
  if (c >= 0 && dir) {
    if (colType(c) !== 'text') {
      const k = numKeys(c);
      a.sort((x, y) => {
        const p = k[x], q = k[y];
        const pn = p !== p, qn = q !== q; // NaN: empty or not a number, always last
        if (pn || qn) return pn && qn ? x - y : pn ? 1 : -1;
        return (p - q) * dir || x - y;
      });
    } else {
      const k = lowerKeys(c);
      a.sort((x, y) => {
        const p = k[x], q = k[y];
        if (p === q) return x - y;
        if (p === '') return 1;
        if (q === '') return -1;
        return p < q ? -dir : dir;
      });
    }
  }
  S.sorted = a;
  return a;
}

function applyView() {
  S.sorted = null;
  applyFilter();
}

function applyFilter() {
  const base = baseOrder();
  const q = S.query.trim().toLowerCase();
  const active = S.filters.filter((f) => f.col < S.ncols && (f.op === 'empty' || f.op === 'notempty' || f.value.trim() !== ''));
  if (!q && !active.length) {
    S.view = base;
  } else {
    const lows = q ? S.vis.map(lowerKeys) : [];
    const fl = active.map((f) => ({ op: f.op, v: f.value.trim().toLowerCase(), k: lowerKeys(f.col) }));
    const out = new Uint32Array(base.length);
    let n = 0;
    outer: for (let i = 0; i < base.length; i++) {
      const r = base[i];
      for (let j = 0; j < fl.length; j++) {
        const f = fl[j];
        const s = f.k[r];
        const keep = f.op === 'contains' ? s.includes(f.v)
          : f.op === 'equals' ? s.trim() === f.v
          : f.op === 'empty' ? s.trim() === '' : s.trim() !== '';
        if (!keep) continue outer;
      }
      if (q) {
        let hit = false;
        for (let j = 0; j < lows.length; j++) if (lows[j][r].includes(q)) { hit = true; break; }
        if (!hit) continue;
      }
      out[n++] = r;
    }
    S.view = out.subarray(0, n);
  }
  if (S.sel && S.sel.pos >= S.view.length) S.sel = null;
  S.version++;
  updateStats();
  el.grid.setAttribute('aria-rowcount', String(S.view.length + 1));
  el.empty.hidden = S.view.length > 0;
  render();
}

function setSort(c, dir) {
  if (dir === undefined) dir = S.sortCol === c ? (S.sortDir === 1 ? -1 : S.sortDir === -1 ? 0 : 1) : 1;
  S.sortCol = dir ? c : -1;
  S.sortDir = dir;
  S.sel = null;
  buildHead();
  applyView();
  const name = S.headers[c];
  toast(dir ? `Sorted by ${name}, ${dir > 0 ? 'ascending' : 'descending'} (${colType(c)})` : 'Original order');
}

/* ---------- stats line ---------- */

function updateStats() {
  let card = el.results.querySelector('.result');
  if (!card) {
    card = make('div', 'result stats');
    card.innerHTML = '<div class="result__meta"><div class="result__name stats__count" id="row-count"></div><div class="result__info" id="stats"></div></div><div class="stats__match stat" id="match-count"></div>';
    el.results.append(card);
  }
  const total = dataCount();
  $('row-count').textContent = `${fmt(total)} rows${S.truncated ? ' (preview)' : ''}`;
  const delim = DELIM_NAMES[S.detected] || `"${S.detected}"`;
  $('stats').textContent = `${fmt(S.ncols)} ${S.ncols === 1 ? 'column' : 'columns'}${S.hidden.size ? ` (${S.hidden.size} hidden)` : ''} · ${formatBytes(S.file.size)} · ${delim}-separated · ${S.encoding === 'windows-1252' ? 'Windows-1252' : S.encoding.toUpperCase()}${S.truncated ? ` · first ${fmt(PREVIEW_ROWS)} rows only` : ''}`;
  const filtered = S.query.trim() || S.filters.length;
  $('match-count').textContent = filtered
    ? `${fmt(S.view.length)} of ${fmt(total)} rows match`
    : 'Showing all rows';
  $('match-count').classList.toggle('stat--warn', Boolean(filtered) && S.view.length === 0);
}

/* ---------- virtual rendering ---------- */

function geometry() {
  const n = S.view.length;
  const total = n * ROW_H;
  const spacer = Math.min(total, MAX_SPACER);
  const viewH = Math.max(ROW_H, el.grid.clientHeight - headH);
  return { n, total, spacer, viewH };
}

// Maps the real scrollTop to a "virtual" offset in the full-height list (identity unless the list is scaled).
function virtualTop(st, g) {
  if (g.total <= g.spacer) return st;
  const maxSt = g.spacer - g.viewH;
  return maxSt > 0 ? (Math.min(st, maxSt) / maxSt) * (g.total - g.viewH) : 0;
}

function scrollForVirtual(vt, g) {
  if (g.total <= g.spacer) return vt;
  return (vt / (g.total - g.viewH)) * (g.spacer - g.viewH);
}

function render() {
  const g = geometry();
  el.body.style.height = `${g.spacer}px`;
  const st = el.grid.scrollTop;
  const vt = virtualTop(st, g);
  const first = Math.max(0, Math.floor(vt / ROW_H) - OVERSCAN);
  const q = S.query.trim().toLowerCase();
  const start = dataStart();
  for (let k = 0; k < pool.length; k++) {
    const row = pool[k];
    const i = first + k;
    if (i >= g.n) { if (!row.hidden) row.hidden = true; row._r = -1; continue; }
    row.hidden = false;
    row.style.transform = `translateY(${Math.round(st - vt + i * ROW_H)}px)`;
    const r = S.view[i];
    if (row._r === r && row._v === S.version && row._pos === i) continue;
    row._r = r; row._v = S.version; row._pos = i;
    row.dataset.pos = i;
    row.setAttribute('aria-rowindex', String(i + 2));
    row.firstChild.textContent = String(r - start + 1);
    const cells = row.children;
    const selRow = S.sel && S.sel.pos === i;
    row.classList.toggle('is-selected', Boolean(selRow));
    for (let ci = 0; ci < S.vis.length; ci++) {
      const d = cells[ci + 1];
      setCellText(d, cell(r, S.vis[ci]), q);
      const on = selRow && S.sel.ci === ci;
      if (on) d.setAttribute('aria-selected', 'true'); else d.removeAttribute('aria-selected');
    }
  }
}

function setCellText(d, text, q) {
  const shown = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  if (!q) { d.textContent = shown; return; }
  const low = shown.toLowerCase();
  let at = low.indexOf(q);
  if (at < 0 || low.length !== shown.length) { d.textContent = shown; return; }
  d.textContent = '';
  let from = 0;
  while (at >= 0) {
    if (at > from) d.append(shown.slice(from, at));
    d.append(make('mark', '', shown.slice(at, at + q.length)));
    from = at + q.length;
    at = low.indexOf(q, from);
  }
  if (from < shown.length) d.append(shown.slice(from));
}

function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

/* ---------- selection, drawer, keyboard ---------- */

function select(pos, ci, { open = false, focus = true } = {}) {
  if (!S.view.length) return;
  pos = Math.max(0, Math.min(S.view.length - 1, pos));
  ci = Math.max(0, Math.min(S.vis.length - 1, ci));
  S.sel = { pos, ci };
  S.version++;
  ensureVisible(pos, ci);
  render();
  if (open || !el.drawer.hidden) openDrawer();
  if (focus && document.activeElement !== el.grid) el.grid.focus({ preventScroll: true });
}

function ensureVisible(pos, ci) {
  const g = geometry();
  const vt = virtualTop(el.grid.scrollTop, g);
  let target = vt;
  if (pos * ROW_H < vt) target = pos * ROW_H;
  else if ((pos + 1) * ROW_H > vt + g.viewH) target = (pos + 1) * ROW_H - g.viewH;
  if (target !== vt) el.grid.scrollTop = scrollForVirtual(target, g);
  const left = colLeft[ci];
  const w = S.widths[S.vis[ci]];
  const vw = el.grid.clientWidth;
  if (left - rnW < el.grid.scrollLeft) el.grid.scrollLeft = left - rnW;
  else if (left + w > el.grid.scrollLeft + vw) el.grid.scrollLeft = left + w - vw;
}

function selectedRow() { return S.sel ? S.view[S.sel.pos] : -1; }

function openDrawer() {
  const r = selectedRow();
  if (r < 0) return;
  el.drawerTitle.textContent = `Row ${fmt(r - dataStart() + 1)}`;
  el.drawerList.replaceChildren();
  S.headers.forEach((h, c) => {
    const dt = make('dt', '', h);
    const dd = make('dd', '', cell(r, c));
    if (!cell(r, c)) { dd.textContent = 'empty'; dd.className = 'is-empty'; }
    if (S.sel && S.vis[S.sel.ci] === c) dt.className = dd.className = `${dd.className} is-current`.trim();
    el.drawerList.append(dt, dd);
  });
  el.drawer.hidden = false;
}

function closeDrawer() { el.drawer.hidden = true; }

function rowAsText(r) {
  return Papa.unparse([S.vis.map((c) => cell(r, c))], { delimiter: S.detected === '\t' ? '\t' : S.detected || ',' });
}

el.body.addEventListener('click', (e) => {
  const d = e.target.closest('.grid__cell, .grid__rn');
  const row = e.target.closest('.grid__row');
  if (!row) return;
  const ci = d && d.dataset.ci != null ? Number(d.dataset.ci) : (S.sel ? S.sel.ci : 0);
  select(Number(row.dataset.pos), ci, { open: true });
});

el.grid.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', () => { if (S.raw.length && !el.gridWrap.hidden) { const before = pool.length; const need = Math.max(POOL_MIN, Math.ceil(el.grid.clientHeight / ROW_H) + OVERSCAN * 2 + 2); if (need > before) buildPool(); scheduleRender(); } });

el.grid.addEventListener('keydown', (e) => {
  if (!S.view.length) return;
  const sel = S.sel || { pos: -1, ci: 0 };
  const page = Math.max(1, Math.floor(geometry().viewH / ROW_H) - 1);
  const mod = e.ctrlKey || e.metaKey;
  let pos = sel.pos;
  let ci = sel.ci;
  switch (e.key) {
    case 'ArrowDown': pos = sel.pos < 0 ? 0 : pos + 1; break;
    case 'ArrowUp': pos = Math.max(0, pos - 1); break;
    case 'ArrowRight': pos = Math.max(0, pos); ci += 1; break;
    case 'ArrowLeft': pos = Math.max(0, pos); ci -= 1; break;
    case 'PageDown': pos = Math.max(0, pos) + page; break;
    case 'PageUp': pos = Math.max(0, pos - page); break;
    case 'Home': pos = mod ? 0 : Math.max(0, pos); ci = 0; break;
    case 'End': pos = mod ? S.view.length - 1 : Math.max(0, pos); ci = S.vis.length - 1; break;
    case 'Enter': if (S.sel) openDrawer(); e.preventDefault(); return;
    case 'c': case 'C':
      if (mod && S.sel && !String(window.getSelection())) {
        e.preventDefault();
        copyText(cell(selectedRow(), S.vis[S.sel.ci]), 'Cell');
      }
      return;
    default: return;
  }
  e.preventDefault();
  select(pos, ci);
});

el.head.addEventListener('click', (e) => {
  const sortBtn = e.target.closest('.hcell__sort');
  const info = e.target.closest('.hcell__info');
  if (sortBtn) setSort(Number(sortBtn.dataset.col));
  else if (info) openPop(Number(info.dataset.col), info);
});

el.copyRow.addEventListener('click', () => { const r = selectedRow(); if (r >= 0) copyText(rowAsText(r), 'Row'); });
el.closeDrawer.addEventListener('click', () => { closeDrawer(); el.grid.focus({ preventScroll: true }); });

/* ---------- column details popover ---------- */

function columnStats(c) {
  const start = dataStart();
  const n = dataCount();
  const t = colType(c);
  const seen = new Set();
  let empty = 0;
  let min = null, max = null, minV = '', maxV = '';
  const k = t !== 'text' ? numKeys(c) : null;
  for (let i = 0; i < n; i++) {
    const r = start + i;
    const v = cell(r, c);
    if (!v.trim()) { empty++; continue; }
    seen.add(v);
    const key = k ? k[r] : v.toLowerCase();
    if (k && key !== key) continue;
    if (min === null || key < min) { min = key; minV = v; }
    if (max === null || key > max) { max = key; maxV = v; }
  }
  return { t, distinct: seen.size, empty, minV, maxV };
}

function openPop(c, anchor) {
  const st = columnStats(c);
  el.pop.replaceChildren();
  const title = make('h3', '', S.headers[c]);
  title.id = 'col-pop-title';
  const dl = make('dl', 'popover__stats');
  const add = (k, v) => dl.append(make('dt', '', k), make('dd', '', v));
  add('Type', st.t === 'number' ? 'Number' : st.t === 'date' ? 'Date (ISO)' : 'Text');
  add('Distinct values', fmt(st.distinct));
  add('Empty cells', fmt(st.empty));
  add('Min', st.minV || '—');
  add('Max', st.maxV || '—');
  const row = make('div', 'row');
  const btn = (label, fn) => { const b = make('button', 'btn btn--small', label); b.type = 'button'; b.addEventListener('click', () => { closePop(); fn(); }); row.append(b); return b; };
  const first = btn('Sort ascending', () => setSort(c, 1));
  btn('Sort descending', () => setSort(c, -1));
  btn('Filter', () => addFilter(c));
  btn('Hide column', () => { if (S.vis.length > 1) { S.hidden.add(c); columnsChanged(); } else toast('At least one column stays visible'); });
  el.pop.append(title, dl, row);
  el.pop.hidden = false;
  el.pop._anchor = anchor;
  placePop();
  first.focus({ preventScroll: true });
}

// Keeps the popover next to its header button while the page or the grid scrolls.
function placePop() {
  if (el.pop.hidden || !el.pop._anchor) return;
  const a = el.pop._anchor.getBoundingClientRect();
  if (!a.width) { closePop(); return; }
  const w = el.pop.offsetWidth;
  const h = el.pop.offsetHeight;
  const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  el.pop.style.left = `${left}px`;
  el.pop.style.top = `${top}px`;
}

function closePop() {
  if (el.pop.hidden) return;
  el.pop.hidden = true;
}

document.addEventListener('pointerdown', (e) => {
  if (!el.pop.hidden && !el.pop.contains(e.target) && !e.target.closest('.hcell__info')) closePop();
});
el.grid.addEventListener('scroll', placePop, { passive: true });
window.addEventListener('scroll', placePop, { passive: true });

/* ---------- filters ---------- */

function addFilter(c = (S.vis[0] ?? 0)) {
  S.filters.push({ col: c, op: 'contains', value: '' });
  renderFilters();
  const inputs = el.filterBar.querySelectorAll('.filter__value');
  inputs[inputs.length - 1]?.focus();
}

let filterTimer = 0;
function renderFilters() {
  el.filterBar.replaceChildren();
  el.filterBar.hidden = S.filters.length === 0;
  S.filters.forEach((f, i) => {
    const row = make('div', 'filter');
    const uid = `f${i}`;
    const colSel = make('select', 'filter__col');
    colSel.id = `${uid}-col`;
    colSel.setAttribute('aria-label', `Filter ${i + 1} column`);
    S.headers.forEach((h, c) => { const o = make('option', '', h); o.value = c; colSel.append(o); });
    colSel.value = f.col;
    const opSel = make('select', 'filter__op');
    opSel.setAttribute('aria-label', `Filter ${i + 1} condition`);
    [['contains', 'contains'], ['equals', 'equals'], ['empty', 'is empty'], ['notempty', 'is not empty']].forEach(([v, t]) => { const o = make('option', '', t); o.value = v; opSel.append(o); });
    opSel.value = f.op;
    const val = make('input', 'filter__value');
    val.type = 'text';
    val.value = f.value;
    val.placeholder = 'value';
    val.setAttribute('aria-label', `Filter ${i + 1} value`);
    val.hidden = f.op === 'empty' || f.op === 'notempty';
    const rm = make('button', 'btn btn--small btn--ghost', '✕');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remove filter ${i + 1}`);
    colSel.addEventListener('change', () => { f.col = Number(colSel.value); applyFilter(); });
    opSel.addEventListener('change', () => { f.op = opSel.value; val.hidden = f.op === 'empty' || f.op === 'notempty'; applyFilter(); });
    val.addEventListener('input', () => { f.value = val.value; clearTimeout(filterTimer); filterTimer = setTimeout(applyFilter, 150); });
    rm.addEventListener('click', () => { S.filters.splice(i, 1); renderFilters(); applyFilter(); el.addFilter.focus(); });
    row.append(colSel, opSel, val, rm);
    el.filterBar.append(row);
  });
}

el.addFilter.addEventListener('click', () => addFilter());

/* ---------- toolbar ---------- */

let searchTimer = 0;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.query = el.search.value; S.sel = null; el.grid.scrollTop = 0; applyFilter(); }, 150);
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.search.value) {
    e.preventDefault();
    e.stopPropagation();
    el.search.value = '';
    clearTimeout(searchTimer);
    S.query = '';
    applyFilter();
  }
});

el.delimiter.addEventListener('change', () => {
  if (!S.file) return;
  S.delimiter = el.delimiter.value;
  parse(S.file, S.truncated ? PREVIEW_ROWS : 0);
});

el.hasHeader.addEventListener('change', () => {
  S.hasHeader = el.hasHeader.checked && S.raw.length > 1;
  el.hasHeader.checked = S.hasHeader;
  S.type = [];
  S.num = [];
  S.sortCol = -1;
  S.sortDir = 0;
  S.sel = null;
  closeDrawer();
  setupColumns();
  renderFilters();
  applyView();
});

el.decimalComma.addEventListener('change', () => {
  S.decimalComma = el.decimalComma.checked;
  S.type = [];
  S.num = [];
  if (S.sortCol >= 0) buildHead();
  applyView();
});

el.toggleCols.addEventListener('click', () => {
  const open = el.colPanel.hidden;
  el.colPanel.hidden = !open;
  el.toggleCols.setAttribute('aria-expanded', String(open));
});

el.openAnother.addEventListener('click', () => el.input.click());

el.download.addEventListener('click', () => {
  if (!S.raw.length) return;
  const fields = S.vis.map((c) => S.headers[c]);
  const data = new Array(S.view.length);
  for (let i = 0; i < S.view.length; i++) { const r = S.view[i]; data[i] = S.vis.map((c) => cell(r, c)); }
  const csv = Papa.unparse({ fields, data }, { newline: '\r\n' });
  const base = S.file.name.replace(/\.[^.]+$/, '') || 'data';
  const name = `${base}-view.csv`;
  downloadBlob(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }), name);
  toast(`Saved ${name} (${fmt(data.length)} rows)`);
});

/* ---------- global keys ---------- */

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !el.toolbar.hidden) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (e.key === 'Escape') {
    if (!el.pop.hidden) { closePop(); el.pop._anchor?.focus(); return; }
    if (!el.drawer.hidden) { closeDrawer(); if (!typing) el.grid.focus({ preventScroll: true }); return; }
    if (!typing && S.query) { el.search.value = ''; S.query = ''; applyFilter(); }
  }
});

wireDropzone(el.zone, el.input, handleFiles);
// Dropping a file anywhere on the viewer replaces the current file.
['dragover', 'drop'].forEach((t) => el.gridWrap.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'drop') { const files = [...(e.dataTransfer?.files || [])]; if (files.length) handleFiles(files); }
}));

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-orders.csv');
  const blob = await res.blob();
  await handleFiles([new File([blob], 'north-pier-supply-orders.csv', { type: 'text/csv' })]);
  setSort(6, -1);
  el.search.value = 'port alder';
  S.query = 'port alder';
  applyFilter();
  select(0, 2, { open: false, focus: false });
};

// Lets the test suite exercise the >300 MB preview path with a small fixture.
export function setBigFileLimit(bytes) { BIG_FILE = bytes; }

export { handleFiles };
