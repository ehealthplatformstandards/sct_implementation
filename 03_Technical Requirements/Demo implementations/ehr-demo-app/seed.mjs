// Seed three fictitious demo patients through the eHR API, so every entry passes the same
// validation as an entry made in the UI (active concept, permitted by the binding, version stamped).
// Run it while the production terminology server is the July 2026 Belgian Edition, to reproduce the
// release-upgrade scenario of S04 (some of these concepts are inactivated in 20260915).
//
// Usage: node seed.mjs [http://localhost:3000] [--force]
const BASE = process.argv.slice(2).find((x) => !x.startsWith('--')) || 'http://localhost:3000';

async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}

/** Use the preferred term of the language, or a given synonym, exactly as a user would select it (U06). */
async function term(code, lang, synonym) {
  if (synonym) return synonym;
  const { displays } = await call(`/api/displays?codes=${code}&lang=${lang}`);
  return displays[code];
}

const patients = [
  { id: 'pat-001', family: 'Peeters', given: 'Marie', gender: 'female', birthDate: '1958-04-12', lang: 'nl-BE' },
  { id: 'pat-002', family: 'Janssens', given: 'Lucas', gender: 'male', birthDate: '2016-03-02', lang: 'nl-BE' },
  { id: 'pat-003', family: 'Dubois', given: 'Jean', gender: 'male', birthDate: '1950-11-30', lang: 'fr-BE' },
];

// [patient, careSet, conceptId, synonym-or-null, context, recordedAt]
const entries = [
  ['pat-001', 'problem', '38341003', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2015-06-01' }, '2026-08-03T09:12:00Z'],
  ['pat-001', 'problem', '44054006', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2019-03-15' }, '2026-08-03T09:13:00Z'],
  ['pat-001', 'problem', '111360009', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2026-07-20' }, '2026-08-03T09:15:00Z'],
  ['pat-001', 'problem', '698767004', 'epilepsie na CVA', { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2024-11-02' }, '2026-08-03T09:16:00Z'],
  ['pat-001', 'problem', '370999003', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2010-01-01' }, '2026-08-03T09:17:00Z'],
  ['pat-001', 'allergy', '764146007', 'penicilline', { clinical_status: 'active', verification_status: 'confirmed', category: '609328004', criticality: 'high', reaction_manifestation_sct: '126485001', reaction_manifestation_term: 'urticaria' }, '2026-08-03T09:20:00Z'],
  ['pat-001', 'vaccination', '1181000221105', null, { occurrence_date: '2025-10-15' }, '2026-08-03T09:22:00Z'],
  ['pat-001', 'procedure', '443435007', null, { occurrence_date: '2023-05-10' }, '2026-08-03T09:24:00Z'],
  ['pat-001', 'observation', '27113001', null, { occurrence_date: '2026-08-03', value_quantity: 78, value_unit: 'kg' }, '2026-08-03T09:25:00Z'],
  ['pat-002', 'problem', '32398004', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2026-02-10' }, '2026-08-12T14:02:00Z'],
  ['pat-002', 'problem', '61947007', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2018-01-01' }, '2026-08-12T14:03:00Z'],
  ['pat-002', 'problem', '195967001', null, { clinical_status: 'active', verification_status: 'confirmed', severity_sct: '6736007', onset_date: '2021-09-01' }, '2026-08-12T14:04:00Z'],
  ['pat-002', 'allergy', '762952008', null, { clinical_status: 'active', verification_status: 'confirmed', category: '609328004', criticality: 'high', reaction_manifestation_sct: '39579001', reaction_manifestation_term: 'anafylaxie' }, '2026-08-12T14:06:00Z'],
  ['pat-002', 'vaccination', '871831003', null, { occurrence_date: '2017-05-02' }, '2026-08-12T14:07:00Z'],
  ['pat-003', 'problem', '32398004', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2026-01-05' }, '2026-08-20T10:30:00Z'],
  ['pat-003', 'problem', '49436004', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2022-04-11' }, '2026-08-20T10:31:00Z'],
  ['pat-003', 'problem', '84114007', null, { clinical_status: 'active', verification_status: 'confirmed', severity_sct: '6736007', onset_date: '2023-02-20' }, '2026-08-20T10:32:00Z'],
  ['pat-003', 'problem', '5913000', null, { clinical_status: 'active', verification_status: 'confirmed', laterality_sct: '7771000', onset_date: '2025-12-01' }, '2026-08-20T10:33:00Z'],
  ['pat-003', 'problem', '370999003', null, { clinical_status: 'active', verification_status: 'confirmed', onset_date: '2012-06-01' }, '2026-08-20T10:34:00Z'],
  ['pat-003', 'problem', '53084003', null, { clinical_status: 'resolved', verification_status: 'confirmed', onset_date: '2025-02-01', abatement_date: '2025-02-20' }, '2026-08-20T10:35:00Z'],
  ['pat-003', 'procedure', '232717009', 'pontage coronaire', { occurrence_date: '2019-09-09' }, '2026-08-20T10:36:00Z'],
  ['pat-003', 'vaccination', '1181000221105', 'vaccin contre la grippe', { occurrence_date: '2025-10-20' }, '2026-08-20T10:37:00Z'],
];

// The recorded scenario (S04) needs the July 2026 edition in production: several of these concepts are
// inactive in later editions, and the eHR would (rightly) refuse to record them (S03).
const { productionVersion } = await call('/api/version');
if (!productionVersion.endsWith('/20260715') && !process.argv.includes('--force')) {
  console.error(`seed.mjs reproduces the recorded scenario and expects 20260715 in production (found ${productionVersion}). Use --force to try anyway.`);
  process.exit(1);
}

for (const p of patients) await call('/api/patients', p);
for (const [pid, careSet, code, syn, context, recordedAt] of entries) {
  const lang = patients.find((p) => p.id === pid).lang;
  const t = await term(code, lang, syn);
  const r = await call('/api/entries', { patientId: pid, careSet, code, term: t, lang, method: 'search', context, recordedAt });
  console.log(`#${r.id} ${pid} ${careSet} ${code} "${t}" (${r.entry.sct_version.split('/').pop()})`);
}
// U05: one free-text entry (no code) for a term that could not be found
const ft = await call('/api/entries', { patientId: 'pat-002', careSet: 'problem', freeText: 'klachten na blootstelling aan PFAS (lokale term, niet gevonden)', lang: 'nl-BE', method: 'free-text', context: { clinical_status: 'active' }, recordedAt: '2026-08-12T14:10:00Z' });
console.log(`#${ft.id} pat-002 free text`);
// U07: favourites, including one concept that will become inactive in the next release
for (const [careSet, code, t] of [['problem', '195967001', 'astma'], ['problem', '38341003', 'hypertensie'], ['problem', '111360009', 'obstipatie'], ['problem', '84114007', 'hartfalen']]) {
  await call('/api/favourites', { careSet, code, term: t });
}
console.log('seed done');
