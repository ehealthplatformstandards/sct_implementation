// S04 - preservation of historically coded data when a new Belgian Edition is deployed.
//
// After a release deployment (TSP4) this job:
//   1. collects every distinct Concept ID stored in the record,
//   2. asks the terminology server which of them are still active (ECL only returns active concepts),
//   3. for every inactivated concept, reads the historical associations of the new release through
//      the implicit SNOMED CT concept maps (ConceptMap/$translate, ?fhir_cm=<association refset>),
//   4. stores those associations in a separate table.
// It never updates clinical_entry.sct_concept_id: the originally recorded code stays the record.
// A clinician can then decide to record a new entry with a proposed active concept.

import { implicit } from '../../shared/fhir-ts-client.mjs';

/** Historical association reference sets used to propose active replacement concepts. */
export const ASSOCIATIONS = [
  { refset: '900000000000527005', label: 'SAME AS', note: 'same meaning - can be used as replacement' },
  { refset: '900000000000526001', label: 'REPLACED BY', note: 'replacement' },
  { refset: '1186921001', label: 'POSSIBLY REPLACED BY', note: 'one of several possible replacements - clinical choice needed' },
  { refset: '900000000000523009', label: 'POSSIBLY EQUIVALENT TO', note: 'ambiguous concept - clinical choice needed' },
  { refset: '1186924009', label: 'PARTIALLY EQUIVALENT TO', note: 'partial overlap - review needed' },
  { refset: '900000000000530003', label: 'ALTERNATIVE', note: 'alternative concept' },
];

export async function analyseReleaseImpact({ store, ts, productionVersion, displayLanguage = 'nl-BE', trace = [] }) {
  const t0 = Date.now();
  const ids = store.all('SELECT DISTINCT sct_concept_id AS id FROM clinical_entry WHERE sct_concept_id IS NOT NULL').map((r) => r.id);
  const active = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const r = await ts.expand({ url: implicit.ecl(batch.join(' OR ')), count: batch.length, displayLanguage, trace });
    for (const c of r.contains) active.add(c.code);
  }
  const inactive = ids.filter((id) => !active.has(id));
  const findings = [];
  let added = 0;
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT OR IGNORE INTO sct_historical_association
    (entry_id, original_concept_id, association_refset, association_label, target_concept_id, target_display, detected_in_version, detected_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const id of inactive) {
    const targets = [];
    for (const a of ASSOCIATIONS) {
      try {
        const t = await ts.translate({ url: implicit.conceptMap(a.refset), code: id, trace });
        for (const m of t.matches) if (m?.concept?.code) targets.push({ ...a, code: m.concept.code, display: m.concept.display });
      } catch (e) { if (e.status !== 404) throw e; } // 404: no association of this type
    }
    const entries = store.all('SELECT id FROM clinical_entry WHERE sct_concept_id = ?', id);
    for (const e of entries) for (const t of targets) added += Number(insert.run(e.id, id, t.refset, t.label, t.code, t.display || null, productionVersion, now).changes);
    findings.push({ conceptId: id, entries: entries.map((e) => e.id), targets });
  }
  return { checked: ids.length, stillActive: active.size, inactive: findings, associationsAdded: added, productionVersion, ms: Date.now() - t0, trace };
}
