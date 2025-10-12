// ---- Config ----
const PACK_URL = './data/pack.json';
const TERMS_URL = './data/terms.json';

// ---- Shorthands ----
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// ---- Data stores ----
let PACK = null;
let VERSIONS = {};        // version_id -> recipe version
let COCKTAILS = [];       // array of cocktails
let ING_LIST = [];        // [{id, name}]
let ING_MAP = {};         // id -> name

// Terms model (explicit search terms)
let TERMS = [];           // [{ id, label, includes: string[] }]
let TERM_MAP = {};        // id -> { id, label, includes }
let TERM_TO_INGIDS = {};  // termId -> Set<ingredientId> (resolved from includes[])

// ---- State (persisted to sessionStorage) ----
const SKEY_REQ = 'requiredTerm';
const SKEY_OPT = 'optionalTerm';
const SKEY_EXC = 'excludeTerm';
const SKEY_Q =   'nameQuery';

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

// Compile a string "pattern" into a matcher. If it parses as a regex, treat as regex; else exact-match on id or display name.
function makeMatcher(pattern) {
  // Heuristic: treat as regex if string contains regex metacharacters or starts/ends with ^ or $
  const looksRegex = /[.^$*+?()[\]{}|\\]/.test(pattern);
  if (looksRegex) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
    if (re) {
      return ({ id, name }) => re.test(id) || re.test(name);
    }
  }
  const pnorm = norm(pattern);
  return ({ id, name }) => norm(id) === pnorm || norm(name) === pnorm;
}

// Precompute all ingredients as {id, name} and a matcher function
function buildTermIndex(termsJson) {
  TERMS = Array.isArray(termsJson?.terms) ? termsJson.terms : [];
  TERM_MAP = Object.fromEntries(TERMS.map(t => [t.id, t]));
  TERM_TO_INGIDS = {};

  const allIngs = ING_LIST.map(({ id, name }) => ({ id, name: name || prettify(id) }));

  for (const term of TERMS) {
    const includes = Array.isArray(term.includes) ? term.includes : [];
    const matchers = includes.map(makeMatcher);
    const hitIds = new Set();

    for (const ing of allIngs) {
      if (matchers.some(m => m(ing))) hitIds.add(ing.id);
    }
    TERM_TO_INGIDS[term.id] = hitIds;
  }
}

function displayNameForTerm(termId) {
  return (TERM_MAP[termId]?.label) || prettify(termId);
}

// ---- Loaders ----
async function loadAll() {
  // Load pack
  const res = await fetch(PACK_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load pack.json');
  PACK = await res.json();

  COCKTAILS = PACK.cocktails || [];
  VERSIONS = PACK.versions || {};

  // Ingredient list from PACK (canonical list)
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

  ING_LIST = base.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  ING_MAP = Object.fromEntries(ING_LIST.map(x => [x.id, x.name]));

  // Load explicit terms
  const tres = await fetch(TERMS_URL, { cache: 'no-store' });
  if (!tres.ok) throw new Error('Failed to load terms.json');
  const termsJson = await tres.json();
  buildTermIndex(termsJson);
}

// ---- Chips ----
function renderChips() {
  const rows = [
    { wrap: $('#req-chips'), set: reqSelected, kind: 'req' },
    { wrap: $('#opt-chips'), set: optSelected, kind: 'opt' },
    { wrap: $('#exc-chips'), set: excSelected, kind: 'exc' },
  ];
  rows.forEach(({ wrap, set, kind }) => {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    [...set].forEach(id => {
      const chip = document.createElement('div');
      chip.className = `chip ${kind}`;
      const span = document.createElement('span');
      span.textContent = displayNameForTerm(id);
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

// ---- Autocomplete (terms only) ----
function setupAutocomplete(prefix, targetSet) {
  const input = $(`#${prefix}-input`);
  const list = $(`#${prefix}-suggest`);
  let items = [];
  let activeIdx = -1;

  function clearList() { while (list.firstChild) list.removeChild(list.firstChild); }

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
      li.textContent = it.label;
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

  function compareSuggestions(a, b, q) {
    const startsA = a.key.startsWith(q) ? 0 : 1;
    const startsB = b.key.startsWith(q) ? 0 : 1;
    if (startsA !== startsB) return startsA - startsB;
    if (a.key.length !== b.key.length) return a.key.length - b.key.length;
    return a.label.localeCompare(b.label);
  }

  input.addEventListener('input', e => {
    const q = norm(e.target.value);
    if (!q) { list.classList.add('hidden'); clearList(); return; }

    const out = [];
    for (const t of TERMS) {
      const key = norm(t.label || t.id);
      if (key.includes(q)) out.push({ id: t.id, label: t.label || prettify(t.id), key });
    }
    out.sort((a, b) => compareSuggestions(a, b, q));

    items = out.slice(0, 60);
    activeIdx = Math.min(activeIdx, items.length - 1);
    showSuggestions();
  });

  input.addEventListener('keydown', e => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); showSuggestions(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); showSuggestions(); }
    if (e.key === 'Enter')     { e.preventDefault(); if (activeIdx >= 0) select(items[activeIdx].id); }
    if (e.key === 'Escape')    { list.classList.add('hidden'); clearList(); }
  });

  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) list.classList.add('hidden');
  });
}

// ---- Any-version helpers ----
function ingredientIdsForVersion(v) {
  return new Set((v?.ingredients || []).map(i => i.id));
}
function ingredientIdsForAllVersionsOfCocktail(cocktail) {
  // Gather all versions by canonical slug match
  const canonId = cocktail.id;
  const versions = Object.values(VERSIONS).filter(v => (v.name_slug || slug(v.name)) === canonId);
  const primary = cocktail.primary_version_id ? VERSIONS[cocktail.primary_version_id] : null;
  if (primary && !versions.find(v => v.id === primary.id)) versions.unshift(primary);

  const agg = new Set();
  versions.forEach(v => (v.ingredients || []).forEach(i => agg.add(i.id)));
  return { versions, allIngIds: agg, primaryVersion: versions[0] || primary };
}

// Given a set of ingredient IDs and a selected term, return true if there’s any overlap
function cocktailHasAnyFromTerm(ingSet, termId) {
  const allowed = TERM_TO_INGIDS[termId] || new Set();
  for (const id of allowed) if (ingSet.has(id)) return true;
  return false;
}

// ---- Match logic (terms) ----
function passesRequired(ingSet, requiredTermIds) {
  for (const t of requiredTermIds) if (!cocktailHasAnyFromTerm(ingSet, t)) return false;
  return true;
}
function failsExcluded(ingSet, excludedTermIds) {
  for (const t of excludedTermIds) if (cocktailHasAnyFromTerm(ingSet, t)) return true;
  return false;
}
function optionalScore(ingSet, optionalTermIds) {
  let score = 0;
  for (const t of optionalTermIds) if (cocktailHasAnyFromTerm(ingSet, t)) score += 1;
  return score;
}

// ---- Results ----
function clearResults() {
  const grid = $('#results');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
}
function ensureCountNode() {
  let counter = $('#result-count');
  if (!counter) {
    counter = document.createElement('div');
    counter.id = 'result-count';
    counter.className = 'result-count muted';
    const gridWrap = $('#results-wrap') || $('#results').parentElement || document.body;
    gridWrap.insertBefore(counter, gridWrap.firstChild);
  }
  return counter;
}

function renderResults() {
  const grid = $('#results');
  const empty = $('#empty');
  clearResults();

  const req = [...reqSelected];
  const opt = [...optSelected];
  const exc = [...excSelected];
  const q = norm(nameQuery);

  const items = [];
  for (const c of COCKTAILS) {
    if (q && !norm(c.name).includes(q)) continue;

    const { versions, allIngIds, primaryVersion } = ingredientIdsForAllVersionsOfCocktail(c);
    if (!versions.length) continue;

    if (!passesRequired(allIngIds, req)) continue;
    if (failsExcluded(allIngIds, exc)) continue;

    const score = optionalScore(allIngIds, opt);

    // "Missing": primary-version ingredients not covered by union of selected req+opt term sets
    const covered = new Set();
    for (const t of [...req, ...opt]) for (const id of (TERM_TO_INGIDS[t] || [])) covered.add(id);
    const missing = (primaryVersion?.ingredients || [])
      .filter(i => !covered.has(i.id))
      .map(i => i.id);

    items.push({
      cid: c.id,
      name: c.name,
      image: c.image || primaryVersion?.image || '',
      versionId: c.primary_version_id,
      optScore: score,
      missing
    });
  }

  // Counter
  ensureCountNode().textContent = `${items.length} cocktails out of ${COCKTAILS.length}`;

  if (!items.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  // Sort: more optional matches first, then name
  items.sort((a, b) => (b.optScore - a.optScore) || a.name.localeCompare(b.name));

  // Cards
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

    const b2 = document.createElement('span');
    b2.className = 'badge missing';
    b2.textContent = `Missing: ${it.missing.map(id => ING_MAP[id] || id).join(', ') || '—'}`;

    badges.appendChild(b2);
    meta.appendChild(h3);
    meta.appendChild(badges);

    card.appendChild(img);
    card.appendChild(meta);
    card.addEventListener('click', () => openModal(it.cid));
    grid.appendChild(card);
  });
}

// ---- Modal (unchanged except it already supports versions) ----
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

    // ingredients (bold if covered by any selected term)
    clear(ingUl);
    const covered = new Set();
    for (const t of [...reqSelected, ...optSelected]) for (const id of (TERM_TO_INGIDS[t] || [])) covered.add(id);

    (v.ingredients || []).forEach(i => {
      const li = document.createElement('li');
      if (covered.has(i.id)) {
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
      const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      instr.innerHTML = `<ol>${lines.map(line => `<li>${line}</li>`).join('')}</ol>`;
    } else {
      instr.innerHTML = '';
    }

    // garnish
    if (v.garnish && !v.garnish.includes('N/A')) {
      garn_s.style.display = '';
      garn.innerHTML = v.garnish.trim();
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

  const closeBtn = $('#modal-close');
  if (closeBtn) closeBtn.focus();

  const close = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  };
  $('#modal-close').onclick = close;
  $('#modal-backdrop').onclick = close;

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
