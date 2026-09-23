// Per-language word lexicon built from the Belgian Edition release files (RF2 Snapshot).
//
// Why: U01 asks the eHR to understand plural / feminine variants, minor spelling mistakes and
// compound words (decompounding). A FHIR terminology server typically offers prefix, any-order
// matching (and sometimes fuzzy matching) but no language-specific stemming or decompounding.
// This demo therefore adds a small *query rewriting* step in the eHR: it uses the vocabulary of
// the edition itself (every word that occurs in an active description of an active concept) to
//   - check whether a typed token exists (as a word or as the prefix of a word),
//   - find the singular / masculine form of a token (light, rule-based variants),
//   - correct one-edit typos (substitution, insertion, deletion, transposition),
//   - split compound words into constituent words (nl / de).
// The rewritten query is then sent to the terminology server as a normal $expand filter.
//
// This is one possible approach, shown as an example. Search engines with language analysers
// (stemming, dictionary decompounders, fuzzy queries) are an equally valid alternative.

import fs from 'node:fs';
import { findRf2File, streamRf2, RF2 } from '../../shared/rf2.mjs';

/** Lower-case and remove diacritics (the terminology server folds characters in the same way). */
export function fold(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[œ]/g, 'oe').replace(/[æ]/g, 'ae').replace(/ß/g, 'ss');
}
/** Split a (folded) term into word tokens. */
export function words(text) {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean);
}

export class Lexicon {
  constructor(lang) {
    this.lang = lang;
    this.freq = new Map(); // word -> number of descriptions containing it
    this.sorted = [];      // sorted word list, for prefix checks
    this.deletes = null;   // lazily built one-delete index for typo correction
  }

  add(term) {
    for (const w of new Set(words(term))) this.freq.set(w, (this.freq.get(w) || 0) + 1);
  }

  finish() {
    this.sorted = [...this.freq.keys()].sort();
    return this;
  }

  has(w) { return this.freq.has(w); }
  count(w) { return this.freq.get(w) || 0; }

  /** Is `prefix` the beginning of at least one word? (binary search on the sorted list) */
  hasPrefix(prefix) {
    let lo = 0; let hi = this.sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sorted[mid] < prefix) lo = mid + 1; else hi = mid; }
    return lo < this.sorted.length && this.sorted[lo].startsWith(prefix);
  }

  /** Total frequency of the words starting with `prefix` (capped scan, used for scoring). */
  prefixWeight(prefix, cap = 200) {
    let lo = 0; let hi = this.sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sorted[mid] < prefix) lo = mid + 1; else hi = mid; }
    let total = 0;
    for (let i = lo, n = 0; i < this.sorted.length && n < cap && this.sorted[i].startsWith(prefix); i++, n++) total += this.freq.get(this.sorted[i]);
    return total;
  }

  // ---------------------------------------------------------------- typo correction
  buildDeletes(minLength = 4) {
    this.deletes = new Map();
    for (const [w, f] of this.freq) {
      if (w.length < minLength || f < 2 || /\d/.test(w)) continue;
      for (let i = 0; i < w.length; i++) {
        const d = w.slice(0, i) + w.slice(i + 1);
        const list = this.deletes.get(d);
        if (list) { if (list.length < 30) list.push(w); } else this.deletes.set(d, [w]);
      }
    }
  }

  /** Words at Damerau-Levenshtein distance 1 from `token`, most frequent first. */
  corrections(token) {
    if (token.length < 5) return [];
    if (!this.deletes) this.buildDeletes();
    const candidates = new Set();
    const probe = (k) => { for (const w of this.deletes.get(k) || []) candidates.add(w); };
    probe(token);                                               // token has one extra character
    if (this.freq.has(token)) return [];
    for (let i = 0; i < token.length; i++) {
      const d = token.slice(0, i) + token.slice(i + 1);
      probe(d);                                                 // substitution / transposition
      if (this.freq.get(d) >= 2) candidates.add(d);             // token has one character too many
    }
    return [...candidates]
      .filter((w) => w !== token && damerauLevenshtein(w, token) === 1)
      .sort((a, b) => this.count(b) - this.count(a))
      .slice(0, 3);
  }

  // ---------------------------------------------------------------- plural / feminine variants
  /** Candidate base forms of a token (light, rule-based; kept only if the base form is a known word). */
  variants(token) {
    const out = new Set();
    const t = token;
    const add = (w) => { if (w && w.length >= 3 && w !== t && this.freq.get(w) >= 2) out.add(w); };
    if (this.lang === 'nl') {
      if (t.endsWith("'s")) add(t.slice(0, -2));
      if (t.endsWith('s')) add(t.slice(0, -1));                      // infecties -> infectie
      if (t.endsWith('en')) {
        const b = t.slice(0, -2);
        add(b); add(`${b}e`);                                        // ziekten -> ziekte
        const m = /^(.*[^aeiou])([aeiou])([^aeiou])$/.exec(b);        // fracturen -> fractuur
        if (m) add(`${m[1]}${m[2]}${m[2]}${m[3]}`);
        if (/([bcdfgklmnprstvz])\1$/.test(b)) add(b.slice(0, -1));    // wratten -> wrat
        if (b.endsWith('er')) add(b.slice(0, -2));                   // kinderen -> kind
      }
      if (t.endsWith('en') === false && t.endsWith('n') && /[ie]n$/.test(t)) add(t.slice(0, -1));
    } else if (this.lang === 'fr') {
      if (/aux$/.test(t)) add(t.replace(/aux$/, 'al'));              // medicaux -> medical
      if (/[sx]$/.test(t)) add(t.slice(0, -1));                      // fractures -> fracture
      const u = t.replace(/[sx]$/, '');
      const fem = [[/iere$/, 'ier'], [/ere$/, 'er'], [/euse$/, 'eux'], [/euse$/, 'eur'], [/ive$/, 'if'], [/elle$/, 'el'],
        [/enne$/, 'en'], [/ette$/, 'et'], [/ee$/, 'e'], [/ale$/, 'al'], [/aire$/, 'aire'], [/que$/, 'que'], [/e$/, '']];
      for (const [re, rep] of fem) if (re.test(u)) add(u.replace(re, rep));
    } else if (this.lang === 'de') {
      for (const suf of ['en', 'n', 'e', 'er', 's', 'es']) if (t.endsWith(suf)) add(t.slice(0, -suf.length));
    } else {
      if (t.endsWith('ies')) add(`${t.slice(0, -3)}y`);
      if (t.endsWith('ves')) add(`${t.slice(0, -3)}f`);
      if (t.endsWith('es')) add(t.slice(0, -2));
      if (t.endsWith('s')) add(t.slice(0, -1));
    }
    return [...out].sort((a, b) => this.count(b) - this.count(a));
  }

  // ---------------------------------------------------------------- decompounding
  /**
   * Split a compound token into two (or three) known words, e.g. nl "heupprothese" -> ["heup","prothese"].
   * Linking elements (nl "s", "e", "en"; de "s", "n", "en", "es") may join the parts.
   * When `lastTokenPrefix` is true the final part may be the prefix of a word (user still typing).
   */
  decompound(token, { lastTokenPrefix = false, minPart = 3, minTail = 4, depth = 0 } = {}) {
    if (!['nl', 'de'].includes(this.lang) || token.length < minPart + minTail) return null;
    const links = this.lang === 'nl' ? ['', 's', 'e', 'en'] : ['', 's', 'n', 'en', 'es', 'e'];
    const stop = STOPWORDS[this.lang];
    let best = null;
    for (let i = minPart; i <= token.length - minTail; i++) {
      const head = token.slice(0, i); const tail = token.slice(i);
      if (stop.has(tail)) continue;
      for (const link of links) {
        if (link && !head.endsWith(link)) continue;
        // "niersteen": prefer nier + steen over nier + s + teen when the linking letters start a real word
        if (link && this.count(link + tail) >= 1) continue;
        const left = link ? head.slice(0, -link.length) : head;
        if (left.length < minPart || stop.has(left) || this.count(left) < 3) continue;
        let rightParts = null; let rightScore = 0;
        if (this.count(tail) >= 2) { rightParts = [tail]; rightScore = Math.log(1 + this.count(tail)); }
        else if (lastTokenPrefix && this.hasPrefix(tail)) { rightParts = [tail]; rightScore = Math.log(1 + this.prefixWeight(tail)) - 1; }
        else if (depth === 0) {
          const sub = this.decompound(tail, { lastTokenPrefix, minPart, minTail, depth: 1 });
          if (sub) { rightParts = sub.parts; rightScore = sub.score - 1; }
        }
        if (!rightParts) continue;
        // prefer frequent parts and splits without a linking element
        const score = Math.log(1 + this.count(left)) + rightScore - (link ? 1.5 : 0);
        if (!best || score > best.score) best = { parts: [left, ...rightParts], score, link };
      }
    }
    return best;
  }
}

const STOPWORDS = {
  nl: new Set(['van', 'met', 'en', 'de', 'het', 'een', 'bij', 'door', 'voor', 'zonder', 'na', 'in', 'op', 'of', 'aan', 'als', 'uit', 'tot', 'ten', 'ter', 'naar', 'over', 'onder', 'niet', 'geen']),
  de: new Set(['der', 'die', 'das', 'und', 'von', 'mit', 'bei', 'durch', 'fur', 'ohne', 'nach', 'im', 'in', 'an', 'auf', 'aus', 'zum', 'zur', 'des', 'dem', 'den', 'ein', 'eine', 'oder', 'nicht', 'kein']),
};

export function damerauLevenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Build lexicons (and the Description ID index used by U02) from an RF2 Snapshot folder.
 * @returns {Promise<{lexicons: Record<string, Lexicon>, descriptionIndex: DescriptionIndex, stats: object}>}
 */
export async function buildFromRf2(snapshotDir, languages = ['nl', 'fr', 'de', 'en'], log = console.log) {
  const t0 = Date.now();
  const activeConcepts = new Set();
  const [conceptFile] = findRf2File(snapshotDir, /^sct2_Concept_Snapshot.*\.txt$/);
  await streamRf2(conceptFile, (r) => { if (r[2] === '1') activeConcepts.add(r[0]); });
  log(`[lexicon] ${activeConcepts.size} active concepts (${Date.now() - t0} ms)`);
  const lexicons = {}; const descIds = []; const descConcepts = [];
  for (const lang of languages) {
    const lex = new Lexicon(lang);
    const files = findRf2File(snapshotDir, new RegExp(`^sct2_Description_Snapshot-${lang}_.*\\.txt$`));
    for (const f of files) {
      await streamRf2(f, (r) => {
        // id effectiveTime active moduleId conceptId languageCode typeId term caseSignificanceId
        if (r[2] !== '1' || !activeConcepts.has(r[4])) return;
        if (r[6] !== RF2.FSN) lex.add(r[7]);
        descIds.push(BigInt(r[0])); descConcepts.push(BigInt(r[4]));
      });
    }
    lexicons[lang] = lex.finish();
    log(`[lexicon] ${lang}: ${lex.sorted.length} distinct words (${Date.now() - t0} ms)`);
  }
  const descriptionIndex = new DescriptionIndex(descIds, descConcepts);
  log(`[lexicon] description index: ${descriptionIndex.size} active descriptions (${Date.now() - t0} ms)`);
  return { lexicons, descriptionIndex, stats: { ms: Date.now() - t0, activeConcepts: activeConcepts.size } };
}

/** Sorted Description ID -> Concept ID index (BigInt64 arrays keep memory low). U02. */
export class DescriptionIndex {
  constructor(descIds, conceptIds) {
    const order = descIds.map((_, i) => i).sort((a, b) => (descIds[a] < descIds[b] ? -1 : descIds[a] > descIds[b] ? 1 : 0));
    this.ids = BigInt64Array.from(order.map((i) => descIds[i]));
    this.concepts = BigInt64Array.from(order.map((i) => conceptIds[i]));
    this.size = this.ids.length;
  }
  conceptFor(descriptionId) {
    const key = BigInt(descriptionId);
    let lo = 0; let hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ids[mid] === key) return String(this.concepts[mid]);
      if (this.ids[mid] < key) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }
}

/** Optional on-disk cache so the demo starts in seconds after the first run. */
export function saveCache(file, { lexicons, descriptionIndex }) {
  const obj = { v: 1, lexicons: {}, desc: { ids: Buffer.from(descriptionIndex.ids.buffer).toString('base64'), concepts: Buffer.from(descriptionIndex.concepts.buffer).toString('base64') } };
  for (const [k, lex] of Object.entries(lexicons)) obj.lexicons[k] = [...lex.freq];
  fs.writeFileSync(file, JSON.stringify(obj));
}
export function loadCache(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lexicons = {};
  for (const [k, entries] of Object.entries(obj.lexicons)) { const lex = new Lexicon(k); lex.freq = new Map(entries); lexicons[k] = lex.finish(); }
  const di = Object.create(DescriptionIndex.prototype);
  const b1 = Buffer.from(obj.desc.ids, 'base64'); const b2 = Buffer.from(obj.desc.concepts, 'base64');
  di.ids = new BigInt64Array(b1.buffer, b1.byteOffset, b1.length / 8); di.concepts = new BigInt64Array(b2.buffer, b2.byteOffset, b2.length / 8); di.size = di.ids.length;
  return { lexicons, descriptionIndex: di };
}
