// Second part of the demo scenario. Run it AFTER the upgrade to the September 2026 edition (Demo 1,
// deploy-release.mjs), when the eHR runs 20260915:
//   - records one entry with a concept that is new in 20260915, so the record holds codes of two edition
//     versions (TSP5, S04). The concept has no French or Dutch term yet in this edition, so the user
//     selects the English term that the terminology server returns as fallback (TSP6, U06);
//   - queues one piece of feedback for the Belgian NRC about that missing translation (TSP7).
//
// Usage: node seed-after-upgrade.mjs [http://localhost:3000]
const BASE = process.argv[2] || 'http://localhost:3000';

async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}

const { productionVersion } = await call('/api/version');
if (!productionVersion.endsWith('/20260915')) throw new Error(`run this after the upgrade to 20260915 (production is ${productionVersion})`);

const code = '1401652004'; // |At increased risk for undernutrition (finding)| - new in the September 2026 edition
const { displays } = await call(`/api/displays?codes=${code}&lang=fr-BE`);
const r = await call('/api/entries', {
  patientId: 'pat-003', careSet: 'problem', code, term: displays[code], lang: 'fr-BE', method: 'search',
  context: { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2026-09-21' },
});
console.log(`#${r.id} pat-003 problem ${code} "${displays[code]}" (${r.entry.sct_version.split('/').pop()})`);

const f = await call('/api/feedback', {
  mode: 'queue', kind: 'missing-translation', lang: 'fr-BE', careSet: 'problem', code, searchText: 'risque de dénutrition',
  comment: `Pas de terme français pour ${code} (nouveau concept de l'édition 20260915) : l'application affiche le terme anglais "${displays[code]}".`,
});
console.log(`feedback #${f.id} queued for the NRC`);
