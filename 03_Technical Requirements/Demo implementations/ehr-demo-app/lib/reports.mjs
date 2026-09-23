// S06 - reporting / data extraction that uses the SNOMED CT ontology (is-a + defining attributes)
// instead of hand-maintained code lists.
//
// Each report is an ECL expression. The eHR evaluates it against the concepts stored in the record by
// asking the terminology server for  (report ECL) AND (concept1 OR concept2 OR ...)  - so the result
// always reflects the relationships of the edition version that the server runs, and no code list has
// to be enumerated or maintained. (An eHR could equally evaluate the same ECL in its own database with
// a transitive closure table; the requirement leaves the mechanism to the supplier.)

import { implicit } from '../../shared/fhir-ts-client.mjs';

export const REPORTS = [
  {
    id: 'lung', title: 'Patients with a disorder of the lung',
    ecl: '<< 19829001 |Disorder of lung|', uses: 'is-a hierarchy (all subtypes of "Disorder of lung")',
  },
  {
    id: 'diabetes', title: 'Patients with diabetes mellitus (any type)',
    ecl: '<< 73211009 |Diabetes mellitus|', uses: 'is-a hierarchy',
  },
  {
    id: 'heart', title: 'Clinical findings located in the heart',
    ecl: '< 404684003 |Clinical finding| : 363698007 |Finding site| = << 80891009 |Heart structure|',
    uses: 'defining attribute "Finding site" + is-a on the attribute value',
  },
  {
    id: 'bacterial', title: 'Infectious diseases caused by bacteria',
    ecl: '<< 40733004 |Infectious disease| : 246075003 |Causative agent| = << 409822003 |Domain Bacteria|',
    uses: 'defining attribute "Causative agent"',
  },
  {
    id: 'hip-procedures', title: 'Procedures on the hip joint',
    ecl: '< 71388002 |Procedure| : << 363704007 |Procedure site| = << 24136001 |Hip joint structure|',
    uses: 'defining attribute "Procedure site" (and its sub-attributes)',
  },
  {
    id: 'epilepsy', title: 'Patients with epilepsy (any type)',
    ecl: '<< 84757009 |Epilepsy|', uses: 'is-a hierarchy; with the ECL history supplement also codes that were inactivated after they were recorded',
  },
  {
    id: 'penicillin-allergy', title: 'Allergies / intolerances to a penicillin',
    ecl: '<< 764146007 |Substance with penicillin structure|', uses: 'is-a hierarchy of substances', careSet: 'allergy',
  },
];

/**
 * Run one report over the record.
 * @returns {{report, version, conceptSetSize, matchedConcepts, patients, entries, trace}}
 */
export async function runReport({ store, ts, report, history = false, displayLanguage = 'nl-BE', trace = [] }) {
  // History supplement (ECL 2.x): also match inactive concepts whose SAME AS / REPLACED BY / ... target is
  // in the set, so data recorded under an older edition is still found (legacy + current data, S04/S05).
  const ecl = history ? `(${report.ecl}) {{ +HISTORY-MIN }}` : report.ecl;
  const rows = store.all(`SELECT e.*, p.family, p.given FROM clinical_entry e JOIN patient p ON p.id = e.patient_id
                          WHERE e.sct_concept_id IS NOT NULL ${report.careSet ? 'AND e.care_set = ?' : ''}`, ...(report.careSet ? [report.careSet] : []));
  const ids = [...new Set(rows.map((r) => r.sct_concept_id))];
  // Size of the concept set the ECL stands for (what a hand-made code list would have to enumerate)
  const size = await ts.expand({ url: implicit.ecl(ecl), count: 1, displayLanguage, trace });
  const matched = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const r = await ts.expand({ url: implicit.ecl(`(${ecl}) AND (${batch.join(' OR ')})`), count: batch.length, displayLanguage, includeInactive: history, trace });
    for (const c of r.contains) matched.set(c.code, { display: c.display, inactive: c.inactive === true });
  }
  const hits = rows.filter((r) => matched.has(r.sct_concept_id));
  const patients = [...new Map(hits.map((h) => [h.patient_id, { id: h.patient_id, name: `${h.given} ${h.family}` }])).values()];
  return {
    report, ecl, history, version: size.usedVersion, conceptSetSize: size.total,
    matchedConcepts: [...matched].map(([code, m]) => ({ code, display: m.display, inactive: m.inactive })),
    patients, entries: hits.map((h) => ({ id: h.id, patient: `${h.given} ${h.family}`, conceptId: h.sct_concept_id, term: h.sct_term_selected, careSet: h.care_set })),
    trace,
  };
}
