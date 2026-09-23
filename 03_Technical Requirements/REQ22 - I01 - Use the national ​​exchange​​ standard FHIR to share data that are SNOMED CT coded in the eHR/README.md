# REQ22 · I01 · Use the national exchange standard FHIR to share data that are SNOMED CT coded in the eHR: example implementation

> **Example, not normative.** This page shows how the [demo implementations](../Demo%20implementations/README.md) address this requirement. It is one possible approach, shared for discussion. It is not "the way it should be done", and passing the demo's checks does not certify that a product meets the requirement.

| | |
|---|---|
| **Requirement** | I01: *Requirements Specification SNOMED CT Implementation*, V1.0 (10.09.2026) |
| **Shown in** | Demo 3 · Record (FHIR exchange) |
| **Demo code and how to run it** | [`05_Demo implementations`](../Demo%20implementations/README.md) |

## Requirement

> Use the national exchange standard FHIR to share data that are SNOMED CT coded in the eHR.

## How the demo addresses it

- **Generated from the stored data.** The FHIR export ([`fhir-export.mjs`](../Demo%20implementations/ehr-demo-app/lib/fhir-export.mjs)) creates resources that declare the Belgian profiles (HL7 Belgium / eHealth platform), straight from the stored entries:

| Data | Resource | Profile (`meta.profile`) |
|---|---|---|
| Problem list | Condition | `https://www.ehealth.fgov.be/standards/fhir/core-clinical/StructureDefinition/be-problem` |
| Allergy & Intolerance | AllergyIntolerance | `…/allergy/StructureDefinition/be-allergyintolerance` |
| Vaccination | Immunization | `…/vaccination/StructureDefinition/be-vaccination` |
| Procedures | Procedure | `…/core-clinical/StructureDefinition/be-procedure` |
| Clinical observation | Observation | `…/core-clinical/StructureDefinition/be-clinical-observation` |
| Patient, recorder | Patient, Practitioner | `…/core/StructureDefinition/be-patient`, `be-practitioner` |

- **SNOMED CT codes:**
  - `Coding.system` = `http://snomed.info/sct`;
  - `Coding.version` = the edition version used when the code was chosen, for example `http://snomed.info/sct/11000172109/version/20260715`;
  - `Coding.code` = the stored Concept ID;
  - `Coding.display` and `CodeableConcept.text` = the term the user selected.
- **Free text** travels as `text` only, without a coding (U05).
- **Context** goes into the FHIR elements for it (S02), including `be-ext-laterality` on `bodySite` and `be-ext-allergy-type`.
- **Available per patient or per entry:** a collection Bundle per patient (`GET /api/patients/{id}/fhir`) or one resource per entry (`GET /api/entries/{id}/fhir`).

## Screenshots

![FHIR resources generated from the stored entries, with one complete Condition.](./screenshots/i01-i02-fhir-export.png)

*FHIR resources generated from the stored entries, with one complete Condition.*

## Requests (examples)

```http
GET /api/patients/pat-003/fhir     -> Bundle (collection) with Patient, Practitioner and one resource per entry
```

The parameters are shown without URL encoding, for readability. `[base]` is the FHIR endpoint of the local terminology server, `http://localhost:8090/fhir` in the demo.

## Where to look in the code

- [`ehr-demo-app/lib/fhir-export.mjs`](../Demo%20implementations/ehr-demo-app/lib/fhir-export.mjs)
- [`ehr-demo-app/server.mjs`](../Demo%20implementations/ehr-demo-app/server.mjs) (FHIR routes)

## Limitations and open points

- **Not validated.** The resources were **not** validated with the HL7 FHIR validator against the Belgian packages, because the FHIR package registry could not be reached from the demo environment. Validate them before reusing the mapping.
- **Demo identifiers.** The demo namespace `https://example.org/demo-ehr/…` is used; no national numbers.
- **No transport.** The demo does not send the resources anywhere (no eHealth platform services, no FHIR server). It shows the content only.

---

*Screenshots taken on 22 September 2026 with the SNOMED CT Belgian Edition 20260915 in production, unless the file name says `before-upgrade`. The patients are fictitious. SNOMED CT content © SNOMED International; the Belgian Edition is maintained by the Belgian NRC and used under the SNOMED CT Affiliate Licence.*
