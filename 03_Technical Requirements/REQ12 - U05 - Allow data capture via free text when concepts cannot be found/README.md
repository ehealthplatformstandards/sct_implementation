# REQ12 · U05 · Allow data capture via free text when concepts cannot be found: example implementation

> **Example, not normative.** This page shows how the [demo implementations](../Demo%20implementations/README.md) address this requirement. It is one possible approach, shared for discussion. It is not "the way it should be done", and passing the demo's checks does not certify that a product meets the requirement.

| | |
|---|---|
| **Requirement** | U05: *Requirements Specification SNOMED CT Implementation*, V1.0 (10.09.2026) |
| **Shown in** | Demo 2 (entry) · Demo 3 (storage, display, exchange) |
| **Demo code and how to run it** | [`Demo implementations`](../Demo%20implementations/README.md) |

## Requirement

> Where a user cannot identify a suitable SNOMED CT concept for a SNOMED CT-coded data element, the solution shall provide a mechanism to record the clinical information temporarily as free text.
>
> The free-text value shall be clearly distinguishable from SNOMED CT-coded data and shall not be assigned a SNOMED CT Concept ID, placeholder code, or other representation implying that it is SNOMED CT-coded.
>
> This solution is bound to the terminology feedback mechanism defined in TSP7 Provide a reporting/feedback mechanism, requiring the missing concept to be reported through the established Belgian NRC process.

## How the demo addresses it

- **Entry.** Every search offers *No suitable concept? Record as free text and report it*. The free-text box is visibly different (dashed, labelled "uncoded"). The single action records the text **and** opens the NRC feedback dialog (TSP7).
- **Storage.** Free text goes into its own column, `clinical_entry.free_text`. A database rule forbids a Concept ID, a selected term or a Description ID on such a row:

```sql
CHECK ((sct_concept_id IS NOT NULL AND free_text IS NULL AND sct_term_selected IS NOT NULL)
    OR (sct_concept_id IS NULL AND free_text IS NOT NULL AND sct_description_id IS NULL))
```

- **Display.** The patient summary shows a *free text* label and "- (no code)" instead of a Concept ID.
- **Exchange.** The FHIR export puts the text in `CodeableConcept.text` only, without any `coding` (I01).

## Screenshots

![Free-text entry offered when nothing is found, with the report to the NRC.](./screenshots/u05-free-text.png)

*Free-text entry offered when nothing is found, with the report to the NRC.*

![The stored row: free_text filled, no Concept ID, no term, no version.](./screenshots/s01-stored-rows.png)

*The stored row: free_text filled, no Concept ID, no term, no version.*

![Patient summary: the free-text entry is labelled and has no code.](./screenshots/s04-after-upgrade-record-child.png)

*Patient summary: the free-text entry is labelled and has no code.*

## Requests (examples)

```http
(no terminology request)
POST /api/entries {"patientId":"pat-002","careSet":"problem","freeText":"klachten na blootstelling aan PFAS (lokale term, niet gevonden)","method":"free-text"}
```

The parameters are shown without URL encoding, for readability. `[base]` is the FHIR endpoint of the local terminology server, `http://localhost:8090/fhir` in the demo.

## Where to look in the code

- [`ehr-demo-app/lib/store.mjs`](../Demo%20implementations/ehr-demo-app/lib/store.mjs) (schema)
- [`ehr-demo-app/public/js/search-page.js`](../Demo%20implementations/ehr-demo-app/public/js/search-page.js) (free-text box)
- [`ehr-demo-app/lib/fhir-export.mjs`](../Demo%20implementations/ehr-demo-app/lib/fhir-export.mjs) (codeableConcept)
- **Without Node.js:** [`python/serve_demo2.py`](../Demo%20implementations/python/README.md) stores free text in the same separate column, with the same offer to report the missing concept to the NRC.

## Limitations and open points

- **Follow-up of "temporarily".** The demo does not follow up free-text entries once the NRC publishes a concept, for example with a work list to code them later. A real solution would.

---

*Screenshots taken on 22 September 2026 with the SNOMED CT Belgian Edition 20260915 in production, unless the file name says `before-upgrade`. The patients are fictitious. SNOMED CT content © SNOMED International; the Belgian Edition is maintained by the Belgian NRC and used under the SNOMED CT Affiliate Licence.*
