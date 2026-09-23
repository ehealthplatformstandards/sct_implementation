// Demo 1 - TSP1 (FHIR terminology operations), TSP2 (ECL concept sets) and TSP6 (languages).
//
// Runs a set of standard FHIR R4 terminology requests against the local terminology server and
// records what came back. Nothing here is specific to Snowstorm Lite: point --fhir at any server.
//
// Usage: node conformance-check.mjs [--fhir http://localhost:8090/fhir] [--id tsp1-tsp2-tsp6-conformance]

import { FhirTerminologyClient, implicit, SNOMED } from '../shared/fhir-ts-client.mjs';
import { tokenFromEnv } from '../shared/oauth.mjs';
import { Report, args } from './lib/report.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const a = args({ fhir: 'http://localhost:8090/fhir', id: 'tsp1-tsp2-tsp6-conformance', bindings: fileURLToPath(new URL('../ehr-demo-app/config/bindings.json', import.meta.url)) });
const ts = new FhirTerminologyClient({ baseUrl: a.fhir, name: 'lts', bearerToken: tokenFromEnv() });
const bindings = JSON.parse(fs.readFileSync(a.bindings, 'utf8'));
const r = new Report({
  id: a.id, title: 'Terminology services: FHIR operations, ECL and languages', requirements: ['TSP1', 'TSP2', 'TSP6'],
  intro: 'Every check below is one standard FHIR R4 terminology request ($lookup, $validate-code, $expand) on http://snomed.info/sct. The value sets of the Care Set data elements are defined intensionally with ECL (implicit value sets <code>http://snomed.info/sct?fhir_vs=ecl/…</code>), so no member list is maintained by hand.',
});
const last = (trace) => trace[trace.length - 1];
const t = () => [];

// ------------------------------------------------------------------ server + version
{
  const trace = t();
  const cs = await ts.request('metadata', 'metadata', {}, { trace });
  const ops = Object.fromEntries((cs.rest?.[0]?.resource || []).map((x) => [x.type, (x.operation || []).map((o) => o.name)]));
  r.meta['FHIR endpoint'] = a.fhir;
  r.meta.Software = `${cs.software?.name || '?'} ${cs.software?.version || ''}`;
  r.meta['FHIR version'] = cs.fhirVersion;
  const needed = { CodeSystem: ['lookup'], ValueSet: ['expand', 'validate-code'] };
  for (const [type, list] of Object.entries(needed)) for (const op of list) {
    r.check({ req: 'TSP1', name: `CapabilityStatement declares ${type}/$${op}`, expected: 'declared', actual: (ops[type] || []).includes(op) ? 'declared' : 'missing', status: (ops[type] || []).includes(op) ? 'pass' : 'fail', ms: last(trace).ms, request: 'GET /metadata' });
  }
  const versions = await ts.snomedVersions({ trace });
  r.meta['SNOMED CT version'] = versions.map((v) => v.version).join(', ');
  r.check({ req: 'TSP1', name: 'SNOMED CT Belgian Edition loaded (CodeSystem?url=http://snomed.info/sct)', expected: 'http://snomed.info/sct/11000172109/version/…', actual: versions[0]?.version, status: /\/11000172109\/version\/\d{8}$/.test(versions[0]?.version || '') ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
}

// ------------------------------------------------------------------ TSP1: the five Care Sets
const CASES = {
  problem: { member: '195967001', nonMember: '71388002', filters: { 'nl-BE': 'astma', 'fr-BE': 'asthme', 'de-BE': 'asthma', 'en-US': 'asthma' } },
  allergy: { member: '762952008', nonMember: '195967001', filters: { 'nl-BE': 'pinda', 'fr-BE': 'arachide', 'de-BE': 'erdnuss', 'en-US': 'peanut' } },
  vaccination: { member: '1181000221105', nonMember: '762952008', filters: { 'nl-BE': 'influenza', 'fr-BE': 'grippe', 'de-BE': 'grippe', 'en-US': 'influenza' } },
  procedure: { member: '443435007', nonMember: '195967001', filters: { 'nl-BE': 'heupprothese', 'fr-BE': 'hanche prothese', 'de-BE': 'hüft', 'en-US': 'hip replacement' } },
  observation: { member: '27113001', nonMember: '195967001', filters: { 'nl-BE': 'lichaamsgewicht', 'fr-BE': 'poids corporel', 'de-BE': 'körpergewicht', 'en-US': 'body weight' } },
};
const INACTIVE = { code: '602001', label: 'Ross river fever (inactive since 2020-01-31, REPLACED BY 789400009)' };

const bindingRows = [];
for (const [id, c] of Object.entries(CASES)) {
  const cs = bindings.careSets.find((x) => x.id === id);
  const url = implicit.ecl(cs.binding.ecl);
  let trace = t();
  const all = await ts.expand({ url, count: 1, trace });
  r.check({ req: 'TSP1', name: `$expand binding of ${cs.label} (${cs.dataElement})`, detail: cs.binding.ecl, expected: '> 0 concepts', actual: `${all.total} concepts`, status: all.total > 0 ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
  bindingRows.push([cs.label, cs.dataElement, cs.binding.ecl, all.total]);
  for (const [lang, filter] of Object.entries(c.filters)) {
    trace = t();
    const res = await ts.expand({ url, filter, count: 3, displayLanguage: lang, trace });
    r.check({ req: lang === 'en-US' ? 'TSP1' : 'TSP1 TSP6', name: `$expand ${cs.label} with filter "${filter}" (${lang})`, expected: 'matches in that language', actual: res.contains.slice(0, 3).map((x) => x.display).join(' | ') || 'no match', status: res.contains.length ? 'pass' : 'warn', ms: last(trace).ms, request: last(trace).url });
  }
  trace = t();
  const ok = await ts.validateInValueSet({ url, code: c.member, trace });
  r.check({ req: 'TSP1', name: `$validate-code ${c.member} in ${cs.label}`, expected: true, actual: ok.result, detail: ok.display, status: ok.result === true ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
  trace = t();
  const no = await ts.validateInValueSet({ url, code: c.nonMember, trace });
  r.check({ req: 'TSP1', name: `$validate-code ${c.nonMember} (other hierarchy) in ${cs.label}`, expected: false, actual: no.result, status: no.result === false ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
}
{
  const cs = bindings.careSets.find((x) => x.id === 'problem');
  const trace = t();
  const v = await ts.validateInValueSet({ url: implicit.ecl(cs.binding.ecl), code: INACTIVE.code, trace });
  r.check({ req: 'TSP1', name: `$validate-code of an inactive concept: ${INACTIVE.label}`, expected: false, actual: v.result, detail: v.message, status: v.result === false ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
}

// ------------------------------------------------------------------ TSP1 + TSP6: $lookup in every Belgian language reference set
const LANGS = { 'nl-BE': '31000172101', 'fr-BE': '21000172104', 'de-BE': '120961000172108', 'nl-BE-GP': '701000172104', 'fr-BE-GP': '711000172101', 'en-US': '900000000000509007' };
const langRows = [];
for (const code of ['22298006', '195967001', '38341003']) {
  const row = [code];
  for (const [lang, refset] of Object.entries(LANGS)) {
    const trace = t();
    const lk = await ts.lookup({ code, displayLanguage: lang, trace });
    const refsetPt = lk.designation.find((d) => (d.language || '').replace(/-/g, '').endsWith(refset))?.value;
    row.push(refsetPt ? `${lk.display}` : `${lk.display} (fallback)`);
    r.check({ req: 'TSP6', name: `$lookup ${code} displayLanguage=${lang} (language refset ${refset})`, expected: 'preferred term of that language reference set', actual: lk.display, status: refsetPt ? 'pass' : (lang.endsWith('GP') ? 'info' : 'warn'), detail: refsetPt ? undefined : 'no preferred term in this reference set: the server falls back to another language', ms: last(trace).ms, request: last(trace).url });
  }
  langRows.push(row);
}
r.block('Preferred terms per Belgian language reference set (TSP6)', `<table><tr><th>Concept</th>${Object.keys(LANGS).map((l) => `<th>${l}</th>`).join('')}</tr>${langRows.map((row) => `<tr>${row.map((c, i) => `<td class="${i === 0 ? 'mono' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table>`);

{
  const trace = t();
  const lk = await ts.lookup({ code: '22298006', displayLanguage: 'nl-BE', property: ['parent', 'child', 'normalFormTerse', 'inactive'], trace });
  r.check({ req: 'TSP1', name: '$lookup 22298006 with properties parent, child, normalFormTerse, inactive', expected: 'hierarchy + defining relationships', actual: `${lk.prop('parent').length} parents, ${lk.prop('child').length} children, ${lk.prop('normalFormTerse')[0]}`, status: lk.prop('parent').length ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
}

// ------------------------------------------------------------------ TSP2: ECL
const ECL = [
  { ecl: '< 404684003 |Clinical finding| : 363698007 |Finding site| = << 80891009 |Heart structure|', what: 'refinement on a defining attribute (finding site)', yes: '22298006', no: '195967001' },
  { ecl: '<< 73211009 |Diabetes mellitus| MINUS << 46635009 |Diabetes mellitus type 1|', what: 'hierarchy with exclusion (MINUS)', yes: '44054006', no: '46635009' },
  { ecl: '^ 40811000172108 |Belgian problem list subset| AND << 19829001 |Disorder of lung|', what: 'Belgian reference set combined with a hierarchy', yes: '233604007', no: '22298006' },
  { ecl: '<< 40733004 |Infectious disease| : 246075003 |Causative agent| = << 409822003 |Domain Bacteria|', what: 'attribute refinement (causative agent)', yes: '53084003', no: '233604007' },
  { ecl: '<< 84757009 |Epilepsy|', what: 'descendants are found through relationships - concepts added in a new release are included automatically', yes: '1380178003', no: '22298006' },
];
const eclRows = [];
for (const e of ECL) {
  let trace = t();
  const x = await ts.expand({ url: implicit.ecl(e.ecl), count: 3, displayLanguage: 'nl-BE', trace });
  eclRows.push([e.ecl, e.what, x.total]);
  r.check({ req: 'TSP2', name: `ValueSet/$expand ECL: ${e.what}`, detail: e.ecl, expected: 'evaluated dynamically', actual: `${x.total} concepts, e.g. ${x.contains.map((c) => c.display).join(' | ')}`, status: x.total > 0 ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
  trace = t();
  const y = await ts.validateInValueSet({ url: implicit.ecl(e.ecl), code: e.yes, trace });
  let exists = true;
  if (y.result !== true) { try { await ts.lookup({ code: e.yes }); } catch { exists = false; } }
  if (!exists) {
    // e.g. 1380178003 was added in the 20260915 edition: once that edition is deployed it is a member
    // of << 84757009 without anybody editing the constraint (TSP2: no enumerated member list).
    r.check({ req: 'TSP2', name: `$validate-code ${e.yes} against the ECL above`, expected: 'member once the concept exists', actual: 'concept not in this edition version', detail: 'The concept was added in a later release; after the upgrade it becomes a member automatically.', status: 'info', ms: last(trace).ms, request: last(trace).url });
  } else {
    r.check({ req: 'TSP2', name: `$validate-code ${e.yes} against the ECL above`, expected: true, actual: y.result, detail: y.display || y.message, status: y.result === true ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
  }
  trace = t();
  const n = await ts.validateInValueSet({ url: implicit.ecl(e.ecl), code: e.no, trace });
  r.check({ req: 'TSP2', name: `$validate-code ${e.no} against the ECL above`, expected: false, actual: n.result, status: n.result === false ? 'pass' : 'fail', ms: last(trace).ms, request: last(trace).url });
}
r.block('Care Set bindings evaluated as ECL (TSP1 / TSP2)', `<table><tr><th>Care Set</th><th>Data element</th><th>Binding (ECL)</th><th>Concepts</th></tr>${bindingRows.map((b) => `<tr><td>${b[0]}</td><td class="mono">${b[1]}</td><td class="mono">${b[2]}</td><td class="num">${Number(b[3]).toLocaleString('en')}</td></tr>`).join('')}</table>`);
r.block('Other ECL constraints (TSP2)', `<table><tr><th>ECL</th><th>What it shows</th><th>Concepts</th></tr>${eclRows.map((b) => `<tr><td class="mono">${b[0]}</td><td>${b[1]}</td><td class="num">${Number(b[2]).toLocaleString('en')}</td></tr>`).join('')}</table>`);
r.write();
process.exitCode = r.ok ? 0 : 1;
