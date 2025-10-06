// app.js — flat autocomplete, alias → canonical only, supersets on match
// Uses your existing HTML + CSS (no visual changes).

const PACK_URL = './data/pack.json';
const SUPERSETS_URL = './data/supersets.json';
const ALIASES_URL = './data/aliases.json';

const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

/* ------------ Data stores ------------ */
let PACK = null;
let VERSIONS = {};           // version_id -> RecipeVersion
let COCKTAILS = [];          // list of cocktails
let ING_LIST = [];           // [{id, name}] (ingredients only; no groups)
let ING_MAP = {};            // id -> name
let NAME_INDEX = {};         // norm(name) -> id

// Supersets: key is a canonical **ingredient id**; value: array of ingredient ids.
// We will enforce that key includes itself at runtime.
let SUPERSETS = {};          // { [ingredientId]: [ingredientIds...] }

// Aliases: lowercased alias string -> canonical ingredient id
let ALIAS_TO_ID = {};        // { 'whisky': 'whiskey', ... }

// Selections
const SKEY_REQ = 'reqIng';
const SKEY_OPT = 'optIng';
let reqSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_REQ) || '[]'));
let optSelected = new Set(JSON.parse(sessionStorage.getItem(SKEY_OPT) || '[]'));

/* ------------ Utils ------------ */
function norm(s){
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function escapeHtml(s=''){ return s.replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function prettify(id){ return (id||'').split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '); }
function slug(s=''){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }

/* ------------ Loaders ------------ */
async function loadAll(){
  const [packRes, supRes, aliRes] = await Promise.all([
    fetch(PACK_URL, {cache:'no-store'}),
    fetch(SUPERSETS_URL, {cache:'no-store'}).catch(()=>null),
    fetch(ALIASES_URL, {cache:'no-store'}).catch(()=>null),
  ]);
  if (!packRes?.ok) throw new Error('Failed to load pack.json');
  PACK = await packRes.json();

  // Pack
  COCKTAILS = PACK.cocktails || [];
  VERSIONS  = PACK.versions || {};

  // Ingredients (from pack)
  let baseIngredients = [];
  if (PACK.ingredients){
    baseIngredients = Object.values(PACK.ingredients)
      .filter(i => i && i.id)
      .map(i => ({ id: i.id, name: i.name || prettify(i.id) }));
  } else {
    // Fallback: crawl versions to discover unique ingredient ids
    const seen = {};
    for (const v of Object.values(VERSIONS)){
      (v.ingredients || []).forEach(i => {
        if (i?.id && !seen[i.id]) seen[i.id] = { id: i.id, name: i.name || prettify(i.id) };
      });
    }
    baseIngredients = Object.values(seen);
  }
  // Build maps
  ING_LIST = baseIngredients.sort((a,b)=>a.name.localeCompare(b.name));
  ING_MAP  = Object.fromEntries(ING_LIST.map(x => [x.id, x.name]));
  NAME_INDEX = Object.fromEntries(ING_LIST.map(x => [norm(x.name), x.id]));

  // Supersets
  if (supRes && supRes.ok){
    const sup = await supRes.json();
    // Accept two shapes:
    // 1) { groups:[ { id, name, members:[ids], aliases:[strings] }, ... ] }  <-- keys must be ingredient ids you already have
    // 2) { supersets: { ingredientId: [ids...] } }
    if (Array.isArray(sup.groups)){
      SUPERSETS = {};
      sup.groups.forEach(g => {
        if (!g?.id) return;
        const key = g.id;
        const members = Array.isArray(g.members) ? g.members.slice() : [];
        SUPERSETS[key] = members;
        // inline aliases that point to the canonical key
        (g.aliases || []).forEach(a => { ALIAS_TO_ID[norm(a)] = key; });
      });
    } else if (sup.supersets && typeof sup.supersets === 'object'){
      SUPERSETS = { ...sup.supersets };
    }
  }

  // Enforce "A includes A" whenever A is a known ingredient
  const ingSet = new Set(ING_LIST.map(i => i.id));
  Object.keys(SUPERSETS).forEach(key => {
    if (!Array.isArray(SUPERSETS[key])) SUPERSETS[key] = [];
    if (ingSet.has(key) && !SUPERSETS[key].includes(key)) SUPERSETS[key].push(key);
  });

  // Aliases
  if (aliRes && aliRes.ok){
    const ali = await aliRes.json();
    // Accept two shapes:
    // 1) { aliases: { "whisky":"whiskey", ... } }
    // 2) { aliases: [ { alias:"whisky", id:"whiskey" }, ... ] }
    if (ali.aliases && !Array.isArray(ali.aliases)){
      Object.entries(ali.aliases).forEach(([k,v]) => { ALIAS_TO_ID[norm(k)] = v; });
    } else if (Array.isArray(ali.aliases)){
      ali.aliases.forEach(row => {
        if (row?.alias && row?.id) ALIAS_TO_ID[norm(row.alias)] = row.id;
      });
    }
  }
}

/* ------------ Selection chips UI (unchanged look) ------------ */
function setupChipUI(){
  const reqWrap = $('#req-chips');
  const optWrap = $('#opt-chips');

  function chipEl(id, kind){
    const div = document.createElement('div');
    div.className = `chip ${kind}`;
    div.innerHTML = `<span>${ING_MAP[id] || id}</span><button class="x" aria-label="Remove">&times;</button>`;
    div.querySelector('.x').addEventListener('click', ()=>{
      (kind==='req'?reqSelected:optSelected).delete(id);
      persistSelections();
      setupChipUI.render();
      renderResults();
    });
    return div;
  }

  function render(){
    reqWrap.innerHTML = ''; optWrap.innerHTML = '';
    for (const id of reqSelected) reqWrap.appendChild(chipEl(id, 'req'));
    for (const id of optSelected) optWrap.appendChild(chipEl(id, 'opt'));
  }

  setupChipUI.render = render;
  render();
}
function persistSelections(){
  sessionStorage.setItem(SKEY_REQ, JSON.stringify([...reqSelected]));
  sessionStorage.setItem(SKEY_OPT, JSON.stringify([...optSelected]));
}

/* ------------ Autocomplete (NO groups in the list) ------------ */
function setupAutocomplete(prefix, targetSet){
  const input = $(`#${prefix}-input`);
  const list  = $(`#${prefix}-suggest`);
  let items = [];  // [{id, name}] ingredients only
  let activeIdx = -1;

  function getSuggestions(query){
    const q = norm(query);
    if (!q) return [];

    // If alias matches, only show canonical targets of aliases that match the typed text
    // Alias match rule: alias === q OR alias starts with q
    const aliasTargets = new Set();
    Object.entries(ALIAS_TO_ID).forEach(([aliasStr, canonicalId])=>{
      if (aliasStr === q || aliasStr.startsWith(q)) aliasTargets.add(canonicalId);
    });

    let pool;
    if (aliasTargets.size){
      // Only canonical ids mapped from matching aliases
      pool = [...aliasTargets].map(id => ({ id, name: ING_MAP[id] || id }));
    } else {
      // Normal substring search over canonical ingredient names
      pool = ING_LIST.filter(x => norm(x.name).includes(q));
    }

    // Deduplicate and sort
    const seen = new Set();
    const out = [];
    for (const it of pool){
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ id: it.id, name: it.name });
      if (out.length >= 60) break; // guardrail
    }
    return out.sort((a,b)=>a.name.localeCompare(b.name));
  }

  function render(){
    list.innerHTML = '';
    if (!items.length){
      list.classList.remove('hidden');
      list.innerHTML = '<li class="empty muted">No matches.</li>';
      return;
    }
    items.forEach((it, idx) => {
      const li = document.createElement('li');
      li.className = 'member';           // keep your existing visual style
      li.textContent = it.name;
      if (idx === activeIdx) li.classList.add('active');
      li.addEventListener('click', ()=> select(it.id));
      list.appendChild(li);
    });
  }

  function select(id){
    if (!id) return;
    if (!targetSet.has(id)){
      targetSet.add(id);      // only ingredient ids get added (no groups)
      persistSelections();
      setupChipUI.render();
      renderResults();
    }
    input.value = '';
    list.classList.add('hidden');
    activeIdx = -1;
  }

  input.addEventListener('input', e => {
    const q = e.target.value;
    if (!q){ list.classList.add('hidden'); list.innerHTML=''; return; }
    items = getSuggestions(q);
    activeIdx = Math.min(activeIdx, items.length-1);
    render();
  });

  input.addEventListener('keydown', e => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown'){ e.preventDefault(); activeIdx = Math.min(activeIdx+1, items.length-1); render(); }
    if (e.key === 'ArrowUp'){ e.preventDefault(); activeIdx = Math.max(activeIdx-1, 0); render(); }
    if (e.key === 'Enter'){ e.preventDefault(); if (activeIdx >= 0) select(items[activeIdx].id); }
    if (e.key === 'Escape'){ list.classList.add('hidden'); }
  });

  document.addEventListener('click', (e)=> {
    if (!list.contains(e.target) && e.target !== input) list.classList.add('hidden');
  });
}

/* ------------ Superset expansion (per selection) ------------ */
// Per your rule: selecting A expands to OR over (A ∪ members(A))
function expandSelectionIds(ids){
  const out = new Set();
  (ids || []).forEach(id => {
    const members = SUPERSETS[id] || [];
    out.add(id); // always include A
    members.forEach(m => out.add(m));
  });
  return out;
}

/* ------------ Matching ------------ */
function requiredPasses(recipeIngIds, requiredIds){
  // AND across each required selection; within each, OR over its expansion
  for (const rid of requiredIds){
    const expanded = expandSelectionIds([rid]);
    let ok = false;
    for (const x of expanded){ if (recipeIngIds.includes(x)) { ok = true; break; } }
    if (!ok) return false;
  }
  return true;
}
function optionalScore(recipeIngIds, optionalIds){
  // If there are optionals, recipe must match at least one expanded optional.
  // Score = how many optionals are satisfied (for ranking).
  if (!optionalIds.length) return 0;
  let hits = 0;
  let any = false;
  for (const oid of optionalIds){
    const expanded = expandSelectionIds([oid]);
    let hit = false;
    for (const x of expanded){ if (recipeIngIds.includes(x)) { hit = true; break; } }
    if (hit){ hits++; any = true; }
  }
  return any ? hits : -1; // -1 means reject later
}

/* ------------ Results (unchanged look) ------------ */
function clearAll(){
  reqSelected.clear(); optSelected.clear();
  persistSelections();
  setupChipUI.render();
  renderResults();
}

function renderResults(){
  const grid = $('#results');
  const empty = $('#empty');
  grid.innerHTML = '';

  const req = [...reqSelected];
  const opt = [...optSelected];

  // Precompute selection-expanded set for "Missing" chips in cards
  const selectedExpanded = expandSelectionIds([...reqSelected, ...optSelected]);

  const items = [];
  for (const c of COCKTAILS){
    const primary = VERSIONS[c.primary_version_id];
    if (!primary) continue;
    const ingIds = (primary.ingredients || []).map(i => i.id);

    // Required gate
    if (!requiredPasses(ingIds, req)) continue;

    // Optional gate + score
    const optPts = optionalScore(ingIds, opt);
    if (opt.length && optPts < 0) continue;

    const missing = (primary.ingredients || [])
      .filter(i => !selectedExpanded.has(i.id))
      .map(x => x.id);

    items.push({
      cid: c.id,
      name: c.name,
      image: c.image || primary.image || '',
      versionId: c.primary_version_id,
      optScore: optPts < 0 ? 0 : optPts,
      missing,
      missCount: missing.length
    });
  }

  if (!items.length){ empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  items.sort((a,b)=> b.optScore - a.optScore || a.missCount - b.missCount || a.name.localeCompare(b.name));

  for (const it of items){
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" alt="" src="${it.image || ''}">
      <div class="meta">
        <h3 class="name">${it.name}</h3>
        <div class="badges">
          <span class="badge missing">Missing: ${it.missing.map(id=>ING_MAP[id]||id).join(', ') || '—'}</span>
        </div>
      </div>
    `;
    card.addEventListener('click', ()=> openModal(it.cid));
    grid.appendChild(card);
  }
}

/* ------------ Modal (same visuals) ------------ */
function openModal(canonId){
  const title = $('#modal-title');
  const img = $('#modal-img');
  const ingList = $('#modal-ingredients');
  const instr = $('#modal-instructions');
  const meta = $('#modal-meta');
  const tabs = $('#modal-tabs');

  const versions = Object.values(VERSIONS).filter(v => (v.name_slug || slug(v.name)) === canonId);
  const primary = (COCKTAILS.find(c => c.id === canonId) || {}).primary_version_id;
  const pver = primary ? VERSIONS[primary] : null;
  if (pver && !versions.find(v => v.id === pver.id)) versions.unshift(pver);
  if (!versions.length) return;

  title.textContent = versions[0].name || canonId;

  function renderVersion(v){
    img.src = v.image || '';
    img.alt = v.name || '';
    const selExpanded = expandSelectionIds([...reqSelected, ...optSelected]);
    ingList.innerHTML = '';
    (v.ingredients || []).forEach(i => {
      const has = selExpanded.has(i.id);
      const li = document.createElement('li');
      li.innerHTML = has
        ? `<strong>${escapeHtml(i.name)}</strong>${i.measure?` — ${escapeHtml(i.measure)}`:''}`
        : `<span style="color:#ffd1d1">${escapeHtml(i.name)}</span>${i.measure?` — ${escapeHtml(i.measure)}`:''}`;
      ingList.appendChild(li);
    });
    instr.textContent = v.instructions || '';

    const a = v.attribution || {};
    const bits = [];
    if (a.author) bits.push(`Author: ${a.author}`);
    if (a.license) bits.push(`License: ${a.license}`);
    if (a.source) bits.push(`Source: <a href="${a.source}" target="_blank" rel="noopener">link</a>`);
    meta.innerHTML = bits.join(' • ') || '';
  }

  tabs.innerHTML = '';
  versions.forEach((v, idx) => {
    const btn = document.createElement('button');
    btn.textContent = v.name || `Version ${idx+1}`;
    btn.className = idx===0 ? 'active' : '';
    btn.addEventListener('click', ()=>{
      $$('.modal__tabs button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderVersion(v);
    });
    tabs.appendChild(btn);
  });

  renderVersion(versions[0]);

  const modal = $('#modal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  const close = () => { modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); };
  $('#modal-close').onclick = close;
  $('#modal-backdrop').onclick = close;
}

/* ------------ Bootstrap ------------ */
window.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  setupChipUI();
  setupAutocomplete('req', reqSelected);
  setupAutocomplete('opt', optSelected);
  $('#clear-all').addEventListener('click', clearAll);
  renderResults();
});
