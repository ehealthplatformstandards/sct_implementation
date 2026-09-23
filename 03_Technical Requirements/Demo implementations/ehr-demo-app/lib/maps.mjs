// S05 - maps from SNOMED CT to classifications (import, storage and use).
//
// The demo imports the map reference sets that are part of the loaded Belgian Edition into the
// eHR database (with the edition version they came from), and derives target codes by evaluating
// the map rules against the patient record, as described in the SNOMED CT to ICD-10 map guide:
//   * rows are grouped by mapGroup; within a group, rules are evaluated in mapPriority order and the
//     first rule that evaluates to true gives the target of that group (an empty target = no code);
//   * "TRUE" and "OTHERWISE TRUE" always match;
//   * "IFA 248152002 | Female (finding) |" / "IFA 248153007 | Male (finding) |" test the gender;
//   * "IFA 445518008 | Age at onset of clinical finding (observable entity) | <= 15.0 years" tests the age;
//   * "IFA <conceptId> | ... |" tests whether the record contains that concept (or a subtype of it).
// A real implementation also shows the map advice to coders (e.g. "POSSIBLE REQUIREMENT FOR ...").

import path from 'node:path';
import { findRf2File, streamRf2 } from '../../shared/rf2.mjs';
import { implicit } from '../../shared/fhir-ts-client.mjs';

/** Map artefacts listed in S05, and where the demo finds them. */
export const S05_TARGETS = [
  { id: 'icd10', label: 'ICD-10 (WHO)', refsets: ['447562003', '10861000172102'], system: 'http://hl7.org/fhir/sid/icd-10' },
  { id: 'icpc2', label: 'ICPC-2', refsets: [], system: 'http://hl7.org/fhir/sid/icpc-2' },
  { id: 'ichi', label: 'ICHI', refsets: [], system: 'http://id.who.int/ichi' },
  { id: 'nihdi', label: 'NIHDI nomenclature', refsets: [], system: 'https://www.ehealth.fgov.be/standards/fhir/core/NamingSystem/nihdi-nomenclature' },
  { id: 'loinc', label: 'LOINC', refsets: [], system: 'http://loinc.org' },
  { id: 'orpha', label: 'Orphanet (ORPHAcodes)', refsets: [], system: 'https://www.orpha.net' },
];

const MAP_NAMES = {
  '447562003': 'SNOMED CT to ICD-10 extended map (International)',
  '10861000172102': 'Belgian addition to ICD-10 extended map',
};

/** Import all rows of the extended map refsets we know into the store (idempotent). */
export async function importExtendedMaps(store, snapshotDir, editionVersion, log = console.log) {
  const [file] = findRf2File(snapshotDir, /^der2_iisssccRefset_ExtendedMapSnapshot.*\.txt$/);
  if (!file) throw new Error('No extended map file in the RF2 snapshot');
  const wanted = new Set(Object.keys(MAP_NAMES));
  store.run('DELETE FROM map_member');
  store.run('DELETE FROM map_artefact');
  const insert = store.db.prepare('INSERT INTO map_member VALUES (?,?,?,?,?,?,?,?,?)');
  const counts = {};
  store.db.exec('BEGIN');
  await streamRf2(file, (r) => {
    // id effectiveTime active moduleId refsetId referencedComponentId mapGroup mapPriority mapRule mapAdvice mapTarget correlationId mapCategoryId
    if (r[2] !== '1' || !wanted.has(r[4])) return;
    insert.run(r[4], r[5], Number(r[6]), Number(r[7]), r[8], r[9], r[10].trim(), r[11], r[12]);
    counts[r[4]] = (counts[r[4]] || 0) + 1;
  });
  store.db.exec('COMMIT');
  const now = new Date().toISOString();
  for (const [refset, n] of Object.entries(counts)) {
    store.run('INSERT INTO map_artefact VALUES (?,?,?,?,?,?,?)', refset, MAP_NAMES[refset], 'http://hl7.org/fhir/sid/icd-10', path.basename(file), editionVersion, now, n);
  }
  log(`[maps] imported ${JSON.stringify(counts)} from ${path.basename(file)}`);
  return counts;
}

/** Age in years at a given date. */
export function ageAt(birthDate, date) {
  const b = new Date(birthDate); const d = new Date(date);
  let age = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) age--;
  return age;
}

/**
 * Evaluate one map rule. `ctx` = { gender: 'female'|'male'|..., ageAtOnset: number, hasConcept: (id) => Promise<boolean> }.
 * Returns {value:boolean, explanation:string}
 */
export async function evaluateRule(rule, ctx) {
  const r = (rule || '').trim();
  if (r === 'TRUE' || r === 'OTHERWISE TRUE') return { value: true, explanation: r };
  let m = /^IFA 248152002 \|[^|]*\|$/.exec(r);
  if (m) return { value: ctx.gender === 'female', explanation: `patient gender = ${ctx.gender}` };
  m = /^IFA 248153007 \|[^|]*\|$/.exec(r);
  if (m) return { value: ctx.gender === 'male', explanation: `patient gender = ${ctx.gender}` };
  m = /^IFA 445518008 \|[^|]*\|\s*(<=|>=|<|>|=)\s*([\d.]+)\s*years$/.exec(r);
  if (m) {
    const [, op, n] = m; const age = ctx.ageAtOnset; const lim = Number(n);
    const value = age === undefined || age === null ? false : { '<=': age <= lim, '>=': age >= lim, '<': age < lim, '>': age > lim, '=': age === lim }[op];
    return { value, explanation: `age at onset = ${age ?? 'unknown'} years (rule: ${op} ${n})` };
  }
  m = /^IFA (\d{6,18}) \|([^|]*)\|$/.exec(r);
  if (m) { const has = await ctx.hasConcept(m[1]); return { value: has, explanation: `record ${has ? 'contains' : 'does not contain'} ${m[1]} |${m[2]}|` }; }
  return { value: false, explanation: `rule not supported by the demo: ${r}` };
}

/** Derive the target codes for a concept, group by group, following the map rules (S05). */
export async function deriveTargets(store, conceptId, ctx) {
  const rows = store.all('SELECT * FROM map_member WHERE referenced_component_id = ? ORDER BY refset_id, map_group, map_priority', conceptId);
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.refset_id}#${r.map_group}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const results = [];
  for (const [k, rs] of groups) {
    const evaluated = [];
    let chosen = null;
    for (const r of rs) {
      const ev = await evaluateRule(r.map_rule, ctx);
      evaluated.push({ priority: r.map_priority, rule: r.map_rule, target: r.map_target, advice: r.map_advice, result: ev.value, explanation: ev.explanation });
      if (ev.value) { chosen = r; break; }
    }
    results.push({ refset: k.split('#')[0], group: Number(k.split('#')[1]), target: chosen?.map_target || null, advice: chosen?.map_advice || null, evaluated });
  }
  return results;
}

/** Record-level helper: does the patient record contain `conceptId` or one of its subtypes? (ECL << via the terminology server) */
export function makeHasConcept(ts, patientConceptIds, trace) {
  return async (conceptId) => {
    if (!patientConceptIds.length) return false;
    const res = await ts.expand({ url: implicit.ecl(`(<< ${conceptId}) AND (${patientConceptIds.join(' OR ')})`), count: 1, trace });
    return (res.total ?? res.contains.length) > 0;
  };
}
