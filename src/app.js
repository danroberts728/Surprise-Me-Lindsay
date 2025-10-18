/* app.js — base-liquor checkboxes + responds_to-aware filtering
   Assumptions:
   - pack.json, terms.json, aliases.json live alongside this file (adjust URLs if needed).
   - Keeps your existing UI: name search, required/optional/excluded chips, results, modal.
*/

const PACK_URL    = './data/pack.json';
const TERMS_URL   = './data/terms.json';
const ALIASES_URL = './data/aliases.json';

// -------------------- DOM helpers --------------------
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// -------------------- State --------------------
let PACK = null;
let VERSIONS = {};   // id -> version
let COCKTAILS = [];  // [{id, name, ...}]
let ING_LIST = [];   // [{id, name}]
let ING_MAP  = {};   // id -> name

let TERMS = [];           // [{id, label, includes: [...] }]
let TERM_MAP = {};        // id -> term
let TERM_TO_INGIDS = {};  // termId -> Set(ingId)

let ALIASES = {};         // id -> { id, name, responds_to: [...] }

const SKEY_REQ  = 'requiredTerms';
const SKEY_OPT  = 'optionalTerms';
const SKEY_EXC  = 'excludedTerms';
const SKEY_Q    = 'nameQuery';
const SKEY_BASE = 'baseLiquors';

let reqSelected  = new Set(JSON.parse(sessionStorage.getItem(SKEY_REQ)  || '[]'));
let optSelected  = new Set(JSON.parse(sessionStorage.getItem(SKEY_OPT)  || '[]'));
let excSelected  = new Set(JSON.parse(sessionStorage.getItem(SKEY_EXC)  || '[]'));
let nameQuery    = sessionStorage.getItem(SKEY_Q) || '';
let baseSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_BASE) || '[]'));

// -------------------- Constants --------------------
const BASE_LIQUORS = [
  'brandy',
  'cachaca',
  'gin',
  'grappa',
  'mezcal',
  'rum',
  'scotch',
  'tequila',
  'vodka',
  'whiskey'
];

// base -> Set(ingredientId) (built from aliases + fallback)
let BASE_TO_INGIDS = {};

// -------------------- Utils --------------------
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
  return (id || '').split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}
function slug(s = '') {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function saveState() {
  sessionStorage.setItem(SKEY_REQ,  JSON.stringify([...reqSelected]));
  sessionStorage.setItem(SKEY_OPT,  JSON.stringify([...optSelected]));
  sessionStorage.setItem(SKEY_EXC,  JSON.stringify([...excSelected]));
  sessionStorage.setItem(SKEY_Q,    nameQuery);
  sessionStorage.setItem(SKEY_BASE, JSON.stringify([...baseSelected]));
}

// -------------------- Loaders --------------------
async function loadAll() {
  // pack
  const pres = await fetch(PACK_URL, { cache: 'no-store' });
  if (!pres.ok) throw new Error('Failed to load pack.json');
  PACK = await pres.json();

  COCKTAILS = Array.isArray(PACK.cocktails) ? PACK.cocktails : [];
  VERSIONS  = PACK.versions || {};

  // Build ingredient list from the union of PACK.ingredients and all version ingredients
  const seen = new Map();
  if (PACK.ingredients) {
    for (const i of Object.values(PACK.ingredients)) {
      if (i?.id) seen.set(i.id, { id: i.id, name: i.name || prettify(i.id) });
    }
  }
  for (const v of Object.values(VERSIONS)) {
    for (const i of (v.ingredients || [])) {
      if (i?.id && !seen.has(i.id)) seen.set(i.id, { id: i.id, name: i.name || prettify(i.id) });
    }
  }
  ING_LIST = [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  ING_MAP  = Object.fromEntries(ING_LIST.map(x => [x.id, x.name]));

  // terms
  const tres = await fetch(TERMS_URL, { cache: 'no-store' });
  if (!tres.ok) throw new Error('Failed to load terms.json');
  const tjson = await tres.json();
  TERMS    = Array.isArray(tjson?.terms) ? tjson.terms : [];
  TERM_MAP = Object.fromEntries(TERMS.map(t => [t.id, t]));
  buildTermIndex();

  // aliases
  const ares = await fetch(ALIASES_URL, { cache: 'no-store' });
  if (ares.ok) {
    const aj = await ares.json();
    ALIASES = aj?.ingredients || {};
  } else {
    ALIASES = {};
  }

  // base map
  buildBaseIndex();
}

function buildTermIndex() {
  TERM_TO_INGIDS = {};
  const allIngs = ING_LIST.map(({ id, name }) => ({ id, name: name || prettify(id) }));

  const makeMatcher = (pattern) => {
    const looksRegex = /[.^$*+?()[\]{}|\\]/.test(pattern);
    if (looksRegex) {
      try {
        const re = new RegExp(pattern, 'i');
        return ({ id, name }) => re.test(id) || re.test(name);
      } catch { /* fall through */ }
    }
    const p = norm(pattern);
    return ({ id, name }) => norm(id) === p || norm(name) === p;
  };

  for (const term of TERMS) {
    const m = (Array.isArray(term.includes) ? term.includes : []).map(makeMatcher);
    const hitIds = new Set();
    for (const ing of allIngs) {
      if (m.some(fn => fn(ing))) hitIds.add(ing.id);
    }
    TERM_TO_INGIDS[term.id] = hitIds;
  }
}

// Build base → ingredientIds using aliases.responds_to first, then a minimal fallback regex.
function buildBaseIndex() {
  BASE_TO_INGIDS = {};
  const BASES = new Set(BASE_LIQUORS);
  for (const b of BASE_LIQUORS) BASE_TO_INGIDS[b] = new Set();

  // 1) aliases.json: if an ingredient responds_to a base, map it.
  for (const ing of Object.values(ALIASES)) {
    const rs = Array.isArray(ing.responds_to) ? ing.responds_to.map(x => x.toLowerCase()) : [];
    for (const tag of rs) {
      if (BASES.has(tag)) BASE_TO_INGIDS[tag].add(ing.id);
    }
  }

  // 2) if a base exists as a bare ingredient id, include it
  for (const { id } of ING_LIST) {
    if (BASES.has(id)) BASE_TO_INGIDS[id].add(id);
  }

  // 3) minimal fallback for ingredients not in aliases.json
  const FALLBACK = {
    aguardiente: [/aguardiente/],
    brandy:      [/brandy|cognac|armagnac/],
    cachaca:     [/cacha[çc]a/],
    gin:         [/\bgin\b/, /old_tom_gin/, /london_dry_gin/],
    grappa:      [/grappa/],
    mezcal:      [/mezcal/],
    rum:         [/\brum\b/, /jamaican_.*rum/, /demerara_.*rum/, /goslings_.*rum/, /aged_rum|white_rum|dark_rum/],
    scotch:      [/scotch|single_malt|blended_.*scotch/],
    tequila:     [/tequila/],
    vodka:       [/vodka|absolut_/],
    whiskey:     [/whiskey|bourbon|rye_?whiskey|tennessee_?whiskey|irish_?whiskey/],
    whisky:      [/whisky|bourbon|rye_?whiskey|scotch|tennessee_?whiskey/],
  };

  for (const { id, name } of ING_LIST) {
    const hay = `${(id||'')} ${(name||'')}`.toLowerCase();
    for (const base of BASE_LIQUORS) {
      if (BASE_TO_INGIDS[base].has(id)) continue; // already captured by aliases
      const tests = FALLBACK[base] || [];
      if (tests.some(re => re.test(hay))) BASE_TO_INGIDS[base].add(id);
    }
  }
}

// -------------------- UI: chips & base checkboxes --------------------
function renderChips() {
  const rows = [
    { wrap: $('#req-chips'), set: reqSelected, kind: 'req' },
    { wrap: $('#opt-chips'), set: optSelected, kind: 'opt' },
    { wrap: $('#exc-chips'), set: excSelected, kind: 'exc' },
  ];
  rows.forEach(({ wrap, set, kind }) => {
    if (!wrap) return;
    wrap.innerHTML = '';
    [...set].forEach(id => {
      const chip = document.createElement('div');
      chip.className = `chip ${kind}`;
      const span = document.createElement('span');
      span.textContent = TERM_MAP[id]?.label || prettify(id);
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
      chip.append(span, btn);
      wrap.appendChild(chip);
    });
  });

  const nameInput = $('#name-search');
  if (nameInput) nameInput.value = nameQuery;
}

function renderBaseFilters() {
  const wrap = $('#base-filters');
  if (!wrap) return;
  wrap.innerHTML = '';
  BASE_LIQUORS.forEach(base => {
    const id = `base-${base}`;
    const label = prettify(base);
    const box = document.createElement('label');
    box.className = 'chip';
    box.style.cursor = 'pointer';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = baseSelected.has(base);
    input.style.marginRight = '8px';

    input.addEventListener('change', () => {
      if (input.checked) baseSelected.add(base);
      else baseSelected.delete(base);
      saveState();
      renderResults();
    });

    const span = document.createElement('span');
    span.textContent = label;

    box.append(input, span);
    wrap.appendChild(box);
  });
}

// -------------------- Autocomplete for terms --------------------
function setupAutocomplete(prefix, targetSet) {
  const input = $(`#${prefix}-input`);
  const list  = $(`#${prefix}-suggest`);
  if (!input || !list) return;

  list.classList.add('hidden');

  let items = [];
  let activeIdx = -1;

  const clearList = () => { list.innerHTML = ''; };
  const show = () => {
    list.classList.remove('hidden');
    if (!items.length) {
      list.innerHTML = '<li class="empty muted">No matches.</li>';
      return;
    }
    list.innerHTML = '';
    items.forEach((it, idx) => {
      const li = document.createElement('li');
      li.className = 'member';
      li.textContent = it.label;
      if (idx === activeIdx) li.classList.add('active');
      li.addEventListener('click', () => select(it.id));
      list.appendChild(li);
    });
  };
  const select = (id) => {
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
  };

  function compare(a, b, q) {
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
    out.sort((a, b) => compare(a, b, q));
    items = out.slice(0, 60);
    activeIdx = Math.min(activeIdx, items.length - 1);
    show();
  });

  input.addEventListener('keydown', e => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); show(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); show(); }
    if (e.key === 'Enter')     { e.preventDefault(); if (activeIdx >= 0) select(items[activeIdx].id); }
    if (e.key === 'Escape')    { list.classList.add('hidden'); }
  });

  document.addEventListener('click', (ev) => {
    if (!list.contains(ev.target) && ev.target !== input) list.classList.add('hidden');
  });
}

// -------------------- Matching --------------------
function ingredientIdsForVersion(v) {
  return new Set((v?.ingredients || []).map(i => i.id));
}
function versionsForCanonId(canonId) {
  const versions = Object.values(VERSIONS).filter(v => (v.name_slug || slug(v.name)) === canonId);
  const primaryId = (COCKTAILS.find(c => c.id === canonId) || {}).primary_version_id;
  const primary = primaryId ? VERSIONS[primaryId] : null;
  if (primary && !versions.find(v => v.id === primary.id)) versions.unshift(primary);
  return versions;
}
function allIngIdsForCocktail(cocktail) {
  const versions = versionsForCanonId(cocktail.id);
  const agg = new Set();
  versions.forEach(v => (v.ingredients || []).forEach(i => agg.add(i.id)));
  return { versions, allIngIds: agg, primary: versions[0] || null };
}

function cocktailHasAnyFromTerm(ingSet, termId) {
  const allowed = TERM_TO_INGIDS[termId] || new Set();
  for (const id of allowed) if (ingSet.has(id)) return true;
  return false;
}

function passesRequired(ingSet, requiredTermIds) {
  for (const t of requiredTermIds) if (!cocktailHasAnyFromTerm(ingSet, t)) return false;
  return true;
}
function failsExcluded(ingSet, excludedTermIds) {
  for (const t of excludedTermIds) if (cocktailHasAnyFromTerm(ingSet, t)) return true;
  return false;
}
function optionalScore(ingSet, optionalTermIds) {
  let s = 0;
  for (const t of optionalTermIds) if (cocktailHasAnyFromTerm(ingSet, t)) s += 1;
  return s;
}

// NEW: Base-liquor filter (AND across checked bases). Uses alias-driven BASE_TO_INGIDS.
function passesBaseLiquors(ingSet) {
  const bases = [...baseSelected];
  if (!bases.length) return true;
  for (const b of bases) {
    const allowed = BASE_TO_INGIDS[b] || new Set();
    let hit = false;
    for (const id of allowed) { if (ingSet.has(id)) { hit = true; break; } }
    if (!hit) return false;
  }
  return true;
}

// -------------------- Results --------------------
function clearResults() {
  const grid = $('#results');
  if (grid) grid.innerHTML = '';
}
function ensureCountNode() {
  let counter = $('#result-count');
  if (!counter) {
    counter = document.createElement('div');
    counter.id = 'result-count';
    counter.className = 'result-count muted';
    const grid = $('#results');
    const parent = grid?.parentElement || document.body;
    parent.insertBefore(counter, grid);
  }
  return counter;
}

function renderResults() {
  const grid  = $('#results');
  const empty = $('#empty');
  if (!grid) return;

  clearResults();

  const req = [...reqSelected];
  const opt = [...optSelected];
  const exc = [...excSelected];
  const q   = norm(nameQuery);

  const items = [];
  for (const c of COCKTAILS) {
    if (q && !norm(c.name).includes(q)) continue;

    const { versions, allIngIds, primary } = allIngIdsForCocktail(c);
    if (!versions.length) continue;

    // Base-liquor filter (acts like additional required)
    if (!passesBaseLiquors(allIngIds)) continue;

    if (!passesRequired(allIngIds, req)) continue;
    if (failsExcluded(allIngIds, exc)) continue;

    const score = optionalScore(allIngIds, opt);

    // Compute "missing" against union of selected req+opt term sets (for display only)
    const covered = new Set();
    for (const t of [...req, ...opt]) for (const id of (TERM_TO_INGIDS[t] || [])) covered.add(id);
    const missing = (primary?.ingredients || [])
      .filter(i => !covered.has(i.id))
      .map(i => i.id);

    items.push({
      cid: c.id,
      name: c.name,
      image: c.image || primary?.image || '',
      versionId: c.primary_version_id,
      optScore: score,
      missing
    });
  }

  ensureCountNode().textContent = `${items.length} cocktails out of ${COCKTAILS.length}`;

  if (!items.length) { if (empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');

  items.sort((a, b) => (b.optScore - a.optScore) || a.name.localeCompare(b.name));

  for (const it of items) {
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
    meta.append(h3, badges);

    card.append(img, meta);
    card.addEventListener('click', () => openModal(it.cid));
    grid.appendChild(card);
  }
}

// -------------------- Modal --------------------
function openModal(canonId) {
  const modal = $('#modal');
  const title = $('#modal-title');
  const img   = $('#modal-img');
  const ingUl = $('#modal-ingredients');
  const instr = $('#modal-instructions');
  const garnS = $('#modal-garnish-section');
  const garn  = $('#modal-garnish');
  const meta  = $('#modal-meta');
  const tabs  = $('#modal-tabs');

  const versions = versionsForCanonId(canonId);
  if (!versions.length) return;

  const clear = el => { if (el) el.innerHTML = ''; };
  if (title) title.textContent = versions[0].name || canonId;

  const renderVersion = (v) => {
    if (img) {
      img.alt = v.name || '';
      img.removeAttribute('src');
      if (v.image) img.src = v.image;
    }

    if (ingUl) {
      clear(ingUl);
      const covered = new Set();
      for (const t of [...reqSelected, ...optSelected]) for (const id of (TERM_TO_INGIDS[t] || [])) covered.add(id);

      (v.ingredients || []).forEach(i => {
        const li = document.createElement('li');
        const label = i.name || ING_MAP[i.id] || i.id;
        if (covered.has(i.id)) {
          const strong = document.createElement('strong');
          strong.textContent = label;
          li.appendChild(strong);
        } else {
          const span = document.createElement('span');
          span.className = 'missing';
          span.textContent = label;
          li.appendChild(span);
        }
        if (i.measure) {
          const sep = document.createTextNode(' — ');
          const meas = document.createElement('span');
          meas.className = 'measure';
          meas.textContent = Array.isArray(i.measure) ? i.measure.join(' / ') : i.measure;
          li.append(sep, meas);
        }
        ingUl.appendChild(li);
      });
    }

    if (instr) {
      const normalized = (v.instructions || '').replace(/\\n/g, '\n');
      const lines = normalized.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      instr.innerHTML = lines.length ? `<ol>${lines.map(l => `<li>${l}</li>`).join('')}</ol>` : '';
    }

    if (garnS && garn) {
      if (v.garnish && !/N\/A/i.test(v.garnish)) {
        garnS.style.display = '';
        garn.textContent = v.garnish.trim();
      } else {
        garnS.style.display = 'none';
      }
    }

    if (meta) {
      clear(meta);
      const a = v.attribution || {};
      const bits = [];
      if (a.author)  bits.push(`Author: ${a.author}`);
      if (a.license) bits.push(`License: ${a.license}`);
      if (bits.length) meta.append(bits.join(' • '));
      if (a.source_name && a.source_url) {
        if (bits.length) meta.append(document.createTextNode(' • '));
        const link = document.createElement('a');
        link.href = a.source_url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = a.source_name;
        meta.appendChild(link);
      }
    }
  };

  if (tabs) {
    clear(tabs);
    versions.forEach((v, idx) => {
      const btn = document.createElement('button');
      btn.textContent = v.id || `Version ${idx + 1}`;
      if (idx === 0) btn.classList.add('active');
      btn.addEventListener('click', () => {
        $$('#modal .modal__tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderVersion(v);
      });
      tabs.appendChild(btn);
    });
  }

  renderVersion(versions[0]);

  if (modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }
  $('#modal-close')?.addEventListener('click', closeModal);
  $('#modal-backdrop')?.addEventListener('click', closeModal);
  document.addEventListener('keydown', escCloseOnce);
}
function escCloseOnce(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escCloseOnce); } }
function closeModal() {
  const modal = $('#modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

// -------------------- Clear --------------------
function clearAll() {
  reqSelected.clear();
  optSelected.clear();
  excSelected.clear();
  baseSelected.clear();
  nameQuery = '';
  saveState();
  renderChips();
  renderBaseFilters();
  renderResults();
}

// -------------------- Boot --------------------
function setupNameSearch() {
  const nameInput = $('#name-search');
  if (!nameInput) return;
  nameInput.value = nameQuery;
  nameInput.addEventListener('input', (e) => {
    nameQuery = e.target.value || '';
    saveState();
    renderResults();
  });
}
function wireClear() { $('#clear-all')?.addEventListener('click', clearAll); }

function setupAutocompleteSuite() {
  setupAutocomplete('req', reqSelected);
  setupAutocomplete('opt', optSelected);
  setupAutocomplete('exc', excSelected);
}

window.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderChips();
  renderBaseFilters();
  setupAutocompleteSuite();
  setupNameSearch();
  wireClear();
  renderResults();
});
