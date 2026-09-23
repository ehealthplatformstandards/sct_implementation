// Demo 1 - TSP4 content verification: is the deployed edition complete and unchanged?
//
// Compares the RF2 release package (the source published by the NRC) with what the terminology
// server serves after the import:
//   - concepts and their active / inactive status          (count + sample)
//   - descriptions and their properties (language, type,   (sample: every active description of the
//     preferred term per language reference set)            sampled concepts, in nl/fr/de/en)
//   - inferred relationships (is-a + defining attributes)  (sample: parents + normal form)
//   - reference sets and their members                     (every Belgian simple reference set)
//   - historical associations and ICD-10 map               (sample through ConceptMap/$translate)
// Stated relationships / OWL axioms are not served by every terminology server (e.g. Snowstorm Lite
// serves the inferred form only); the check reports this instead of silently skipping it.
//
// Usage (standalone): node verify-integrity.mjs --fhir http://localhost:8080/fhir --rf2 <Snapshot folder> [--sample 300]

import { findRf2File, streamRf2, RF2 } from '../shared/rf2.mjs';
import { FhirTerminologyClient, implicit } from '../shared/fhir-ts-client.mjs';
import { tokenFromEnv } from '../shared/oauth.mjs';
import { parseNormalForm } from '../ehr-demo-app/lib/search-service.mjs';

const LANG_REFSETS = { '31000172101': 'nl', '21000172104': 'fr', '120961000172108': 'de', '900000000000509007': 'en', '701000172104': 'nl', '711000172101': 'fr' };

function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

export async function verifyIntegrity({ fhirBase, snapshotDir, sample = 300, seed = 20260915, report, log = console.log }) {
  const ts = new FhirTerminologyClient({ baseUrl: fhirBase, timeoutMs: 60000, bearerToken: tokenFromEnv() });
  const random = rng(seed);
  const t0 = Date.now();
  // ------------------------------------------------------------ concepts
  const active = []; const inactive = [];
  await streamRf2(findRf2File(snapshotDir, /^sct2_Concept_Snapshot/)[0], (r) => (r[2] === '1' ? active : inactive).push(r[0]));
  const pick = (arr, n) => { const out = new Set(); while (out.size < Math.min(n, arr.length)) out.add(arr[Math.floor(random() * arr.length)]); return [...out]; };
  const sampleActive = new Set(pick(active, sample));
  const sampleInactive = new Set(pick(inactive, Math.round(sample / 3)));
  log(`[integrity] RF2: ${active.length} active / ${inactive.length} inactive concepts; sample ${sampleActive.size} + ${sampleInactive.size}`);
  const activeCount = await ts.expand({ url: implicit.ecl('<< 138875005 |SNOMED CT Concept|'), count: 1 });
  report.check({ req: 'TSP4', name: 'Active concepts: RF2 vs terminology server', detail: 'RF2 sct2_Concept_Snapshot active=1 vs $expand << 138875005 (total)', expected: active.length, actual: activeCount.total, status: activeCount.total === active.length ? 'pass' : 'fail' });

  // ------------------------------------------------------------ descriptions (sampled concepts)
  const desc = new Map(); // conceptId -> [{id, lang, type, term}]
  const descOwner = new Map();
  for (const f of findRf2File(snapshotDir, /^sct2_Description_Snapshot-/)) {
    await streamRf2(f, (r) => {
      if (r[2] !== '1' || !sampleActive.has(r[4])) return;
      if (!desc.has(r[4])) desc.set(r[4], []);
      desc.get(r[4]).push({ id: r[0], lang: r[5], type: r[6], term: r[7] });
      descOwner.set(r[0], r[4]);
    });
  }
  const pts = new Map(); // conceptId -> {refsetId: term}
  for (const f of findRf2File(snapshotDir, /^der2_cRefset_LanguageSnapshot-/)) {
    await streamRf2(f, (r) => {
      if (r[2] !== '1' || r[6] !== RF2.PREFERRED || !LANG_REFSETS[r[4]]) return;
      const c = descOwner.get(r[5]); if (!c) return;
      const d = desc.get(c).find((x) => x.id === r[5]);
      if (d.type === RF2.FSN) return;
      if (!pts.has(c)) pts.set(c, {});
      pts.get(c)[r[4]] = d.term;
    });
  }
  // ------------------------------------------------------------ inferred relationships (sampled concepts)
  const rel = new Map();
  await streamRf2(findRf2File(snapshotDir, /^sct2_Relationship_Snapshot/)[0], (r) => {
    if (r[2] !== '1' || !sampleActive.has(r[4])) return;
    if (!rel.has(r[4])) rel.set(r[4], { parents: new Set(), attrs: new Set() });
    if (r[7] === RF2.IS_A) rel.get(r[4]).parents.add(r[5]); else rel.get(r[4]).attrs.add(`${r[7]}=${r[5]}`);
  });
  // concrete values (e.g. strengths of medicinal products) are part of the normal form too
  for (const f of findRf2File(snapshotDir, /^sct2_RelationshipConcreteValues_Snapshot/)) {
    await streamRf2(f, (r) => {
      if (r[2] !== '1' || !sampleActive.has(r[4])) return;
      if (!rel.has(r[4])) rel.set(r[4], { parents: new Set(), attrs: new Set() });
      rel.get(r[4]).attrs.add(`${r[7]}=${r[5]}`);
    });
  }
  log(`[integrity] RF2 sample loaded in ${Math.round((Date.now() - t0) / 1000)} s; querying the server`);

  // ------------------------------------------------------------ compare the sample with $lookup
  const stats = { concepts: 0, statusOk: 0, fsnOk: 0, ptChecked: 0, ptOk: 0, descChecked: 0, descOk: 0, parentsOk: 0, attrsOk: 0, inactiveOk: 0 };
  const mismatches = [];
  const ids = [...sampleActive];
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      const lk = await ts.lookup({ code: id, property: ['parent', 'inactive', 'normalFormTerse'] });
      stats.concepts++;
      if (lk.prop('inactive')[0] === false) stats.statusOk++; else mismatches.push(`${id}: active in RF2, inactive on server`);
      const d = desc.get(id) || [];
      const fsn = d.find((x) => x.type === RF2.FSN && x.lang === 'en')?.term;
      const sFsn = lk.designation.find((x) => x.use?.code === RF2.FSN)?.value;
      if (fsn === sFsn) stats.fsnOk++; else mismatches.push(`${id}: FSN "${fsn}" vs "${sFsn}"`);
      // every active description (synonyms, all languages) is served
      const served = new Set(lk.designation.filter((x) => x.value).map((x) => `${(x.language || '').slice(0, 2)}|${x.value}`));
      for (const x of d.filter((y) => y.type !== RF2.FSN)) { stats.descChecked++; if (served.has(`${x.lang}|${x.term}`)) stats.descOk++; else mismatches.push(`${id}: description ${x.id} (${x.lang}) "${x.term}" not served`); }
      // preferred term per language reference set
      for (const [refset, term] of Object.entries(pts.get(id) || {})) {
        stats.ptChecked++;
        const sp = lk.designation.find((x) => (x.language || '').includes('-x-sctlang-') && x.language.split('-x-sctlang-')[1].replace(/-/g, '') === refset);
        if (sp?.value === term) stats.ptOk++; else mismatches.push(`${id}: PT in ${refset} "${term}" vs "${sp?.value}"`);
      }
      const rr = rel.get(id) || { parents: new Set(), attrs: new Set() };
      const sp = new Set(lk.prop('parent').map(String));
      if (sp.size === rr.parents.size && [...sp].every((p) => rr.parents.has(p))) stats.parentsOk++; else mismatches.push(`${id}: parents RF2 [${[...rr.parents]}] vs server [${[...sp]}]`);
      const nf = parseNormalForm(lk.prop('normalFormTerse')[0] || '');
      const sa = new Set(nf.attributes.map((a) => `${a.type}=${a.value.replace(/^#/, '').replace(/^"|"$/g, '')}`));
      const ra = new Set([...rr.attrs].map((x) => x.replace(/=#/, '=').replace(/="|"$/g, '')));
      if (sa.size === ra.size && [...sa].every((x) => ra.has(x))) stats.attrsOk++; else mismatches.push(`${id}: attributes RF2 [${[...ra].join(',')}] vs server [${[...sa].join(',')}]`);
    }));
  }
  for (const id of sampleInactive) {
    try { const lk = await ts.lookup({ code: id, property: ['inactive'] }); if (lk.prop('inactive')[0] === true) stats.inactiveOk++; else mismatches.push(`${id}: inactive in RF2, active on server`); } catch { mismatches.push(`${id}: inactive concept not found on server`); }
  }
  const pct = (a, b) => `${a}/${b}`;
  report.check({ req: 'TSP4', name: 'Concept status (sample of active concepts)', expected: pct(stats.concepts, stats.concepts), actual: pct(stats.statusOk, stats.concepts), status: stats.statusOk === stats.concepts ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Concept status (sample of inactive concepts)', expected: pct(sampleInactive.size, sampleInactive.size), actual: pct(stats.inactiveOk, sampleInactive.size), status: stats.inactiveOk === sampleInactive.size ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Fully specified names (sample)', expected: pct(stats.concepts, stats.concepts), actual: pct(stats.fsnOk, stats.concepts), status: stats.fsnOk === stats.concepts ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Active descriptions nl/fr/de/en of the sampled concepts are served', expected: pct(stats.descChecked, stats.descChecked), actual: pct(stats.descOk, stats.descChecked), status: stats.descOk === stats.descChecked ? 'pass' : 'fail' });
  report.check({ req: 'TSP4 TSP6', name: 'Preferred term per language reference set (nl-BE, fr-BE, de-BE, GP, en-US)', expected: pct(stats.ptChecked, stats.ptChecked), actual: pct(stats.ptOk, stats.ptChecked), status: stats.ptOk === stats.ptChecked ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Inferred is-a relationships (parents of sampled concepts)', expected: pct(stats.concepts, stats.concepts), actual: pct(stats.parentsOk, stats.concepts), status: stats.parentsOk === stats.concepts ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Inferred defining attributes (normal form of sampled concepts)', expected: pct(stats.concepts, stats.concepts), actual: pct(stats.attrsOk, stats.concepts), status: stats.attrsOk === stats.concepts ? 'pass' : 'fail' });
  report.check({ req: 'TSP4', name: 'Stated relationships / OWL axioms', detail: 'Not exposed by this terminology server (it serves the inferred form). A server that serves the stated form would be checked the same way.', expected: 'served', actual: 'not exposed by the server', status: 'warn' });

  // ------------------------------------------------------------ reference sets (all Belgian simple refsets)
  const members = new Map(); const activeSet = new Set(active);
  for (const f of findRf2File(snapshotDir, /^der2_Refset_.*Snapshot.*\.txt$/)) {
    await streamRf2(f, (r) => {
      if (r[2] !== '1') return;
      if (!members.has(r[4])) members.set(r[4], { all: 0, activeConcepts: 0 });
      const m = members.get(r[4]); m.all++; if (activeSet.has(r[5])) m.activeConcepts++;
    });
  }
  const refRows = [];
  for (const [refset, m] of [...members].sort((x, y) => y[1].all - x[1].all)) {
    const srv = await ts.expand({ url: implicit.refset(refset), count: 1 });
    const ok = srv.total === m.all || srv.total === m.activeConcepts;
    refRows.push({ refset, rf2: m.all, rf2ActiveConcepts: m.activeConcepts, server: srv.total, ok });
    if (!ok) mismatches.push(`refset ${refset}: RF2 ${m.all} members vs server ${srv.total}`);
  }
  const refOk = refRows.filter((x) => x.ok).length;
  report.check({ req: 'TSP4', name: `Reference set members (${refRows.length} simple reference sets)`, expected: `${refRows.length} identical`, actual: `${refOk} identical`, status: refOk === refRows.length ? 'pass' : 'fail' });
  const withInactive = refRows.filter((x) => x.rf2ActiveConcepts < x.rf2);
  if (withInactive.length) report.check({ req: 'S03', name: 'Reference set members that reference inactive concepts', detail: withInactive.map((x) => `${x.refset}: ${x.rf2 - x.rf2ActiveConcepts}`).join('; '), expected: 'filtered out by the eHR at data entry', actual: `${withInactive.reduce((s, x) => s + x.rf2 - x.rf2ActiveConcepts, 0)} members`, status: 'info' });

  // ------------------------------------------------------------ historical associations + ICD-10 map (sample)
  const assoc = []; const maps = [];
  await streamRf2(findRf2File(snapshotDir, /^der2_cRefset_AssociationSnapshot/)[0], (r) => { if (r[2] === '1' && r[4] === '900000000000526001' && random() < 0.004) assoc.push([r[5], r[6]]); });
  await streamRf2(findRf2File(snapshotDir, /^der2_iisssccRefset_ExtendedMapSnapshot/)[0], (r) => { if (r[2] === '1' && r[4] === '447562003' && r[8] === 'TRUE' && r[10] && random() < 0.0005) maps.push([r[5], r[10].trim()]); });
  let assocOk = 0; let mapOk = 0;
  for (const [src, tgt] of assoc.slice(0, 80)) { try { const t = await ts.translate({ url: implicit.conceptMap('900000000000526001'), code: src }); if (t.matches.some((m) => m.concept?.code === tgt)) assocOk++; else mismatches.push(`REPLACED BY ${src} -> ${tgt} not returned`); } catch { mismatches.push(`REPLACED BY ${src}: no map`); } }
  for (const [src, tgt] of maps.slice(0, 60)) { try { const t = await ts.translate({ url: implicit.conceptMap('447562003'), code: src }); if (t.matches.some((m) => m.concept?.code === tgt)) mapOk++; else mismatches.push(`ICD-10 ${src} -> ${tgt} not returned`); } catch { mismatches.push(`ICD-10 ${src}: no map`); } }
  report.check({ req: 'TSP4', name: 'Historical associations (REPLACED BY, sample)', expected: `${Math.min(80, assoc.length)}/${Math.min(80, assoc.length)}`, actual: `${assocOk}/${Math.min(80, assoc.length)}`, status: assocOk === Math.min(80, assoc.length) ? 'pass' : 'fail' });
  report.check({ req: 'TSP4 S05', name: 'ICD-10 extended map rows (sample)', expected: `${Math.min(60, maps.length)}/${Math.min(60, maps.length)}`, actual: `${mapOk}/${Math.min(60, maps.length)}`, status: mapOk === Math.min(60, maps.length) ? 'pass' : 'fail' });

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  report.block('Reference sets: RF2 package vs terminology server', `<table><tr><th>Reference set</th><th class="num">RF2 active members</th><th class="num">of which active concepts</th><th class="num">Server</th><th></th></tr>${refRows.map((x) => `<tr><td class="mono">${x.refset}</td><td class="num">${x.rf2.toLocaleString('en')}</td><td class="num">${x.rf2ActiveConcepts.toLocaleString('en')}</td><td class="num">${(x.server ?? 0).toLocaleString('en')}</td><td>${x.ok ? '<span class="st pass">OK</span>' : '<span class="st fail">DIFF</span>'}</td></tr>`).join('')}</table>`);
  if (mismatches.length) report.block(`Differences (${mismatches.length})`, `<pre>${esc(mismatches.slice(0, 200).join('\n'))}</pre>`);
  log(`[integrity] done in ${Math.round((Date.now() - t0) / 1000)} s, ${mismatches.length} difference(s)`);
  return { stats, refRows, mismatches, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-integrity.mjs')) {
  const { Report, args } = await import('./lib/report.mjs');
  const a = args({ fhir: 'http://localhost:8080/fhir', sample: '300', id: 'tsp4-integrity' });
  const r = new Report({ id: a.id, title: 'Release deployment: content integrity (RF2 vs terminology server)', requirements: ['TSP4'] });
  r.meta['Terminology server'] = a.fhir; r.meta['RF2 snapshot'] = a.rf2;
  r.meta['SNOMED CT version on server'] = (await new FhirTerminologyClient({ baseUrl: a.fhir }).snomedVersions())[0]?.version;
  await verifyIntegrity({ fhirBase: a.fhir, snapshotDir: a.rf2, sample: Number(a.sample), report: r });
  r.write();
  process.exitCode = r.ok ? 0 : 1;
}
