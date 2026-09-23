// Demo 1 - TSP4 controlled deployment of a new Belgian Edition (blue/green), with TSP5 hand-over.
//
//   1. the active instance (e.g. "blue", 20260715) keeps serving the eHR through the LTS proxy;
//   2. the new release package is loaded into the idle instance ("green") through the server's own
//      import API (Snowstorm Lite: POST /fhir-admin/load-package);
//   3. the loaded content is verified against the RF2 package (verify-integrity.mjs) + smoke tests;
//   4. the proxy switches atomically to green; the eHR is told the new production version (TSP5);
//   5. blue stays available for rollback.
// During the whole procedure an availability probe sends eHR-like requests to the proxy (several per
// second) and records every failure: "no interruption of terminology-dependent functionality".
//
// Usage:
//   node deploy-release.mjs --package BE_20260915_snapshot.zip --version-uri http://snomed.info/sct/11000172109/version/20260915 \
//        --rf2 <Snapshot folder of the same release> [--proxy http://localhost:8090] [--standby green --standby-url http://localhost:8080] \
//        [--admin-password ... | env SNOWSTORM_ADMIN_PASSWORD] [--proxy-token ... | env PROXY_ADMIN_TOKEN] [--ehr http://localhost:3000] [--sample 300]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { FhirTerminologyClient, implicit } from '../shared/fhir-ts-client.mjs';
import { Report, args } from './lib/report.mjs';
import { verifyIntegrity } from './verify-integrity.mjs';

const a = args({
  proxy: 'http://localhost:8090', 'proxy-token': process.env.PROXY_ADMIN_TOKEN || 'change-me', standby: 'green', 'standby-url': 'http://localhost:8080',
  'admin-user': 'admin', 'admin-password': process.env.SNOWSTORM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD, ehr: 'http://localhost:3000', sample: '300', id: 'tsp4-controlled-deployment',
});
if (!a.package || !a['version-uri'] || !a.rf2) throw new Error('--package, --version-uri and --rf2 are required');
if (!a['admin-password']) throw new Error('give the Snowstorm Lite admin password with --admin-password or the SNOWSTORM_ADMIN_PASSWORD environment variable');
const r = new Report({
  id: a.id, title: 'Controlled deployment of a new Belgian Edition (blue/green)', requirements: ['TSP4', 'TSP5'],
  intro: 'The new release is imported into the idle terminology server instance while the active instance keeps answering the eHR. The imported content is verified against the RF2 package before the LTS proxy switches. An availability probe measures the service seen by the eHR during the whole procedure.',
});
const steps = [];
const T0 = Date.now();
const step = async (name, fn) => {
  const t = Date.now(); console.log(`\n== ${name}`);
  try { const out = await fn(); steps.push({ name, start: t - T0, ms: Date.now() - t, ok: true }); return out; } catch (e) { steps.push({ name, start: t - T0, ms: Date.now() - t, ok: false, error: e.message }); throw e; }
};
const getJson = async (url, opts = {}) => { const res = await fetch(url, opts); const j = await res.json(); if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };

// ------------------------------------------------------------------ availability probe (what the eHR sees)
const probe = { samples: [], running: true };
async function runProbe() {
  const queries = ['ast', 'astma', 'diab', 'hyperten', 'pneumo', 'fractuur femur', 'hartfalen', 'migr'];
  let i = 0;
  while (probe.running) {
    const t = Date.now();
    const q = queries[i++ % queries.length];
    const url = `${a.proxy}/fhir/ValueSet/$expand?url=${encodeURIComponent(implicit.ecl('< 404684003 |Clinical finding|'))}&filter=${encodeURIComponent(q)}&count=10&displayLanguage=nl-BE`;
    let ok = false; let status = 0; let backend = '';
    try { const res = await fetch(url, { headers: { Accept: 'application/fhir+json', 'Accept-Language': 'nl-BE' }, signal: AbortSignal.timeout(5000) }); status = res.status; backend = res.headers.get('x-lts-backend') || ''; await res.arrayBuffer(); ok = res.ok; } catch { ok = false; }
    probe.samples.push({ t: t - T0, ms: Date.now() - t, ok, status, backend });
    await new Promise((res) => setTimeout(res, 250));
  }
}

// ------------------------------------------------------------------ multipart upload of the RF2 package (streamed)
function uploadPackage(baseUrl, file, versionUri) {
  return new Promise((resolve, reject) => {
    const boundary = `----sct-demo-${Date.now()}`;
    const head1 = `--${boundary}\r\nContent-Disposition: form-data; name="version-uri"\r\n\r\n${versionUri}\r\n`;
    const head2 = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(file)}"\r\nContent-Type: application/zip\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const size = fs.statSync(file).size;
    const u = new URL(`${baseUrl}/fhir-admin/load-package`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 60 * 60 * 1000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(head1) + Buffer.byteLength(head2) + size + Buffer.byteLength(tail), Authorization: `Basic ${Buffer.from(`${a['admin-user']}:${a['admin-password']}`).toString('base64')}` },
    }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => (res.statusCode < 300 ? resolve({ status: res.statusCode, body }) : reject(new Error(`load-package HTTP ${res.statusCode}: ${body.slice(0, 300)}`)))); });
    req.on('error', reject);
    req.write(head1); req.write(head2);
    const s = fs.createReadStream(file);
    s.on('end', () => req.end(tail));
    s.pipe(req, { end: false });
  });
}

// ------------------------------------------------------------------ procedure
r.meta['LTS proxy (endpoint used by the eHR)'] = `${a.proxy}/fhir`;
r.meta['Release package'] = `${path.basename(a.package)} (${(fs.statSync(a.package).size / 1e6).toFixed(0)} MB)`;
r.meta['Target version'] = a['version-uri'];
const probing = runProbe();
let before;
try {
  before = await step('1. Current state of the LTS', async () => {
    const s = await getJson(`${a.proxy}/admin/status`);
    r.meta['Active before'] = `${s.active} - ${s.activeVersion}`;
    r.check({ req: 'TSP4', name: 'Standby instance is not the active one', expected: `active != ${a.standby}`, actual: `active = ${s.active}`, status: s.active !== a.standby ? 'pass' : 'fail' });
    return s;
  });
  await step(`2. Import the new release into the standby instance (${a.standby})`, async () => {
    const res = await uploadPackage(a['standby-url'], a.package, a['version-uri']);
    r.check({ req: 'TSP4', name: `Import into ${a.standby} via POST /fhir-admin/load-package`, expected: 'HTTP 200', actual: `HTTP ${res.status}`, status: 'pass' });
  });
  const standbyTs = new FhirTerminologyClient({ baseUrl: `${a['standby-url']}/fhir`, timeoutMs: 60000 });
  await step('3. Version check on the standby instance', async () => {
    const v = (await standbyTs.snomedVersions())[0]?.version;
    r.check({ req: 'TSP4', name: 'Standby serves the new version', expected: a['version-uri'], actual: v, status: v === a['version-uri'] ? 'pass' : 'fail' });
  });
  await step('4. Content integrity: RF2 package vs standby instance', async () => {
    await verifyIntegrity({ fhirBase: `${a['standby-url']}/fhir`, snapshotDir: a.rf2, sample: Number(a.sample), report: r });
  });
  await step('5. Smoke tests on the standby instance', async () => {
    for (const [lang, q] of [['nl-BE', 'astma'], ['fr-BE', 'asthme'], ['de-BE', 'asthma'], ['en-US', 'asthma']]) {
      const x = await standbyTs.expand({ url: implicit.ecl('< 404684003 |Clinical finding|'), filter: q, count: 1, displayLanguage: lang });
      r.check({ req: 'TSP4', name: `Search "${q}" (${lang}) on the standby instance`, expected: 'result', actual: x.contains[0]?.display || 'none', status: x.contains.length ? 'pass' : 'fail' });
    }
    const v = await standbyTs.validateInValueSet({ url: implicit.refset('40811000172108'), code: '195967001' });
    r.check({ req: 'TSP4', name: '$validate-code on a Belgian reference set', expected: true, actual: v.result, status: v.result === true ? 'pass' : 'fail' });
  });
  if (!r.ok) throw new Error('verification failed: the proxy is NOT switched, the active instance keeps serving');
  await step(`6. Switch the LTS proxy to ${a.standby}`, async () => {
    const res = await getJson(`${a.proxy}/admin/switch?to=${a.standby}&expectVersion=${encodeURIComponent(a['version-uri'])}`, { method: 'POST', headers: { 'x-admin-token': a['proxy-token'] } });
    r.check({ req: 'TSP4', name: 'Atomic switch of the LTS proxy', expected: `${before.active} -> ${a.standby}`, actual: `${res.switched.from} -> ${res.switched.to} at ${res.switched.at}`, status: 'pass' });
  });
  await step('7. Tell the eHR the new production version (TSP5)', async () => {
    try {
      const res = await getJson(`${a.ehr}/api/admin/production-version`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: a['version-uri'] }) });
      const v = await getJson(`${a.ehr}/api/version`);
      r.check({ req: 'TSP5', name: 'All eHR components use the new version', expected: a['version-uri'], actual: `${res.productionVersion} - ${v.consistent ? 'consistent' : 'INCONSISTENT'}`, status: v.consistent && res.productionVersion === a['version-uri'] ? 'pass' : 'fail' });
    } catch (e) { r.check({ req: 'TSP5', name: 'Notify the eHR', expected: 'reachable', actual: e.message, status: 'warn' }); }
  });
  await new Promise((res) => setTimeout(res, 4000)); // keep probing a little after the switch
} catch (e) {
  console.error(`\nDEPLOYMENT STOPPED: ${e.message}`);
  r.check({ req: 'TSP4', name: 'Deployment', expected: 'completed', actual: `stopped: ${e.message}`, status: 'fail' });
} finally {
  probe.running = false; await probing;
}

// ------------------------------------------------------------------ availability summary + report
const s = probe.samples; const failed = s.filter((x) => !x.ok);
const lat = s.map((x) => x.ms).sort((x, y) => x - y); const p95 = lat[Math.floor(0.95 * (lat.length - 1))] || 0;
const byBackend = s.reduce((m, x) => ({ ...m, [x.backend || '?']: (m[x.backend || '?'] || 0) + 1 }), {});
r.check({ req: 'TSP4', name: 'Terminology service availability during the procedure (probe via the LTS proxy)', detail: `${s.length} eHR-like requests over ${Math.round((Date.now() - T0) / 1000)} s; served by ${Object.entries(byBackend).map(([k, v]) => `${k}: ${v}`).join(', ')}`, expected: '0 failed requests', actual: `${failed.length} failed, p95 ${p95} ms`, status: failed.length === 0 ? 'pass' : 'fail' });
const after = await getJson(`${a.proxy}/admin/status`).catch(() => null);
r.meta['Active after'] = after ? `${after.active} - ${after.activeVersion}` : '?';
r.meta.Rollback = `POST ${a.proxy}/admin/switch?to=${before?.active || 'blue'} (the previous instance keeps its index)`;

const W = 1100; const H = 170; const tmax = Math.max(1, ...s.map((x) => x.t));
const ymax = Math.max(100, ...s.map((x) => x.ms));
const pts = s.map((x) => `${(x.t / tmax) * W},${H - 20 - (x.ms / ymax) * (H - 40)}`).join(' ');
const marks = steps.map((st) => `<line x1="${(st.start / tmax) * W}" x2="${(st.start / tmax) * W}" y1="0" y2="${H - 20}" stroke="#9aa5b1" stroke-dasharray="3,3"/><text x="${(st.start / tmax) * W + 3}" y="12" font-size="10" fill="#5f6b7a">${st.name.split('.')[0]}</text>`).join('');
const fails = failed.map((x) => `<circle cx="${(x.t / tmax) * W}" cy="${H - 20}" r="3" fill="#b3261e"/>`).join('');
const colours = s.map((x) => `<circle cx="${(x.t / tmax) * W}" cy="${H - 8}" r="1.6" fill="${x.backend === 'green' ? '#1e7b4a' : '#1d4f91'}"/>`).join('');
r.block('Availability seen by the eHR during the deployment', `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#fbfcfd;border:1px solid #eef1f4;border-radius:6px">${marks}<polyline points="${pts}" fill="none" stroke="#1d4f91" stroke-width="1.2"/>${fails}${colours}<text x="${W - 4}" y="${H - 24}" font-size="10" text-anchor="end" fill="#5f6b7a">response time (max ${ymax} ms)</text></svg>
<p style="font-size:12.5px;color:#3b4a5c">Line: response time of each probe request through the LTS proxy. Dots below: backend that answered (<span style="color:#1d4f91">blue = previous release</span>, <span style="color:#1e7b4a">green = new release</span>). Dashed lines: start of each step. Failed requests would appear as red dots.</p>
<table><tr><th>Step</th><th class="num">Start</th><th class="num">Duration</th><th>Result</th></tr>${steps.map((st) => `<tr><td>${st.name}</td><td class="num">${Math.round(st.start / 1000)} s</td><td class="num">${(st.ms / 1000).toFixed(1)} s</td><td>${st.ok ? '<span class="st pass">OK</span>' : `<span class="st fail">FAILED</span> ${st.error}`}</td></tr>`).join('')}</table>`);
r.write();
process.exitCode = r.ok ? 0 : 1;
