#!/usr/bin/env python3
"""Demo 2 in Python (command line) - search & select against a FHIR terminology server.

Shows the mechanics behind the browser demo of ``02-search-and-select`` with nothing but the Python
standard library, so that the requirements can be tried out on a machine without Node.js and
without a local terminology server:

  U01  search on a term, restricted to a context subset first, then to everything the binding of the
       data element permits (--extend); results ranked the same way as in the browser demo
  U02  search on an identifier: the SCTID is checked (length, leading zero, Verhoeff check digit,
       partition) before it is looked up
  U03  concept details: parents, children, defining relationships and the terms of every Belgian
       language reference set (--detail)
  U04  nothing outside the binding is offered, and a selection is checked before it is accepted
  S03  an inactive concept is refused
  TSP6 every request carries displayLanguage, so the terms come from the Belgian language
       reference sets (--lang)

Usage:
    python3 ts_search.py --fhir http://localhost:8090/fhir "astma"
    python3 ts_search.py --care-set procedure --lang fr-BE "prothese hanche"
    python3 ts_search.py --care-set problem --context cardio --extend "infarct"
    python3 ts_search.py --detail 22298006 --lang de-BE
    python3 ts_search.py --care-set problem --validate 71388002

Example implementation for discussion - not a normative implementation.
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fhir_ts import (FhirError, FhirTerminologyClient, implicit_ecl,  # noqa: E402
                     ssl_context_from_env, token_from_env)
from lexicon import words  # noqa: E402  (folding and tokenising, shared with the browser demo)
from search_service import best_matching_designation, semantic_tag  # noqa: E402
from sctid import classify_sctid  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BINDINGS = os.path.join(HERE, '..', 'ehr-demo-app', 'config', 'bindings.json')
LANGS = [('nl-BE', '31000172101'), ('fr-BE', '21000172104'), ('de-BE', '120961000172108'),
         ('nl-BE-GP', '701000172104'), ('fr-BE-GP', '711000172101'), ('en-US', '900000000000509007')]
MIN_CHARS = 3
DEBOUNCE_MS = 500

try:  # keep a Windows console from crashing on accented terms
    sys.stdout.reconfigure(errors='replace')
except (AttributeError, ValueError):
    pass


# --------------------------------------------------------------------------- bindings
def care_set(bindings, care_set_id):
    for c in bindings['careSets']:
        if c['id'] == care_set_id:
            return c
    raise SystemExit('unknown care set %s (available: %s)'
                     % (care_set_id, ', '.join(c['id'] for c in bindings['careSets'])))


def context_of(cs, context_id):
    contexts = cs.get('contexts') or []
    if not contexts or context_id == 'none':
        return None
    if context_id:
        hit = next((c for c in contexts if c['id'] == context_id), None)
        if not hit:
            raise SystemExit('unknown context %s (available: %s, none)'
                             % (context_id, ', '.join(c['id'] for c in contexts)))
        return hit
    return next((c for c in contexts if c.get('default')), None)


def context_ecl(ctx):
    return ctx.get('ecl') or ('^ %s' % ctx['refset'])


def ecl_for(cs, ctx):
    """ECL of the data element binding, optionally restricted to a context subset (U01 + U04)."""
    base = '(%s)' % cs['binding']['ecl']
    return '%s AND (%s)' % (base, context_ecl(ctx)) if ctx else base


# --------------------------------------------------------------------------- output helpers
def table(rows, headers):
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = '  ' + '  '.join(h.ljust(widths[i]) for i, h in enumerate(headers)).rstrip()
    out = [line, '  ' + '  '.join('-' * widths[i] for i in range(len(headers)))]
    for row in rows:
        out.append('  ' + '  '.join(str(c).ljust(widths[i]) for i, c in enumerate(row)).rstrip())
    return '\n'.join(out)


def print_header(cs, ctx, lang):
    print('Care set  : %s (%s) - %s binding' % (cs['label'], cs['dataElement'], cs.get('strength', '?')))
    print('Binding   : %s' % cs['binding']['ecl'])
    print('            source: %s' % cs['binding'].get('source', '-'))
    print('Context   : %s' % ('%s (%s)' % (ctx['label'], context_ecl(ctx)) if ctx
                              else 'none - the whole binding'))
    print('Language  : %s' % lang)


# --------------------------------------------------------------------------- U01: search
def run_tier(ts, tier_ecl, text, lang, count, trace):
    res = ts.expand(implicit_ecl(tier_ecl), filter=text, count=count, display_language=lang,
                    include_designations=True, trace=trace)
    q_tokens = words(text)
    items = []
    for c in res['contains']:
        matched = best_matching_designation(c, lang[:2].lower(), q_tokens)
        items.append({'code': c.get('code'), 'pt': c.get('display'), 'term': matched or c.get('display'),
                      'covered': bool(matched), 'tag': semantic_tag(c)})
    # Ranking (U01 "relevant result ranking"), applied to the page the server returned:
    #   1. a term in the user's language contains every search word (not only the FSN semantic tag);
    #   2. the matched term equals the query, then it starts with the query;
    #   3. fewer words, then shorter terms; the server's order breaks the remaining ties.
    qf = ' '.join(q_tokens)
    def key(it):
        tf = ' '.join(words(it['term']))
        return (0 if it['covered'] else 1, 0 if tf == qf else 1, 0 if tf.startswith(qf) else 1,
                len(tf.split(' ')), len(tf))
    items.sort(key=key)
    return {'total': res['total'], 'items': items, 'inactive_removed': res['inactiveRemoved']}


def search(ts, cs, ctx, text, lang, count, extend, trace):
    print_header(cs, ctx, lang)
    print('Query     : "%s"   (the browser demo waits %d ms and needs at least %d characters)'
          % (text, DEBOUNCE_MS, MIN_CHARS))
    if len(re.sub(r'\s+', '', text)) < MIN_CHARS:
        print('\nToo short: at least %d characters (U01).' % MIN_CHARS)
        return
    print()

    tiers = []
    if ctx:
        tiers.append((ctx['label'], ecl_for(cs, ctx)))
        if extend:
            tiers.append(('All concepts permitted by the binding (%s)' % cs['binding'].get('source', 'binding'),
                          ecl_for(cs, None)))
    else:
        tiers.append(('All concepts permitted by the binding', ecl_for(cs, None)))

    seen = set()
    for label, tier_ecl in tiers:
        try:
            res = run_tier(ts, tier_ecl, text, lang, count, trace)
        except FhirError as e:
            print('%s\n  request failed: %s\n' % (label, e))
            continue
        rows = []
        for it in res['items']:
            if it['code'] in seen:   # the broader tier repeats nothing of the context tier
                continue
            seen.add(it['code'])
            term = it['term'] if it['term'] == it['pt'] else '%s  [PT: %s]' % (it['term'], it['pt'])
            rows.append([it['code'], term, it['tag'], '' if it['covered'] else 'other match'])
        print('%s - %s concept(s) match, showing %d' % (label, res['total'], len(rows)))
        if res['inactive_removed']:
            print('  (%d inactive concept(s) removed from the expansion)' % res['inactive_removed'])
        print(table(rows, ['CODE', 'TERM (%s)' % lang, 'SEMANTIC TAG', 'MATCHED ON']) if rows
              else '  no match')
        if any(not it['covered'] for it in res['items']):
            print('  MATCHED ON is empty when a term in %s starts with every search word; "other match"\n'
                  '  means the server matched inside a word or on another description. Those rank lower (U01).'
                  % lang)
        print()
    if ctx and not extend:
        print('Nothing outside the binding is ever offered (U04). Add --extend to widen the search '
              'from the context subset to the whole binding.')


# --------------------------------------------------------------------------- U02: identifier
def search_by_id(ts, cs, text, lang, trace):
    info = classify_sctid(text)
    print('Identifier: %s' % text)
    if not info['valid']:
        print('  Not a valid SNOMED CT identifier (%s).' % info['reason'])
        return
    print('  Valid SCTID: %s identifier, %s format%s'
          % (info['kind'], info['format'],
             ', namespace %s' % info['namespace'] if info.get('namespace') else ''))
    if info['kind'] == 'description':
        print('  A Description ID cannot be resolved through the FHIR R4 terminology operations.\n'
              '  Build the index from the RF2 description file (python3 build_lexicon.py <Snapshot>)\n'
              '  and use serve_demo2.py, which resolves it; a server may also expose it through its\n'
              '  own API (Snowstorm: /descriptions/{id}).')
        return
    if info['kind'] != 'concept':
        print('  This is a %s identifier, not a concept.' % info['kind'])
        return
    validate(ts, cs, text, lang, trace)


# --------------------------------------------------------------------------- U04 + S03: validation
def validate(ts, cs, code, lang, trace):
    """Check a selected concept against the binding of the data element, the way the eHR does."""
    url = implicit_ecl(cs['binding']['ecl'])
    try:
        in_binding = ts.validate_in_valueset(url, code, display_language=lang, trace=trace)
    except FhirError as e:
        print('  ValueSet/$validate-code failed: %s' % e)
        return
    if in_binding.get('result') is True:
        # $validate-code only echoes a display when one was sent, so ask for it when it is missing.
        display = in_binding.get('display')
        if not display:
            try:
                display = ts.lookup(code, display_language=lang, trace=trace).display
            except FhirError:
                display = '?'
        # A server may report a reference set member as valid while flagging it inactive: S03 forbids it.
        if in_binding.get('inactive') is True:
            print('  REFUSED  %s - %s' % (code, display))
            print('           Inactive concept - cannot be recorded (S03).')
            return
        print('  ACCEPTED %s - %s' % (code, display))
        print('           Active concept permitted by the binding of %s (U04).' % cs['label'])
        return
    try:
        lk = ts.lookup(code, display_language=lang, property=['inactive'], trace=trace)
    except FhirError:
        print('  REFUSED  %s - unknown concept identifier.' % code)
        return
    inactive = lk.prop('inactive')[:1] == [True]
    print('  REFUSED  %s - %s' % (code, lk.display))
    print('           %s' % ('Inactive concept - cannot be recorded (S03).' if inactive
                             else 'Not permitted by the binding of %s (U04).' % cs['label']))


# --------------------------------------------------------------------------- U03: concept details
def detail(ts, code, lang, trace):
    try:
        lk = ts.lookup(code, display_language=lang,
                       property=['parent', 'child', 'normalFormTerse', 'inactive', 'moduleId'], trace=trace)
    except FhirError as e:
        print('Concept %s: %s' % (code, e))
        return
    print('Concept   : %s  %s' % (code, lk.display))
    print('Status    : %s' % ('inactive' if lk.prop('inactive')[:1] == [True] else 'active'))
    module = lk.prop('moduleId')
    if module:
        print('Module    : %s%s' % (module[0], '  (Belgian Edition)' if module[0] == '11000172109' else ''))
    normal = lk.prop('normalFormTerse')
    if normal:
        print('Normal form (defining relationships):\n    %s' % normal[0])

    def names(codes):
        out = []
        for c in codes[:12]:
            try:
                out.append([c, ts.lookup(c, display_language=lang, trace=trace).display])
            except FhirError:
                out.append([c, '?'])
        return out

    for title, prop in (('Parents (IS A)', 'parent'), ('Children', 'child')):
        codes = lk.prop(prop)
        print('\n%s: %d' % (title, len(codes)))
        rows = names(codes)
        if rows:
            print(table(rows, ['CODE', 'TERM (%s)' % lang]))
            if len(codes) > len(rows):
                print('  ... and %d more' % (len(codes) - len(rows)))

    print('\nPreferred term per Belgian language reference set (TSP6):')
    rows = []
    for language, refset in LANGS:
        try:
            one = ts.lookup(code, display_language=language, trace=trace)
            has_own = any((d.get('language') or '').replace('-', '').endswith(refset)
                          for d in one.designation)
            rows.append([language, refset, one.display, '' if has_own else 'fallback'])
        except FhirError as e:
            rows.append([language, refset, 'error: %s' % e, ''])
    print(table(rows, ['LANGUAGE', 'REFSET', 'PREFERRED TERM', 'NOTE']))


# --------------------------------------------------------------------------- main
def main():
    p = argparse.ArgumentParser(description='Search & select against a FHIR terminology server (U01-U04, S03, TSP6).',
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog='Care sets and context subsets come from ehr-demo-app/config/bindings.json.')
    p.add_argument('text', nargs='?', help='search term, or a SNOMED CT identifier')
    p.add_argument('--fhir', default='http://localhost:8090/fhir', help='FHIR base URL of the terminology server')
    p.add_argument('--care-set', default='problem', help='care set id (default: problem)')
    p.add_argument('--context', default=None, help="context subset id, or 'none' for the whole binding")
    p.add_argument('--lang', default='nl-BE', help='display language / language reference set (default: nl-BE)')
    p.add_argument('--count', type=int, default=10, help='number of results per tier (default: 10)')
    p.add_argument('--extend', action='store_true', help='also search outside the context subset (U01)')
    p.add_argument('--detail', metavar='CODE', help='show the details of one concept (U03)')
    p.add_argument('--validate', metavar='CODE', help='check one concept against the binding (U04, S03)')
    p.add_argument('--list', action='store_true', help='list the care sets and context subsets, then exit')
    p.add_argument('--bindings', default=DEFAULT_BINDINGS, help='path to config/bindings.json')
    p.add_argument('--requests', action='store_true', help='print every FHIR request that was made (TSP1)')
    p.add_argument('--timeout', type=int, default=60, help='request timeout in seconds')
    p.add_argument('--ca-bundle', default=None, help='extra CA bundle (corporate TLS proxy)')
    a = p.parse_args()

    if not os.path.exists(a.bindings):
        raise SystemExit('bindings file not found: %s (use --bindings)' % a.bindings)
    with open(a.bindings, encoding='utf-8') as f:
        bindings = json.load(f)

    if a.list:
        for cs in bindings['careSets']:
            print('%-22s %-28s %s' % (cs['id'], cs['label'], cs['dataElement']))
            for c in cs.get('contexts') or []:
                print('    --context %-20s %s (%s)%s'
                      % (c['id'], c['label'], context_ecl(c), '  [default]' if c.get('default') else ''))
        return 0

    if not (a.text or a.detail or a.validate):
        p.error('give a search term, --detail CODE, --validate CODE or --list')

    ctx_ssl = ssl_context_from_env(a.ca_bundle)
    ts = FhirTerminologyClient(a.fhir, timeout=a.timeout, ssl_context=ctx_ssl,
                               bearer_token=token_from_env(ssl_context=ctx_ssl))
    trace = []
    cs = care_set(bindings, a.care_set)
    ctx = context_of(cs, a.context)

    try:
        version = (ts.snomed_versions(trace=trace) or [{}])[0].get('version')
    except FhirError as e:
        raise SystemExit('cannot reach %s: %s' % (a.fhir, e))
    print('Server    : %s' % a.fhir)
    print('SNOMED CT : %s' % version)

    if a.detail:
        detail(ts, a.detail, a.lang, trace)
    elif a.validate:
        print_header(cs, ctx, a.lang)
        print()
        validate(ts, cs, a.validate, a.lang, trace)
    elif re.match(r'^\d+$', a.text.strip()):
        print_header(cs, ctx, a.lang)
        print()
        search_by_id(ts, cs, a.text.strip(), a.lang, trace)
    else:
        search(ts, cs, ctx, a.text, a.lang, a.count, a.extend, trace)

    if a.requests:
        print('\nFHIR requests (TSP1): %d' % len(trace))
        for t in trace:
            print('  %6s ms  %s %s' % (t['ms'], t['status'], t['url']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
