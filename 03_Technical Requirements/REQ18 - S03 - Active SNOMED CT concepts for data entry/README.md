# REQ18 · S03 · Active SNOMED CT concepts for data entry: example implementation

> **Example, not normative.** This page shows how the [demo implementations](../Demo%20implementations/README.md) address this requirement. It is one possible approach, shared for discussion. It is not "the way it should be done", and passing the demo's checks does not certify that a product meets the requirement.

| | |
|---|---|
| **Requirement** | S03: *Requirements Specification SNOMED CT Implementation*, V1.0 (10.09.2026) |
| **Shown in** | Demo 2 · Search & select (+ validation on the server) |
| **Demo code and how to run it** | [`05_Demo implementations`](../Demo%20implementations/README.md) |

## Requirement

> The eHR shall prevent inactive SNOMED CT concepts from being newly selected or recorded as the coded value of a clinical data element.
>
> Only concepts that are active in that SNOMED CT version and permitted by the applicable terminology binding shall be accepted for recording.

## How the demo addresses it

- **Search.** Every search uses `activeOnly=true`. In addition, the demo client removes any result the server flags `inactive: true`. Snowstorm Lite returns inactive reference set members even with `activeOnly=true`, so this second filter is needed.
- **Every entry route is checked.** ID search, favourites, recently used and text-analysis suggestions all use one validation function, `validateSelection`:
  - `$validate-code` against the binding;
  - rejection when the server answers `result: true` **with** `inactive: true`, which is what Snowstorm Lite returns for inactive reference set members;
  - `$lookup` to explain the reason.
- **Checked again before storing.** `POST /api/entries` repeats the validation on the server, against the production version.
- **After an upgrade.** A favourite that became inactive (111360009 in 20260915) is shown as blocked (U07). A concept found by ID is shown with the reason, and it cannot be selected.
- **Content found during the demo.** The integrity check of the 20260915 release found 70 members of Belgian simple reference sets that refer to inactive concepts. The release notes list this as known issue ISRS-7703. For example, 698767004 *epilepsie na CVA* is still a member of the problem list subset 40811000172108 and 61947007 *doofstomheid* of the GP subset 721000172106. The eHR never offers these concepts.

## Screenshots

![An inactive concept entered by ID: shown with the reason, cannot be selected.](./screenshots/s03-inactive-concept.png)

*An inactive concept entered by ID: shown with the reason, cannot be selected.*

![A favourite that was inactivated by the new release is blocked.](./screenshots/u07-favourites-after-upgrade.png)

*A favourite that was inactivated by the new release is blocked.*

## Requests (examples)

```http
GET [base]/ValueSet/$validate-code?url=http://snomed.info/sct?fhir_vs=ecl/<binding>&system=http://snomed.info/sct&code=111360009
    -> Snowstorm Lite: result=true + inactive=true for an inactive reference set member (the eHR rejects it)
GET [base]/CodeSystem/$lookup?system=http://snomed.info/sct&code=111360009&property=inactive
```

The parameters are shown without URL encoding, for readability. `[base]` is the FHIR endpoint of the local terminology server, `http://localhost:8090/fhir` in the demo.

## Where to look in the code

- [`ehr-demo-app/lib/search-service.mjs`](../Demo%20implementations/ehr-demo-app/lib/search-service.mjs) (validateSelection)
- [`shared/fhir-ts-client.mjs`](../Demo%20implementations/shared/fhir-ts-client.mjs) (expand: includeInactive)
- [`ehr-demo-app/server.mjs`](../Demo%20implementations/ehr-demo-app/server.mjs) (POST /api/entries)
- **Without Node.js:** [`python/serve_demo2.py`](../Demo%20implementations/python/README.md) runs the same validation before storing, and `python3 ts_search.py --validate <code>` refuses an inactive concept in the same way.

## Limitations and open points

- **Check your own server.** How servers report inactive members differs. The double check (`inactive` flag + `$lookup`) is what made the demo robust with Snowstorm Lite; check the behaviour of your own terminology server.

---

*Screenshots taken on 22 September 2026 with the SNOMED CT Belgian Edition 20260915 in production, unless the file name says `before-upgrade`. The patients are fictitious. SNOMED CT content © SNOMED International; the Belgian Edition is maintained by the Belgian NRC and used under the SNOMED CT Affiliate Licence.*
