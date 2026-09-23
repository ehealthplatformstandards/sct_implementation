// Demo 3 page: what happens with SNOMED CT-coded data after data entry.
import { h, api, req, loadConfig, header, lang, renderTrace, prettyJson, toast, prefs, shortVersion, config } from './common.js';

const $ = (id) => document.getElementById(id);
const S = { patientId: null, tab: 'summary', patient: null };
const TABS = [
  ['summary', 'Patient summary', ['S01', 'S02', 'U06']],
  ['stored', 'Stored data', ['S01', 'S02', 'U05']],
  ['upgrade', 'Release upgrade', ['S04']],
  ['reports', 'Reports', ['S06']],
  ['classifications', 'Classifications', ['S05']],
  ['fhir', 'FHIR exchange', ['I01', 'I02']],
  ['feedback', 'NRC feedback queue', ['TSP7']],
];

async function init() {
  await loadConfig();
  header('record');
  const qs = new URLSearchParams(location.search);
  S.tab = qs.get('tab') || 'summary';
  const { items } = await api('/api/patients');
  S.patientId = qs.get('patient') || prefs.get('patient', items[0]?.id);
  if (!items.find((p) => p.id === S.patientId)) S.patientId = items[0]?.id;
  $('patient-bar').replaceChildren(h('div.row', h('b', 'Patient'),
    h('select', { onchange: (e) => { S.patientId = e.target.value; prefs.set('patient', S.patientId); show(S.tab); } },
      items.map((p) => h('option', { value: p.id, selected: p.id === S.patientId }, `${p.given} ${p.family} · ${p.gender} · born ${p.birth_date} · ${p.entries} entries`))),
    h('span.spacer'), h('a', { href: '/search.html' }, '← add entries with the search & select component (Demo 2)')));
  renderTabs();
  show(S.tab);
}

function renderTabs() {
  $('tabs').replaceChildren(...TABS.map(([id, label, reqs]) => h('button', { class: id === S.tab ? 'active' : '', onclick: () => show(id) }, label, req(...reqs))));
}

async function show(tab) {
  S.tab = tab; renderTabs();
  const u = new URL(location.href); u.searchParams.set('tab', tab); history.replaceState(null, '', u);
  const el = $('tab-content');
  el.replaceChildren(h('div.panel.muted', 'Loading…'));
  renderTrace($('trace-panel'), []); // tabs that call the terminology server replace this
  try { await ({ summary, stored, upgrade, reports, classifications, fhir, feedback })[tab](el); } catch (e) { el.replaceChildren(h('div.panel', h('span.chip.bad', e.message))); }
}

const careLabel = (id) => config.careSets.find((c) => c.id === id)?.label || id;
const dateOnly = (s) => (s || '').slice(0, 10);

// ------------------------------------------------------------------ summary (S01, S02, S04, U05, U06)
async function summary(el) {
  const [r, cls] = await Promise.all([api(`/api/patients/${S.patientId}?lang=${lang()}`), api(`/api/patients/${S.patientId}/classification?lang=${lang()}`)]);
  renderTrace($('trace-panel'), [...r.trace, ...cls.trace]);
  const icd = Object.fromEntries(cls.items.map((i) => [i.entry.id, i.icd10.map((g) => g.target).filter(Boolean)]));
  const d = (c) => (c ? r.displays[c] || c : null);
  const groups = {};
  for (const e of r.entries) (groups[e.care_set] ||= []).push(e);
  const order = config.careSets.map((c) => c.id);
  const blocks = Object.entries(groups).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([cs, list]) => h('div.panel',
    h('h2', careLabel(cs), ' ', h('span.muted.small', list[0].data_element)),
    h('table', h('tr', h('th', 'Recorded term', req('U06')), h('th', 'SNOMED CT Concept ID', req('S01')), h('th', 'Context', req('S02')), h('th', 'Recorded', req('TSP5')), h('th', `Status in ${shortVersion(r.productionVersion)}`, req('S04', 'S03')), h('th', 'ICD-10 (derived)', req('S05'))),
      list.map((e) => h('tr',
        h('td', e.sct_concept_id ? h('b', e.sct_term_selected) : h('span', h('span.chip.warn', 'free text'), ' ', e.free_text, req('U05'))),
        h('td.mono', e.sct_concept_id || h('span.muted', '- (no code)')),
        h('td.small', contextText(e, d)),
        h('td.small', dateOnly(e.recorded_at), h('br'), e.sct_version ? h('span.muted', `edition ${shortVersion(e.sct_version)}`) : ''),
        h('td.small', e.sct_concept_id === null ? '' : e.activeInProduction ? h('span.chip.ok', 'active') : h('div', h('span.chip.bad', 'inactive'),
          e.associations.length ? e.associations.map((a) => h('div', h('span.muted', `${a.association_label}: `), d(a.target_concept_id) || a.target_display, ' ', h('span.mono.muted', a.target_concept_id))) : h('div.muted', 'run the release impact analysis'))),
        h('td.mono', (icd[e.id] || []).join(', ') || h('span.muted', '-')))))));
  el.replaceChildren(h('div.panel.small.muted', 'Every row shows the Concept ID (the authoritative value) with the term the user selected at the time, the context stored in separate fields, the edition version used at data entry, and the status of the concept in the current production edition.'), ...blocks);
}

function contextText(e, d) {
  const parts = [];
  if (e.clinical_status) parts.push(`clinical status: ${e.clinical_status}`);
  if (e.verification_status) parts.push(`verification: ${e.verification_status}`);
  if (e.severity_sct) parts.push(`severity: ${d(e.severity_sct)}`);
  if (e.body_site_sct) parts.push(`body site: ${d(e.body_site_sct)}`);
  if (e.laterality_sct) parts.push(`laterality: ${d(e.laterality_sct)}`);
  if (e.category && e.care_set === 'allergy') parts.push(`type: ${d(e.category)}`);
  if (e.criticality) parts.push(`criticality: ${e.criticality}`);
  if (e.reaction_manifestation_term) parts.push(`reaction: ${e.reaction_manifestation_term}`);
  if (e.onset_date) parts.push(`onset: ${e.onset_date}`);
  if (e.abatement_date) parts.push(`abatement: ${e.abatement_date}`);
  if (e.occurrence_date) parts.push(`date: ${e.occurrence_date}`);
  if (e.value_quantity !== null && e.value_quantity !== undefined) parts.push(`value: ${e.value_quantity} ${e.value_unit || ''}`);
  return parts.map((p) => h('div', p));
}

// ------------------------------------------------------------------ stored rows (S01, S02, U05)
async function stored(el) {
  const { rows } = await api(`/api/db/clinical_entry?patient=${S.patientId}`);
  const cols = ['id', 'care_set', 'data_element', 'sct_concept_id', 'sct_term_selected', 'term_language', 'sct_version', 'free_text', 'clinical_status', 'verification_status', 'severity_sct', 'body_site_sct', 'laterality_sct', 'onset_date', 'entry_method', 'recorded_at'];
  el.replaceChildren(
    h('div.panel', h('h2', 'Table clinical_entry (rows of this patient)', req('S01', 'S02', 'U05')),
      h('p.small.muted', 'sct_concept_id is the authoritative coded value; sct_term_selected keeps the term the user saw; context lives in its own columns; free text has its own column and never a code. sct_version records the edition version used at data entry.'),
      h('div', { style: { overflowX: 'auto' } }, h('table.small', h('tr', cols.map((c) => h('th.mono', c))), rows.slice().reverse().map((r) => h('tr', cols.map((c) => h('td', { class: ['sct_concept_id', 'sct_version', 'severity_sct', 'body_site_sct', 'laterality_sct'].includes(c) ? 'mono' : '' }, c === 'sct_version' ? shortVersion(r[c]) : (r[c] ?? '')))))))),
    h('div.panel', h('h2', 'Database rule (excerpt of the schema)', req('S01', 'U05')),
      h('pre.json', `CHECK ((sct_concept_id IS NOT NULL AND free_text IS NULL AND sct_term_selected IS NOT NULL)
    OR (sct_concept_id IS NULL AND free_text IS NOT NULL AND sct_description_id IS NULL))
-- a coded value always carries its Concept ID; a Description ID is only informative;
-- free text can never carry a code or placeholder code.`)));
}

// ------------------------------------------------------------------ release upgrade (S04)
async function upgrade(el) {
  const [assoc, entries] = await Promise.all([api('/api/db/sct_historical_association'), api(`/api/db/clinical_entry?patient=${S.patientId}`)]);
  const out = h('div');
  el.replaceChildren(
    h('div.panel', h('h2', 'Terminology update: impact on recorded data', req('S04')),
      h('p.small', `Production edition: `, h('b', config.productionVersion), '. After a new release has been deployed (TSP4), the eHR checks every Concept ID stored in the record. Inactivated concepts keep their original Concept ID in the record; the historical associations of the new release (SAME AS, REPLACED BY, POSSIBLY REPLACED BY, ...) are stored separately as proposals.'),
      h('div.row', h('button', { onclick: async () => { const r = await api('/api/release-impact', { method: 'POST' }); renderTrace($('trace-panel'), r.trace); toast(`${r.checked} concepts checked, ${r.inactive.length} inactive, ${r.associationsAdded} association rows added`); show('upgrade'); } }, 'Run release impact analysis'), h('span.muted.small', 'ECL membership check for all stored concepts + ConceptMap/$translate on the association reference sets')), out),
    h('div.panel', h('h2', `Table sct_historical_association (${assoc.rows.length} rows)`, req('S04')),
      h('table.small', h('tr', ['entry_id', 'original_concept_id', 'association', 'target_concept_id', 'target_display', 'detected_in_version', 'detected_at'].map((c) => h('th.mono', c))),
        assoc.rows.map((r) => h('tr', h('td', r.entry_id), h('td.mono', r.original_concept_id), h('td', r.association_label), h('td.mono', r.target_concept_id), h('td', r.target_display), h('td.mono', shortVersion(r.detected_in_version)), h('td', r.detected_at.slice(0, 19)))))),
    h('div.panel', h('h2', 'The original records are unchanged', req('S04')),
      h('table.small', h('tr', ['id', 'sct_concept_id', 'sct_term_selected', 'sct_version', 'recorded_at'].map((c) => h('th.mono', c))),
        entries.rows.filter((r) => assoc.rows.some((a) => a.entry_id === r.id)).map((r) => h('tr', h('td', r.id), h('td.mono', r.sct_concept_id), h('td', r.sct_term_selected), h('td.mono', shortVersion(r.sct_version)), h('td', r.recorded_at.slice(0, 19)))))));
}

// ------------------------------------------------------------------ reports (S06)
async function reports(el) {
  const out = h('div');
  el.replaceChildren(h('div.panel', h('h2', 'Reports defined with ECL', req('S06', 'TSP2')),
    h('p.small.muted', 'Each report is one ECL expression. The eHR evaluates it for the concepts stored in the record: (report ECL) AND (concept1 OR concept2 ...). Hierarchies and defining attributes of the current edition are used - no code list is enumerated or maintained.'),
    h('table', h('tr', h('th', 'Report'), h('th', 'ECL'), h('th', 'Uses'), h('th', '')),
      config.reports.map((r) => h('tr', h('td', r.title), h('td.mono', r.ecl), h('td.small', r.uses), h('td', h('div.row', h('button.secondary', { onclick: () => runReport(r.id, out, false) }, 'Run'), h('button.secondary', { title: 'include codes inactivated after recording (ECL {{ +HISTORY-MIN }})', onclick: () => runReport(r.id, out, true) }, '+ legacy codes'))))))), out);
  const qs = new URLSearchParams(location.search);
  if (qs.get('report')) runReport(qs.get('report'), out, qs.get('history') === 'true');
}

async function runReport(id, out, history) {
  out.replaceChildren(h('div.panel.muted', 'Running…'));
  const r = await api(`/api/reports/${id}?lang=${lang()}&history=${history}`);
  renderTrace($('trace-panel'), r.trace);
  out.replaceChildren(h('div.panel', h('h2', r.report.title, req('S06')),
    h('div.kv', h('div', 'ECL'), h('div.mono', r.ecl), h('div', 'Legacy codes'), h('div', r.history ? h('span', 'included: ECL history supplement {{ +HISTORY-MIN }} (SAME AS / REPLACED BY ... associations)', req('S04')) : 'not included (current concepts only)'), h('div', 'Edition version used'), h('div.mono', r.version),
      h('div', 'Concepts covered by the ECL'), h('div', h('b', (r.conceptSetSize ?? 0).toLocaleString('en')), ' concepts (never enumerated by hand)'),
      h('div', 'Matching concepts in the record'), h('div', r.matchedConcepts.map((c) => h('div', c.display, ' ', h('span.mono.muted', c.code), c.inactive ? h('span.chip.warn', { style: { marginLeft: '6px' } }, 'inactive - found through its historical association') : null))),
      h('div', 'Patients'), h('div', h('b', r.patients.length), ' - ', r.patients.map((p) => p.name).join(', '))),
    h('h3', 'Matching entries'),
    h('table.small', h('tr', h('th', 'Entry'), h('th', 'Patient'), h('th', 'Recorded term'), h('th', 'Concept ID')), r.entries.map((e) => h('tr', h('td', e.id), h('td', e.patient), h('td', e.term), h('td.mono', e.conceptId))))));
}

// ------------------------------------------------------------------ classifications (S05)
async function classifications(el) {
  const [c, maps] = await Promise.all([api(`/api/patients/${S.patientId}/classification?lang=${lang()}`), api('/api/maps')]);
  renderTrace($('trace-panel'), c.trace);
  const p = c.patient;
  el.replaceChildren(
    h('div.panel', h('h2', 'Map artefacts known to the eHR', req('S05')),
      h('table.small', h('tr', h('th', 'Target (S05 list)'), h('th', 'Map reference set'), h('th', 'Loaded from'), h('th', 'Edition version'), h('th.num', 'Rows')),
        maps.targets.flatMap((t) => (t.artefacts.length ? t.artefacts.map((a) => h('tr', h('td', t.label), h('td', `${a.name} (${a.refset_id})`), h('td.mono', a.source_file), h('td.mono', shortVersion(a.edition_version)), h('td.num', a.member_count.toLocaleString('en'))))
          : [h('tr', h('td', t.label), h('td', { colspan: 4 }, h('span.chip.grey', 'no map artefact in the loaded Belgian Edition - same import mechanism once published')))]))),
      h('p.small', h('a', { href: '/api/extract.csv' }, 'Download data extraction (CSV)'), ' - SNOMED CT stays the source; ICD-10 codes are derived outputs.')),
    h('div.panel', h('h2', `ICD-10 derived for ${p.given} ${p.family} (${p.gender}, born ${p.birth_date})`, req('S05')),
      h('p.small.muted', 'Per map group, the rules are evaluated in priority order against the patient record (gender, age at onset, other recorded concepts); the first rule that holds gives the target.'),
      h('table.small', h('tr', h('th', 'Recorded term'), h('th', 'Concept'), h('th', 'Group'), h('th', 'Rules evaluated'), h('th', 'ICD-10')),
        c.items.flatMap((i) => (i.icd10.length ? i.icd10 : [{ group: '-', evaluated: [], target: null }]).map((g, gi) => h('tr',
          h('td', gi === 0 ? i.entry.term : ''), h('td.mono', gi === 0 ? i.entry.conceptId : ''), h('td', g.group),
          h('td', g.via ? h('div', h('span.chip.warn', `legacy code - derived via ${g.via.association} ${g.via.conceptId}`), req('S04')) : '',
            g.evaluated.map((e) => h('div', { class: e.result ? 'status-ok' : 'muted' }, `${e.result ? '✔' : '✘'} ${e.rule}`, h('span.small.muted', ` - ${e.explanation}`)))),
          h('td.mono', g.target || h('span.muted', i.icd10.length ? '(no code)' : 'no map row'))))))));
}

// ------------------------------------------------------------------ FHIR (I01, I02)
async function fhir(el) {
  const b = await api(`/api/patients/${S.patientId}/fhir?lang=${lang()}`);
  const res = b.entry.map((e) => e.resource).filter((r) => !['Patient', 'Practitioner'].includes(r.resourceType));
  const coding = (r) => (r.code || r.vaccineCode);
  // one complete resource as an example: a coded Condition with context elements if there is one
  const example = res.find((r) => r.resourceType === 'Condition' && r.code?.coding && r.bodySite) || res.find((r) => r.resourceType === 'Condition' && r.code?.coding && r.severity) || res.find((r) => r.code?.coding) || res[0];
  el.replaceChildren(
    h('div.panel', h('h2', 'Generated from the stored entries - nothing is typed again', req('I01', 'I02')),
      h('table.small', h('tr', h('th', 'Resource'), h('th', 'Belgian profile'), h('th', 'coding.system | version | code'), h('th', 'coding.display / text (selected term)'), h('th', 'Context elements')),
        res.map((r) => { const c = coding(r); const cd = c?.coding?.[0]; return h('tr', h('td', r.resourceType), h('td.small', r.meta.profile[0].split('/').pop()),
          h('td.mono', cd ? `${cd.system} | ${shortVersion(cd.version)} | ${cd.code}` : h('span.chip.warn', 'text only (U05)')), h('td', c?.text),
          h('td.small', Object.keys(r).filter((k) => ['clinicalStatus', 'verificationStatus', 'severity', 'bodySite', 'onsetDateTime', 'abatementDateTime', 'reaction', 'criticality', 'extension', 'occurrenceDateTime', 'performedDateTime', 'valueQuantity', 'effectiveDateTime'].includes(k)).join(', '))); }))),
    example ? h('div.panel', h('h2', `Example: ${example.resourceType} generated from stored entry ${example.identifier?.[0]?.value}`, req('I01', 'I02')),
      h('p.small.muted', 'Coding.code = the stored Concept ID, Coding.version = the edition version used at data entry, Coding.display and text = the term the user selected (U06). Context goes into its own FHIR elements (S02).'),
      h('div.full-json', prettyJson(example, ['"http://snomed.info/sct"']))) : '',
    h('div.panel', h('h2', 'FHIR Bundle (collection)', req('I01')), prettyJson(b, ['"http://snomed.info/sct"'])));
  $('trace-panel').replaceChildren(h('p.small.muted', 'The FHIR resources are generated from the stored entries. The terminology server is only asked for the display of qualifier codes (severity, body site, laterality, allergy type).'));
}

// ------------------------------------------------------------------ TSP7 queue
async function feedback(el) {
  const { items } = await api('/api/feedback');
  el.replaceChildren(h('div.panel', h('h2', 'Content feedback queued for the Belgian NRC', req('TSP7')),
    h('p.small.muted', 'Reports made in the search screen with "Send via the supplier". The supplier forwards them to the NRC request portal: ', h('a', { href: config.nrcPortal.nl, target: '_blank' }, 'NL'), ' / ', h('a', { href: config.nrcPortal.fr, target: '_blank' }, 'FR'), '.'),
    h('table.small', h('tr', ['#', 'created', 'type', 'language', 'search text', 'concept', 'comment', 'status'].map((c) => h('th', c))),
      items.map((f) => h('tr', h('td', f.id), h('td', f.created_at.slice(0, 16)), h('td', config.feedbackKinds[f.kind] || f.kind), h('td', f.language), h('td', f.search_text), h('td.mono', f.sct_concept_id || ''), h('td', f.comment), h('td', h('span.chip.warn', f.status)))))));
}

init().catch((e) => document.body.append(h('pre', e.stack)));
