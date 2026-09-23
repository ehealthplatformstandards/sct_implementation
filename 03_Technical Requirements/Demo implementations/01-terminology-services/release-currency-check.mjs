// Demo 1 - TSP3 Belgian Edition release currency.
//
// "The SNOMED CT release used by the production solution shall not be more than one month behind the
//  most recent Belgian Edition published by the BE NRC."
//
// The production version is read from the local terminology server (CodeSystem?url=http://snomed.info/sct).
// The most recent published version comes from one of these sources:
//   --upstream <FHIR base>   a FHIR terminology server that lists the published versions, e.g. the Belgian
//                            national terminology server (Ontoserver); --token <OAuth2 bearer token> if needed
//   --release-info <files>   release_package_information.json of downloaded Belgian Edition packages
//                            (effectiveTime + previousPublishedPackage give the publication chain)
//   --latest YYYYMMDD        manual value
// Meant to run on a schedule (daily): the exit code is 1 when the production version is too old.
// The result uses the distance in months between the effective times. Two other readings of "one month
// behind" (number of newer releases, days since the newest release) are reported as information.
//
// Usage: node release-currency-check.mjs --fhir http://localhost:8090/fhir --release-info a.json,b.json
//        [--max-lag-months 1] [--id tsp3-release-currency] [--note "free text shown in the report"]

import fs from 'node:fs';
import { FhirTerminologyClient, parseVersionUri, BE_MODULE } from '../shared/fhir-ts-client.mjs';
import { Report, args } from './lib/report.mjs';
import { tokenFromEnv } from '../shared/oauth.mjs';

const a = args({ fhir: 'http://localhost:8090/fhir', id: 'tsp3-release-currency', 'max-lag-months': '1' });
const r = new Report({
  id: a.id, title: 'Belgian Edition release currency', requirements: ['TSP3'],
  intro: 'Compares the SNOMED CT version used in production (read from the local terminology server) with the most recent Belgian Edition published by the NRC. The requirement allows a lag of at most one month.',
});

const ts = new FhirTerminologyClient({ baseUrl: a.fhir, bearerToken: tokenFromEnv() });
const trace = [];
const prodUri = (await ts.snomedVersions({ trace }))[0]?.version;
const prod = parseVersionUri(prodUri);
r.meta['Local terminology server'] = a.fhir;
r.meta['Production version'] = prodUri;

// ------------------------------------------------------------------ published versions
let published = [];
let source;
if (a.upstream) {
  const up = new FhirTerminologyClient({ baseUrl: a.upstream, bearerToken: a.token || tokenFromEnv(process.env, 'UPSTREAM') || tokenFromEnv() });
  const list = await up.snomedVersions({ trace });
  published = list.map((v) => parseVersionUri(v.version)).filter((v) => v?.module === BE_MODULE).map((v) => v.effectiveTime);
  source = `FHIR CodeSystem versions on ${a.upstream}`;
} else if (a['release-info']) {
  const files = a['release-info'].split(',');
  for (const f of files) {
    const info = JSON.parse(fs.readFileSync(f, 'utf8'));
    published.push(info.effectiveTime);
    const prev = /_(\d{8})T\d{6}Z\.zip$/.exec(info.previousPublishedPackage || '');
    if (prev) published.push(prev[1]);
  }
  source = `release_package_information.json of ${files.length} Belgian Edition package(s)`;
} else if (a.latest) {
  published = [a.latest]; source = 'manual (--latest)';
} else throw new Error('give --upstream, --release-info or --latest');
published = [...new Set(published)].sort();
const latest = published[published.length - 1];
r.meta['Source of published versions'] = source;
r.meta['Published Belgian Edition versions known'] = published.join(', ');

if (a.note) r.meta.Note = a.note;
const ym = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(4, 6)) - 1;
const lag = ym(latest) - ym(prod.effectiveTime);
const newer = published.filter((v) => v > prod.effectiveTime);
const max = Number(a['max-lag-months']);
const asDate = (d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`);
const days = Math.floor((Date.now() - asDate(latest).getTime()) / 86400000);
const daysText = days >= 0 ? `${days} day(s) since ${latest}` : `effective time ${latest} is ${-days} day(s) in the future`;
r.check({ req: 'TSP3', name: 'Production edition is a Belgian Edition', expected: `module ${BE_MODULE}`, actual: prod?.module, status: prod?.module === BE_MODULE ? 'pass' : 'fail' });
r.check({ req: 'TSP3', name: 'Months between the production version and the most recent published Belgian Edition', detail: `production ${prod.effectiveTime} vs. most recent ${latest}; newer releases not deployed: ${newer.join(', ') || 'none'}`, expected: `<= ${max} month`, actual: `${lag} month(s)`, status: lag <= max ? 'pass' : 'fail' });
// Other ways to read "not more than one month behind" (shown for discussion, not used for the result)
r.check({ req: 'TSP3', name: 'Published releases newer than the production version', detail: 'Another reading of the requirement: at most one release behind. Not used for the result of this check.', actual: `${newer.length} (${newer.join(', ') || 'none'})`, status: 'info' });
r.check({ req: 'TSP3', name: 'Days since the effective time of the most recent release', detail: 'How long the newest release has been available (effective time used as the publication date).', actual: daysText, status: 'info' });
r.block('Published Belgian Edition versions and the production version', `<table><tr><th>Effective time</th><th>Status</th></tr>${published.slice().reverse().map((v) => `<tr><td class="mono">${v}</td><td>${v === prod.effectiveTime ? '<b>in production</b>' : v > prod.effectiveTime ? '<span class="bad">published, not deployed</span>' : 'older'}</td></tr>`).join('')}</table>
<p style="font-size:13px">${lag <= max ? '<span class="ok"><b>Compliant.</b></span>' : `<span class="bad"><b>Not compliant:</b></span> deploy ${latest} (controlled deployment, TSP4).`} The check can run daily from a scheduler; the exit code is non-zero when the production version is too old.</p>`);
r.write();
process.exitCode = r.ok ? 0 : 1;
