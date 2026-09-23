# Running the demos

> **Example implementations.** Nothing here is normative, certified or secure. The three patients are fictitious; never use the demo eHR with real patient data. Full descriptions are in [`README.md`](README.md) and in the README of each demo.

## 0 · Pick the route that fits your machine

| Route | You need | What you can run |
|---|---|---|
| **A. Everything locally** | Node.js 22.13+, Java 17+, ~8 GB RAM, the RF2 packages | Demo 1, 2 and 3, including the release upgrade (TSP4, TSP5) |
| **B. No Java** — use a terminology server that already runs | Node.js 22.13+ | Demo 1 checks, Demo 2, Demo 3 (not TSP4, not the two-endpoint half of TSP5) |
| **C. No Node.js and no Java** | Python 3.8+ | Demo 1 checks, Demo 2 (see §5) |
| **D. Nothing** | a browser | The recorded reports and all screenshots (see §6) |

**Docker is not needed** in any route. `00-terminology-server/docker-compose.yml` is only an alternative to route A.

**The RF2 release packages of the Belgian Edition are not in this repository** — download 20260715 and 20260915 from the NRC. Route A needs them for the terminology server; routes B and C only need one Snapshot folder, for the Demo 2 lexicon and the ICD-10 maps.

**Ports used:** 8081 blue terminology server · 8080 green · 8090 proxy · 3000 Node demo eHR · 3100 Python Demo 2.

**On Windows (PowerShell):** set variables with `$env:NAME = 'value'` on their own line, continue a line with a backtick, use `curl.exe` (plain `curl` is an alias for `Invoke-WebRequest`), write Windows paths in JSON bodies with forward slashes, and give each server its own window. The complete PowerShell blocks are in [`00-terminology-server/README.md`](00-terminology-server/README.md) and [`ehr-demo-app/README.md`](ehr-demo-app/README.md).

---

## 1 · Demo 1 · Terminology services & release management (TSP1–TSP6)

### 1a. Start the local terminology server (route A only)

Two Snowstorm Lite instances behind a small proxy: **blue** serves the July edition, **green** is idle and receives the next release.

```bash
cd 00-terminology-server
mkdir -p lts/blue lts/green && cp application.properties lts/blue/ && cp application.properties lts/green/
JAR=/path/to/snowstorm-lite-2.7.0.jar          # from https://github.com/IHTSDO/snowstorm-lite/releases
export ADMIN_PASSWORD='choose-your-own'

# blue: build the index once with a large heap (~8 minutes for the Belgian Edition) ...
cd lts/blue
java -Xmx4g -jar "$JAR" --server.port=8081 --index.path=lucene-index \
     --load=/data/BE_20260715_snapshot.zip \
     --version-uri=http://snomed.info/sct/11000172109/version/20260715
# ... after "Import complete", stop it and start it again without --load:
java -Xmx1200m -jar "$JAR" --server.port=8081 --index.path=lucene-index

# green (second window): the idle instance
cd ../green && java -Xmx4g -jar "$JAR" --server.port=8080 --index.path=lucene-index

# the proxy (third window), from 00-terminology-server
PROXY_PORT=8090 BLUE_URL=http://localhost:8081 GREEN_URL=http://localhost:8080 ACTIVE=blue \
ADMIN_TOKEN='choose-a-token' STATE_FILE=./lts-proxy-state.json node lts-proxy.mjs
```

Check: `curl http://localhost:8090/fhir/metadata` answers, and `http://localhost:8090/admin/status` shows which instance is active.

*Route B:* skip this and use `--fhir https://<server>/fhir` everywhere below. If that server needs authentication, set `TS_BEARER_TOKEN`, or `TS_TOKEN_URL` + `TS_CLIENT_ID` + `TS_CLIENT_SECRET` (+ `TS_SCOPE`). Nothing is stored in this repository.

### 1b. Run the checks

```bash
cd 01-terminology-services
node conformance-check.mjs --fhir http://localhost:8090/fhir          # TSP1, TSP2, TSP6
node release-currency-check.mjs --release-info <20260915>/release_package_information.json,<20260715>/release_package_information.json   # TSP3
```

Each script writes `reports/<id>.html` + `.json` and lists them in `reports/index.html`. **Exit code 1 means a check failed**, so they can run from a scheduler.

### 1c. Deploy the next release (TSP4 + TSP5, route A only)

```bash
SNOWSTORM_ADMIN_PASSWORD=... PROXY_ADMIN_TOKEN=... \
node deploy-release.mjs --package BE_20260915_snapshot.zip \
     --version-uri http://snomed.info/sct/11000172109/version/20260915 \
     --rf2 <Snapshot folder of 20260915>
```

It imports into green while blue keeps serving, verifies the content against the RF2 files, switches the proxy, hands the new version to the eHR, and measures availability throughout. Afterwards:

```bash
node version-consistency-check.mjs --ehr http://localhost:3000      # TSP5
```

---

## 2 · Demo 2 · Search & select (U01–U08, TSP6, TSP7, S02, S03)

```bash
cd ehr-demo-app
node build-lexicon.mjs /data/rf2/<20260715>/Snapshot                 # once per edition, ~18 s
RF2_SNAPSHOT_DIR=/data/rf2/<20260715>/Snapshot node server.mjs       # http://localhost:3000
node seed.mjs                                                        # second window: 3 fictitious patients
```

Open **`http://localhost:3000/search.html`**. Add `LTS_BASE_URL=https://<server>/fhir` for route B.

What to try: type `hypertensei` (spelling correction) · `hartinfarct` (decompounding) · `nierstenen` (plural form) · a Concept ID like `195967001` or a Description ID like `6281000172111` · switch the language at the top right · switch the context subset · click **ⓘ** for the hierarchy · **★** for favourites · *Analyse text* for the text-analysis suggestions · *No suitable concept?* for free text and the NRC feedback.

---

## 3 · Demo 3 · Record, analytics & exchange (S01–S06, I01, I02)

Same server as Demo 2 — open **`http://localhost:3000/record.html`**. The tabs are *Summary*, *Stored rows*, *Release upgrade*, *Classifications*, *Reports* and *FHIR*.

The S04 scenario needs the release upgrade of §1c. After it, run these three steps and then click **Run release impact analysis** in *Release upgrade*:

```bash
curl -X POST localhost:3000/api/admin/import-maps -H 'Content-Type: application/json' \
     -d '{"snapshotDir":"/data/rf2/<20260915>/Snapshot"}'          # ICD-10 maps of the new edition (S05)
node build-lexicon.mjs /data/rf2/<20260915>/Snapshot                # then restart the eHR
node seed-after-upgrade.mjs                                         # 1 entry with a new concept + 1 NRC feedback
```

The Demo 1 reports are also served here, at `http://localhost:3000/demo1/`.

---

## 4 · Optional: the TSP5 mismatch (route A)

A second eHR whose reporting component still points at the old instance, to show what an inconsistency looks like:

```bash
PORT=3001 REPORTING_LTS_BASE_URL=http://localhost:8081/fhir LEXICON_CACHE=/nonexistent node ehr-demo-app/server.mjs
node 01-terminology-services/version-consistency-check.mjs --ehr http://localhost:3001 --id tsp5-version-consistency-mismatch
```

---

## 5 · Route C · Python only (no Node.js, no Java, no Docker)

Python 3.8 or later, no `pip install`. Full details in [`python/README.md`](python/README.md).

```bash
cd python
python3 ts_check.py --fhir https://<server>/fhir                     # TSP1, TSP2, TSP6 -> reports/
python3 release_currency_check.py --fhir https://<server>/fhir --latest 20260915      # TSP3
python3 build_lexicon.py /data/rf2/<20260915>/Snapshot               # U01, U02 - once, ~30 s
python3 serve_demo2.py --fhir https://<server>/fhir                  # -> http://localhost:3100/search.html
python3 ts_search.py --fhir https://<server>/fhir "astma"            # the same search on the command line
```

```powershell
cd 'C:\snomed-demo\05_Demo implementations\python'
$env:TS_TOKEN_URL     = 'https://<token endpoint>'      # only for a server that needs authentication
$env:TS_CLIENT_ID     = '<client id>'
$env:TS_CLIENT_SECRET = '<client secret>'
python ts_check.py --fhir 'https://<server>/fhir'
python serve_demo2.py --fhir 'https://<server>/fhir'
```

`serve_demo2.py` serves the same Demo 2 pages as the Node eHR and behaves identically. Demo 3, TSP4 and the two-endpoint half of TSP5 are not in the Python version.

---

## 6 · Route D · Nothing to install

- `01-terminology-services/reports/index.html` — the HTML reports of the recorded run (open in any browser).
- `python/reports/index.html` — the same checks run from Python.
- `screenshots/` — every screen of the three demos.
- `03_Technical Requirements/<REQ…>/Examples/README.md` — per requirement: the requirement text, what the demo does, the screenshots, the example requests, where the code is, and the limitations.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `java -version` prints 1.8 | Snowstorm Lite needs Java 17. Unpack a portable JDK 17 and call it by its full path — `JAVA_HOME` and the `PATH` stay untouched. Or use route B or C. |
| The import is killed, or the machine swaps | The import needs a heap of about 4 GB; serving needs 1.2 GB. Do not run other memory-heavy jobs during an import. |
| `node:sqlite` not found | The eHR needs **Node.js 22.13 or later**: `node --version`. |
| The eHR answers HTTP 409 | A component is pinned to another SNOMED CT version than the server serves (TSP5, on purpose). Run `version-consistency-check.mjs`. |
| HTTP 500 from the terminology server | Some clients send `Accept-Language: *`, which Snowstorm Lite rejects. The demo client always sends an explicit language. |
| No spelling correction or decompounding | The lexicon cache is missing: run `build-lexicon.mjs` (or `build_lexicon.py`) and restart. Everything else still works. |
| `$expand` returns HTTP 501 | Snowstorm Lite implements ECL Core only. Try the constraint on another server. |
| `deploy-release.mjs` returns HTTP 401 | Set `ADMIN_PASSWORD` in the environment of the Snowstorm Lite instance *before* it starts, and pass the same value as `SNOWSTORM_ADMIN_PASSWORD`. |
| The Python scripts cannot reach an https server | Corporate TLS proxy: pass `--ca-bundle <file.pem>` or set `TS_CA_BUNDLE`. `HTTPS_PROXY` is honoured automatically. |
