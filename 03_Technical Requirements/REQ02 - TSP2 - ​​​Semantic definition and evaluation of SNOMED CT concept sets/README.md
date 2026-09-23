# REQ02 · TSP2 · Semantic definition and evaluation of SNOMED CT concept sets: example implementation

> **Example, not normative.** This page shows how the [demo implementations](../Demo%20implementations/README.md) address this requirement. It is one possible approach, shared for discussion. It is not "the way it should be done", and passing the demo's checks does not certify that a product meets the requirement.

| | |
|---|---|
| **Requirement** | TSP2: *Requirements Specification SNOMED CT Implementation*, V1.0 (10.09.2026) |
| **Shown in** | Demo 1 (checks) · used throughout Demo 2 (bindings) and Demo 3 (reports) |
| **Demo code and how to run it** | [`Demo implementations`](../Demo%20implementations/README.md) |

## Requirement

> The FHIR terminology service shall support the dynamic definition and evaluation of SNOMED CT concept sets based on the SNOMED CT hierarchy and relationships, without requiring all member concepts to be individually enumerated or maintained.
>
> The terminology service shall support:
>
> - ValueSet/$expand to return the concepts satisfying a dynamically defined SNOMED CT constraint; and
> - $validate-code to determine whether a specified SNOMED CT concept satisfies that constraint.
>
> The solution should support SNOMED CT Expression Constraint Language (ECL), conformant to a published SNOMED International ECL specification supported by the solution, as the standard mechanism for expressing these constraints.
>
> Where ECL is not supported, the supplier shall demonstrate that the alternative mechanism:
>
> 1. evaluates concept membership dynamically using the SNOMED CT hierarchy and relationships;
> 2. supports equivalent use within ValueSet/$expand and $validate-code; and
> 3. does not require the complete resulting concept set to be manually enumerated or maintained.

## How the demo addresses it

- **Every concept set in the demo is an ECL expression**, used as an implicit FHIR value set `http://snomed.info/sct?fhir_vs=ecl/<ECL>`. No member list is stored anywhere:
  - the bindings of the data elements ([`bindings.json`](../Demo%20implementations/ehr-demo-app/config/bindings.json));
  - the context subsets;
  - the analytics reports (S06);
  - the "is this concept still active" checks after an upgrade (S04).
- **The same ECL for both operations.** It is used with `ValueSet/$expand` (list or search) and with `ValueSet/$validate-code` (is concept X a member?).
- **Five ECL patterns checked by [`conformance-check.mjs`](../Demo%20implementations/01-terminology-services/README.md)**, each with `$expand` and with `$validate-code` for a member and a non-member:
  - refinement on a defining attribute;
  - exclusion with `MINUS`;
  - Belgian reference set combined with the hierarchy;
  - attribute refinement on the causative agent;
  - a hierarchy that picks up concepts added in a later release.
- **Concepts from a new release are included without any change.** `<< 84757009 |Epilepsy|` contains 1380178003 *Epilepsy due to and following stroke* on 20260915. That concept did not exist in 20260715. The ECL did not change.
- **ECL 2.x history supplement.** `{{ +HISTORY-MIN }}` is used by the S06 reports to include codes that were inactivated after they were recorded.

## Screenshots

![The TSP2 checks of the conformance report: five ECL expressions, each evaluated with $expand and $validate-code.](./screenshots/tsp2-checks.png)

*The TSP2 checks of the conformance report: five ECL expressions, each evaluated with $expand and $validate-code.*

![An analytics report defined by one ECL expression with a defining attribute (S06).](./screenshots/s06-report-attribute.png)

*An analytics report defined by one ECL expression with a defining attribute (S06).*

## Requests (examples)

```http
GET [base]/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=ecl/< 404684003 |Clinical finding| : 363698007 |Finding site| = << 80891009 |Heart structure|&count=20
GET [base]/ValueSet/$validate-code?url=http://snomed.info/sct?fhir_vs=ecl/<< 73211009 MINUS << 46635009&system=http://snomed.info/sct&code=44054006
GET [base]/ValueSet/$expand?url=http://snomed.info/sct?fhir_vs=ecl/(<< 84757009 |Epilepsy|) {{ +HISTORY-MIN }}&count=1
```

The parameters are shown without URL encoding, for readability. `[base]` is the FHIR endpoint of the local terminology server, `http://localhost:8090/fhir` in the demo.

## Where to look in the code

- [`01-terminology-services/conformance-check.mjs`](../Demo%20implementations/01-terminology-services/conformance-check.mjs)
- [`ehr-demo-app/config/bindings.json`](../Demo%20implementations/ehr-demo-app/config/bindings.json)
- [`ehr-demo-app/lib/reports.mjs`](../Demo%20implementations/ehr-demo-app/lib/reports.mjs)
- [`shared/fhir-ts-client.mjs`](../Demo%20implementations/shared/fhir-ts-client.mjs)
- **Without Node.js:** [`python/ts_check.py`](../Demo%20implementations/python/README.md) evaluates the same ECL constraints with the Python standard library only.

## Limitations and open points

- **ECL subset.** Snowstorm Lite implements "ECL Core", a subset of ECL. According to its documentation, unsupported features (attribute groups, concept/description/member filters, member fields, …) return HTTP 501. The demo only uses constructs within that subset. A supplier should state which ECL specification version and which features its terminology service supports.
- **Versions.** The results always reflect the edition version that the server holds (see TSP5).

---

*Screenshots taken on 22 September 2026 with the SNOMED CT Belgian Edition 20260915 in production, unless the file name says `before-upgrade`. The patients are fictitious. SNOMED CT content © SNOMED International; the Belgian Edition is maintained by the Belgian NRC and used under the SNOMED CT Affiliate Licence.*
