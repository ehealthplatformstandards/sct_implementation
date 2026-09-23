// Writes the result of a Demo 1 check as JSON + a self-contained HTML page (no external assets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reports');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Report {
  constructor({ id, title, requirements, intro }) {
    this.id = id; this.title = title; this.requirements = requirements; this.intro = intro;
    this.started = new Date(); this.meta = {}; this.checks = []; this.blocks = [];
  }

  /** Record one check. status: 'pass' | 'fail' | 'warn' | 'info' */
  check({ req, name, detail, expected, actual, status, ms, request }) {
    this.checks.push({ req, name, detail, expected, actual, status, ms, request });
    const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' }[status] || status;
    console.log(`  [${icon}] ${req ? `${req} ` : ''}${name}${actual !== undefined ? ` -> ${typeof actual === 'object' ? JSON.stringify(actual) : actual}` : ''}`);
    return status === 'pass' || status === 'info';
  }

  /** Extra HTML block (already escaped / trusted markup produced by the scripts). */
  block(title, html) { this.blocks.push({ title, html }); }

  get ok() { return this.checks.every((c) => c.status !== 'fail'); }

  write() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const finished = new Date();
    const summary = { pass: 0, fail: 0, warn: 0, info: 0 };
    for (const c of this.checks) summary[c.status] = (summary[c.status] || 0) + 1;
    const data = { id: this.id, title: this.title, requirements: this.requirements, started: this.started, finished, meta: this.meta, summary, ok: this.ok, checks: this.checks, blocks: this.blocks.map((b) => b.title) };
    fs.writeFileSync(path.join(REPORT_DIR, `${this.id}.json`), JSON.stringify(data, null, 2));
    const rows = this.checks.map((c) => `<tr class="${c.status}"><td><span class="st ${c.status}">${c.status.toUpperCase()}</span></td><td>${esc(c.req || '')}</td><td><b>${esc(c.name)}</b>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}${c.request ? `<div class="rq">${esc(c.request)}</div>` : ''}</td><td>${esc(fmt(c.expected))}</td><td>${esc(fmt(c.actual))}</td><td class="num">${c.ms !== undefined ? `${c.ms} ms` : ''}</td></tr>`).join('\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(this.title)}</title>
<style>
body{font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:14px;color:#1f2933;background:#f5f6f8;margin:0}
header{background:#1d4f91;color:#fff;padding:12px 22px}header h1{font-size:18px;margin:0}header .sub{opacity:.85;font-size:12.5px;margin-top:3px}
.disc{background:#fff8d6;border-bottom:1px solid #efe1a0;color:#5c4b00;padding:6px 22px;font-size:12px}
main{padding:16px 22px 40px;max-width:1500px;margin:0 auto}.panel{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:14px 16px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f4;vertical-align:top}
th{background:#f7f8fa;color:#5f6b7a;font-size:12px}.num{text-align:right;white-space:nowrap}.d{color:#5f6b7a;font-size:12px;margin-top:2px}
.rq{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:#3b4a5c;margin-top:3px;word-break:break-all}
.st{font-size:11px;font-weight:700;border-radius:4px;padding:1px 6px}.st.pass{background:#e5f4ec;color:#1e7b4a}.st.fail{background:#fdecea;color:#b3261e}.st.warn{background:#fff4e0;color:#9a5b00}.st.info{background:#e8eff9;color:#1d4f91}
.kv{display:grid;grid-template-columns:230px 1fr;gap:4px 12px;font-size:13px}.kv div:nth-child(odd){color:#5f6b7a}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.badge{display:inline-block;font-size:11px;font-weight:700;color:#6b3fa0;background:#f1eafa;border:1px solid #d8c6ef;border-radius:4px;padding:0 5px;margin-right:4px}
.big{font-size:22px;font-weight:700}.ok{color:#1e7b4a}.bad{color:#b3261e}.warnc{color:#9a5b00}
pre{background:#0f1720;color:#d7e2ee;border-radius:6px;padding:10px 12px;font-size:12px;overflow:auto}
</style></head><body>
<header><h1>${esc(this.title)}</h1><div class="sub">${this.requirements.map((r) => `<span class="badge" style="background:#fff">${esc(r)}</span>`).join('')} Demo 1 · run ${esc(this.started.toISOString().replace('T', ' ').slice(0, 19))} UTC · ${Math.round((finished - this.started) / 1000)} s</div></header>
<div class="disc">Example implementation for discussion - not a normative test suite. SNOMED CT content: SNOMED CT Belgian Edition, © SNOMED International.</div>
<main>
<section class="panel"><div class="kv">${Object.entries(this.meta).map(([k, v]) => `<div>${esc(k)}</div><div class="mono">${esc(fmt(v))}</div>`).join('')}
<div>Result</div><div class="big ${this.ok ? 'ok' : 'bad'}">${this.ok ? 'PASS' : 'FAIL'} <span style="font-size:13px;font-weight:400;color:#5f6b7a">${summary.pass} pass · ${summary.fail} fail · ${summary.warn} warning · ${summary.info} info</span></div></div>
${this.intro ? `<p style="font-size:13px;color:#3b4a5c">${this.intro}</p>` : ''}</section>
${this.blocks.map((b) => `<section class="panel"><h2>${esc(b.title)}</h2>${b.html}</section>`).join('\n')}
<section class="panel"><h2>Checks</h2><table><tr><th>Status</th><th>Req.</th><th>Check</th><th>Expected</th><th>Actual</th><th>Time</th></tr>${rows}</table></section>
</main></body></html>`;
    const file = path.join(REPORT_DIR, `${this.id}.html`);
    fs.writeFileSync(file, html);
    writeIndex();
    console.log(`\n${this.ok ? 'PASS' : 'FAIL'} - report written to ${file}`);
    return file;
  }
}

function fmt(v) { return v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

/** reports/index.html lists every report that has been produced. */
export function writeIndex() {
  const items = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8'))).sort((a, b) => a.id.localeCompare(b.id));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo 1 reports</title><style>body{font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:14px;margin:0;background:#f5f6f8;color:#1f2933}header{background:#1d4f91;color:#fff;padding:12px 22px}main{padding:16px 22px;max-width:1100px}table{border-collapse:collapse;width:100%;background:#fff}th,td{padding:8px 10px;border-bottom:1px solid #eef1f4;text-align:left}th{background:#f7f8fa;color:#5f6b7a;font-size:12px}.ok{color:#1e7b4a;font-weight:700}.bad{color:#b3261e;font-weight:700}</style></head><body>
<header><b>Demo 1 · Terminology services &amp; release management - reports</b></header><main><p>Example checks against the local terminology server. Re-run the scripts in <code>01-terminology-services</code> to refresh.</p>
<table><tr><th>Report</th><th>Requirements</th><th>Result</th><th>Run</th></tr>${items.map((i) => `<tr><td><a href="${i.id}.html">${esc(i.title)}</a></td><td>${i.requirements.join(', ')}</td><td class="${i.ok ? 'ok' : 'bad'}">${i.ok ? 'PASS' : 'FAIL'}</td><td>${esc(String(i.started).slice(0, 19).replace('T', ' '))}</td></tr>`).join('')}</table></main></body></html>`;
  fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), html);
}

export function args(defaults = {}) {
  const out = { ...defaults };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true'; out[k] = v; }
  }
  return out;
}
