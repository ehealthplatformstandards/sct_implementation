// Shared helpers for the demo pages (no framework, no build step).

export const REQS = {
  TSP1: 'FHIR enabled services ($lookup, $validate-code, $expand)', TSP2: 'Semantic definition of concept sets (ECL)',
  TSP3: 'Belgian Edition release currency', TSP4: 'Controlled release deployment', TSP5: 'Version consistency',
  TSP6: 'Multilanguage accommodation (language reference sets)', TSP7: 'Reporting / feedback mechanism (NRC)',
  U01: 'Basic search functionalities', U02: 'Search by Concept ID / Description ID', U03: 'Browse nearby hierarchy',
  U04: 'Limit search and selection to the binding', U05: 'Free text when no concept is found', U06: 'Show the term selected by the user',
  U07: 'Most relevant concepts (favourites / recent)', U08: 'Integration of tools that suggest concepts',
  S01: 'Store SNOMED CT Concept IDs', S02: 'Context represented separately', S03: 'Only active concepts for data entry',
  S04: 'Preservation of historically coded data', S05: 'Maps to classifications', S06: 'Use defining relationships in reporting',
  I01: 'FHIR as national exchange standard', I02: 'Reuse coded data in FHIR messages',
};

/** Tiny element builder: h('div.cls#id', {attr}, children...) */
export function h(tag, attrs = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const r of rest) { if (r[0] === '.') el.classList.add(r.slice(1)); else el.id = r.slice(1); }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Purple requirement label, visible when "Show requirement labels" is on. */
export function req(...ids) {
  const f = document.createDocumentFragment();
  for (const id of ids) f.append(h('span.req', { title: `${id} - ${REQS[id] || ''}` }, id));
  return f;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; e.status = res.status; throw e; }
  return body;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(`sct-demo-${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`sct-demo-${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};
export const prefs = store;

export let config = null;
export async function loadConfig() { config = await api('/api/config'); return config; }
export const lang = () => new URLSearchParams(location.search).get('lang') || store.get('lang', config?.defaultLanguage || 'nl-BE');

export function header(active) {
  const langs = Object.entries(config.languages);
  const v = config.productionVersion || '';
  const top = h('header.top',
    h('span.brand', 'Demo eHR · SNOMED CT implementation examples'),
    h('nav', h('a', { href: '/index.html', class: active === 'home' ? 'active' : '' }, 'Overview'),
      h('a', { href: '/search.html', class: active === 'search' ? 'active' : '' }, 'Demo 2 · Search & select'),
      h('a', { href: '/record.html', class: active === 'record' ? 'active' : '' }, 'Demo 3 · Record, analytics & exchange')),
    h('span.spacer'),
    h('span.version-chip', { title: 'Production SNOMED CT edition version used by every component (TSP5)' }, `Belgian Edition ${v.split('/').pop()}`, req('TSP5')),
    h('label', 'Language ', h('select#lang', { onchange: (e) => { store.set('lang', e.target.value); const u = new URL(location.href); u.searchParams.set('lang', e.target.value); location.href = u.toString(); } },
      langs.map(([code, l]) => h('option', { value: code, selected: code === lang() }, `${code} · ${l.label}`))), req('TSP6')),
    h('label', h('input', { type: 'checkbox', id: 'showreq', checked: store.get('showreq', true), onchange: (e) => { store.set('showreq', e.target.checked); document.body.classList.toggle('show-req', e.target.checked); } }), ' requirement labels'),
  );
  const disc = h('div.disclaimer', 'Example implementation for discussion - not a normative reference design. SNOMED CT content: SNOMED CT Belgian Edition, © SNOMED International, used under the SNOMED CT Affiliate Licence.');
  document.body.prepend(top, disc);
  document.body.classList.toggle('show-req', store.get('showreq', true));
}

/** Render the FHIR request log (the calls the eHR made to the terminology server). */
export function renderTrace(el, trace, title = 'FHIR requests to the local terminology server') {
  el.replaceChildren(h('div.row', h('b', title), req('TSP1'), h('span.spacer'), h('span.muted.small', `${trace.length} call(s)`)),
    trace.length ? h('div.log', trace.map((t) => h('div', h('span.op', `${t.method} ${t.op}`), ' ', h('span.ms', `${t.ms} ms`), ` [${t.status}] `, t.url.replace(/^https?:\/\/[^/]+/, '').replace(/\+/g, ' '))))
      : h('p.small.muted', 'No terminology request was needed for this screen (the data came from the eHR database).'));
}

export function prettyJson(obj, highlight = []) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let txt = esc(JSON.stringify(obj, null, 2));
  txt = txt.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b/g, (m, s, colon, n) => (s ? (colon ? `<span class="k">${s}</span>${colon}` : `<span class="s">${s}</span>`) : `<span class="n">${n}</span>`));
  for (const hl of highlight) txt = txt.split(hl).join(`<span class="hl">${hl}</span>`);
  return h('pre.json', { html: txt });
}

export function toast(msg, ms = 3500) {
  const t = h('div.toast', msg); document.body.append(t); setTimeout(() => t.remove(), ms);
}

export const shortVersion = (v) => (v || '').split('/').pop();
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Wrap the typed tokens (prefix match) in <mark> for display. */
export function highlight(term, query) {
  const toks = String(query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  if (!toks.length) return esc(term);
  const folded = term.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // map folded index -> original index (NFD removal changes lengths)
  const map = []; let fi = 0;
  for (let i = 0; i < term.length; i++) { const f = term[i].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); for (let k = 0; k < f.length; k++) map[fi++] = i; }
  const marks = new Array(term.length).fill(false);
  const re = /[a-z0-9]+/g; let m;
  while ((m = re.exec(folded))) for (const t of toks) if (m[0].startsWith(t)) for (let k = 0; k < t.length; k++) marks[map[m.index + k]] = true;
  let out = ''; let open = false;
  for (let i = 0; i < term.length; i++) { if (marks[i] && !open) { out += '<mark>'; open = true; } if (!marks[i] && open) { out += '</mark>'; open = false; } out += esc(term[i]); }
  return open ? `${out}</mark>` : out;
}
