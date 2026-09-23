// I01 / I02 - reuse the stored SNOMED CT-coded data to populate Belgian FHIR resources automatically.
//
// Nothing is re-entered: every resource below is generated from the clinical_entry rows that were
// recorded through the search & select component (Demo 2). The SNOMED CT concept, the version used
// at data entry and the term the user selected go into Coding.system/version/code/display and
// CodeableConcept.text; the context columns (S02) go into their own FHIR elements.
//
// Profiles (HL7 Belgium / eHealth platform implementation guides):
//   BeProblem              https://www.ehealth.fgov.be/standards/fhir/core-clinical/StructureDefinition/be-problem
//   BeAllergyIntolerance   https://www.ehealth.fgov.be/standards/fhir/allergy/StructureDefinition/be-allergyintolerance
//   BeVaccination          https://www.ehealth.fgov.be/standards/fhir/vaccination/StructureDefinition/be-vaccination
//   BeProcedure            https://www.ehealth.fgov.be/standards/fhir/core-clinical/StructureDefinition/be-procedure
//   BeClinicalObservation  https://www.ehealth.fgov.be/standards/fhir/core-clinical/StructureDefinition/be-clinical-observation
// This is an illustration of the mapping, not a validated implementation of these profiles.

import { SNOMED } from '../../shared/fhir-ts-client.mjs';

const BE = 'https://www.ehealth.fgov.be/standards/fhir';
export const PROFILES = {
  patient: `${BE}/core/StructureDefinition/be-patient`,
  practitioner: `${BE}/core/StructureDefinition/be-practitioner`,
  problem: `${BE}/core-clinical/StructureDefinition/be-problem`,
  allergy: `${BE}/allergy/StructureDefinition/be-allergyintolerance`,
  vaccination: `${BE}/vaccination/StructureDefinition/be-vaccination`,
  procedure: `${BE}/core-clinical/StructureDefinition/be-procedure`,
  observation: `${BE}/core-clinical/StructureDefinition/be-clinical-observation`,
};
const EXT = {
  recorder: `${BE}/core/StructureDefinition/be-ext-recorder`,
  laterality: `${BE}/core-clinical/StructureDefinition/be-ext-laterality`,
  allergyType: `${BE}/allergy/StructureDefinition/be-ext-allergy-type`,
  procedureRecorded: 'http://hl7.org/fhir/5.0/StructureDefinition/extension-Procedure.recorded',
};
const DEMO_ID = 'https://example.org/demo-ehr';

/** The coded value of a data element, built only from what was stored (S01 + U05 + U06). */
export function codeableConcept(e) {
  if (!e.sct_concept_id) return { text: e.free_text }; // U05: free text travels as text only, never with a code
  return {
    coding: [{ system: SNOMED, version: e.sct_version || undefined, code: e.sct_concept_id, display: e.sct_term_selected }],
    text: e.sct_term_selected,
  };
}

// Qualifier codes (severity, body site, laterality, allergy type) were chosen with the same edition version as the entry.
const sct = (code, display, version) => (code ? { coding: [{ system: SNOMED, version: version || undefined, code, display }] } : undefined);
const ref = (type, id) => ({ reference: `${type}/${id}` });

// be-ext-laterality is an extension of bodySite. When only a laterality was recorded, the caller passes the
// body site taken from the concept's own definition ({code, version}: finding site / procedure site), so the
// laterality is not lost.
function bodySite(e, displays, derived) {
  const site = e.body_site_sct || derived?.code;
  if (!site) return undefined;
  const cc = sct(site, displays[site], e.body_site_sct ? e.sct_version : derived.version);
  if (e.laterality_sct) cc.extension = [{ url: EXT.laterality, valueCoding: { system: SNOMED, version: e.sct_version || undefined, code: e.laterality_sct, display: displays[e.laterality_sct] } }];
  return [cc];
}

export function toResource(e, displays = {}, derivedSites = {}) {
  const id = `entry-${e.id}`;
  const identifier = [{ system: `${DEMO_ID}/entry`, value: String(e.id) }];
  const patient = ref('Patient', e.patient_id);
  const recorder = ref('Practitioner', e.recorder_id);
  switch (e.care_set) {
    case 'problem':
      return clean({
        resourceType: 'Condition', id, meta: { profile: [PROFILES.problem] }, identifier,
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: e.clinical_status || 'active' }] },
        verificationStatus: e.verification_status ? { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: e.verification_status }] } : undefined,
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        severity: sct(e.severity_sct, displays[e.severity_sct], e.sct_version),
        code: codeableConcept(e),
        bodySite: bodySite(e, displays, derivedSites[e.id]),
        subject: patient, onsetDateTime: e.onset_date || undefined, abatementDateTime: e.abatement_date || undefined,
        recordedDate: e.recorded_at, recorder,
      });
    case 'allergy':
      return clean({
        resourceType: 'AllergyIntolerance', id, meta: { profile: [PROFILES.allergy] },
        extension: e.category ? [{ url: EXT.allergyType, valueCodeableConcept: sct(e.category, displays[e.category], e.sct_version) }] : undefined,
        identifier,
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: e.clinical_status || 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: e.category ? (e.verification_status || 'confirmed') : 'unconfirmed' }] },
        criticality: e.criticality || undefined,
        code: codeableConcept(e), patient, onsetDateTime: e.onset_date || undefined, recordedDate: e.recorded_at, recorder,
        reaction: e.reaction_manifestation_sct ? [{ manifestation: [{ coding: [{ system: SNOMED, version: e.sct_version || undefined, code: e.reaction_manifestation_sct, display: e.reaction_manifestation_term }], text: e.reaction_manifestation_term }] }] : undefined,
      });
    case 'vaccination':
      return clean({
        resourceType: 'Immunization', id, meta: { profile: [PROFILES.vaccination] },
        extension: [{ url: EXT.recorder, valueReference: recorder }],
        identifier, status: 'completed', vaccineCode: codeableConcept(e), patient,
        occurrenceDateTime: e.occurrence_date || e.recorded_at, recorded: e.recorded_at,
        site: bodySite(e, displays, derivedSites[e.id])?.[0],
      });
    case 'procedure':
      return clean({
        resourceType: 'Procedure', id, meta: { profile: [PROFILES.procedure] },
        extension: [{ url: EXT.procedureRecorded, valueDateTime: e.recorded_at }],
        identifier, status: 'completed', code: codeableConcept(e), subject: patient,
        performedDateTime: e.occurrence_date || e.recorded_at, recorder, bodySite: bodySite(e, displays, derivedSites[e.id]),
      });
    case 'observation':
      return clean({
        resourceType: 'Observation', id, meta: { profile: [PROFILES.observation] },
        extension: [{ url: EXT.recorder, valueReference: recorder }],
        identifier, status: 'final', code: codeableConcept(e), subject: patient,
        effectiveDateTime: e.occurrence_date || e.recorded_at,
        valueQuantity: e.value_quantity !== null && e.value_quantity !== undefined ? { value: e.value_quantity, unit: e.value_unit, system: 'http://unitsofmeasure.org', code: e.value_unit } : undefined,
      });
    default:
      throw new Error(`unknown care set ${e.care_set}`);
  }
}

export function patientResource(p) {
  return clean({
    resourceType: 'Patient', id: p.id, meta: { profile: [PROFILES.patient] },
    identifier: [{ system: `${DEMO_ID}/patient`, value: p.id }],
    name: [{ family: p.family, given: [p.given] }], gender: p.gender, birthDate: p.birth_date,
  });
}
export function practitionerResource(pr) {
  return clean({
    resourceType: 'Practitioner', id: pr.id, meta: { profile: [PROFILES.practitioner] },
    identifier: [{ system: `${DEMO_ID}/practitioner`, value: pr.id }], name: [{ family: pr.family, given: [pr.given] }],
  });
}

/** A collection Bundle with the patient, the recorder(s) and every recorded entry. */
export function patientBundle(store, patientId, displays = {}, derivedSites = {}) {
  const p = store.get('SELECT * FROM patient WHERE id = ?', patientId);
  const entries = store.entriesForPatient(patientId);
  const recorders = [...new Set(entries.map((e) => e.recorder_id))].map((id) => store.get('SELECT * FROM practitioner WHERE id = ?', id));
  const resources = [patientResource(p), ...recorders.map(practitionerResource), ...entries.map((e) => toResource(e, displays, derivedSites))];
  return {
    resourceType: 'Bundle', type: 'collection', timestamp: new Date().toISOString(),
    entry: resources.map((r) => ({ fullUrl: `urn:uuid:${r.resourceType}-${r.id}`, resource: r })),
  };
}

function clean(o) {
  if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) { const c = clean(v); if (c !== undefined && !(Array.isArray(c) && !c.length)) out[k] = c; }
    return out;
  }
  return o;
}
