// Local Terminology Server (LTS) front door with blue/green switching - TSP4 / TSP5 example.
//
// The eHR only knows ONE terminology endpoint (this proxy, e.g. http://localhost:8090/fhir).
// Behind it run two terminology server instances ("blue" and "green"), each holding one edition
// version. A new Belgian Edition is loaded into the idle instance while the active one keeps serving
// the eHR; after verification the proxy switches atomically. The old instance stays available for
// rollback. Requests that are in flight during the switch complete on the instance they started on.
//
// Version-aware routing (TSP5): a request that asks for a specific SNOMED CT version (system-version,
// systemVersion or version parameter, as the pinned eHR clients send them) goes to the instance that serves
// exactly that version, if one does. So between the switch and the moment every eHR component has moved to
// the new version, components that still ask for the previous version keep getting it from the previous
// instance instead of a mismatch. Requests without a version go to the active instance.
//
// Zero dependencies. Configuration (environment variables):
//   PROXY_PORT=8090  BLUE_URL=http://localhost:8081  GREEN_URL=http://localhost:8080
//   ACTIVE=blue|green (initial)  STATE_FILE=./lts-proxy-state.json  ADMIN_TOKEN=change-me
//
// Admin API (not exposed to the eHR in a real deployment):
//   GET  /admin/status                    active backend + SNOMED CT version of each backend
//   POST /admin/switch?to=green           health + version check, then atomic switch
//   GET  /admin/events                    switch history

import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = process.env;
const PORT = Number(env.PROXY_PORT || 8090);
const STATE_FILE = env.STATE_FILE || fileURLToPath(new URL('./lts-proxy-state.json', import.meta.url));
const ADMIN_TOKEN = env.ADMIN_TOKEN || 'change-me';
const backends = { blue: env.BLUE_URL || 'http://localhost:8081', green: env.GREEN_URL || 'http://localhost:8080' };
let state = { active: env.ACTIVE || 'blue', events: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first start */ }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const counters = { requests: 0, errors: 0, routedByVersion: 0 };
const served = {}; // backend name -> SNOMED CT version URI it serves (refreshed every 30 s, on status and on switch)
async function refreshVersions() {
  for (const i of await Promise.all(Object.keys(backends).map(backendInfo))) served[i.name] = i.healthy ? i.version : null;
}
refreshVersions(); setInterval(refreshVersions, 30000).unref();

/** The SNOMED CT version URI a FHIR request asks for, if any. */
function requestedVersion(url) {
  const q = url.searchParams;
  const v = q.get('system-version') || q.get('systemVersion') || q.get('version');
  if (!v) return null;
  return v.startsWith('http://snomed.info/sct|') ? v.slice('http://snomed.info/sct|'.length) : v;
}

async function backendInfo(name) {
  const base = backends[name];
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/fhir/CodeSystem?url=http://snomed.info/sct`, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(5000) });
    const b = await r.json();
    return { name, url: base, healthy: r.ok, version: b.entry?.[0]?.resource?.version || null, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { name, url: base, healthy: false, version: null, error: e.message };
  }
}

function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); }

async function admin(req, res, url) {
  if (url.pathname === '/admin/status') {
    const info = await Promise.all(Object.keys(backends).map(backendInfo));
    for (const i of info) served[i.name] = i.healthy ? i.version : null;
    return send(res, 200, { active: state.active, activeVersion: info.find((i) => i.name === state.active)?.version, backends: info, counters });
  }
  if (url.pathname === '/admin/events') return send(res, 200, state.events);
  if (url.pathname === '/admin/switch' && req.method === 'POST') {
    if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return send(res, 401, { error: 'admin token required' });
    const to = url.searchParams.get('to');
    if (!backends[to]) return send(res, 400, { error: `unknown backend ${to}` });
    const target = await backendInfo(to);
    const expected = url.searchParams.get('expectVersion');
    if (!target.healthy) return send(res, 409, { error: `backend ${to} is not healthy`, target });
    if (expected && target.version !== expected) return send(res, 409, { error: `backend ${to} runs ${target.version}, expected ${expected}`, target });
    const from = state.active;
    served[to] = target.version;
    state.active = to; // atomic: every request that starts after this line goes to the new backend
    const ev = { at: new Date().toISOString(), from, to, version: target.version };
    state.events.push(ev); save();
    console.log(`[lts-proxy] switched ${from} -> ${to} (${target.version})`);
    return send(res, 200, { switched: ev });
  }
  return send(res, 404, { error: 'unknown admin route' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/admin/')) return admin(req, res, url).catch((e) => send(res, 500, { error: e.message }));
  // chosen once per request: a switch never moves a request that is in flight
  let name = state.active;
  const wanted = requestedVersion(url);
  if (wanted && served[name] !== wanted) {
    const other = Object.keys(backends).find((b) => served[b] === wanted);
    if (other) { name = other; counters.routedByVersion++; }
  }
  const target = new URL(backends[name]);
  counters.requests++;
  const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host, 'x-lts-backend': name } }, (up) => {
    res.writeHead(up.statusCode, { ...up.headers, 'x-lts-backend': name });
    up.pipe(res);
  });
  upstream.on('error', (e) => { counters.errors++; send(res, 502, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'transient', diagnostics: `LTS backend unavailable: ${e.message}` }] }); });
  req.pipe(upstream);
}).listen(PORT, () => console.log(`[lts-proxy] listening on :${PORT}, active = ${state.active} (${backends[state.active]})`));
