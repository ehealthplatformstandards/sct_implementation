// Demo 2 page: structured data entry with the SNOMED CT search & select component.
import { h, api, req, loadConfig, header, lang, renderTrace, toast, prefs, highlight, config } from './common.js';
import { ConceptPicker } from './concept-picker.js';

const S = { careSet: 'problem', context: null, patientId: null, selected: null, freeText: null, timings: [], lastTrace: [], displays: {} };
const $ = (id) => document.getElementById(id);
const careSetOf = (id) => config.careSets.find((c) => c.id === id);

const NOTES = {
  nl: 'Patiënte van 67 jaar met gekende hypertensie en diabetes type 2. Sinds 3 dagen koorts en productieve hoest, klinisch beeld van pneumonie. Geen pijn op de borst.',
  fr: 'Patiente de 67 ans, hypertension artérielle et diabète de type 2 connus. Depuis 3 jours fièvre et toux productive, tableau clinique de pneumonie. Pas de douleur thoracique.',
  de: 'Patientin, 67 Jahre, bekannte Hypertonie und Diabetes mellitus Typ 2. Seit 3 Tagen Fieber und produktiver Husten, klinisches Bild einer Pneumonie. Keine Brustschmerzen.',
  en: '67-year-old woman with known hypertension and type 2 diabetes. Fever and productive cough for 3 days, clinical picture of pneumonia. No chest pain.',
};

let picker;

async function init() {
  await loadConfig();
  header('search');
  const qs = new URLSearchParams(location.search);
  S.careSet = qs.get('careSet') || prefs.get('careSet', 'problem');
  await renderPatient();
  renderCareSets();
  picker = new ConceptPicker($('picker'), {
    careSet: S.careSet, context: null,
    onSelect: (it) => { S.selected = it; S.freeText = null; renderSelection(); },
    onDetails: (code) => showDetails(code),
    onFavourite: async (it) => { await api('/api/favourites', { method: 'POST', body: { careSet: S.careSet, code: it.code, term: it.term } }); toast(`★ "${it.term}" added to favourites`); renderFavourites(); },
    onTrace: (t) => { S.lastTrace = t; renderTrace($('trace-panel'), t); },
    onTiming: (ms) => { S.timings.push(ms); renderTiming(); },
    onFreeText: (text) => { S.freeText = text || ''; S.selected = null; renderSelection(); },
  });
  selectCareSet(S.careSet);
  renderNlp();
  renderTiming();
  renderTrace($('trace-panel'), []);
  if (qs.get('q')) { picker.input.value = qs.get('q'); picker.onInput(); }
}

async function renderPatient() {
  const { items } = await api('/api/patients');
  S.patientId = prefs.get('patient', items[0]?.id);
  if (!items.find((p) => p.id === S.patientId)) S.patientId = items[0]?.id;
  $('patient-panel').replaceChildren(h('div.row',
    h('b', 'Patient'), h('select', { onchange: (e) => { S.patientId = e.target.value; prefs.set('patient', S.patientId); } },
      items.map((p) => h('option', { value: p.id, selected: p.id === S.patientId }, `${p.given} ${p.family} (${p.gender}, ${p.birth_date}) · ${p.entries} entries`))),
    h('span.spacer'), h('a', { href: '/record.html' }, 'Open the patient record (Demo 3) →')));
}

function renderCareSets() {
  $('caresets').replaceChildren(...config.careSets.filter((c) => !c.qualifier).map((c) => h('button', { class: c.id === S.careSet ? 'active' : '', onclick: () => selectCareSet(c.id) }, c.label)));
}

function selectCareSet(id) {
  S.careSet = id; prefs.set('careSet', id); S.selected = null; S.freeText = null;
  const cs = careSetOf(id);
  renderCareSets();
  S.context = cs.contexts?.find((c) => c.default)?.id || null;
  $('binding-info').replaceChildren(
    h('div', h('b', 'Data element: '), h('span.mono', cs.dataElement), ' · profile ', h('a', { href: cs.fhirProfile, target: '_blank' }, cs.fhirProfile.split('/').pop()), req('I01')),
    h('div', h('b', 'Terminology binding (ECL): '), h('span.mono', cs.binding.ecl), req('U04', 'TSP2')),
    h('div.badge-src', `Source: ${cs.binding.source}`),
  );
  const ctxs = cs.contexts || [];
  $('context-row').replaceChildren(...(ctxs.length ? [
    h('b', 'Context subset'), req('U01'),
    h('select', { onchange: (e) => { S.context = e.target.value; picker.setContext(S.context); } },
      ctxs.map((c) => h('option', { value: c.id, selected: c.id === S.context }, `${c.label} (${c.refset ? `refset ${c.refset}` : 'ECL'})`)),
      h('option', { value: 'none' }, 'No context: search the whole binding')),
    h('span.muted.small', 'Results from the context subset are shown first; the broader binding can be searched when needed.'),
  ] : [h('span.muted.small', 'No context subset for this data element.')]));
  picker.setCareSet(id, S.context);
  renderSelection();
  renderFavourites();
}

// ------------------------------------------------------------------ selection + context (U06, S01, S02, U05)
const STATUS = {
  problem: { clinical: ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'], verification: ['confirmed', 'provisional', 'differential', 'unconfirmed', 'refuted'] },
  allergy: { clinical: ['active', 'inactive', 'resolved'], verification: ['confirmed', 'unconfirmed', 'refuted'] },
};
const ALLERGY_TYPES = ['609328004', '609396006', '609433001', '782197009'];

async function ensureDisplays(codes) {
  const missing = codes.filter((c) => !S.displays[`${lang()}:${c}`]);
  if (missing.length) {
    const { displays } = await api(`/api/displays?codes=${missing.join(',')}&lang=${lang()}`);
    for (const [k, v] of Object.entries(displays)) S.displays[`${lang()}:${k}`] = v;
  }
  return (c) => S.displays[`${lang()}:${c}`] || c;
}

async function renderSelection() {
  const box = $('selection');
  const cs = careSetOf(S.careSet);
  if (S.freeText !== null) {
    const ta = h('input', { type: 'text', value: S.freeText, style: { width: '100%' } });
    box.replaceChildren(h('div.freetext-box',
      h('div.row', h('b', 'Free text entry (not SNOMED CT-coded)'), req('U05'), h('span.chip.warn', 'uncoded')),
      h('p.small.muted', 'Stored in a separate free-text field - never with a Concept ID or placeholder code. The missing concept should be reported to the NRC.'),
      ta,
      h('div.row', { style: { marginTop: '8px' } },
        h('button', { onclick: async () => { await save({ freeText: ta.value.trim() }); openFeedback({ kind: 'missing-concept', searchText: ta.value.trim() }); } }, 'Record as free text and report to the NRC'), req('U05', 'TSP7'),
        h('button.secondary', { onclick: () => { S.freeText = null; renderSelection(); } }, 'Cancel'))));
    return;
  }
  if (!S.selected) { box.replaceChildren(); return; }
  const it = S.selected;
  const d = await ensureDisplays([...config.qualifiers.severity.codes, ...config.qualifiers.laterality.codes, ...(S.careSet === 'allergy' ? ALLERGY_TYPES : [])]);
  const fields = h('div.fields');
  const ctx = {};
  const sel = (name, label, options, opt = {}) => {
    const s = h('select', { onchange: (e) => { ctx[name] = e.target.value || undefined; } }, h('option', { value: '' }, '-'), options.map(([v, t]) => h('option', { value: v, selected: v === opt.default }, t)));
    if (opt.default) ctx[name] = opt.default;
    fields.append(h('label.field', label, s));
  };
  const date = (name, label) => fields.append(h('label.field', label, h('input', { type: 'date', onchange: (e) => { ctx[name] = e.target.value || undefined; } })));
  if (STATUS[S.careSet]) {
    sel('clinical_status', 'Clinical status', STATUS[S.careSet].clinical.map((x) => [x, x]), { default: 'active' });
    sel('verification_status', 'Verification status', STATUS[S.careSet].verification.map((x) => [x, x]), { default: 'confirmed' });
  }
  if (S.careSet === 'problem') {
    sel('severity_sct', 'Severity', config.qualifiers.severity.codes.map((c) => [c, d(c)]));
    sel('laterality_sct', 'Laterality', config.qualifiers.laterality.codes.map((c) => [c, d(c)]));
    date('onset_date', 'Onset date');
  }
  if (S.careSet === 'procedure') { sel('laterality_sct', 'Laterality', config.qualifiers.laterality.codes.map((c) => [c, d(c)])); date('occurrence_date', 'Performed on'); }
  if (S.careSet === 'vaccination') date('occurrence_date', 'Administered on');
  if (S.careSet === 'allergy') {
    sel('category', 'Type (be-ext-allergy-type)', ALLERGY_TYPES.map((c) => [c, d(c)]), { default: '609328004' });
    sel('criticality', 'Criticality', [['low', 'low'], ['high', 'high'], ['unable-to-assess', 'unable to assess']]);
  }
  if (S.careSet === 'observation') {
    fields.append(h('label.field', 'Value', h('input', { type: 'number', step: 'any', onchange: (e) => { ctx.value_quantity = Number(e.target.value); } })));
    fields.append(h('label.field', 'Unit (UCUM)', h('input', { type: 'text', value: 'kg', onchange: (e) => { ctx.value_unit = e.target.value; } })));
    ctx.value_unit = 'kg';
    date('occurrence_date', 'Measured on');
  }
  // qualifier pickers re-use the same component with another binding (body site / reaction manifestation)
  const qualifierPicker = (careSet, label, codeField, termField) => {
    const holder = h('div'); const chosen = h('div.small');
    fields.append(h('label.field', { style: { gridColumn: '1 / -1' } }, label, holder, chosen));
    const p = new ConceptPicker(holder, {
      careSet, context: careSetOf(careSet).contexts?.[0]?.id, compact: true, placeholder: `Search ${label.toLowerCase()}…`,
      onSelect: (x) => { ctx[codeField] = x.code; if (termField) ctx[termField] = x.term; chosen.replaceChildren(h('span.chip.ok', `${x.term} (${x.code})`)); p.clear(); },
      onTrace: (t) => renderTrace($('trace-panel'), t),
    });
  };
  if (S.careSet === 'problem' || S.careSet === 'procedure') qualifierPicker('body-site', 'Body site', 'body_site_sct');
  if (S.careSet === 'allergy') qualifierPicker('allergy-manifestation', 'Reaction manifestation', 'reaction_manifestation_sct', 'reaction_manifestation_term');

  const method = it.via?.includes('Concept ID') ? 'concept-id' : it.via?.includes('Description ID') ? 'description-id' : (it.method || 'search');
  box.replaceChildren(h('div.selected-box',
    h('div.row', h('span.term', it.term), req('U06'), h('span.chip.ok', 'SNOMED CT'), h('span.spacer'), h('button.link', { onclick: () => { S.selected = null; renderSelection(); } }, 'clear')),
    h('div.kv', { style: { marginTop: '6px' } },
      h('div', 'Concept ID (stored)'), h('div', h('span.mono', it.code), req('S01')),
      h('div', 'Term as selected (stored)'), h('div', it.term, req('U06')),
      h('div', 'Preferred term'), h('div', it.pt || '-'),
      h('div', 'Entry method'), h('div', method, method === 'suggestion' ? req('U08') : method.includes('id') ? req('U02') : method === 'favourite' || method === 'recent' ? req('U07') : null),
    ),
    h('h3', 'Context (stored in separate fields)', req('S02')), fields,
    h('div.row', { style: { marginTop: '10px' } },
      h('button', { onclick: () => save({ code: it.code, term: it.term, method, context: ctx }) }, 'Add to patient record'), req('S01', 'S03', 'U04'),
      h('span.muted.small', 'The concept is validated again on the server (active + permitted by the binding) before it is stored.'))));
}

async function save(body) {
  try {
    const r = await api('/api/entries', { method: 'POST', body: { patientId: S.patientId, careSet: S.careSet, lang: lang(), ...body } });
    renderTrace($('trace-panel'), r.trace || []);
    toast(body.freeText ? `Free text stored (entry #${r.id}) - no code attached.` : `Stored entry #${r.id}: Concept ID ${r.entry.sct_concept_id} + term "${r.entry.sct_term_selected}" (${r.entry.sct_version.split('/').pop()})`);
    S.selected = null; S.freeText = null; picker.clear(); renderSelection(); renderFavourites(); renderPatient();
    return r;
  } catch (e) {
    toast(`Not stored: ${e.message}`, 6000);
    if (e.body?.trace) renderTrace($('trace-panel'), e.body.trace);
    return null;
  }
}

// ------------------------------------------------------------------ U03 details / hierarchy (+ TSP6 designations)
async function showDetails(code) {
  const panel = $('details-panel');
  panel.replaceChildren(h('h2', 'Concept details & hierarchy'), h('div.muted', 'Loading…'));
  const d = await api(`/api/concept/${code}?careSet=${S.careSet}&lang=${lang()}`);
  renderTrace($('trace-panel'), d.trace || []);
  const node = (n) => h(`div.node${n.selectable ? '' : '.no'}`, h('a', { onclick: () => showDetails(n.code), title: n.selectable ? 'permitted by the binding' : 'not permitted by the binding of this data element' }, n.display), ' ', h('span.mono.muted', n.code), n.selectable ? '' : h('span.chip.grey', 'not in binding'));
  const byLang = {};
  for (const x of d.designations) if (!/-x-/.test(x.language) && x.use !== 'display') (byLang[x.language] ||= []).push(x);
  const pts = d.designations.filter((x) => /-x-sctlang-/.test(x.language));
  panel.replaceChildren(
    h('div.row', h('h2', { style: { margin: 0 } }, d.display), req('U03')),
    h('div.small.muted', d.fsn, ' · ', h('span.mono', d.code), ' · ', d.sufficientlyDefined ? 'fully defined' : 'primitive', ' · effective ', d.effectiveTime, ' · module ', d.moduleId),
    h('div.row', { style: { margin: '8px 0' } },
      d.inactive ? h('span.chip.bad', 'inactive') : h('span.chip.ok', 'active'),
      d.selectable ? h('span.chip.ok', 'permitted by this binding') : h('span.chip.bad', d.selectableReason), req('U04', 'S03'),
      d.selectable ? h('button', { onclick: () => { S.selected = { code: d.code, term: d.display, pt: d.display, method: 'search' }; S.freeText = null; renderSelection(); } }, 'Select') : null),
    h('h3', 'Parents (is-a)'), h('div.hier', d.parents.map(node)),
    h('div.hier', h('span.current', d.display)),
    h('h3', `Children (${d.childCount})`), h('div.hier', d.children.map(node), d.childCount > d.children.length ? h('div.muted.small', `… ${d.childCount - d.children.length} more`) : null),
    h('h3', 'Defining relationships (inferred)'),
    d.attributes.length ? h('table', h('tr', h('th', 'Group'), h('th', 'Relationship type'), h('th', 'Target')),
      d.attributes.map((a) => h('tr', h('td', a.group || '-'), h('td', h('a', { onclick: () => showDetails(a.type.code) }, a.type.display)), h('td', h('a', { onclick: () => showDetails(a.value.code) }, a.value.display), ' ', h('span.mono.muted', a.value.code))))) : h('div.muted.small', 'No defining attributes.'),
    h('h3', 'Preferred terms per Belgian language reference set', req('TSP6')),
    h('table', pts.map((x) => h('tr', h('td.mono', x.language), h('td', x.value)))),
    h('h3', 'All descriptions'),
    h('div.small', Object.entries(byLang).map(([l, list]) => h('div', h('b', `${l}: `), list.map((x) => x.value).join(' · ')))),
  );
}

// ------------------------------------------------------------------ U07 favourites / recent
async function renderFavourites() {
  const panel = $('fav-panel');
  const { items, trace } = await api(`/api/favourites?careSet=${S.careSet}&lang=${lang()}`);
  const row = (f) => h(`div.result${f.valid ? '' : '.disabled'}`, { onclick: () => { if (!f.valid) return; S.selected = { code: f.code, term: f.term, pt: f.currentDisplay, method: f.kind }; S.freeText = null; renderSelection(); } },
    h('div', h('div.term', f.term), h('div.sub', h('span.mono', f.code), ' · ', f.kind, !f.valid ? h('span.chip.bad', { style: { marginLeft: '6px' } }, f.reason) : h('span.chip.ok', { style: { marginLeft: '6px' } }, 'valid'))),
    f.kind === 'favourite' ? h('div.actions', h('button.secondary', { title: 'remove', onclick: async (e) => { e.stopPropagation(); await api(`/api/favourites?careSet=${S.careSet}&code=${f.code}`, { method: 'DELETE' }); renderFavourites(); } }, '✕')) : null);
  const favs = items.filter((i) => i.kind === 'favourite'); const recent = items.filter((i) => i.kind === 'recent');
  panel.replaceChildren(h('div.row', h('h2', { style: { margin: 0 } }, 'Favourites & recently used'), req('U07')),
    h('p.small.muted', 'Quick access without a full search. Every entry is re-validated (active + permitted by the binding) exactly like a search result.', req('S03', 'U04')),
    h('h3', 'Favourites'), h('div.results', favs.length ? favs.map(row) : h('div.result.muted', 'none')),
    h('h3', 'Recently used'), h('div.results', recent.length ? recent.map(row) : h('div.result.muted', 'none')));
  if (trace?.length) renderTrace($('trace-panel'), trace);
}

// ------------------------------------------------------------------ U01 timing
function renderTiming() {
  const t = [...S.timings].sort((a, b) => a - b);
  const pct = (p) => (t.length ? t[Math.min(t.length - 1, Math.ceil(p * t.length) - 1)] : '-');
  const within = t.length ? Math.round((100 * t.filter((x) => x <= 1000).length) / t.length) : '-';
  $('timing-panel').replaceChildren(h('div.row', h('h2', { style: { margin: 0 } }, 'Search response time (this session)'), req('U01')),
    h('div.kv', h('div', 'Searches measured'), h('div', t.length), h('div', 'Median'), h('div', `${pct(0.5)} ms`), h('div', '95th percentile'), h('div', h('b', `${pct(0.95)} ms`)),
      h('div', 'Within 1 second'), h('div', within === '-' ? '-' : h('span', { class: within >= 95 ? 'status-ok' : 'status-bad' }, `${within} %`)),
      h('div', 'Settings'), h('div', `min. ${config.minChars} characters · debounce ${config.debounceMs} ms (included in the measured time)`)));
}

// ------------------------------------------------------------------ U08 text analysis
function renderNlp() {
  const l = lang().slice(0, 2);
  const ta = h('textarea', {}, NOTES[l] || NOTES.en);
  const out = h('div');
  $('nlp-panel').replaceChildren(h('div.row', h('h2', { style: { margin: 0 } }, 'Suggestions from a text-analysis tool'), req('U08')),
    h('p.small.muted', 'The eHR sends the note to a text-analysis service (HTTP/JSON). Candidates are only suggestions: the user confirms each one, and the eHR validates it (active + binding) before storing.'),
    ta, h('div.row', { style: { marginTop: '8px' } }, h('button', { onclick: () => analyse(ta.value, out) }, 'Analyse text'), h('span.muted.small', `Service: ${config.suggestService}`)), out);
}

async function analyse(text, out) {
  out.replaceChildren(h('div.muted', 'Analysing…'));
  const r = await api('/api/suggest', { method: 'POST', body: { text, lang: lang(), careSet: S.careSet } });
  renderTrace($('trace-panel'), r.trace || []);
  let html = ''; let pos = 0;
  for (const c of r.candidates) { html += escapeHtml(text.slice(pos, c.start)) + `<mark class="${c.negated ? 'neg' : ''}">${escapeHtml(text.slice(c.start, c.end))}</mark>`; pos = c.end; }
  html += escapeHtml(text.slice(pos));
  out.replaceChildren(h('div.note-highlight.small', { style: { margin: '10px 0', lineHeight: '1.7' }, html }),
    h('div.small.muted', `${r.service} · ${r.candidates.length} candidate(s)`),
    ...r.candidates.map((c) => {
      const ok = c.validation.valid && !c.negated;
      const row = h('div.suggestion',
        h('div', h('b', c.term), ' ', h('span.mono.muted', c.conceptId), h('div.small.muted', `from "${c.text}" · confidence ${c.confidence}`,
          c.negated ? h('span.chip.bad', { style: { marginLeft: '6px' } }, 'negated in the text') : null,
          c.validation.valid ? h('span.chip.ok', { style: { marginLeft: '6px' } }, 'valid for this data element') : h('span.chip.bad', { style: { marginLeft: '6px' } }, c.validation.reason))),
        h('span.spacer', { style: { flex: 1 } }),
        h('button', { disabled: !ok, onclick: async () => { const s = await save({ code: c.conceptId, term: c.term, method: 'suggestion', context: { clinical_status: 'active', verification_status: 'confirmed' } }); if (s) { row.replaceChildren(h('span.chip.ok', `✓ confirmed and stored as entry #${s.id}: ${c.term}`)); } } }, 'Confirm'),
        h('button.secondary', { onclick: () => row.remove() }, 'Reject'));
      return row;
    }));
}
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ------------------------------------------------------------------ TSP7 feedback dialog
function openFeedback(prefill = {}) {
  const dlg = $('feedback-dialog');
  const kind = h('select', Object.entries(config.feedbackKinds).map(([k, v]) => h('option', { value: k, selected: k === prefill.kind }, v)));
  const text = h('input', { type: 'text', value: prefill.searchText || '', style: { width: '100%' } });
  const comment = h('textarea', { placeholder: 'What is missing or wrong? (e.g. the clinical term used in practice)' });
  const result = h('div');
  const submit = async (mode) => {
    const r = await api('/api/feedback', { method: 'POST', body: { kind: kind.value, searchText: text.value, comment: comment.value, careSet: S.careSet, code: prefill.code, lang: lang(), mode } });
    if (mode === 'portal') {
      result.replaceChildren(h('p.small', 'Paste this summary in the NRC request portal:'), h('pre.json', r.summary), h('a.btn', { href: r.portal, target: '_blank' }, `Open the NRC portal (${r.portal.endsWith('/fr') ? 'FR' : 'NL'}) ↗`));
    } else result.replaceChildren(h('p.status-ok', `Queued as report #${r.id}: the supplier forwards it to the Belgian NRC.`), h('pre.json', r.summary));
  };
  dlg.replaceChildren(h('div.row', h('h2', { style: { margin: 0 } }, 'Report missing or erroneous SNOMED CT content'), req('TSP7')),
    h('p.small.muted', 'Feedback ends up in the official Belgian NRC channel - either directly (portal) or through the supplier (queue).'),
    h('label.field', 'Type', kind), h('label.field', 'Search text / term', text), h('label.field', 'Comment', comment),
    h('div.row', { style: { marginTop: '10px' } }, h('button', { onclick: () => submit('portal') }, 'Prepare for the NRC portal'), h('button.secondary', { onclick: () => submit('queue') }, 'Send via the supplier (queue)'), h('span.spacer', { style: { flex: 1 } }), h('button.link', { onclick: () => dlg.close() }, 'close')),
    result);
  dlg.showModal();
}
window.openFeedback = openFeedback;

init().catch((e) => { document.body.append(h('pre', e.stack)); });
