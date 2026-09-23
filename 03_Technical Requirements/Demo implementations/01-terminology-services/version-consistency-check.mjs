// Demo 1 - TSP5 Version consistency.
//
// "The solution shall use the same production version of the Belgian Edition of SNOMED CT across all
//  components and terminology-dependent services that exchange or process SNOMED CT-coded information.
//  Where the solution uses different SNOMED CT versions concurrently, the supplier shall identify the
//  affected components and versions and demonstrate that SNOMED CT-coded information can be exchanged and
//  processed between them without loss or unintended change of clinical meaning."
//
// What this check does:
//   1. asks the eHR which terminology endpoint and SNOMED CT version each component uses (GET /api/version)
//      and asks every endpoint itself which version it serves (CodeSystem?url=http://snomed.info/sct);
//   2. reads the active backend of the LTS proxy;
//   3. calls every read-only component once through the eHR API. Each component is pinned to the production
//      version and refuses to answer (HTTP 409) when its terminology server returns another version;
//   4. lists the versions stamped on the stored entries and exported in FHIR (Coding.version);
//   5. when components run different versions: identifies them, and compares for every concept stored in
//      the record the active status and the FSN on both versions, and the result of every analytics
//      report (S06) on both versions. That comparison is the evidence the second paragraph asks for.
//
// Usage: node version-consistency-check.mjs [--ehr http://localhost:3000] [--proxy http://localhost:8090] [--id tsp5-version-consistency]

import { FhirTerminologyClient, implicit, parseVersionUri, BE_MODULE, SNOMED } from '../shared/fhir-ts-client.mjs';
import { Report, args } from './lib/report.mjs';
import { tokenFromEnv } from '../shared/oauth.mjs';

const bearerToken = tokenFromEnv();

const a = args({ ehr: 'http://localhost:3000', proxy: 'http://localhost:8090', id: 'tsp5-version-consistency', lang: 'nl-BE' });
const r = new Report({
  id: a.id, title: 'Version consistency across eHR components', requirements: ['TSP5'],
  intro: 'Every eHR component that processes SNOMED CT-coded data (search, validation, reporting, FHIR export, release impact) has its own terminology client and may be configured with its own endpoint. The check verifies that all of them run the production version of the Belgian Edition, that each component refuses to work on another version, and which versions are stamped on stored and exported data. When versions differ, it identifies the components and compares the meaning of every stored concept and the analytics results between the versions.',
});
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (v) => parseVersionUri(v)?.effectiveTime || v || '?';
const isId = (x) => typeof x === 'string' && /^\d{6,18}$/.test(x);

async function ehr(method, path, body) {
  const t = performance.now();
  const res = await fetch(`${a.ehr}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, ms: Math.round(performance.now() - t) };
}

// ------------------------------------------------------------------ 1. components and their endpoints
const ver = await ehr('GET', '/api/version');
if (ver.status !== 200) throw new Error(`GET ${a.ehr}/api/version: HTTP ${ver.status}`);
const prod = ver.json.productionVersion;
const components = ver.json.components;
r.meta.eHR = a.ehr;
r.meta['Production version (eHR)'] = prod;
for (const c of components) {
  r.check({
    req: 'TSP5', name: `Component "${c.component}" runs the production version`,
    detail: `endpoint ${c.terminologyServer} · version pinned in the component: ${short(c.pinnedVersion)}`,
    expected: short(prod), actual: c.error ? `error: ${c.error}` : short(c.serverVersion),
    status: c.serverVersion === prod && c.pinnedVersion === prod ? 'pass' : 'fail',
    request: `GET ${c.terminologyServer}/CodeSystem?url=${SNOMED}`,
  });
}
// the same question asked by this script directly, without trusting the eHR's own answer
const endpoints = [...new Set(components.map((c) => c.terminologyServer))];
const endpointVersions = {};
for (const url of endpoints) {
  const list = await new FhirTerminologyClient({ baseUrl: url, bearerToken }).snomedVersions().catch((e) => [{ version: `error: ${e.message}` }]);
  endpointVersions[url] = list.map((v) => v.version);
  r.check({
    req: 'TSP5', name: `Endpoint ${url} serves the production version (and only that version)`,
    detail: `used by: ${components.filter((c) => c.terminologyServer === url).map((c) => c.component).join(', ')}`,
    expected: short(prod), actual: list.map((v) => short(v.version)).join(', '),
    status: list.length === 1 && list[0].version === prod ? 'pass' : 'fail', request: `GET ${url}/CodeSystem?url=${SNOMED}`,
  });
}

// ------------------------------------------------------------------ 2. LTS proxy
const px = await fetch(`${a.proxy}/admin/status`).then((x) => x.json()).catch(() => null);
if (px) {
  r.meta['LTS proxy'] = `${a.proxy}: active backend "${px.active}" (${short(px.activeVersion)})`;
  r.check({ req: 'TSP5', name: 'LTS proxy: the active backend serves the production version', expected: short(prod), actual: `${px.active}: ${short(px.activeVersion)}`, status: px.activeVersion === prod ? 'pass' : 'fail', request: `GET ${a.proxy}/admin/status` });
  for (const b of px.backends.filter((x) => x.name !== px.active)) {
    const used = components.filter((c) => c.terminologyServer.startsWith(b.url)).map((c) => c.component);
    r.check({ req: 'TSP5', name: `LTS proxy: standby backend "${b.name}" (kept for rollback)`, detail: used.length ? `used directly by: ${used.join(', ')}` : 'not used by any component', expected: used.length ? short(prod) : 'not used', actual: short(b.version), status: used.length && b.version !== prod ? 'fail' : 'info' });
  }
}

// ------------------------------------------------------------------ 3. every component, once
const exercises = [
  { component: 'search', label: 'search "astma" in the problem list (U01)', method: 'GET', path: `/api/search?text=astma&careSet=problem&lang=${a.lang}` },
  { component: 'validation', label: 'validate 195967001 |Asthma| for the problem list (U04/S03)', method: 'POST', path: '/api/validate', body: { code: '195967001', careSet: 'problem', lang: a.lang } },
  { component: 'reporting', label: 'report "Patients with a disorder of the lung" (S06)', method: 'GET', path: '/api/reports/lung' },
  { component: 'fhir-export', label: 'FHIR export of patient pat-001 (I01)', method: 'GET', path: '/api/patients/pat-001/fhir' },
];
for (const x of exercises) {
  const res = await ehr(x.method, x.path, x.body);
  const refused = res.status === 409;
  r.check({
    req: 'TSP5', name: `Component "${x.component}": ${x.label}`,
    detail: refused ? 'The component detected that its terminology server answered with another version than the pinned production version and refused to process the data.' : undefined,
    expected: 'HTTP 200', actual: refused ? `HTTP 409 refused: ${res.json.error}` : `HTTP ${res.status}`, status: res.status === 200 ? 'pass' : 'fail', ms: res.ms, request: `${x.method} ${a.ehr}${x.path}`,
  });
}
r.check({ req: 'TSP5', name: 'Component "release-impact" (S04)', detail: 'not called by this check because it writes to the record; its endpoint and version are verified above', status: 'info', actual: short(components.find((c) => c.component === 'release-impact')?.serverVersion) });

// ------------------------------------------------------------------ 4. version stamps on stored and exported data
const stamped = ver.json.versionsInRecord || [];
r.check({
  req: 'TSP5', name: 'Versions stamped on stored entries (clinical_entry.sct_version)',
  detail: 'Entries keep the version they were recorded with. Entries from an older version are not re-coded; the release impact analysis (S04) links them to their replacements.',
  expected: `Belgian Edition versions (module ${BE_MODULE})`, actual: stamped.map((v) => `${short(v.version)}: ${v.entries} entries`).join(', ') || 'none',
  status: stamped.every((v) => parseVersionUri(v.version)?.module === BE_MODULE) ? 'pass' : 'fail',
});
const patients = (await ehr('GET', '/api/patients')).json.items || [];
const codings = [];
const walk = (o) => {
  if (Array.isArray(o)) o.forEach(walk);
  else if (o && typeof o === 'object') { if (o.system === SNOMED && o.code) codings.push(o); Object.values(o).forEach(walk); }
};
let exportOk = true;
for (const p of patients) {
  const res = await ehr('GET', `/api/patients/${p.id}/fhir`);
  if (res.status !== 200) { exportOk = false; continue; }
  walk(res.json);
}
const byVersion = codings.reduce((m, c) => ({ ...m, [c.version || 'no version']: (m[c.version || 'no version'] || 0) + 1 }), {});
r.check({
  req: 'TSP5', name: `Coding.version in the FHIR export of ${patients.length} patients (${codings.length} SNOMED CT codings)`,
  detail: 'FHIR Coding.version is "the version of the code system which was used when choosing this code", so a receiver can interpret each code in the right version.',
  expected: 'every SNOMED CT coding carries its version', actual: Object.entries(byVersion).map(([k, v]) => `${short(k)}: ${v}`).join(', ') || 'none',
  status: !exportOk ? 'fail' : (byVersion['no version'] ? 'warn' : 'pass'),
});

// ------------------------------------------------------------------ 5. different versions in use: identify and compare
const versionsInUse = [...new Set(components.map((c) => c.serverVersion).filter(Boolean))];
if (versionsInUse.length > 1 || versionsInUse.some((v) => v !== prod)) {
  const prodEndpoint = components.find((c) => c.serverVersion === prod)?.terminologyServer;
  const others = [...new Set(components.filter((c) => c.serverVersion && c.serverVersion !== prod).map((c) => `${c.terminologyServer}|${c.serverVersion}`))].map((k) => { const [url, version] = k.split('|'); return { url, version }; });
  r.block('Components running another version than production', `<table><tr><th>Component</th><th>Endpoint</th><th>Version</th></tr>${components.map((c) => `<tr><td>${esc(c.component)}</td><td class="mono">${esc(c.terminologyServer)}</td><td class="mono ${c.serverVersion === prod ? '' : 'bad'}">${esc(short(c.serverVersion))}${c.serverVersion === prod ? '' : ' ≠ production'}</td></tr>`).join('')}</table>`);
  const entries = (await ehr('GET', '/api/db/clinical_entry')).json.rows || [];
  const ids = [...new Set(entries.flatMap((e) => [e.sct_concept_id, e.severity_sct, e.body_site_sct, e.laterality_sct, e.category, e.reaction_manifestation_sct]).filter(isId))];
  const reports = (await ehr('GET', '/api/reports')).json.items || [];
  const prodTs = new FhirTerminologyClient({ baseUrl: prodEndpoint, bearerToken });

  async function describe(ts) {
    const status = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const x = await ts.expand({ url: implicit.ecl(batch.join(' OR ')), count: batch.length, includeInactive: true, displayLanguage: 'en' });
      for (const c of x.contains) status.set(c.code, c.inactive === true ? 'inactive' : 'active');
    }
    const fsn = new Map();
    await Promise.all(ids.map(async (id) => {
      try {
        const lk = await ts.lookup({ code: id, displayLanguage: 'en' });
        fsn.set(id, lk.designation.find((d) => d.use?.code === '900000000000003001' && String(d.language || '').startsWith('en'))?.value || lk.display);
      } catch { /* unknown in this version */ }
    }));
    const reportHits = {};
    for (const rep of reports) {
      const scope = entries.filter((e) => isId(e.sct_concept_id) && (!rep.careSet || e.care_set === rep.careSet));
      const list = [...new Set(scope.map((e) => e.sct_concept_id))];
      const x = list.length ? await ts.expand({ url: implicit.ecl(`(${rep.ecl}) AND (${list.join(' OR ')})`), count: list.length }) : { contains: [] };
      const hit = new Set(x.contains.map((c) => c.code));
      reportHits[rep.id] = { concepts: hit, entries: scope.filter((e) => hit.has(e.sct_concept_id)) };
    }
    return { status, fsn, reportHits };
  }

  const P = await describe(prodTs);
  for (const o of others) {
    const O = await describe(new FhirTerminologyClient({ baseUrl: o.url, bearerToken }));
    const affected = components.filter((c) => c.terminologyServer === o.url && c.serverVersion === o.version).map((c) => c.component);
    const rows = ids.map((id) => {
      const sp = P.status.get(id) || 'unknown'; const so = O.status.get(id) || 'unknown';
      const same = sp === so && P.fsn.get(id) === O.fsn.get(id);
      return { id, sp, so, fp: P.fsn.get(id), fo: O.fsn.get(id), same };
    });
    rows.sort((x, y) => Number(x.same) - Number(y.same)); // differences first
    const changed = rows.filter((x) => !x.same);
    r.check({
      req: 'TSP5', name: `Stored concepts with the same status and FSN in ${short(prod)} and ${short(o.version)}`,
      detail: `affected component(s): ${affected.join(', ')} on ${o.url}`, expected: `${ids.length} of ${ids.length}`, actual: `${ids.length - changed.length} of ${ids.length}`,
      status: changed.length ? 'fail' : 'pass',
    });
    const diffReports = [];
    for (const rep of reports) {
      const hp = P.reportHits[rep.id]; const ho = O.reportHits[rep.id];
      const onlyP = hp.entries.filter((e) => !ho.concepts.has(e.sct_concept_id)); const onlyO = ho.entries.filter((e) => !hp.concepts.has(e.sct_concept_id));
      if (onlyP.length || onlyO.length) diffReports.push({ rep, hp, ho, onlyP, onlyO });
    }
    r.check({
      req: 'TSP5', name: `Analytics reports give the same result on ${short(prod)} and ${short(o.version)}`,
      detail: 'Each report (S06) is evaluated on the stored concepts with both versions.', expected: `${reports.length} of ${reports.length} identical`, actual: `${reports.length - diffReports.length} of ${reports.length} identical`,
      status: diffReports.length ? 'fail' : 'pass',
    });
    const who = (e) => `${esc(e.patient_id)} · ${esc(e.sct_concept_id)} ${esc(e.sct_term_selected)}`;
    r.block(`Meaning of the stored concepts: ${short(prod)} (production) vs ${short(o.version)} (${affected.join(', ')})`, `<table><tr><th>Concept</th><th>${esc(short(prod))}</th><th>${esc(short(o.version))}</th><th>Same meaning?</th></tr>${rows.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td><span class="${x.sp === 'active' ? '' : 'bad'}">${esc(x.sp)}</span><div class="d">${esc(x.fp || '-')}</div></td><td><span class="${x.so === 'active' ? '' : 'bad'}">${esc(x.so)}</span><div class="d">${esc(x.fo || '-')}</div></td><td>${x.same ? '<span class="ok">yes</span>' : '<b class="bad">no</b>'}</td></tr>`).join('')}</table>
<p style="font-size:13px">${changed.length ? `<b class="bad">${changed.length} stored concept(s)</b> have another status or another fully specified name in ${esc(short(o.version))}. Data exchanged with or processed by the ${esc(affected.join(', '))} component(s) can be interpreted differently for these concepts.` : 'All stored concepts have the same status and fully specified name in both versions.'}</p>`);
    r.block(`Analytics results: ${short(prod)} vs ${short(o.version)}`, `<table><tr><th>Report</th><th class="num">${esc(short(prod))}</th><th class="num">${esc(short(o.version))}</th><th>Entries that differ</th></tr>${reports.map((rep) => {
      const d = diffReports.find((x) => x.rep.id === rep.id);
      return `<tr><td><b>${esc(rep.title)}</b><div class="rq">${esc(rep.ecl)}</div></td><td class="num">${P.reportHits[rep.id].entries.length}</td><td class="num">${O.reportHits[rep.id].entries.length}</td><td>${d ? [...d.onlyP.map((e) => `only in ${esc(short(prod))}: ${who(e)}`), ...d.onlyO.map((e) => `<span class="bad">only in ${esc(short(o.version))}: ${who(e)}</span>`)].join('<br>') : '<span class="ok">identical</span>'}</td></tr>`;
    }).join('')}</table>
<p style="font-size:13px">Entries counted per report. A difference means the ${esc(affected.join(', '))} component would give another answer than production for the same record. Options: point the component to the production endpoint (the LTS proxy), or document for each difference why it does not change clinical meaning.</p>`);
  }
}

r.write();
process.exitCode = r.ok ? 0 : 1;
