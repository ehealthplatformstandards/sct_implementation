// Search & select service of the demo eHR (Demo 2).
//
// Requirements illustrated here:
//   U01  progressive matching, variants, decompounding, multi-prefix any-order, context subsets
//   U02  search by Concept ID / Description ID
//   U03  concept details for hierarchy browsing (parents, children, attributes)
//   U04  search and selection limited to the terminology binding of the data element
//   S03  only active concepts can be selected
//   TSP6 display in the user's language via the Belgian language reference sets
//
// All terminology knowledge comes from the FHIR terminology server (ValueSet/$expand,
// ValueSet/$validate-code, CodeSystem/$lookup). The lexicon is only used to rewrite the query.

import { implicit, SNOMED } from '../../shared/fhir-ts-client.mjs';
import { classifySctid } from '../../shared/sctid.mjs';
import { words } from './lexicon.mjs';

const LANG_OF = (displayLanguage) => displayLanguage.slice(0, 2).toLowerCase();

export class SearchService {
  constructor({ ts, validator, lexicons, descriptionIndex, bindings, minChars = 3, pageSize = 15, autoExtendBelow = 5, fuzzyFallback = true }) {
    // validator: terminology client of the eHR's validation component (validateSelection falls back to ts)
    this.ts = ts; this.validator = validator; this.lexicons = lexicons; this.descriptionIndex = descriptionIndex; this.fuzzyFallback = fuzzyFallback;
    this.bindings = bindings; this.minChars = minChars; this.pageSize = pageSize; this.autoExtendBelow = autoExtendBelow;
  }

  careSet(id) {
    const cs = this.bindings.careSets.find((c) => c.id === id);
    if (!cs) throw new Error(`unknown care set ${id}`);
    return cs;
  }

  context(cs, contextId) {
    if (!cs.contexts?.length || contextId === 'none') return null;
    return cs.contexts.find((c) => c.id === contextId) || cs.contexts.find((c) => c.default) || null;
  }

  static contextEcl(ctx) { return ctx.ecl || `^ ${ctx.refset}`; }

  /** ECL of the data element binding, optionally restricted to a context subset (U01 + U04). */
  eclFor(cs, ctx) {
    const b = `(${cs.binding.ecl})`;
    return ctx ? `${b} AND (${SearchService.contextEcl(ctx)})` : b;
  }

  // ------------------------------------------------------------------ query analysis (U01)
  analyse(text, displayLanguage) {
    const lang = LANG_OF(displayLanguage);
    const lex = this.lexicons?.[lang];
    const tokens = words(text);
    const rewrites = [];
    const alternatives = [];
    if (!lex || !tokens.length) return { tokens, rewrites, alternatives };
    const variantTokens = [...tokens]; const typoTokens = [...tokens]; const compoundTokens = [...tokens];
    let hasVariant = false; let hasTypo = false; let hasCompound = false;
    tokens.forEach((tok, i) => {
      const isLast = i === tokens.length - 1;
      const known = isLast ? lex.hasPrefix(tok) : (lex.has(tok) || lex.hasPrefix(tok));
      if (tok.length >= 4 && !/^\d+$/.test(tok)) {
        const v = lex.variants(tok)[0];
        if (v && !v.startsWith(tok)) { variantTokens[i] = v; hasVariant = true; rewrites.push({ type: 'variant', from: tok, to: v }); }
      }
      if (tok.length >= 7 && known) {
        // split the singular form when there is one (nl "nierstenen" -> "niersteen" -> "nier" + "steen")
        const base = lex.variants(tok)[0] || tok;
        const c = lex.decompound(base, { lastTokenPrefix: isLast && base === tok });
        // only when every part is at least as common as the compound itself ("myocard" is not "myo" + "card")
        const plausible = c && c.parts.length > 1 && Math.min(...c.parts.map((x) => lex.count(x) || lex.prefixWeight(x))) >= lex.count(base);
        if (plausible) { compoundTokens[i] = c.parts.join(' '); hasCompound = true; rewrites.push({ type: 'decompound', from: tok, to: c.parts.join(' + ') }); }
      }
      if (!known && tok.length >= 5) {
        const c = lex.corrections(tok)[0];
        if (c) { typoTokens[i] = c; hasTypo = true; rewrites.push({ type: 'typo', from: tok, to: c }); }
      }
    });
    if (hasVariant) alternatives.push({ via: 'variant', text: variantTokens.join(' ') });
    if (hasCompound) alternatives.push({ via: 'decompound', text: compoundTokens.join(' ') });
    if (hasTypo) alternatives.push({ via: 'typo', text: typoTokens.join(' ') });
    return { tokens, rewrites, alternatives };
  }

  // ------------------------------------------------------------------ main entry point
  async search({ text, careSetId, contextId, displayLanguage = 'nl-BE', extend = false, trace = [] }) {
    const t0 = performance.now();
    const cs = this.careSet(careSetId);
    const ctx = this.context(cs, contextId);
    const q = String(text || '').trim();
    const idInfo = classifySctid(q);
    if (/^\d+$/.test(q)) {
      const res = await this.searchById(q, idInfo, cs, ctx, displayLanguage, trace);
      return { ...res, serverMs: Math.round(performance.now() - t0), trace };
    }
    if (q.replace(/\s+/g, '').length < this.minChars) {
      return { mode: 'too-short', minChars: this.minChars, sections: [], serverMs: 0, trace };
    }
    const analysis = this.analyse(q, displayLanguage);
    const tiers = [];
    if (ctx) tiers.push({ id: 'context', label: ctx.label, ecl: this.eclFor(cs, ctx), refset: ctx.refset });
    // The context subset is only a preference: the user may always widen the search to everything the
    // binding of the data element permits (U01). Nothing outside the binding is ever offered (U04).
    const mayExtend = Boolean(ctx);
    const broader = { id: 'broader', label: `All concepts permitted by the binding (${cs.binding.source})`, ecl: this.eclFor(cs, null) };
    if (!ctx) tiers.push(broader);

    const runTier = async (tier) => {
      const queries = [{ via: 'typed', text: q }, ...analysis.alternatives];
      const results = await Promise.all(queries.map((qq) => this.expandTier(tier, qq, displayLanguage, trace).catch((e) => ({ error: e.message, items: [], total: 0, via: qq.via }))));
      const merged = new Map();
      let total = 0;
      for (const r of results) {
        if (r.via === 'typed') total = r.total ?? 0;
        for (const it of r.items) {
          if (!merged.has(it.code)) merged.set(it.code, { ...it, via: [r.via] });
          else if (!merged.get(it.code).via.includes(r.via)) merged.get(it.code).via.push(r.via);
        }
      }
      // Ranking (U01 "relevant result ranking"), applied to the page returned by the server:
      //   1. concepts matched by the typed text before concepts found only through a rewritten query;
      //   2. concepts with a term in the user's language that contains every search word before concepts
      //      that the server matched on another description only (e.g. "pro" in the FSN tag "(procedure)");
      //   3. the matched term equals the query, then the matched term starts with the query;
      //   4. fewer words, then shorter terms; the server's own order breaks the remaining ties (stable sort).
      const fold = (x) => words(x).join(' ');
      const key = (it) => {
        const typed = it.via.includes('typed');
        const qf = fold(typed ? q : (analysis.alternatives.find((a) => it.via.includes(a.via))?.text || q));
        const tf = fold(it.term);
        return [typed ? 0 : 1, it.covered ? 0 : 1, tf === qf ? 0 : 1, tf.startsWith(qf) ? 0 : 1, tf.split(' ').length, tf.length];
      };
      const cmp = (a, b) => { const ka = key(a); const kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; };
      const items = [...merged.values()].sort(cmp);
      return { ...tier, total, items: items.slice(0, this.pageSize * 2), errors: results.filter((r) => r.error).map((r) => r.error) };
    };

    const sections = [];
    for (const tier of tiers) sections.push(await runTier(tier));
    const contextCount = sections[0]?.items.length ?? 0;
    const autoExtended = ctx && mayExtend && !extend && contextCount < this.autoExtendBelow;
    if (ctx && mayExtend && (extend || autoExtended)) {
      const b = await runTier(broader);
      const seen = new Set(sections[0].items.map((i) => i.code));
      b.items = b.items.filter((i) => !seen.has(i.code));
      b.autoExtended = autoExtended;
      sections.push(b);
    }
    // Last resort for spelling mistakes the lexicon cannot fix (more than one edit): the server's own
    // fuzzy matching (Snowstorm / Snowstorm Lite: a trailing "~" in the filter, max. 2 edits per word).
    let fuzzy = false;
    if (sections.every((s) => s.items.length === 0) && this.fuzzyFallback) {
      fuzzy = true;
      const fq = { via: 'fuzzy', text: `${q}~` };
      const seen = new Set();
      for (const s of sections) {
        const r = await this.expandTier(s, fq, displayLanguage, trace).catch(() => ({ items: [] }));
        s.items = r.items.filter((it) => !seen.has(it.code)).map((it) => ({ ...it, via: ['fuzzy'] })); // the broader tier repeats nothing of the context tier
        for (const it of s.items) seen.add(it.code);
      }
      if (fuzzy) analysis.rewrites.push({ type: 'fuzzy', from: q, to: `${q}~ (server-side fuzzy match)` });
    }
    return {
      mode: 'text', query: q, analysis, fuzzy, careSet: { id: cs.id, label: cs.label, strength: cs.strength, binding: cs.binding },
      context: ctx, canExtend: Boolean(ctx && mayExtend), extended: sections.length > 1, sections,
      serverMs: Math.round(performance.now() - t0), trace,
    };
  }

  async expandTier(tier, query, displayLanguage, trace) {
    const res = await this.ts.expand({
      url: implicit.ecl(tier.ecl), filter: query.text, count: this.pageSize, displayLanguage, includeDesignations: true, trace,
    });
    const lang = LANG_OF(displayLanguage);
    const qTokens = words(query.text);
    const items = res.contains.map((c) => {
      const matched = bestMatchingDesignation(c, lang, qTokens);
      const fsn = (c.designation || []).find((d) => d.use?.code === '900000000000003001')?.value;
      return {
        code: c.code, system: c.system || SNOMED, pt: c.display,
        // covered = a term in the user's language contains every search word (not only the FSN, e.g. its semantic tag)
        term: matched || c.display, covered: Boolean(matched), semanticTag: fsn ? (/\(([^()]+)\)\s*$/.exec(fsn)?.[1] || '') : '',
      };
    });
    return { via: query.via, total: res.total, items };
  }

  // ------------------------------------------------------------------ U02
  async searchById(q, idInfo, cs, ctx, displayLanguage, trace) {
    if (!idInfo.valid) return { mode: 'id', query: q, idInfo, sections: [], message: `Not a valid SNOMED CT identifier (${idInfo.reason}).` };
    let conceptId = q; let via = 'Concept ID';
    if (idInfo.kind === 'description') {
      via = 'Description ID';
      // Description IDs cannot be resolved through the FHIR R4 terminology operations: the demo uses
      // an index built from the RF2 description file (build-lexicon.mjs / build_lexicon.py).
      if (!this.descriptionIndex) return { mode: 'id', query: q, idInfo, sections: [], message: 'Description ID search needs the RF2 description index; build the lexicon first.' };
      conceptId = this.descriptionIndex.conceptFor(q);
      if (!conceptId) return { mode: 'id', query: q, idInfo, sections: [], message: `Description ID ${q} is not an active description in the loaded edition.` };
    } else if (idInfo.kind !== 'concept') {
      return { mode: 'id', query: q, idInfo, sections: [], message: `This is a ${idInfo.kind} identifier, not a concept or description.` };
    }
    let lookup;
    try { lookup = await this.ts.lookup({ code: conceptId, displayLanguage, property: ['inactive'], trace }); } catch (e) {
      return { mode: 'id', query: q, idInfo, sections: [], message: `Concept ${conceptId} not found in the loaded edition.` };
    }
    const validation = await this.validateSelection({ code: conceptId, careSetId: cs.id, displayLanguage, trace });
    const fsn = lookup.designation.find((d) => d.use?.code === '900000000000003001')?.value;
    return {
      mode: 'id', query: q, idInfo, via,
      sections: [{ id: 'id', label: `Found by ${via}`, items: [{ code: conceptId, pt: lookup.display, term: lookup.display, semanticTag: fsn ? (/\(([^()]+)\)\s*$/.exec(fsn)?.[1] || '') : '', via: [via], selectable: validation.valid, reason: validation.reason }] }],
    };
  }

  // ------------------------------------------------------------------ U04 + S03 (+ U07/U08 reuse)
  /** The one validation rule used for every way of entering a code (search, ID, favourite, NLP suggestion). */
  async validateSelection({ code, careSetId, display, displayLanguage = 'nl-BE', trace = [] }) {
    const cs = this.careSet(careSetId);
    const out = { code, careSetId, valid: false };
    const ts = this.validator || this.ts;
    const inBinding = await ts.validateInValueSet({ url: implicit.ecl(cs.binding.ecl), code, display, displayLanguage, trace });
    // A server may report a reference set member as valid while flagging it inactive: S03 forbids it.
    if (inBinding.result === true && inBinding.inactive === true) {
      out.display = inBinding.display; out.inactive = true; out.reason = 'Inactive concept - cannot be recorded (S03)';
      return out;
    }
    if (inBinding.result === true) {
      out.valid = true; out.display = inBinding.display; out.reason = 'Active concept permitted by the binding';
      return out;
    }
    // Explain why: unknown, inactive, or simply outside the binding?
    try {
      const lk = await ts.lookup({ code, displayLanguage, property: ['inactive'], trace });
      out.display = lk.display;
      const inactive = lk.prop('inactive')[0] === true;
      out.reason = inactive ? 'Inactive concept - cannot be recorded (S03)' : `Not permitted by the binding of ${cs.label} (U04)`;
      out.inactive = inactive;
    } catch {
      out.reason = 'Unknown concept identifier';
    }
    return out;
  }

  // ------------------------------------------------------------------ U03
  async conceptDetails({ code, careSetId, displayLanguage = 'nl-BE', trace = [] }) {
    const cs = this.careSet(careSetId);
    const lk = await this.ts.lookup({ code, displayLanguage, property: ['parent', 'child', 'inactive', 'sufficientlyDefined', 'normalFormTerse', 'normalForm', 'effectiveTime', 'moduleId'], trace });
    const parents = lk.prop('parent').map(String);
    const children = lk.prop('child').map(String);
    // Defining attributes come from the (inferred) normal form, e.g. ===parents:{363698007=74281007,...}
    const nf = parseNormalForm(lk.prop('normalFormTerse')[0] || '');
    const names = namesFromNormalForm(lk.prop('normalForm')[0] || '');
    const shownChildren = children.slice(0, 60);
    const related = [...new Set([...parents, ...shownChildren, ...nf.attributes.flatMap((a) => [a.type, a.value])].filter((x) => /^\d{6,18}$/.test(x)))];
    // One $expand returns the displays of the related concepts, a second one tells which of them the
    // binding of the current data element permits (only those can be selected, U04).
    const selectable = new Set();
    if (related.length) {
      const list = related.join(' OR ');
      const [all, allowed] = await Promise.all([
        this.ts.expand({ url: implicit.ecl(list), count: related.length, displayLanguage, trace }),
        this.ts.expand({ url: implicit.ecl(`(${list}) AND (${cs.binding.ecl})`), count: related.length, displayLanguage, trace }),
      ]);
      for (const c of all.contains) names[c.code] = c.display;
      for (const c of allowed.contains) selectable.add(c.code);
    }
    const fsn = lk.designation.find((d) => d.use?.code === '900000000000003001')?.value;
    const node = (id) => ({ code: id, display: names[id] || id, selectable: selectable.has(id) });
    const self = await this.validateSelection({ code, careSetId, displayLanguage, trace });
    return {
      code, display: lk.display, fsn, version: lk.version,
      inactive: lk.prop('inactive')[0] === true, sufficientlyDefined: lk.prop('sufficientlyDefined')[0] === true,
      effectiveTime: lk.prop('effectiveTime')[0], moduleId: lk.prop('moduleId')[0],
      designations: lk.designation.filter((d) => d.language && d.value).map((d) => ({ language: d.language, use: d.use?.display || d.use?.code, value: d.value })),
      parents: parents.map(node), children: shownChildren.map(node), childCount: children.length,
      attributes: nf.attributes.map((a) => ({ group: a.group, type: node(a.type), value: /^\d+$/.test(a.value) ? node(a.value) : { code: a.value, display: a.value, selectable: false } })),
      selectable: self.valid, selectableReason: self.reason,
      trace,
    };
  }
}

/** Parse Snowstorm-style terse normal form: "===p1,p2:a=b,{c=d,e=f}" (=== fully defined, <<< primitive). */
export function parseNormalForm(terse) {
  const m = /^(===|<<<)\s*([^:]*)(?::(.*))?$/.exec(terse.trim());
  if (!m) return { definitionStatus: null, parents: [], attributes: [] };
  const items = []; let depth = 0; let cur = '';
  for (const ch of m[3] || '') {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) items.push(cur);
  const attributes = []; let group = 0;
  for (const item of items) {
    if (item.startsWith('{')) {
      group++;
      for (const pair of item.slice(1, -1).split(',')) { const [type, value] = pair.split('='); attributes.push({ group, type, value }); }
    } else { const [type, value] = item.split('='); attributes.push({ group: 0, type, value }); }
  }
  return { definitionStatus: m[1] === '===' ? 'fully defined' : 'primitive', parents: m[2].split(',').filter(Boolean), attributes };
}

/** Collect "id|term|" pairs from the long normal form (terms are in the display language). */
export function namesFromNormalForm(nf) {
  const out = {};
  for (const m of nf.matchAll(/(\d{6,18})\|([^|]*)\|/g)) out[m[1]] = m[2];
  return out;
}

/** Pick the designation, in the user's language, that matches all typed tokens (prefix, any order). U06. */
export function bestMatchingDesignation(concept, lang, qTokens) {
  const cands = (concept.designation || []).filter((d) => (d.language || '').slice(0, 2) === lang && d.use?.code !== '900000000000003001');
  const matches = cands.filter((d) => {
    const w = words(d.value);
    return qTokens.every((t) => w.some((x) => x.startsWith(t)));
  });
  matches.sort((a, b) => a.value.length - b.value.length);
  return matches[0]?.value || null;
}
