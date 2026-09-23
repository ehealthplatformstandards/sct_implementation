// U08 - integration of a tool that analyses clinical text and proposes SNOMED CT concepts.
//
// The eHR talks to the tool through a small HTTP/JSON contract (example contract, not a standard):
//
//   POST {SUGGEST_SERVICE_URL}
//   { "text": "...", "language": "nl-BE", "careSet": "problem" }
//   -> { "service": "...", "candidates": [ { "start": 12, "end": 22, "text": "hypertensie",
//          "conceptId": "38341003", "term": "hypertensie", "confidence": 0.9, "negated": false } ] }
//
// Whatever tool is plugged in (a hospital NLP pipeline, a commercial coding assistant, an LLM
// service ...), the eHR:
//   - only shows the candidates as suggestions (nothing is recorded without explicit confirmation),
//   - runs the normal validation (active concept + binding of the data element) before recording,
//   - shows the Concept ID and a description for every suggestion.
//
// `ReferenceTextAnalyser` below is a deliberately naive stand-in that implements the same contract
// with dictionary look-ups on the terminology server. It exists only to make the demo self-contained.

import { implicit } from '../../shared/fhir-ts-client.mjs';
import { words } from './lexicon.mjs';

const NEGATION = { nl: ['geen', 'niet', 'zonder', 'uitgesloten'], fr: ['pas', 'sans', 'aucun', 'aucune', 'exclu'], de: ['kein', 'keine', 'ohne', 'nicht'], en: ['no', 'without', 'denies', 'not'] };
const STOP = new Set(['en', 'van', 'de', 'het', 'een', 'met', 'op', 'in', 'sinds', 'dagen', 'jaar', 'et', 'de', 'la', 'le', 'les', 'des', 'du', 'avec', 'depuis', 'und', 'der', 'die', 'das', 'mit', 'seit', 'and', 'the', 'of', 'with', 'since', 'patient', 'patiente', 'patiënt', 'patiënte', 'gekende', 'klinisch', 'beeld', 'bekannte', 'connu', 'connue']);

export class ReferenceTextAnalyser {
  constructor({ ts, bindings, maxNgram = 5 }) { this.ts = ts; this.bindings = bindings; this.maxNgram = maxNgram; }

  async analyse({ text, language = 'nl-BE', careSet = 'problem' }) {
    const cs = this.bindings.careSets.find((c) => c.id === careSet);
    const lang = language.slice(0, 2);
    // word tokens with character offsets
    const toks = [];
    for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) toks.push({ w: words(m[0])[0] || m[0].toLowerCase(), start: m.index, end: m.index + m[0].length, raw: m[0] });
    const sentenceStart = (i) => { let j = i; while (j > 0 && !/[.;\n]/.test(text.slice(toks[j - 1].end, toks[j].start))) j--; return j; };
    const used = new Array(toks.length).fill(false);
    const candidates = [];
    for (let n = this.maxNgram; n >= 1; n--) {
      for (let i = 0; i + n <= toks.length; i++) {
        if (used.slice(i, i + n).some(Boolean)) continue;
        const span = toks.slice(i, i + n);
        const edge = (w) => STOP.has(w) || NEGATION[lang]?.includes(w); // a phrase never starts or ends with a stop word or a negation cue
        if (edge(span[0].w) || edge(span[n - 1].w) || (n === 1 && span[0].w.length < 5)) continue;
        const phrase = span.map((t) => t.w).join(' ');
        const res = await this.ts.expand({ url: implicit.ecl(cs.binding.ecl), filter: phrase, count: 5, displayLanguage: language, includeDesignations: true });
        const best = pickBest(res.contains, lang, span.map((t) => t.w));
        if (!best) continue;
        for (let k = i; k < i + n; k++) used[k] = true;
        const s0 = sentenceStart(i);
        const negated = toks.slice(s0, i).some((t) => NEGATION[lang]?.includes(t.w));
        candidates.push({ start: span[0].start, end: span[n - 1].end, text: text.slice(span[0].start, span[n - 1].end), conceptId: best.code, term: best.term, pt: best.display, confidence: best.score, negated });
      }
    }
    candidates.sort((a, b) => a.start - b.start);
    return { service: 'demo reference text analyser (dictionary look-up, not a real NLP engine)', language, careSet, candidates };
  }
}

/** Accept a result only when one of its designations covers the phrase closely. */
function pickBest(contains, lang, phraseWords) {
  let best = null;
  for (const c of contains) {
    for (const d of c.designation || []) {
      if ((d.language || '').slice(0, 2) !== lang || d.use?.code === '900000000000003001') continue;
      const dw = words(d.value);
      // every word of the phrase must match a word of the description: exactly, or with a short inflection (knie/knieën)
      const close = (x, w) => x === w || (x.startsWith(w) && x.length - w.length <= 2) || (w.startsWith(x) && w.length - x.length <= 2);
      const covered = phraseWords.every((w) => dw.some((x) => close(x, w)));
      if (!covered) continue;
      const score = Math.round((phraseWords.length / Math.max(dw.length, phraseWords.length)) * 100) / 100;
      if (score >= 0.6 && (!best || score > best.score || (score === best.score && d.value.length < best.term.length))) best = { code: c.code, term: d.value, display: c.display, score };
    }
  }
  return best;
}

/** eHR-side adapter: calls the configured tool over HTTP (the contract above). */
export async function callSuggestionService(url, payload, trace) {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  trace?.push({ op: 'text analysis service', method: 'POST', url, status: res.status, ms: Math.round(performance.now() - t0) });
  if (!res.ok) throw new Error(json?.error || `suggestion service returned HTTP ${res.status}`);
  return json;
}
