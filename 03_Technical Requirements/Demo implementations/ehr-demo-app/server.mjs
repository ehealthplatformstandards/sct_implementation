// Demo eHR server for Demo 2 (search & select) and Demo 3 (record, analytics & exchange).
// Zero dependencies: Node >= 22.13 (node:sqlite, global fetch). Start with:  node server.mjs
//
// EXAMPLE ONLY - this is not how a Belgian eHR must be built. It shows one way to meet the
// requirements of the "SNOMED CT Implementation - Requirements Specification" (V1.0).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FhirTerminologyClient, implicit, VersionMismatchError } from '../shared/fhir-ts-client.mjs';
import { BE_LANGUAGE_REFSETS } from '../shared/rf2.mjs';
import { loadCache, buildFromRf2, saveCache } from './lib/lexicon.mjs';
import { SearchService, parseNormalForm } from './lib/search-service.mjs';
import { tokenFromEnv } from '../shared/oauth.mjs';
import { Store } from './lib/store.mjs';
import { analyseReleaseImpact, ASSOCIATIONS } from './lib/release-impact.mjs';
import { REPORTS, runReport } from './lib/reports.mjs';
import { importExtendedMaps, deriveTargets, makeHasConcept, ageAt, S05_TARGETS } from './lib/maps.mjs';
import { patientBundle, toResource, PROFILES } from './lib/fhir-export.mjs';
import { ReferenceTextAnalyser, callSuggestionService } from './lib/nlp-suggest.mjs';
import { NRC_PORTAL, FEEDBACK_KINDS, portalFor, summary } from './lib/feedback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const cfg = {
  port: Number(env.PORT || 3000),
  ltsBaseUrl: env.LTS_BASE_URL || 'http://localhost:8090/fhir',
  // TSP5: every component may point to its own terminology endpoint; all must run the same version
  componentLts: {
    search: env.SEARCH_LTS_BASE_URL, validation: env.VALIDATION_LTS_BASE_URL,
    reporting: env.REPORTING_LTS_BASE_URL, 'fhir-export': env.EXPORT_LTS_BASE_URL, 'release-impact': env.IMPACT_LTS_BASE_URL,
  },
  productionVersion: env.SCT_PRODUCTION_VERSION || null,
  rf2Snapshot: env.RF2_SNAPSHOT_DIR || null,
  lexiconCache: env.LEXICON_CACHE || path.join(HERE, 'data', 'lexicon-cache.json'),
  dbFile: env.DB_FILE || path.join(HERE, 'data', 'ehr-demo.sqlite'),
  debounceMs: Number(env.DEBOUNCE_MS || 500),
  minChars: Number(env.MIN_CHARS || 3),
  defaultLanguage: env.DEFAULT_LANGUAGE || 'nl-BE',
  userId: env.DEMO_USER || 'dr-demo',
};
cfg.suggestUrl = env.SUGGEST_SERVICE_URL || `http://localhost:${cfg.port}/api/text-analysis`;

const bindings = JSON.parse(fs.readFileSync(path.join(HERE, 'config', 'bindings.json'), 'utf8'));
const store = new Store(cfg.dbFile);

// ------------------------------------------------------------------ terminology clients per component
const components = {};
// Optional: bearer token for a terminology server that needs one (e.g. a national server). See shared/oauth.mjs.
const bearerToken = tokenFromEnv();
function makeComponents(version) {
  for (const name of ['search', 'validation', 'reporting', 'fhir-export', 'release-impact']) {
    components[name] = new FhirTerminologyClient({ baseUrl: cfg.componentLts[name] || cfg.ltsBaseUrl, systemVersion: version, name, bearerToken });
  }
}
async function detectVersion(baseUrl) {
  const ts = new FhirTerminologyClient({ baseUrl, bearerToken });
  const v = await ts.snomedVersions();
  return v[0]?.version || null;
}

// ------------------------------------------------------------------ lexicon (U01/U02)
let lexicons = null; let descriptionIndex = null;
async function loadLexicon() {
  if (fs.existsSync(cfg.lexiconCache)) ({ lexicons, descriptionIndex } = loadCache(cfg.lexiconCache));
  else if (cfg.rf2Snapshot) {
    const built = await buildFromRf2(cfg.rf2Snapshot);
    ({ lexicons, descriptionIndex } = built);
    fs.mkdirSync(path.dirname(cfg.lexiconCache), { recursive: true });
    saveCache(cfg.lexiconCache, built);
  } else console.warn('[lexicon] no cache and no RF2_SNAPSHOT_DIR: variants/decompounding/typo correction and Description ID search are disabled');
  if (lexicons) for (const lex of Object.values(lexicons)) lex.buildDeletes(); // typo index, built once at start-up
}

let search;
let analyser;

// ------------------------------------------------------------------ helpers
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(req, res, urlPath) {
  // Demo 1 writes its HTML reports next to its scripts; they are also served here for convenience
  let base = path.join(HERE, 'public');
  if (urlPath.startsWith('/demo1/')) { base = path.join(HERE, '..', '01-terminology-services', 'reports'); urlPath = urlPath.slice('/demo1'.length); }
  let p = path.normalize(path.join(base, decodeURIComponent(urlPath)));
  if (!p.startsWith(base)) return json(res, 403, { error: 'forbidden' });
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}
const now = () => new Date().toISOString();

/** Display terms (in the user's language) for a list of concepts; inactive ones via $lookup. */
async function displaysFor(ids, lang, trace, ts = components.validation) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = {};
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    const r = await ts.expand({ url: implicit.ecl(batch.join(' OR ')), count: batch.length, displayLanguage: lang, includeInactive: true, trace });
    for (const c of r.contains) out[c.code] = c.display;
  }
  // concepts the server did not return (unknown to this version): try $lookup one by one
  await Promise.all(list.filter((id) => !out[id]).map(async (id) => {
    try { out[id] = (await ts.lookup({ code: id, displayLanguage: lang, trace })).display; } catch { /* unknown */ }
  }));
  return out;
}

/** U07: favourites and recently used concepts, each re-validated with the same rules as search results. */
async function favourites(careSet, lang, trace) {
  const favs = store.all('SELECT *, \'favourite\' AS kind FROM favourite WHERE user_id = ? AND care_set = ? ORDER BY term', cfg.userId, careSet);
  const recent = store.all('SELECT *, \'recent\' AS kind FROM recent WHERE user_id = ? AND care_set = ? ORDER BY used_at DESC LIMIT 8', cfg.userId, careSet);
  const all = [...favs, ...recent];
  const checks = await Promise.all(all.map((f) => search.validateSelection({ code: f.sct_concept_id, careSetId: careSet, displayLanguage: lang, trace })));
  return all.map((f, i) => ({ kind: f.kind, code: f.sct_concept_id, term: f.term, valid: checks[i].valid, reason: checks[i].reason, currentDisplay: checks[i].display }));
}

// ------------------------------------------------------------------ API
async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const lang = q.lang || cfg.defaultLanguage;
  const trace = [];
  const p = url.pathname;
  let m;

  if (p === '/api/config') {
    return json(res, 200, {
      careSets: bindings.careSets, qualifiers: bindings.qualifiers, languages: BE_LANGUAGE_REFSETS, debounceMs: cfg.debounceMs, minChars: cfg.minChars,
      defaultLanguage: cfg.defaultLanguage, productionVersion: cfg.productionVersion, nrcPortal: NRC_PORTAL, feedbackKinds: FEEDBACK_KINDS,
      suggestService: cfg.suggestUrl, associations: ASSOCIATIONS, reports: REPORTS.map(({ id, title, ecl, uses }) => ({ id, title, ecl, uses })), profiles: PROFILES,
    });
  }

  // TSP5: which SNOMED CT version does every component use?
  if (p === '/api/version') {
    const rows = await Promise.all(Object.entries(components).map(async ([name, ts]) => {
      let serverVersion = null; let error = null;
      try { serverVersion = (await ts.snomedVersions())[0]?.version; } catch (e) { error = e.message; }
      return { component: name, terminologyServer: ts.baseUrl, pinnedVersion: ts.systemVersion, serverVersion, consistent: serverVersion === cfg.productionVersion, error };
    }));
    const versionsInRecord = store.all('SELECT sct_version AS version, COUNT(*) AS entries FROM clinical_entry WHERE sct_version IS NOT NULL GROUP BY sct_version');
    return json(res, 200, { productionVersion: cfg.productionVersion, consistent: rows.every((r) => r.consistent), components: rows, versionsInRecord });
  }

  // Deployment hook (called by the TSP4 deploy script after switching the terminology server)
  if (p === '/api/admin/production-version' && req.method === 'POST') {
    const body = await readBody(req);
    const version = body.version || await detectVersion(cfg.ltsBaseUrl);
    cfg.productionVersion = version; makeComponents(version);
    search.ts = components.search; search.validator = components.validation;
    if (analyser) analyser.ts = components.search;
    return json(res, 200, { productionVersion: version });
  }

  if (p === '/api/displays') return json(res, 200, { displays: await displaysFor(String(q.codes || '').split(',').filter((x) => /^\d{6,18}$/.test(x)), lang, trace) });

  if (p === '/api/search') {
    const r = await search.search({ text: q.text, careSetId: q.careSet || 'problem', contextId: q.context, displayLanguage: lang, extend: q.extend === 'true', trace });
    return json(res, 200, r);
  }
  if ((m = /^\/api\/concept\/(\d+)$/.exec(p))) {
    return json(res, 200, await search.conceptDetails({ code: m[1], careSetId: q.careSet || 'problem', displayLanguage: lang, trace }));
  }
  if (p === '/api/validate' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ...(await search.validateSelection({ code: b.code, careSetId: b.careSet, display: b.display, displayLanguage: b.lang || lang, trace })), trace });
  }

  // U07
  if (p === '/api/favourites' && req.method === 'GET') return json(res, 200, { items: await favourites(q.careSet || 'problem', lang, trace), trace });
  if (p === '/api/favourites' && req.method === 'POST') {
    const b = await readBody(req);
    store.run('INSERT OR REPLACE INTO favourite VALUES (?,?,?,?,?)', cfg.userId, b.careSet, b.code, b.term, now());
    return json(res, 200, { ok: true });
  }
  if (p === '/api/favourites' && req.method === 'DELETE') {
    store.run('DELETE FROM favourite WHERE user_id = ? AND care_set = ? AND sct_concept_id = ?', cfg.userId, q.careSet, q.code);
    return json(res, 200, { ok: true });
  }

  // U08: the "external" text analysis tool (reference implementation) ...
  if (p === '/api/text-analysis' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, await analyser.analyse(b));
  }
  // ... and the eHR side: call the configured tool, then validate every candidate like any other entry
  if (p === '/api/suggest' && req.method === 'POST') {
    const b = await readBody(req);
    const out = await callSuggestionService(cfg.suggestUrl, { text: b.text, language: b.lang || lang, careSet: b.careSet || 'problem' }, trace);
    const validated = await Promise.all(out.candidates.map(async (c) => ({ ...c, validation: await search.validateSelection({ code: c.conceptId, careSetId: b.careSet || 'problem', displayLanguage: b.lang || lang, trace }) })));
    return json(res, 200, { service: out.service, candidates: validated, trace });
  }

  // TSP7
  if (p === '/api/feedback' && req.method === 'POST') {
    const b = await readBody(req);
    const f = { kind: b.kind || 'missing-concept', language: b.lang || lang, search_text: b.searchText || null, sct_concept_id: b.code || null, care_set: b.careSet || null, comment: b.comment || null };
    const text = summary(f, cfg.productionVersion);
    let id = null;
    if (b.mode === 'queue') id = Number(store.run('INSERT INTO nrc_feedback (created_at,user_id,kind,language,search_text,sct_concept_id,care_set,comment,status) VALUES (?,?,?,?,?,?,?,?,?)', now(), cfg.userId, f.kind, f.language, f.search_text, f.sct_concept_id, f.care_set, f.comment, 'queued for NRC').lastInsertRowid);
    return json(res, 200, { id, portal: portalFor(f.language), summary: text });
  }
  if (p === '/api/feedback' && req.method === 'GET') return json(res, 200, { items: store.all('SELECT * FROM nrc_feedback ORDER BY id DESC') });

  // Demo 3 - patients and entries
  if (p === '/api/patients' && req.method === 'POST') {
    const b = await readBody(req);
    store.run('INSERT OR REPLACE INTO patient (id, family, given, gender, birth_date) VALUES (?,?,?,?,?)', b.id, b.family, b.given, b.gender, b.birthDate);
    return json(res, 201, store.get('SELECT * FROM patient WHERE id = ?', b.id));
  }
  if (p === '/api/patients') return json(res, 200, { items: store.all('SELECT p.*, (SELECT COUNT(*) FROM clinical_entry e WHERE e.patient_id = p.id) AS entries FROM patient p ORDER BY family') });
  if ((m = /^\/api\/patients\/([\w-]+)$/.exec(p))) {
    const patient = store.get('SELECT * FROM patient WHERE id = ?', m[1]);
    if (!patient) return json(res, 404, { error: 'unknown patient' });
    const entries = store.entriesForPatient(m[1]).map((e) => ({ ...e, associations: store.associationsForEntry(e.id) }));
    const ids = entries.flatMap((e) => [e.sct_concept_id, e.severity_sct, e.body_site_sct, e.laterality_sct, e.category, ...e.associations.map((a) => a.target_concept_id)]);
    const displays = await displaysFor(ids, lang, trace);
    const active = await activeSet(entries.map((e) => e.sct_concept_id).filter(Boolean), trace);
    return json(res, 200, { patient, entries: entries.map((e) => ({ ...e, activeInProduction: e.sct_concept_id ? active.has(e.sct_concept_id) : null })), displays, productionVersion: cfg.productionVersion, trace });
  }
  if (p === '/api/entries' && req.method === 'POST') {
    const b = await readBody(req);
    const cs = bindings.careSets.find((c) => c.id === b.careSet);
    if (!cs) return json(res, 400, { error: 'unknown care set' });
    const entry = { ...b.context, patient_id: b.patientId, care_set: cs.id, data_element: cs.dataElement, entry_method: b.method || (b.freeText ? 'free-text' : 'search'), recorded_at: b.recordedAt || now(), recorder_id: b.recorderId || cfg.userId };
    if (b.freeText) {
      Object.assign(entry, { free_text: b.freeText });
    } else {
      // S03 + U04: the same validation for every entry method (search, ID, favourite, suggestion ...)
      const v = await search.validateSelection({ code: b.code, careSetId: cs.id, displayLanguage: b.lang || lang, trace });
      if (!v.valid) return json(res, 422, { error: v.reason, validation: v, trace });
      Object.assign(entry, { sct_concept_id: b.code, sct_term_selected: b.term, sct_description_id: b.descriptionId || null, term_language: b.lang || lang, sct_version: cfg.productionVersion });
    }
    try {
      const id = store.recordEntry(entry);
      if (entry.sct_concept_id) store.run('INSERT OR REPLACE INTO recent VALUES (?,?,?,?,?)', cfg.userId, cs.id, entry.sct_concept_id, entry.sct_term_selected, now());
      return json(res, 201, { id, entry: store.get('SELECT * FROM clinical_entry WHERE id = ?', id), trace });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // S01/S04 data inspector (read-only)
  if ((m = /^\/api\/db\/(clinical_entry|sct_historical_association|map_artefact|nrc_feedback|favourite|recent)$/.exec(p))) {
    const where = q.patient && m[1] === 'clinical_entry' ? 'WHERE patient_id = ?' : '';
    return json(res, 200, { table: m[1], rows: store.all(`SELECT * FROM ${m[1]} ${where} ORDER BY rowid DESC LIMIT 200`, ...(where ? [q.patient] : [])) });
  }

  // S04
  if (p === '/api/release-impact' && req.method === 'POST') {
    return json(res, 200, await analyseReleaseImpact({ store, ts: components['release-impact'], productionVersion: cfg.productionVersion, displayLanguage: lang, trace }));
  }

  // S06
  if (p === '/api/reports') return json(res, 200, { items: REPORTS });
  if ((m = /^\/api\/reports\/([\w-]+)$/.exec(p))) {
    const report = REPORTS.find((r) => r.id === m[1]);
    if (!report) return json(res, 404, { error: 'unknown report' });
    return json(res, 200, await runReport({ store, ts: components.reporting, report, history: q.history === 'true', displayLanguage: lang, trace }));
  }

  // S05
  if (p === '/api/maps') return json(res, 200, { targets: S05_TARGETS.map((t) => ({ ...t, artefacts: store.all(`SELECT * FROM map_artefact WHERE refset_id IN (${t.refsets.map(() => '?').join(',') || "''"})`, ...t.refsets) })) });
  if (p === '/api/admin/import-maps' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, await importExtendedMaps(store, b.snapshotDir || cfg.rf2Snapshot, cfg.productionVersion));
  }
  if ((m = /^\/api\/patients\/([\w-]+)\/classification$/.exec(p))) {
    const patient = store.get('SELECT * FROM patient WHERE id = ?', m[1]);
    const entries = store.entriesForPatient(m[1]).filter((e) => e.sct_concept_id);
    const hasConcept = makeHasConcept(components.reporting, entries.map((e) => e.sct_concept_id), trace);
    const out = [];
    for (const e of entries) {
      out.push({ entry: { id: e.id, careSet: e.care_set, conceptId: e.sct_concept_id, term: e.sct_term_selected, onset: e.onset_date || e.recorded_at }, icd10: await classifyEntry(e, patient, hasConcept) });
    }
    return json(res, 200, { patient, items: out, artefacts: store.all('SELECT * FROM map_artefact'), trace });
  }
  if (p === '/api/extract.csv') {
    // data extraction (S05): SNOMED CT stays the source, the classification codes are derived outputs
    const rows = [['patient_id', 'care_set', 'sct_concept_id', 'sct_term_selected', 'sct_version', 'icd10_codes', 'icd10_derived_via']];
    for (const pat of store.all('SELECT * FROM patient')) {
      const entries = store.entriesForPatient(pat.id).filter((e) => e.sct_concept_id);
      const hasConcept = makeHasConcept(components.reporting, entries.map((e) => e.sct_concept_id), trace);
      for (const e of entries) {
        const t = await classifyEntry(e, pat, hasConcept);
        rows.push([pat.id, e.care_set, e.sct_concept_id, e.sct_term_selected, e.sct_version, t.map((x) => x.target).filter(Boolean).join(' '), [...new Set(t.filter((x) => x.via).map((x) => `${x.via.association} ${x.via.conceptId}`))].join('; ')]);
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end(rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'));
  }

  // I01 / I02
  if ((m = /^\/api\/patients\/([\w-]+)\/fhir$/.exec(p))) {
    const entries = store.entriesForPatient(m[1]);
    const derived = await bodySitesFromDefinition(entries, lang, trace);
    const displays = await displaysFor([...entries.flatMap((e) => [e.severity_sct, e.body_site_sct, e.laterality_sct, e.category]), ...Object.values(derived).map((d) => d.code)], lang, trace, components['fhir-export']);
    return json(res, 200, patientBundle(store, m[1], displays, derived));
  }
  if ((m = /^\/api\/entries\/(\d+)\/fhir$/.exec(p))) {
    const e = store.get('SELECT * FROM clinical_entry WHERE id = ?', Number(m[1]));
    const derived = await bodySitesFromDefinition([e], lang, trace);
    const displays = await displaysFor([e.severity_sct, e.body_site_sct, e.laterality_sct, e.category, ...Object.values(derived).map((d) => d.code)], lang, trace, components['fhir-export']);
    return json(res, 200, { entry: e, resource: toResource(e, displays, derived) });
  }
  return json(res, 404, { error: `no route ${p}` });
}

// S05 for legacy + current data: the ICD-10 code(s) of an entry are derived from its own concept. A concept
// that has no row in the current map (typically because it was inactivated after it was recorded) is
// classified through the historical association(s) stored by the release impact analysis (S04); the
// result says which association was followed. The recorded concept itself is never changed.
async function classifyEntry(e, patient, hasConcept) {
  const ctx = { gender: patient.gender, ageAtOnset: patient.birth_date ? ageAt(patient.birth_date, e.onset_date || e.recorded_at) : undefined, hasConcept };
  const direct = await deriveTargets(store, e.sct_concept_id, ctx);
  if (direct.length) return direct;
  const out = [];
  for (const a of store.associationsForEntry(e.id)) {
    for (const g of await deriveTargets(store, a.target_concept_id, ctx)) out.push({ ...g, via: { association: a.association_label, conceptId: a.target_concept_id } });
  }
  return out;
}

// I01 / S02: the Belgian laterality extension sits on bodySite. For an entry with a laterality but no body
// site, the body site is taken from the concept's defining relationships (finding site, procedure site),
// read from the terminology server with $lookup (normalFormTerse). Returns { entryId: { code, version } }.
const SITE_ATTRIBUTES = ['363698007', '405813007', '405814001', '363704007']; // finding site, procedure site - direct / indirect, procedure site
async function bodySitesFromDefinition(entries, lang, trace) {
  const out = {};
  for (const e of entries.filter((x) => x.laterality_sct && !x.body_site_sct && x.sct_concept_id)) {
    try {
      const lk = await components['fhir-export'].lookup({ code: e.sct_concept_id, displayLanguage: lang, property: ['normalFormTerse'], trace });
      const site = parseNormalForm(lk.prop('normalFormTerse')[0] || '').attributes.find((a) => SITE_ATTRIBUTES.includes(a.type));
      if (site) out[e.id] = { code: site.value.replace(/^#/, ''), version: cfg.productionVersion };
    } catch { /* concept unknown to this version: exported without body site */ }
  }
  return out;
}

async function activeSet(ids, trace) {
  const out = new Set();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    const r = await components.validation.expand({ url: implicit.ecl(batch.join(' OR ')), count: batch.length, trace });
    for (const c of r.contains) out.add(c.code);
  }
  return out;
}

// ------------------------------------------------------------------ start
async function main() {
  if (!cfg.productionVersion) cfg.productionVersion = await detectVersion(cfg.ltsBaseUrl);
  console.log(`[ehr] production SNOMED CT version: ${cfg.productionVersion} (terminology server ${cfg.ltsBaseUrl})`);
  makeComponents(cfg.productionVersion);
  await loadLexicon();
  search = new SearchService({ ts: components.search, validator: components.validation, lexicons, descriptionIndex, bindings, minChars: cfg.minChars });
  analyser = new ReferenceTextAnalyser({ ts: components.search, bindings });
  if (cfg.rf2Snapshot && !store.get('SELECT COUNT(*) AS n FROM map_artefact').n) await importExtendedMaps(store, cfg.rf2Snapshot, cfg.productionVersion);
  store.run("INSERT OR IGNORE INTO practitioner (id, family, given) VALUES (?, 'Demo', 'Dr. An')", cfg.userId);
  // warm-up: the first queries after a (re)start of the terminology server are slower (JIT, caches)
  for (const t of ['astma', 'diabetes', 'hypertensie', 'pneumonie', 'fractuur']) await search.search({ text: t, careSetId: 'problem', displayLanguage: cfg.defaultLanguage }).catch(() => {});
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
    } catch (e) {
      const status = e instanceof VersionMismatchError ? 409 : (e.status && e.status >= 400 ? 502 : 500);
      json(res, status, { error: e.message });
    }
  }).listen(cfg.port, () => console.log(`[ehr] demo eHR listening on http://localhost:${cfg.port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
