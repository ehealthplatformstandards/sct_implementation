// Storage layer of the demo eHR (SQLite through node:sqlite, Node >= 22.13).
//
// Requirements illustrated by this schema:
//   S01  the SNOMED CT Concept ID is the authoritative coded value; the term shown to / selected by
//        the user is stored next to it. A Description ID is informative only and can never replace
//        the Concept ID (see the CHECK constraint and `recordEntry`).
//   S02  context (clinical status, verification status, severity, body site, laterality, dates ...)
//        is stored in separate columns: it supplements the concept, it never replaces it.
//   U05  free text is stored in its own column and can never carry a code or placeholder code.
//   S04  associations to replacement concepts are stored in a separate table; the original
//        Concept ID of a record is never updated by a terminology release.
//   S05  map artefacts are imported with their version, and their rows are stored for reuse.
//   U07  favourites / recently used concepts; TSP7 feedback queue.

import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS patient (
  id TEXT PRIMARY KEY, family TEXT, given TEXT, gender TEXT, birth_date TEXT
);
CREATE TABLE IF NOT EXISTS practitioner (id TEXT PRIMARY KEY, family TEXT, given TEXT);

-- One row per recorded value of a SNOMED CT-coded data element of a Care Set
CREATE TABLE IF NOT EXISTS clinical_entry (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id            TEXT NOT NULL REFERENCES patient(id),
  care_set              TEXT NOT NULL,   -- problem | allergy | vaccination | procedure | observation
  data_element          TEXT NOT NULL,   -- e.g. Condition.code
  -- S01: coded meaning
  sct_concept_id        TEXT,            -- SNOMED CT Concept ID = authoritative coded value
  sct_term_selected     TEXT,            -- term presented to and selected by the user (U06)
  sct_description_id    TEXT,            -- optional, informative only (never a substitute for the Concept ID)
  term_language         TEXT,            -- language / dialect of the selected term, e.g. nl-BE
  sct_version           TEXT,            -- edition version used at data entry, e.g. http://snomed.info/sct/11000172109/version/20260915
  -- U05: temporary free text (no code, no placeholder)
  free_text             TEXT,
  -- S02: context, stored as separate data-model elements
  clinical_status       TEXT,            -- FHIR condition-clinical / allergyintolerance-clinical code
  verification_status   TEXT,            -- FHIR condition-ver-status / allergyintolerance-verification code
  severity_sct          TEXT,            -- be-vs-severity (SNOMED CT)
  body_site_sct         TEXT,            -- be-vs-bodysite (SNOMED CT body structure)
  laterality_sct        TEXT,            -- be-vs-laterality (SNOMED CT qualifier)
  category              TEXT,            -- e.g. problem-list-item, allergy / intolerance type ...
  criticality           TEXT,
  reaction_manifestation_sct TEXT,
  reaction_manifestation_term TEXT,
  onset_date            TEXT,
  abatement_date        TEXT,
  occurrence_date       TEXT,
  value_quantity        REAL,
  value_unit            TEXT,
  entry_method          TEXT NOT NULL,   -- search | concept-id | description-id | favourite | recent | suggestion | free-text | seed
  recorded_at           TEXT NOT NULL,
  recorder_id           TEXT NOT NULL REFERENCES practitioner(id),
  CHECK ((sct_concept_id IS NOT NULL AND free_text IS NULL AND sct_term_selected IS NOT NULL)
      OR (sct_concept_id IS NULL AND free_text IS NOT NULL AND sct_description_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_entry_patient ON clinical_entry(patient_id);
CREATE INDEX IF NOT EXISTS idx_entry_concept ON clinical_entry(sct_concept_id);

-- S04: link from an inactivated recorded concept to its active replacement(s), kept apart
CREATE TABLE IF NOT EXISTS sct_historical_association (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id              INTEGER NOT NULL REFERENCES clinical_entry(id),
  original_concept_id   TEXT NOT NULL,   -- copy of clinical_entry.sct_concept_id (never changed)
  association_refset    TEXT NOT NULL,   -- e.g. 900000000000526001 |REPLACED BY association reference set|
  association_label     TEXT NOT NULL,
  target_concept_id     TEXT NOT NULL,
  target_display        TEXT,
  detected_in_version   TEXT NOT NULL,   -- edition version in which the inactivation was found
  detected_at           TEXT NOT NULL,
  UNIQUE(entry_id, association_refset, target_concept_id)
);

-- S05: imported map artefacts
CREATE TABLE IF NOT EXISTS map_artefact (
  refset_id TEXT PRIMARY KEY, name TEXT, target_system TEXT, source_file TEXT, edition_version TEXT, imported_at TEXT, member_count INTEGER
);
CREATE TABLE IF NOT EXISTS map_member (
  refset_id TEXT, referenced_component_id TEXT, map_group INTEGER, map_priority INTEGER,
  map_rule TEXT, map_advice TEXT, map_target TEXT, correlation_id TEXT, map_category_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_map_member ON map_member(referenced_component_id);

-- U07: favourites / recently used
CREATE TABLE IF NOT EXISTS favourite (user_id TEXT, care_set TEXT, sct_concept_id TEXT, term TEXT, added_at TEXT, PRIMARY KEY (user_id, care_set, sct_concept_id));
CREATE TABLE IF NOT EXISTS recent (user_id TEXT, care_set TEXT, sct_concept_id TEXT, term TEXT, used_at TEXT, PRIMARY KEY (user_id, care_set, sct_concept_id));

-- TSP7: the eHR acting as intermediary for NRC feedback
CREATE TABLE IF NOT EXISTS nrc_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, user_id TEXT, kind TEXT, language TEXT,
  search_text TEXT, sct_concept_id TEXT, care_set TEXT, comment TEXT, status TEXT
);
`;

export class Store {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  /**
   * Record a coded value or a free-text value.
   * Enforces S01 (Concept ID mandatory for coded values) and U05 (free text never carries a code).
   */
  recordEntry(e) {
    if (e.sct_concept_id && e.free_text) throw new Error('A value is either SNOMED CT-coded or free text, never both (U05).');
    if (!e.sct_concept_id && !e.free_text) throw new Error('A coded value requires the SNOMED CT Concept ID (S01).');
    if (e.sct_concept_id && !/^\d{6,18}$/.test(e.sct_concept_id)) throw new Error('Invalid Concept ID.');
    const cols = ['patient_id', 'care_set', 'data_element', 'sct_concept_id', 'sct_term_selected', 'sct_description_id', 'term_language', 'sct_version', 'free_text',
      'clinical_status', 'verification_status', 'severity_sct', 'body_site_sct', 'laterality_sct', 'category', 'criticality', 'reaction_manifestation_sct', 'reaction_manifestation_term',
      'onset_date', 'abatement_date', 'occurrence_date', 'value_quantity', 'value_unit', 'entry_method', 'recorded_at', 'recorder_id'];
    const sql = `INSERT INTO clinical_entry (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const res = this.run(sql, ...cols.map((c) => (e[c] === undefined ? null : e[c])));
    return Number(res.lastInsertRowid);
  }

  entriesForPatient(patientId) {
    return this.all('SELECT * FROM clinical_entry WHERE patient_id = ? ORDER BY care_set, recorded_at', patientId);
  }

  associationsForEntry(entryId) {
    return this.all('SELECT * FROM sct_historical_association WHERE entry_id = ? ORDER BY association_refset', entryId);
  }
}
