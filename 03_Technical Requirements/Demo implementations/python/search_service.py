"""Search & select service (Demo 2) - Python counterpart of ``ehr-demo-app/lib/search-service.mjs``.

Requirements illustrated here:
    U01  progressive matching, variants, decompounding, multi-prefix any-order, context subsets
    U02  search by Concept ID / Description ID
    U03  concept details for hierarchy browsing (parents, children, attributes)
    U04  search and selection limited to the terminology binding of the data element
    S03  only active concepts can be selected
    TSP6 display in the user's language via the Belgian language reference sets

All terminology knowledge comes from the FHIR terminology server (ValueSet/$expand,
ValueSet/$validate-code, CodeSystem/$lookup). The lexicon is only used to rewrite the query.
"""

import re
import time
from concurrent.futures import ThreadPoolExecutor

from fhir_ts import FhirError, implicit_ecl
from lexicon import words
from sctid import classify_sctid

FSN = '900000000000003001'
_POOL = ThreadPoolExecutor(max_workers=8)


def lang_of(display_language):
    return (display_language or 'nl-BE')[:2].lower()


def parse_normal_form(terse):
    """Parse a Snowstorm-style terse normal form: "===p1,p2:a=b,{c=d,e=f}" (=== defined, <<< primitive)."""
    m = re.match(r'^(===|<<<)\s*([^:]*)(?::(.*))?$', (terse or '').strip())
    if not m:
        return {'definitionStatus': None, 'parents': [], 'attributes': []}
    items = []
    depth = 0
    cur = ''
    for ch in m.group(3) or '':
        if ch == '{':
            depth += 1
        if ch == '}':
            depth -= 1
        if ch == ',' and depth == 0:
            items.append(cur)
            cur = ''
        else:
            cur += ch
    if cur:
        items.append(cur)
    attributes = []
    group = 0
    for item in items:
        if item.startswith('{'):
            group += 1
            for pair in item[1:-1].split(','):
                t, _, v = pair.partition('=')
                attributes.append({'group': group, 'type': t, 'value': v})
        else:
            t, _, v = item.partition('=')
            attributes.append({'group': 0, 'type': t, 'value': v})
    return {'definitionStatus': 'fully defined' if m.group(1) == '===' else 'primitive',
            'parents': [p for p in m.group(2).split(',') if p], 'attributes': attributes}


def names_from_normal_form(nf):
    """Collect "id|term|" pairs from the long normal form (terms are in the display language)."""
    return {m.group(1): m.group(2) for m in re.finditer(r'(\d{6,18})\|([^|]*)\|', nf or '')}


def semantic_tag(concept_or_fsn):
    """The semantic tag of a concept, e.g. "disorder" in "Asthma (disorder)"."""
    fsn = concept_or_fsn
    if isinstance(concept_or_fsn, dict):
        fsn = next((d.get('value') for d in concept_or_fsn.get('designation') or []
                    if (d.get('use') or {}).get('code') == FSN), None)
    m = re.search(r'\(([^()]+)\)\s*$', fsn or '')
    return m.group(1) if m else ''


def best_matching_designation(concept, lang, q_tokens):
    """The designation, in the user's language, that matches all typed tokens (prefix, any order). U06."""
    candidates = [d for d in concept.get('designation') or []
                  if (d.get('language') or '')[:2] == lang and (d.get('use') or {}).get('code') != FSN]
    matches = [d for d in candidates
               if all(any(w.startswith(t) for w in words(d.get('value') or '')) for t in q_tokens)]
    matches.sort(key=lambda d: len(d.get('value') or ''))
    return matches[0].get('value') if matches else None


class SearchService(object):
    def __init__(self, ts, bindings, validator=None, lexicons=None, description_index=None,
                 min_chars=3, page_size=15, auto_extend_below=5, fuzzy_fallback=True):
        self.ts = ts
        self.validator = validator   # terminology client of the validation component
        self.lexicons = lexicons or {}
        self.description_index = description_index
        self.bindings = bindings
        self.min_chars = min_chars
        self.page_size = page_size
        self.auto_extend_below = auto_extend_below
        self.fuzzy_fallback = fuzzy_fallback

    # ------------------------------------------------------------------ bindings
    def care_set(self, care_set_id):
        for c in self.bindings['careSets']:
            if c['id'] == care_set_id:
                return c
        raise ValueError('unknown care set %s' % care_set_id)

    def context(self, cs, context_id):
        contexts = cs.get('contexts') or []
        if not contexts or context_id == 'none':
            return None
        if context_id:
            hit = next((c for c in contexts if c['id'] == context_id), None)
            if hit:
                return hit
        return next((c for c in contexts if c.get('default')), None)

    @staticmethod
    def context_ecl(ctx):
        return ctx.get('ecl') or ('^ %s' % ctx['refset'])

    def ecl_for(self, cs, ctx):
        """ECL of the data element binding, optionally restricted to a context subset (U01 + U04)."""
        base = '(%s)' % cs['binding']['ecl']
        return '%s AND (%s)' % (base, self.context_ecl(ctx)) if ctx else base

    # ------------------------------------------------------------------ query analysis (U01)
    def analyse(self, text, display_language):
        lang = lang_of(display_language)
        lex = self.lexicons.get(lang)
        tokens = words(text)
        rewrites = []
        alternatives = []
        if not lex or not tokens:
            return {'tokens': tokens, 'rewrites': rewrites, 'alternatives': alternatives}
        variant_tokens = list(tokens)
        typo_tokens = list(tokens)
        compound_tokens = list(tokens)
        has_variant = has_typo = has_compound = False
        for i, tok in enumerate(tokens):
            is_last = i == len(tokens) - 1
            known = lex.has_prefix(tok) if is_last else (lex.has(tok) or lex.has_prefix(tok))
            if len(tok) >= 4 and not tok.isdigit():
                v = (lex.variants(tok) or [None])[0]
                if v and not v.startswith(tok):
                    variant_tokens[i] = v
                    has_variant = True
                    rewrites.append({'type': 'variant', 'from': tok, 'to': v})
            if len(tok) >= 7 and known:
                # split the singular form when there is one (nl "nierstenen" -> "niersteen" -> nier + steen)
                base = (lex.variants(tok) or [tok])[0] or tok
                c = lex.decompound(base, last_token_prefix=(is_last and base == tok))
                # only when every part is at least as common as the compound itself
                plausible = bool(c) and len(c['parts']) > 1 and min(
                    lex.count(x) or lex.prefix_weight(x) for x in c['parts']) >= lex.count(base)
                if plausible:
                    compound_tokens[i] = ' '.join(c['parts'])
                    has_compound = True
                    rewrites.append({'type': 'decompound', 'from': tok, 'to': ' + '.join(c['parts'])})
            if not known and len(tok) >= 5:
                c = (lex.corrections(tok) or [None])[0]
                if c:
                    typo_tokens[i] = c
                    has_typo = True
                    rewrites.append({'type': 'typo', 'from': tok, 'to': c})
        if has_variant:
            alternatives.append({'via': 'variant', 'text': ' '.join(variant_tokens)})
        if has_compound:
            alternatives.append({'via': 'decompound', 'text': ' '.join(compound_tokens)})
        if has_typo:
            alternatives.append({'via': 'typo', 'text': ' '.join(typo_tokens)})
        return {'tokens': tokens, 'rewrites': rewrites, 'alternatives': alternatives}

    # ------------------------------------------------------------------ main entry point
    def search(self, text, care_set_id='problem', context_id=None, display_language='nl-BE',
               extend=False, trace=None):
        t0 = time.time()
        trace = trace if trace is not None else []
        cs = self.care_set(care_set_id)
        ctx = self.context(cs, context_id)
        q = (text or '').strip()
        id_info = classify_sctid(q)
        if re.match(r'^\d+$', q):
            res = self.search_by_id(q, id_info, cs, ctx, display_language, trace)
            res['serverMs'] = int(round((time.time() - t0) * 1000))
            res['trace'] = trace
            return res
        if len(re.sub(r'\s+', '', q)) < self.min_chars:
            return {'mode': 'too-short', 'minChars': self.min_chars, 'sections': [],
                    'serverMs': 0, 'trace': trace}

        analysis = self.analyse(q, display_language)
        tiers = []
        if ctx:
            tiers.append({'id': 'context', 'label': ctx['label'], 'ecl': self.ecl_for(cs, ctx),
                          'refset': ctx.get('refset')})
        # The context subset is only a preference: the user may always widen the search to everything
        # the binding permits (U01). Nothing outside the binding is ever offered (U04).
        may_extend = bool(ctx)
        broader = {'id': 'broader',
                   'label': 'All concepts permitted by the binding (%s)' % cs['binding'].get('source', ''),
                   'ecl': self.ecl_for(cs, None)}
        if not ctx:
            tiers.append(broader)

        def run_tier(tier):
            queries = [{'via': 'typed', 'text': q}] + analysis['alternatives']
            results = list(_POOL.map(
                lambda qq: self._expand_tier_safe(tier, qq, display_language, trace), queries))
            merged = {}
            total = 0
            for r in results:
                if r['via'] == 'typed':
                    total = r.get('total') or 0
                for it in r['items']:
                    if it['code'] not in merged:
                        item = dict(it)
                        item['via'] = [r['via']]
                        merged[it['code']] = item
                    elif r['via'] not in merged[it['code']]['via']:
                        merged[it['code']]['via'].append(r['via'])
            # Ranking (U01 "relevant result ranking"), applied to the page returned by the server:
            #   1. concepts matched by the typed text before concepts found only through a rewrite;
            #   2. concepts with a term in the user's language containing every search word before
            #      concepts the server matched on another description (e.g. "pro" in "(procedure)");
            #   3. the matched term equals the query, then the matched term starts with the query;
            #   4. fewer words, then shorter terms; the server's own order breaks the remaining ties.
            def fold_text(x):
                return ' '.join(words(x))

            alt_by_via = {a['via']: a['text'] for a in analysis['alternatives']}

            def key(it):
                typed = 'typed' in it['via']
                if typed:
                    qf = fold_text(q)
                else:
                    src = next((alt_by_via[v] for v in it['via'] if v in alt_by_via), q)
                    qf = fold_text(src)
                tf = fold_text(it['term'])
                return (0 if typed else 1, 0 if it['covered'] else 1, 0 if tf == qf else 1,
                        0 if tf.startswith(qf) else 1, len(tf.split(' ')), len(tf))

            items = sorted(merged.values(), key=key)
            out = dict(tier)
            out['total'] = total
            out['items'] = items[:self.page_size * 2]
            out['errors'] = [r['error'] for r in results if r.get('error')]
            return out

        sections = [run_tier(t) for t in tiers]
        context_count = len(sections[0]['items']) if sections else 0
        auto_extended = bool(ctx and may_extend and not extend and context_count < self.auto_extend_below)
        if ctx and may_extend and (extend or auto_extended):
            b = run_tier(broader)
            seen = {i['code'] for i in sections[0]['items']}
            b['items'] = [i for i in b['items'] if i['code'] not in seen]
            b['autoExtended'] = auto_extended
            sections.append(b)

        # Last resort for spelling mistakes the lexicon cannot fix (more than one edit): the server's
        # own fuzzy matching (Snowstorm / Snowstorm Lite: a trailing "~", max. 2 edits per word).
        fuzzy = False
        if all(not s['items'] for s in sections) and self.fuzzy_fallback:
            fuzzy = True
            fq = {'via': 'fuzzy', 'text': '%s~' % q}
            seen = set()
            for s in sections:
                r = self._expand_tier_safe(s, fq, display_language, trace)
                fresh = []
                for it in r['items']:
                    if it['code'] in seen:
                        continue
                    seen.add(it['code'])
                    item = dict(it)
                    item['via'] = ['fuzzy']
                    fresh.append(item)
                s['items'] = fresh
            analysis['rewrites'].append({'type': 'fuzzy', 'from': q,
                                         'to': '%s~ (server-side fuzzy match)' % q})

        return {
            'mode': 'text', 'query': q, 'analysis': analysis, 'fuzzy': fuzzy,
            'careSet': {'id': cs['id'], 'label': cs['label'], 'strength': cs.get('strength'),
                        'binding': cs['binding']},
            'context': ctx, 'canExtend': bool(ctx and may_extend), 'extended': len(sections) > 1,
            'sections': sections, 'serverMs': int(round((time.time() - t0) * 1000)), 'trace': trace,
        }

    def _expand_tier_safe(self, tier, query, display_language, trace):
        try:
            return self.expand_tier(tier, query, display_language, trace)
        except FhirError as e:
            return {'via': query['via'], 'total': 0, 'items': [], 'error': str(e)}

    def expand_tier(self, tier, query, display_language, trace):
        res = self.ts.expand(implicit_ecl(tier['ecl']), filter=query['text'], count=self.page_size,
                             display_language=display_language, include_designations=True, trace=trace)
        lang = lang_of(display_language)
        q_tokens = words(query['text'])
        items = []
        for c in res['contains']:
            matched = best_matching_designation(c, lang, q_tokens)
            items.append({
                'code': c.get('code'), 'system': c.get('system'), 'pt': c.get('display'),
                # covered = a term in the user's language contains every search word (not only the FSN)
                'term': matched or c.get('display'), 'covered': bool(matched),
                'semanticTag': semantic_tag(c),
            })
        return {'via': query['via'], 'total': res.get('total'), 'items': items}

    # ------------------------------------------------------------------ U02
    def search_by_id(self, q, id_info, cs, ctx, display_language, trace):
        if not id_info['valid']:
            return {'mode': 'id', 'query': q, 'idInfo': id_info, 'sections': [],
                    'message': 'Not a valid SNOMED CT identifier (%s).' % id_info['reason']}
        concept_id = q
        via = 'Concept ID'
        if id_info['kind'] == 'description':
            via = 'Description ID'
            # Description IDs cannot be resolved through the FHIR R4 terminology operations: the demo
            # uses an index built from the RF2 description file (build_lexicon.py).
            if not self.description_index:
                return {'mode': 'id', 'query': q, 'idInfo': id_info, 'sections': [],
                        'message': 'Description ID search needs the RF2 description index; '
                                   'build the lexicon first.'}
            concept_id = self.description_index.concept_for(q)
            if not concept_id:
                return {'mode': 'id', 'query': q, 'idInfo': id_info, 'sections': [],
                        'message': 'Description ID %s is not an active description in the loaded edition.' % q}
        elif id_info['kind'] != 'concept':
            return {'mode': 'id', 'query': q, 'idInfo': id_info, 'sections': [],
                    'message': 'This is a %s identifier, not a concept or description.' % id_info['kind']}
        try:
            lookup = self.ts.lookup(concept_id, display_language=display_language,
                                    property=['inactive'], trace=trace)
        except FhirError:
            return {'mode': 'id', 'query': q, 'idInfo': id_info, 'sections': [],
                    'message': 'Concept %s not found in the loaded edition.' % concept_id}
        validation = self.validate_selection(concept_id, cs['id'], display_language=display_language,
                                             trace=trace)
        return {'mode': 'id', 'query': q, 'idInfo': id_info, 'via': via,
                'sections': [{'id': 'id', 'label': 'Found by %s' % via, 'items': [{
                    'code': concept_id, 'pt': lookup.display, 'term': lookup.display,
                    'semanticTag': semantic_tag({'designation': lookup.designation}),
                    'via': [via], 'selectable': validation['valid'],
                    'reason': validation.get('reason')}]}]}

    # ------------------------------------------------------------------ U04 + S03 (+ U07/U08 reuse)
    def validate_selection(self, code, care_set_id, display=None, display_language='nl-BE', trace=None):
        """The one validation rule used for every way of entering a code."""
        trace = trace if trace is not None else []
        cs = self.care_set(care_set_id)
        out = {'code': code, 'careSetId': care_set_id, 'valid': False}
        ts = self.validator or self.ts
        try:
            in_binding = ts.validate_in_valueset(implicit_ecl(cs['binding']['ecl']), code, display=display,
                                                 display_language=display_language, trace=trace)
        except FhirError as e:
            out['reason'] = 'Terminology server error: %s' % e
            return out
        # A server may report a reference set member as valid while flagging it inactive: S03 forbids it.
        if in_binding.get('result') is True and in_binding.get('inactive') is True:
            out['display'] = in_binding.get('display')
            out['inactive'] = True
            out['reason'] = 'Inactive concept - cannot be recorded (S03)'
            return out
        if in_binding.get('result') is True:
            out['valid'] = True
            out['display'] = in_binding.get('display')
            out['reason'] = 'Active concept permitted by the binding'
            return out
        # Explain why: unknown, inactive, or simply outside the binding?
        try:
            lk = ts.lookup(code, display_language=display_language, property=['inactive'], trace=trace)
            out['display'] = lk.display
            inactive = lk.prop('inactive')[:1] == [True]
            out['reason'] = ('Inactive concept - cannot be recorded (S03)' if inactive
                             else 'Not permitted by the binding of %s (U04)' % cs['label'])
            out['inactive'] = inactive
        except FhirError:
            out['reason'] = 'Unknown concept identifier'
        return out

    # ------------------------------------------------------------------ U03
    def concept_details(self, code, care_set_id='problem', display_language='nl-BE', trace=None):
        trace = trace if trace is not None else []
        cs = self.care_set(care_set_id)
        lk = self.ts.lookup(code, display_language=display_language, trace=trace, property=[
            'parent', 'child', 'inactive', 'sufficientlyDefined', 'normalFormTerse', 'normalForm',
            'effectiveTime', 'moduleId'])
        parents = [str(x) for x in lk.prop('parent')]
        children = [str(x) for x in lk.prop('child')]
        # Defining attributes come from the (inferred) normal form, e.g. ===parents:{363698007=74281007}
        nf = parse_normal_form((lk.prop('normalFormTerse') or [''])[0])
        names = names_from_normal_form((lk.prop('normalForm') or [''])[0])
        shown_children = children[:60]
        related = []
        for x in parents + shown_children + [a[k] for a in nf['attributes'] for k in ('type', 'value')]:
            if re.match(r'^\d{6,18}$', str(x)) and x not in related:
                related.append(x)
        # One $expand returns the displays of the related concepts, a second one says which of them the
        # binding of the current data element permits (only those can be selected, U04).
        selectable = set()
        if related:
            joined = ' OR '.join(related)
            futures = [
                _POOL.submit(self.ts.expand, implicit_ecl(joined), count=len(related),
                             display_language=display_language, trace=trace),
                _POOL.submit(self.ts.expand, implicit_ecl('(%s) AND (%s)' % (joined, cs['binding']['ecl'])),
                             count=len(related), display_language=display_language, trace=trace),
            ]
            all_concepts, allowed = (f.result() for f in futures)
            for c in all_concepts['contains']:
                names[c['code']] = c.get('display')
            for c in allowed['contains']:
                selectable.add(c['code'])
        fsn = next((d.get('value') for d in lk.designation
                    if (d.get('use') or {}).get('code') == FSN), None)

        def node(identifier):
            return {'code': identifier, 'display': names.get(identifier) or identifier,
                    'selectable': identifier in selectable}

        self_check = self.validate_selection(code, care_set_id, display_language=display_language, trace=trace)
        return {
            'code': code, 'display': lk.display, 'fsn': fsn, 'version': lk.get('version'),
            'inactive': lk.prop('inactive')[:1] == [True],
            'sufficientlyDefined': lk.prop('sufficientlyDefined')[:1] == [True],
            'effectiveTime': (lk.prop('effectiveTime') or [None])[0],
            'moduleId': (lk.prop('moduleId') or [None])[0],
            'designations': [{'language': d.get('language'),
                              'use': (d.get('use') or {}).get('display') or (d.get('use') or {}).get('code'),
                              'value': d.get('value')}
                             for d in lk.designation if d.get('language') and d.get('value')],
            'parents': [node(p) for p in parents],
            'children': [node(c) for c in shown_children], 'childCount': len(children),
            'attributes': [{'group': a['group'], 'type': node(a['type']),
                            'value': node(a['value']) if str(a['value']).isdigit()
                            else {'code': a['value'], 'display': a['value'], 'selectable': False}}
                           for a in nf['attributes']],
            'selectable': self_check['valid'], 'selectableReason': self_check.get('reason'),
            'trace': trace,
        }
