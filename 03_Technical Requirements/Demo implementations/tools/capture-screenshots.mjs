// Re-creates the screenshots used in the per-requirement documentation (developer tool).
//
//   cd tools && npm install        (installs Playwright; not needed to run the demos themselves)
//   node capture-screenshots.mjs before     -> while the July 2026 edition is in production
//   node capture-screenshots.mjs demo1      -> Demo 1 HTML reports
//   node capture-screenshots.mjs python     -> the reports written by the Python scripts (read from disk)
//   node capture-screenshots.mjs python-ui  -> Demo 2 served by python/serve_demo2.py (PY_EHR_URL, default :3100)
//   node capture-screenshots.mjs after      -> after the upgrade to the September 2026 edition
//   node capture-screenshots.mjs after '^u01' -> only the shots whose name matches the regular expression
//
// Environment: EHR_URL (default http://localhost:3000), EHR_MISMATCH_URL (second eHR instance used for
// the TSP5 inconsistency screenshot, default http://localhost:3001).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'screenshots');
const BASE = process.env.EHR_URL || 'http://localhost:3000';
const BASE2 = process.env.EHR_MISMATCH_URL || 'http://localhost:3001';
fs.mkdirSync(OUT, { recursive: true });
const PY_REPORTS = `file://${path.join(HERE, '..', 'python', 'reports')}`;
const PY_EHR = process.env.PY_EHR_URL || 'http://localhost:3100';
const phase = process.argv[2] || 'after';
const only = process.argv[3];

const wait = (page, ms) => page.waitForTimeout(ms);
async function search(page, text, { settle = 1400 } = {}) {
  const input = page.locator('#picker input.search-input');
  await input.fill('');
  await input.type(text, { delay: 60 });
  await wait(page, settle);
  await page.waitForSelector('#picker .timing b', { timeout: 15000 }).catch(() => {});
}
async function careSet(page, label) { await page.locator('#caresets button', { hasText: label }).click(); await wait(page, 600); }

const SHOTS = {
  before: [
    { name: 's04-before-upgrade-record', url: '/record.html?patient=pat-001&tab=summary&lang=nl-BE', full: true, wait: 3000 },
    { name: 'u07-favourites-before-upgrade', url: '/search.html?lang=nl-BE', el: '#fav-panel', wait: 2500 },
    { name: 'tsp5-versions-before-upgrade', url: '/index.html?lang=nl-BE', el: '#version-panel', wait: 2500 },
  ],
  demo1: [
    { name: 'tsp3-release-currency-before-upgrade', url: '/demo1/tsp3-release-currency-before-upgrade.html', full: true, width: 1300 },
    { name: 'tsp3-release-currency-after-upgrade', url: '/demo1/tsp3-release-currency-after-upgrade.html', full: true, width: 1300 },
    { name: 'tsp4-controlled-deployment-report', url: '/demo1/tsp4-controlled-deployment.html', full: true, width: 1300 },
    { name: 'tsp5-version-consistency-report', url: '/demo1/tsp5-version-consistency.html', full: true, width: 1300 },
    { name: 'tsp5-version-consistency-mismatch-report', url: '/demo1/tsp5-version-consistency-mismatch.html', full: true, width: 1300 },
    { name: 'demo1-report-index', url: '/demo1/index.html', full: true, width: 1100 },
    // the checks of one requirement only (rows of the other requirements hidden), for the per-requirement pages
    ...['TSP1', 'TSP2', 'TSP6'].map((rq) => ({ name: `${rq.toLowerCase()}-checks`, url: '/demo1/tsp1-tsp2-tsp6-conformance.html', width: 1300, el: 'section.panel:last-of-type',
      do: async (p) => { await p.evaluate((r) => { for (const tr of document.querySelectorAll('section.panel:last-of-type tr')) { const c = tr.children[1]; if (c && c.tagName === 'TD' && !c.textContent.split(/\s+/).includes(r)) tr.style.display = 'none'; } }, rq); } })),
  ],
  // Demo 2 served by the Python server (python/serve_demo2.py), default http://localhost:3100
  'python-ui': [
    { name: 'python-demo2-search', url: '/search.html?lang=nl-BE', base: PY_EHR, full: true, wait: 2500,
      do: async (p) => { await search(p, 'hypertensei'); await p.locator('#picker .result .actions button', { hasText: '\u2605' }).first().click(); await wait(p, 1200); } },
    { name: 'python-demo2-overview', url: '/index.html?lang=nl-BE', base: PY_EHR, full: true, wait: 2500 },
  ],
  // The Python scripts write their own reports; these are read straight from disk (file://).
  python: [
    { name: 'python-tsp1-tsp2-tsp6-report', url: '/tsp1-tsp2-tsp6-conformance-python.html', base: PY_REPORTS, width: 1300, height: 760 },
    { name: 'python-tsp3-release-currency-report', url: '/tsp3-release-currency-python.html', base: PY_REPORTS, full: true, width: 1300 },
  ],
  after: [
    { name: 'overview', url: '/index.html?lang=nl-BE', full: true, wait: 2500 },
    { name: 'tsp5-versions-after-upgrade', url: '/index.html?lang=nl-BE', el: '#version-panel', wait: 2500 },
    { name: 'tsp5-versions-mismatch', base: BASE2, url: '/index.html?lang=nl-BE', el: '#version-panel', wait: 2500 },
    { name: 'u01-decompounding-nl', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'femurfractuur'); }, el: '#entry-panel' },
    { name: 'u01-typo-nl', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'hypertensei', { settle: 2200 }); }, el: '#entry-panel' },
    { name: 'u01-fuzzy-nl', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'pneunomie', { settle: 2200 }); }, el: '#entry-panel' },
    { name: 'u01-plural-nl', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'nierstenen'); }, el: '#entry-panel' },
    { name: 'u01-feminine-fr', url: '/search.html?lang=fr-BE&careSet=problem', do: async (p) => { await search(p, 'calcul rénale'); }, el: '#entry-panel' },
    { name: 'u01-decompounding-de', url: '/search.html?lang=de-BE&careSet=problem', do: async (p) => { await search(p, 'Darmentzündung'); }, el: '#entry-panel' },
    { name: 'u01-any-order-en', url: '/search.html?lang=en-US&careSet=problem', do: async (p) => { await search(p, 'cancer skin'); }, el: '#entry-panel' },
    { name: 'u01-any-order-prefix-en', url: '/search.html?lang=en-US&careSet=procedure', do: async (p) => { await search(p, 'pro hip'); }, el: '#entry-panel' },
    { name: 'u01-context-subset', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await p.selectOption('#context-row select', 'cardio'); await search(p, 'hartfal'); }, el: '#entry-panel' },
    { name: 'u01-context-extended', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await p.selectOption('#context-row select', 'cardio'); await search(p, 'bronchitis', { settle: 1800 }); }, el: '#entry-panel' },
    { name: 'u01-response-time', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { for (const t of ['astma', 'diabetes', 'hartfalen', 'hypertensie', 'migraine', 'depressie', 'copd', 'artrose', 'jicht', 'anemie', 'obesitas', 'epilepsie', 'psoriasis', 'eczeem', 'nierinsufficientie', 'pneumonie', 'bronchitis', 'sinusitis', 'cystitis', 'angina pectoris']) await search(p, t, { settle: 900 }); }, el: '#timing-panel' },
    { name: 'u02-concept-id', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, '22298006'); }, el: '#entry-panel' },
    { name: 'u02-description-id', url: '/search.html?lang=fr-BE&careSet=problem', do: async (p) => { await search(p, '6281000172111'); }, el: '#entry-panel' },
    { name: 'u03-hierarchy', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'myocardinfarct'); await p.locator('#picker .result').first().locator('button', { hasText: 'ⓘ' }).click(); await wait(p, 1500); }, el: '#details-panel' },
    { name: 'tsp6-languages-fr', url: '/search.html?lang=fr-BE&careSet=problem', do: async (p) => { await search(p, 'infarctus myocarde'); await p.locator('#picker .result').first().locator('button', { hasText: 'ⓘ' }).click(); await wait(p, 1500); }, full: true },
    { name: 'tsp6-search-de', url: '/search.html?lang=de-BE&careSet=problem', do: async (p) => { await search(p, 'Herzinsuff'); }, el: '#entry-panel' },
    { name: 'u04-binding-vaccination', url: '/search.html?lang=nl-BE&careSet=vaccination', do: async (p) => { await careSet(p, 'Vaccination'); await search(p, 'mazelen'); }, el: '#entry-panel' },
    { name: 'u04-not-in-binding', url: '/search.html?lang=nl-BE&careSet=vaccination', do: async (p) => { await careSet(p, 'Vaccination'); await search(p, '195967001'); }, el: '#entry-panel' },
    { name: 's03-inactive-concept', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, '111360009'); }, el: '#entry-panel' },
    { name: 'u05-free-text', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'klachten na blootstelling PFAS', { settle: 2200 }); await p.locator('button', { hasText: 'No suitable concept' }).click(); await wait(p, 600); }, el: '#entry-panel' },
    { name: 'u06-selected-term', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'hartinfarct'); await p.locator('#picker .result').first().click(); await wait(p, 1200); }, el: '#entry-panel' },
    { name: 's02-context-fields', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await search(p, 'fractuur femurhals'); await p.locator('#picker .result').first().click(); await wait(p, 1200); await p.locator('#selection select').nth(3).selectOption({ index: 1 }); }, el: '#selection' },
    { name: 'u07-favourites-after-upgrade', url: '/search.html?lang=nl-BE', el: '#fav-panel', wait: 2500 },
    { name: 'u08-text-analysis', url: '/search.html?lang=nl-BE&careSet=problem', do: async (p) => { await p.locator('#nlp-panel button', { hasText: 'Analyse text' }).click(); await p.waitForSelector('#nlp-panel .suggestion', { timeout: 30000 }); await wait(p, 500); }, el: '#nlp-panel' },
    { name: 'u08-text-analysis-fr', url: '/search.html?lang=fr-BE&careSet=problem', do: async (p) => { await p.locator('#nlp-panel button', { hasText: 'Analyse text' }).click(); await p.waitForSelector('#nlp-panel .suggestion', { timeout: 30000 }); await wait(p, 500); }, el: '#nlp-panel' },
    { name: 'tsp7-feedback-dialog', url: '/search.html?lang=nl-BE&careSet=allergy', do: async (p) => { await careSet(p, 'Allergy'); await search(p, 'penicilinne'); await p.evaluate(() => window.openFeedback({ kind: 'missing-translation', searchText: 'penicilinne', code: '764146007' })); await p.locator('dialog textarea').fill('Preferred term nl-BE of 764146007 is spelled "penicilinne"; expected "penicilline" (the synonym is spelled correctly).'); await p.locator('dialog button', { hasText: 'Prepare for the NRC portal' }).click(); await wait(p, 800); }, el: 'dialog' },
    { name: 'tsp7-feedback-queue', url: '/record.html?tab=feedback&lang=nl-BE', do: async () => {}, el: '#tab-content', wait: 1500 },
    { name: 's01-stored-rows', url: '/record.html?patient=pat-002&tab=stored&lang=nl-BE', full: true, wait: 2000 },
    { name: 's04-release-impact', url: '/record.html?patient=pat-001&tab=upgrade&lang=nl-BE', do: async (p) => { await p.locator('button', { hasText: 'Run release impact analysis' }).click(); await p.waitForSelector('.toast', { timeout: 30000 }); await wait(p, 1200); }, full: true, wait: 2500 },
    { name: 's04-after-upgrade-record', url: '/record.html?patient=pat-001&tab=summary&lang=nl-BE', full: true, wait: 3000 },
    { name: 's04-after-upgrade-record-child', url: '/record.html?patient=pat-002&tab=summary&lang=nl-BE', full: true, wait: 3000 },
    { name: 's02-context-record-fr', url: '/record.html?patient=pat-003&tab=summary&lang=fr-BE', full: true, wait: 3000 },
    { name: 's05-classification-legacy', url: '/record.html?patient=pat-001&tab=classifications&lang=nl-BE', full: true, wait: 3000 },
    { name: 's05-classification-child', url: '/record.html?patient=pat-002&tab=classifications&lang=nl-BE', full: true, wait: 3000 },
    { name: 's05-classification-adult', url: '/record.html?patient=pat-003&tab=classifications&lang=fr-BE', full: true, wait: 3000 },
    { name: 's06-report-attribute', url: '/record.html?tab=reports&report=heart&lang=nl-BE', full: true, wait: 3000 },
    { name: 's06-report-bacterial', url: '/record.html?tab=reports&report=bacterial&lang=nl-BE', full: true, wait: 3000 },
    { name: 's06-report-legacy', url: '/record.html?tab=reports&report=epilepsy&history=true&lang=nl-BE', full: true, wait: 3000 },
    { name: 's06-report-current-only', url: '/record.html?tab=reports&report=epilepsy&history=false&lang=nl-BE', full: true, wait: 3000 },
    { name: 'i01-i02-fhir-export', url: '/record.html?patient=pat-003&tab=fhir&lang=fr-BE', full: true, wait: 3000, height: 1800 },
  ],
};

const browser = await chromium.launch();
for (const s of SHOTS[phase]) {
  if (only && !new RegExp(only).test(s.name)) continue;
  const page = await browser.newPage({ viewport: { width: s.width || 1440, height: s.height || 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${s.base || BASE}${s.url}`);
  await wait(page, s.wait || 1500);
  if (s.do) await s.do(page);
  const file = path.join(OUT, `${s.name}.png`);
  if (s.el) await page.locator(s.el).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: Boolean(s.full) });
  console.log(`${errors.length ? 'WARN' : 'ok  '} ${s.name}.png ${errors.join(' | ')}`);
  await page.close();
}
await browser.close();
