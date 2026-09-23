# REQ23 · I02 · Reuse SNOMED CT coded data elements for all relevant message exchanges: example implementation

> **Example, not normative.** This page shows how the [demo implementations](../Demo%20implementations/README.md) address this requirement. It is one possible approach, shared for discussion. It is not "the way it should be done", and passing the demo's checks does not certify that a product meets the requirement.

| | |
|---|---|
| **Requirement** | I02: *Requirements Specification SNOMED CT Implementation*, V1.0 (10.09.2026) |
| **Shown in** | Demo 3 · Record (FHIR exchange, data extraction) |
| **Demo code and how to run it** | [`05_Demo implementations`](../Demo%20implementations/README.md) |

## Requirement

> Reuse SNOMED CT coded data elements to (automatically) populate FHIR resources for all relevant message exchanges.

## How the demo addresses it

- **Captured once.** Data is captured once, in Demo 2. Every output is then generated from the same stored rows, and nothing is typed again:

| Output | Generated from | Requirement |
|---|---|---|
| FHIR Condition / AllergyIntolerance / Immunization / Procedure / Observation | `clinical_entry` | I01 |
| Patient summary (display) | `clinical_entry` + displays in the user's language | S01, U06 |
| ICD-10 classification and CSV data extraction | `clinical_entry` + imported map | S05 |
| Reports | `clinical_entry` + ECL | S06 |

- **One mapping function.** The mapping from a stored entry to a FHIR resource is one function, `toResource(entry)`. It serves the patient Bundle and the single-resource export, and it would serve any other message that carries the same care sets.
- **Chosen once, carried unchanged.** The coded value, the selected term, the version and the context travel as they were recorded. The only values the export adds are the display of qualifier codes, and a body site taken from the concept definition when only a laterality was recorded (see S02).

## Screenshots

![The FHIR table lists every stored entry as a resource: nothing is typed again.](./screenshots/i01-i02-fhir-export.png)

*The FHIR table lists every stored entry as a resource: nothing is typed again.*

## Requests (examples)

```http
GET /api/entries/18/fhir     -> the Condition of one stored entry
GET /api/extract.csv         -> the same entries as a data extraction with derived ICD-10 codes
```

The parameters are shown without URL encoding, for readability. `[base]` is the FHIR endpoint of the local terminology server, `http://localhost:8090/fhir` in the demo.

## Where to look in the code

- [`ehr-demo-app/lib/fhir-export.mjs`](../Demo%20implementations/ehr-demo-app/lib/fhir-export.mjs) (toResource, patientBundle)
- [`ehr-demo-app/server.mjs`](../Demo%20implementations/ehr-demo-app/server.mjs)

## Limitations and open points

- **Care sets covered.** The demo covers the five care sets of TSP1. Other message types (e.g. referral letters, the Sumehr / patient summary document) would reuse `toResource`, but they are not implemented.

---

*Screenshots taken on 22 September 2026 with the SNOMED CT Belgian Edition 20260915 in production, unless the file name says `before-upgrade`. The patients are fictitious. SNOMED CT content © SNOMED International; the Belgian Edition is maintained by the Belgian NRC and used under the SNOMED CT Affiliate Licence.*
