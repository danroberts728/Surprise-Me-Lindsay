// src/app.js

// ---- Config ----
const PACK_URL = './data/pack.json';

// ---- Shorthands ----
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// ---- Data stores ----
let PACK = null;
let VERSIONS = {};    // version_id -> recipe version
let COCKTAILS = [];   // array of cocktails
let ING_LIST = [];    // [{id, name}]
let ING_MAP = {};     // id -> name

// ---- State (persisted to sessionStorage) ----
const SKEY_REQ = 'requiredIngredient';
const SKEY_OPT = 'optionalIngredient';
const SKEY_EXC = 'excludeIngredient';
const SKEY_Q = 'nameQuery';

let reqSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_REQ) || '[]'));
let optSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_OPT) || '[]'));
let excSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_EXC) || '[]'));
let nameQuery = sessionStorage.getItem(SKEY_Q) || '';

// ---- Utils ----
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function prettify(id) {
  return (id || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function slug(s = '') {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function saveState() {
  sessionStorage.setItem(SKEY_REQ, JSON.stringify([...reqSelected]));
  sessionStorage.setItem(SKEY_OPT, JSON.stringify([...optSelected]));
  sessionStorage.setItem(SKEY_EXC, JSON.stringify([...excSelected]));
  sessionStorage.setItem(SKEY_Q, nameQuery);
}

// ---- Loaders ----
async function loadAll() {
  const res = await fetch(PACK_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load pack.json');
  PACK = await res.json();

  COCKTAILS = PACK.cocktails || [];
  VERSIONS = PACK.versions || {};

  // Ingredient list (no groups, no aliases)
  let base = [];
  if (PACK.ingredients) {
    base = Object.values(PACK.ingredients)
      .filter(i => i && i.id)
      .map(i => ({ id: i.id, name: i.name || prettify(i.id) }));
  } else {
    const seen = {};
    for (const v of Object.values(VERSIONS)) {
      (v.ingredients || []).forEach(i => {
        if (i?.id && !seen[i.id]) seen[i.id] = { id: i.id, name: i.name || prettify(i.id) };
      });
    }
    base = Object.values(seen);
  }

  ING_LIST = base.sort((a, b) => a.name.localeCompare(b.name));
  ING_MAP = Object.fromEntries(ING_LIST.map(x => [x.id, x.name]));
}

// ---- Chip rows ----
function renderChips() {
  const rows = [
    { wrap: $('#req-chips'), set: reqSelected, kind: 'req' },
    { wrap: $('#opt-chips'), set: optSelected, kind: 'opt' },
    { wrap: $('#exc-chips'), set: excSelected, kind: 'exc' },
  ];
  rows.forEach(({ wrap, set, kind }) => {
    // Clear
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    // Rebuild
    [...set].forEach(id => {
      const chip = document.createElement('div');
      chip.className = `chip ${kind}`;
      const span = document.createElement('span');
      span.textContent = ING_MAP[id] || id;
      const btn = document.createElement('button');
      btn.className = 'x';
      btn.setAttribute('aria-label', 'Remove');
      btn.textContent = '×';
      btn.addEventListener('click', () => {
        set.delete(id);
        saveState();
        renderChips();
        renderResults();
      });
      chip.appendChild(span);
      chip.appendChild(btn);
      wrap.appendChild(chip);
    });
  });

  const nameInput = $('#name-search');
  if (nameInput && nameInput.value !== nameQuery) nameInput.value = nameQuery;
}

// ---- Autocomplete (no HTML strings; using existing ULs) ----
function setupAutocomplete(prefix, targetSet) {
  const input = $(`#${prefix}-input`);
  const list = $(`#${prefix}-suggest`);
  let items = [];
  let activeIdx = -1;

  function clearList() {
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function showSuggestions() {
    clearList();
    list.classList.remove('hidden');
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty muted';
      li.textContent = 'No matches.';
      list.appendChild(li);
      return;
    }
    items.forEach((it, idx) => {
      const li = document.createElement('li');
      li.className = 'member';
      li.textContent = it.name;
      if (idx === activeIdx) li.classList.add('active');
      li.addEventListener('click', () => select(it.id));
      list.appendChild(li);
    });
  }

  function select(id) {
    if (!id) return;
    if (!targetSet.has(id)) {
      targetSet.add(id);
      saveState();
      renderChips();
      renderResults();
    }
    input.value = '';
    list.classList.add('hidden');
    activeIdx = -1;
    clearList();
  }

  input.addEventListener('input', e => {
    const q = norm(e.target.value);
    if (!q) { list.classList.add('hidden'); clearList(); return; }
    items = ING_LIST.filter(x => norm(x.name).includes(q)).slice(0, 60);
    activeIdx = Math.min(activeIdx, items.length - 1);
    showSuggestions();
  });

  input.addEventListener('keydown', e => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); showSuggestions(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); showSuggestions(); }
    if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0) select(items[activeIdx].id); }
    if (e.key === 'Escape') { list.classList.add('hidden'); clearList(); }
  });

  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) { list.classList.add('hidden'); }
  });
}

// ---- Matching (exact IDs only) ----
function requiredPasses(recipeIngIds, requiredIds) {
  for (const rid of requiredIds) if (!recipeIngIds.includes(rid)) return false;
  return true;
}
function excludedFails(recipeIngIds, excludedIds) {
  for (const x of excludedIds) if (recipeIngIds.includes(x)) return true;
  return false;
}
function optionalScore(recipeIngIds, optionalIds) {
  let hits = 0;
  for (const oid of optionalIds) if (recipeIngIds.includes(oid)) hits++;
  return hits;
}

// ---- Results ----
function clearResults() {
  const grid = $('#results');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
}
function renderResults() {
  const grid = $('#results');
  const empty = $('#empty');
  clearResults();

  const req = [...reqSelected];
  const opt = [...optSelected];
  const exc = [...excSelected];
  const q = norm(nameQuery);

  const selectedExact = new Set([...reqSelected, ...optSelected]);

  const items = [];
  for (const c of COCKTAILS) {
    if (q && !norm(c.name).includes(q)) continue;

    const primary = VERSIONS[c.primary_version_id];
    if (!primary) continue;

    const ingIds = (primary.ingredients || []).map(i => i.id);
    if (!requiredPasses(ingIds, req)) continue;
    if (excludedFails(ingIds, exc)) continue;

    const optPts = optionalScore(ingIds, opt);
    const missing = (primary.ingredients || [])
      .filter(i => !selectedExact.has(i.id))
      .map(x => x.id);

    items.push({
      cid: c.id,
      name: c.name,
      image: c.image || primary.image || '',
      versionId: c.primary_version_id,
      optScore: optPts,
      missing,
      missCount: missing.length
    });
  }

  if (!items.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  items.sort((a, b) => b.optScore - a.optScore || a.missCount - b.missCount || a.name.localeCompare(b.name));

  // Build cards using DOM nodes only
  items.forEach(it => {
    const card = document.createElement('article');
    card.className = 'card';

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    if (it.image) img.src = it.image;

    const meta = document.createElement('div');
    meta.className = 'meta';

    const h3 = document.createElement('h3');
    h3.className = 'name';
    h3.textContent = it.name;

    const badges = document.createElement('div');
    badges.className = 'badges';

    const b1 = document.createElement('span');
    b1.className = 'badge';
    b1.textContent = `Optional hits: ${it.optScore}`;

    const b2 = document.createElement('span');
    b2.className = 'badge missing';
    b2.textContent = `Missing: ${it.missing.map(id => ING_MAP[id] || id).join(', ') || '—'}`;

    badges.appendChild(b1);
    badges.appendChild(b2);

    meta.appendChild(h3);
    meta.appendChild(badges);

    card.appendChild(img);
    card.appendChild(meta);

    card.addEventListener('click', () => openModal(it.cid));
    grid.appendChild(card);
  });
}

// ---- Modal ----
function openModal(canonId) {
  const modal = $('#modal');
  const title = $('#modal-title');
  const img = $('#modal-img');
  const ingUl = $('#modal-ingredients');
  const instr = $('#modal-instructions');
  const garn_s = $('#modal-garnish-section');
  const garn = $('#modal-garnish');
  const meta = $('#modal-meta');
  const tabs = $('#modal-tabs');

  // versions for this canonical id
  const versions = Object.values(VERSIONS).filter(v => (v.name_slug || slug(v.name)) === canonId);
  const primaryId = (COCKTAILS.find(c => c.id === canonId) || {}).primary_version_id;
  const pver = primaryId ? VERSIONS[primaryId] : null;
  if (pver && !versions.find(v => v.id === pver.id)) versions.unshift(pver);
  if (!versions.length) return;

  title.textContent = versions[0].name || canonId;

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function renderVersion(v) {
    // image
    img.alt = v.name || '';
    img.removeAttribute('src');
    if (v.image) img.src = v.image;

    // ingredients (bold for owned, .missing for not selected)
    clear(ingUl);
    const selExact = new Set([...reqSelected, ...optSelected]);
    (v.ingredients || []).forEach(i => {
      const li = document.createElement('li');
      if (selExact.has(i.id)) {
        const strong = document.createElement('strong');
        strong.textContent = i.name || ING_MAP[i.id] || i.id;
        li.appendChild(strong);
      } else {
        const span = document.createElement('span');
        span.className = 'missing';
        span.textContent = i.name || ING_MAP[i.id] || i.id;
        li.appendChild(span);
      }
      if (i.measure) {
        const sep = document.createTextNode(' — ');
        const meas = document.createElement('span');
        meas.className = 'measure';
        meas.textContent = i.measure;
        li.appendChild(sep);
        li.appendChild(meas);
      }
      ingUl.appendChild(li);
    });

    // instructions
    if (v.instructions) {
      const normalized = v.instructions.replace(/\\n/g, '\n');
      const lines = normalized
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      instr.innerHTML = `<ol>${lines.map(line => `<li>${line}</li>`).join('')}</ol>`
    } else {
      instr.innerHTML = '';
    }

    // garnish
    if (v.garnish && !v.garnish.includes('N/A')) {
      garn_s.style.display = '';
      const garnish = v.garnish.trim();
      garn.innerHTML = garnish;
    } else {
      garn_s.style.display = 'none';
    }

    // meta
    clear(meta);
    const a = v.attribution || {};
    const bits = [];
    if (a.author) bits.push(`Author: ${a.author}`);
    if (a.license) bits.push(`License: ${a.license}`);
    if (a.source_url) bits.push('Source:');
    if (bits.length) {
      const seg = document.createElement('span');
      seg.textContent += bits.filter(x => x !== 'Source:').join(' • ');
      meta.appendChild(seg);
      if (a.source_name) {
        const dot = seg.textContent ? document.createTextNode(' • ') : document.createTextNode('');
        if (seg.textContent) meta.appendChild(dot);
        const link = document.createElement('a');
        link.href = a.source_url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = a.source_name;
        meta.appendChild(link);
      }
    }
  }

  // tabs
  while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
  versions.forEach((v, idx) => {
    const btn = document.createElement('button');
    btn.textContent = v.id || `Version ${idx + 1}`;
    if (idx === 0) btn.classList.add('active');
    btn.addEventListener('click', () => {
      $$('.modal__tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderVersion(v);
    });
    tabs.appendChild(btn);
  });

  renderVersion(versions[0]);

  // open/close
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  // Focus on close button
  const closeBtn = $('#modal-close');
  if (closeBtn) closeBtn.focus();

  const close = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  };
  $('#modal-close').onclick = close;
  $('#modal-backdrop').onclick = close;

  // Close on escape
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

// ---- Clear all ----
function clearAll() {
  reqSelected.clear();
  optSelected.clear();
  excSelected.clear();
  nameQuery = '';
  saveState();
  renderChips();
  renderResults();
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', async () => {
  await loadAll();

  renderChips();
  setupAutocomplete('req', reqSelected);
  setupAutocomplete('opt', optSelected);
  setupAutocomplete('exc', excSelected);

  const nameInput = $('#name-search');
  if (nameInput) {
    nameInput.value = nameQuery;
    nameInput.addEventListener('input', (e) => {
      nameQuery = e.target.value || '';
      saveState();
      renderResults();
    });
  }

  const clearBtn = $('#clear-all');
  if (clearBtn) clearBtn.addEventListener('click', clearAll);

  renderResults();
});
