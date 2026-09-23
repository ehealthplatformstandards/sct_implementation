#!/usr/bin/env python3
"""Demo 1 in Python - TSP1 (FHIR terminology operations), TSP2 (ECL concept sets), TSP6 (languages).

Runs a set of standard FHIR R4 terminology requests against a terminology server and records what
came back. Nothing here is specific to one product: point ``--fhir`` at a Snowstorm Lite, a
Snowstorm, an Ontoserver, ... that serves the SNOMED CT Belgian Edition.

This is the Python version of ``01-terminology-services/conformance-check.mjs``. It produces the
same HTML + JSON report and exists for machines that have Python but no Node.js, no Java 17 and no
Docker. Unlike the Node version it keeps going when one operation fails, so that a server which
does not implement everything still yields a complete report.

Usage:
    python3 ts_check.py --fhir http://localhost:8090/fhir
    python3 ts_check.py --fhir https://<server>/fhir           # with TS_* credentials, see README

Example implementation for discussion - not a normative test suite.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fhir_ts import (BE_MODULE, FhirError, FhirTerminologyClient, implicit_ecl,  # noqa: E402
                     parse_version_uri, ssl_context_from_env, token_from_env)
from report import Report, esc, thousands  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BINDINGS = os.path.join(HERE, '..', 'ehr-demo-app', 'config', 'bindings.json')

# Used only when config/bindings.json is not next to this folder (i.e. the python folder was copied
# out of the repository). The repository file is the single source of truth.
FALLBACK_BINDINGS = {'careSets': [
    {'id': 'problem', 'label': 'Problem list', 'dataElement': 'Condition.code', 'binding': {'ecl':
        '< 404684003 |Clinical finding| OR < 243796009 |Situation with explicit context| '
        'OR < 272379006 |Event| OR << 160245001 |No current problems or disability|'}},
    {'id': 'allergy', 'label': 'Allergy & Intolerance', 'dataElement': 'AllergyIntolerance.code', 'binding': {'ecl':
        '< 105590001 |Substance| OR < 373873005 |Pharmaceutical / biologic product| '
        'OR < 420134006 |Propensity to adverse reaction| OR << 716186003 |No known allergy|'}},
    {'id': 'vaccination', 'label': 'Vaccination', 'dataElement': 'Immunization.vaccineCode', 'binding': {'ecl':
        '^ 50831000172102 |Belgian subset for Vaccination|'}},
    {'id': 'procedure', 'label': 'Procedures', 'dataElement': 'Procedure.code', 'binding': {'ecl':
        '(< 71388002 |Procedure| OR << 787480003 |No known procedure|) MINUS '
        '(<< 14734007 |Administrative procedure| OR << 59524001 |Blood bank procedure| '
        'OR << 389067005 |Community health procedure| OR << 442006003 |Determination of information| '
        'OR << 225288009 |Environmental care procedure| OR << 308335008 |Patient encounter procedure| '
        'OR << 710135002 |Promotion of health| OR << 389084004 |Staff related procedure|)'}},
    {'id': 'observation', 'label': 'Clinical observation', 'dataElement': 'Observation.code', 'binding': {'ecl':
        '< 363787002 |Observable entity|'}},
]}

# One member and one concept from another hierarchy per Care Set, plus a search term per language.
CASES = {
    'problem': {'member': '195967001', 'non_member': '71388002',
                'filters': {'nl-BE': 'astma', 'fr-BE': 'asthme', 'de-BE': 'asthma', 'en-US': 'asthma'}},
    'allergy': {'member': '762952008', 'non_member': '195967001',
                'filters': {'nl-BE': 'pinda', 'fr-BE': 'arachide', 'de-BE': 'erdnuss', 'en-US': 'peanut'}},
    'vaccination': {'member': '1181000221105', 'non_member': '762952008',
                    'filters': {'nl-BE': 'influenza', 'fr-BE': 'grippe', 'de-BE': 'grippe', 'en-US': 'influenza'}},
    'procedure': {'member': '443435007', 'non_member': '195967001',
                  'filters': {'nl-BE': 'heupprothese', 'fr-BE': 'hanche prothese', 'de-BE': 'hüft',
                              'en-US': 'hip replacement'}},
    'observation': {'member': '27113001', 'non_member': '195967001',
                    'filters': {'nl-BE': 'lichaamsgewicht', 'fr-BE': 'poids corporel',
                                'de-BE': 'körpergewicht', 'en-US': 'body weight'}},
}
INACTIVE = {'code': '602001', 'label': 'Ross river fever (inactive since 2020-01-31, REPLACED BY 789400009)'}

# The Belgian language reference sets (TSP6).
LANGS = [('nl-BE', '31000172101'), ('fr-BE', '21000172104'), ('de-BE', '120961000172108'),
         ('nl-BE-GP', '701000172104'), ('fr-BE-GP', '711000172101'), ('en-US', '900000000000509007')]

ECL_CASES = [
    {'ecl': '< 404684003 |Clinical finding| : 363698007 |Finding site| = << 80891009 |Heart structure|',
     'what': 'refinement on a defining attribute (finding site)', 'yes': '22298006', 'no': '195967001'},
    {'ecl': '<< 73211009 |Diabetes mellitus| MINUS << 46635009 |Diabetes mellitus type 1|',
     'what': 'hierarchy with exclusion (MINUS)', 'yes': '44054006', 'no': '46635009'},
    {'ecl': '^ 40811000172108 |Belgian problem list subset| AND << 19829001 |Disorder of lung|',
     'what': 'Belgian reference set combined with a hierarchy', 'yes': '233604007', 'no': '22298006'},
    {'ecl': '<< 40733004 |Infectious disease| : 246075003 |Causative agent| = << 409822003 |Domain Bacteria|',
     'what': 'attribute refinement (causative agent)', 'yes': '53084003', 'no': '233604007'},
    {'ecl': '<< 84757009 |Epilepsy|',
     'what': 'descendants are found through relationships - concepts added in a new release are '
             'included automatically', 'yes': '1380178003', 'no': '22298006'},
]


def last(trace):
    return trace[-1] if trace else {}


def ms_of(trace):
    return last(trace).get('ms')


def url_of(trace):
    return last(trace).get('url')


def load_bindings(path):
    if path and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            # shown relative to this folder, so the report does not carry a local absolute path
            try:
                shown = os.path.relpath(path, HERE).replace(os.sep, '/')
            except ValueError:
                shown = os.path.normpath(path)
            return json.load(f), shown
    return FALLBACK_BINDINGS, 'built-in copy (config/bindings.json not found)'


def main():
    p = argparse.ArgumentParser(description='FHIR R4 terminology checks for TSP1, TSP2 and TSP6.')
    p.add_argument('--fhir', default='http://localhost:8090/fhir', help='FHIR base URL of the terminology server')
    p.add_argument('--id', default='tsp1-tsp2-tsp6-conformance-python', help='report id (file name)')
    p.add_argument('--bindings', default=DEFAULT_BINDINGS, help='path to config/bindings.json')
    p.add_argument('--out', default=None, help='output folder for the report (default: ./reports)')
    p.add_argument('--timeout', type=int, default=60, help='request timeout in seconds')
    p.add_argument('--ca-bundle', default=None, help='extra CA bundle (corporate TLS proxy)')
    a = p.parse_args()

    ctx = ssl_context_from_env(a.ca_bundle)
    ts = FhirTerminologyClient(a.fhir, name='lts', timeout=a.timeout, ssl_context=ctx,
                               bearer_token=token_from_env(ssl_context=ctx))
    bindings, bindings_source = load_bindings(a.bindings)
    by_id = {c['id']: c for c in bindings['careSets']}

    r = Report(id=a.id, title='Terminology services: FHIR operations, ECL and languages',
               requirements=['TSP1', 'TSP2', 'TSP6'], report_dir=a.out,
               intro='Every check below is one standard FHIR R4 terminology request ($lookup, '
                     '$validate-code, $expand) on http://snomed.info/sct. The value sets of the Care Set '
                     'data elements are defined intensionally with ECL (implicit value sets '
                     '<code>http://snomed.info/sct?fhir_vs=ecl/&hellip;</code>), so no member list is '
                     'maintained by hand. Run with the Python scripts in <code>python/</code> '
                     '(standard library only).')
    r.meta['FHIR endpoint'] = a.fhir
    r.meta['Care Set bindings'] = bindings_source
    r.meta['Run with'] = 'Python %d.%d.%d' % sys.version_info[:3]

    # ----------------------------------------------------------- server + version
    trace = []
    try:
        cs = ts.metadata(trace=trace)
    except FhirError as e:
        print('Cannot read %s/metadata: %s' % (a.fhir, e))
        r.meta['Software'] = 'unreachable'
        r.check(name='CapabilityStatement (GET /metadata)', req='TSP1', status='fail',
                expected='FHIR CapabilityStatement', actual=str(e), request=url_of(trace))
        r.write()
        return 1

    resources = ((cs.get('rest') or [{}])[0]).get('resource') or []
    ops = {x.get('type'): [o.get('name') for o in (x.get('operation') or [])] for x in resources}
    r.meta['Software'] = '%s %s' % ((cs.get('software') or {}).get('name') or '?',
                                    (cs.get('software') or {}).get('version') or '')
    r.meta['FHIR version'] = cs.get('fhirVersion')
    for res_type, needed in (('CodeSystem', ['lookup']), ('ValueSet', ['expand', 'validate-code'])):
        for op in needed:
            declared = op in (ops.get(res_type) or [])
            r.check(name='CapabilityStatement declares %s/$%s' % (res_type, op), req='TSP1',
                    expected='declared', actual='declared' if declared else 'missing',
                    status='pass' if declared else 'fail', ms=ms_of(trace), request='GET /metadata')

    trace = []
    versions = ts.snomed_versions(trace=trace)
    r.meta['SNOMED CT version'] = ', '.join(v['version'] or '?' for v in versions) or 'none'
    first = versions[0]['version'] if versions else None
    parsed = parse_version_uri(first)
    r.check(name='SNOMED CT Belgian Edition loaded (CodeSystem?url=http://snomed.info/sct)', req='TSP1',
            expected='http://snomed.info/sct/%s/version/...' % BE_MODULE, actual=first,
            status='pass' if parsed and parsed['module'] == BE_MODULE else 'fail',
            ms=ms_of(trace), request=url_of(trace))

    # ----------------------------------------------------------- TSP1: the five Care Sets
    binding_rows = []
    for care_set_id, case in CASES.items():
        cs_def = by_id[care_set_id]
        url = implicit_ecl(cs_def['binding']['ecl'])
        trace = []
        try:
            all_concepts = ts.expand(url, count=1, trace=trace)
            total = all_concepts['total']
            r.check(name='$expand binding of %s (%s)' % (cs_def['label'], cs_def['dataElement']), req='TSP1',
                    detail=cs_def['binding']['ecl'], expected='> 0 concepts', actual='%s concepts' % total,
                    status='pass' if (total or 0) > 0 else 'fail', ms=ms_of(trace), request=url_of(trace))
            binding_rows.append([cs_def['label'], cs_def['dataElement'], cs_def['binding']['ecl'], total])
        except FhirError as e:
            r.check(name='$expand binding of %s (%s)' % (cs_def['label'], cs_def['dataElement']), req='TSP1',
                    detail=cs_def['binding']['ecl'], expected='> 0 concepts', actual=str(e), status='fail',
                    ms=ms_of(trace), request=url_of(trace))
            binding_rows.append([cs_def['label'], cs_def['dataElement'], cs_def['binding']['ecl'], 'error'])

        for lang, filter_text in case['filters'].items():
            trace = []
            req = 'TSP1' if lang == 'en-US' else 'TSP1 TSP6'
            try:
                res = ts.expand(url, filter=filter_text, count=3, display_language=lang, trace=trace)
                hits = [c.get('display') for c in res['contains'][:3]]
                r.check(name='$expand %s with filter "%s" (%s)' % (cs_def['label'], filter_text, lang),
                        req=req, expected='matches in that language', actual=' | '.join(hits) or 'no match',
                        status='pass' if hits else 'warn', ms=ms_of(trace), request=url_of(trace))
            except FhirError as e:
                r.check(name='$expand %s with filter "%s" (%s)' % (cs_def['label'], filter_text, lang),
                        req=req, expected='matches in that language', actual=str(e), status='fail',
                        ms=ms_of(trace), request=url_of(trace))

        for code, expected, label in ((case['member'], True, 'in'),
                                      (case['non_member'], False, '(other hierarchy) in')):
            trace = []
            try:
                v = ts.validate_in_valueset(url, code, trace=trace)
                r.check(name='$validate-code %s %s %s' % (code, label, cs_def['label']), req='TSP1',
                        expected=expected, actual=v.get('result'), detail=v.get('display') or v.get('message'),
                        status='pass' if v.get('result') is expected else 'fail',
                        ms=ms_of(trace), request=url_of(trace))
            except FhirError as e:
                r.check(name='$validate-code %s %s %s' % (code, label, cs_def['label']), req='TSP1',
                        expected=expected, actual=str(e), status='fail', ms=ms_of(trace), request=url_of(trace))

    trace = []
    try:
        v = ts.validate_in_valueset(implicit_ecl(by_id['problem']['binding']['ecl']), INACTIVE['code'], trace=trace)
        r.check(name='$validate-code of an inactive concept: %s' % INACTIVE['label'], req='TSP1',
                expected=False, actual=v.get('result'), detail=v.get('message'),
                status='pass' if v.get('result') is False else 'fail', ms=ms_of(trace), request=url_of(trace))
    except FhirError as e:
        r.check(name='$validate-code of an inactive concept: %s' % INACTIVE['label'], req='TSP1',
                expected=False, actual=str(e), status='fail', ms=ms_of(trace), request=url_of(trace))

    # ----------------------------------------------------------- TSP1 + TSP6: language reference sets
    lang_rows = []
    for code in ('22298006', '195967001', '38341003'):
        row = [code]
        for lang, refset in LANGS:
            trace = []
            try:
                lk = ts.lookup(code, display_language=lang, trace=trace)
                refset_pt = next((d.get('value') for d in lk.designation
                                  if (d.get('language') or '').replace('-', '').endswith(refset)), None)
                row.append(lk.display if refset_pt else '%s (fallback)' % lk.display)
                status = 'pass' if refset_pt else ('info' if lang.endswith('GP') else 'warn')
                r.check(name='$lookup %s displayLanguage=%s (language refset %s)' % (code, lang, refset),
                        req='TSP6', expected='preferred term of that language reference set',
                        actual=lk.display, status=status, ms=ms_of(trace), request=url_of(trace),
                        detail=None if refset_pt else 'no preferred term in this reference set: '
                                                      'the server falls back to another language')
            except FhirError as e:
                row.append('error')
                r.check(name='$lookup %s displayLanguage=%s (language refset %s)' % (code, lang, refset),
                        req='TSP6', expected='preferred term of that language reference set',
                        actual=str(e), status='fail', ms=ms_of(trace), request=url_of(trace))
        lang_rows.append(row)
    r.block('Preferred terms per Belgian language reference set (TSP6)',
            '<table><tr><th>Concept</th>%s</tr>%s</table>' % (
                ''.join('<th>%s</th>' % esc(l) for l, _ in LANGS),
                ''.join('<tr>%s</tr>' % ''.join(
                    '<td class="%s">%s</td>' % ('mono' if i == 0 else '', esc(c)) for i, c in enumerate(row))
                    for row in lang_rows)))

    trace = []
    try:
        lk = ts.lookup('22298006', display_language='nl-BE',
                       property=['parent', 'child', 'normalFormTerse', 'inactive'], trace=trace)
        parents, children = lk.prop('parent'), lk.prop('child')
        normal = (lk.prop('normalFormTerse') or [''])[0]
        r.check(name='$lookup 22298006 with properties parent, child, normalFormTerse, inactive', req='TSP1',
                expected='hierarchy + defining relationships',
                actual='%d parents, %d children, %s' % (len(parents), len(children), normal),
                status='pass' if parents else 'fail', ms=ms_of(trace), request=url_of(trace))
    except FhirError as e:
        r.check(name='$lookup 22298006 with properties parent, child, normalFormTerse, inactive', req='TSP1',
                expected='hierarchy + defining relationships', actual=str(e), status='fail',
                ms=ms_of(trace), request=url_of(trace))

    # ----------------------------------------------------------- TSP2: ECL
    ecl_rows = []
    for e in ECL_CASES:
        url = implicit_ecl(e['ecl'])
        trace = []
        try:
            x = ts.expand(url, count=3, display_language='nl-BE', trace=trace)
            ecl_rows.append([e['ecl'], e['what'], x['total']])
            r.check(name='ValueSet/$expand ECL: %s' % e['what'], req='TSP2', detail=e['ecl'],
                    expected='evaluated dynamically',
                    actual='%s concepts, e.g. %s' % (x['total'], ' | '.join(
                        c.get('display') or '' for c in x['contains'])),
                    status='pass' if (x['total'] or 0) > 0 else 'fail',
                    ms=ms_of(trace), request=url_of(trace))
        except FhirError as err:
            ecl_rows.append([e['ecl'], e['what'], 'error'])
            r.check(name='ValueSet/$expand ECL: %s' % e['what'], req='TSP2', detail=e['ecl'],
                    expected='evaluated dynamically', actual=str(err), status='fail',
                    ms=ms_of(trace), request=url_of(trace))

        trace = []
        try:
            y = ts.validate_in_valueset(url, e['yes'], trace=trace)
            exists = True
            if y.get('result') is not True:
                try:
                    ts.lookup(e['yes'])
                except FhirError:
                    exists = False
            if not exists:
                # e.g. 1380178003 was added in the 20260915 edition: once that edition is deployed it is a
                # member of << 84757009 without anybody editing the constraint (TSP2: no enumerated list).
                r.check(name='$validate-code %s against the ECL above' % e['yes'], req='TSP2',
                        expected='member once the concept exists', actual='concept not in this edition version',
                        detail='The concept was added in a later release; after the upgrade it becomes a '
                               'member automatically.', status='info', ms=ms_of(trace), request=url_of(trace))
            else:
                r.check(name='$validate-code %s against the ECL above' % e['yes'], req='TSP2',
                        expected=True, actual=y.get('result'), detail=y.get('display') or y.get('message'),
                        status='pass' if y.get('result') is True else 'fail',
                        ms=ms_of(trace), request=url_of(trace))
        except FhirError as err:
            r.check(name='$validate-code %s against the ECL above' % e['yes'], req='TSP2', expected=True,
                    actual=str(err), status='fail', ms=ms_of(trace), request=url_of(trace))

        trace = []
        try:
            n = ts.validate_in_valueset(url, e['no'], trace=trace)
            r.check(name='$validate-code %s against the ECL above' % e['no'], req='TSP2', expected=False,
                    actual=n.get('result'), status='pass' if n.get('result') is False else 'fail',
                    ms=ms_of(trace), request=url_of(trace))
        except FhirError as err:
            r.check(name='$validate-code %s against the ECL above' % e['no'], req='TSP2', expected=False,
                    actual=str(err), status='fail', ms=ms_of(trace), request=url_of(trace))

    r.block('Care Set bindings evaluated as ECL (TSP1 / TSP2)',
            '<table><tr><th>Care Set</th><th>Data element</th><th>Binding (ECL)</th><th>Concepts</th></tr>%s</table>'
            % ''.join('<tr><td>%s</td><td class="mono">%s</td><td class="mono">%s</td><td class="num">%s</td></tr>'
                      % (esc(b[0]), esc(b[1]), esc(b[2]), esc(thousands(b[3]))) for b in binding_rows))
    r.block('Other ECL constraints (TSP2)',
            '<table><tr><th>ECL</th><th>What it shows</th><th>Concepts</th></tr>%s</table>'
            % ''.join('<tr><td class="mono">%s</td><td>%s</td><td class="num">%s</td></tr>'
                      % (esc(b[0]), esc(b[1]), esc(thousands(b[2]))) for b in ecl_rows))
    r.write()
    return 0 if r.ok else 1


if __name__ == '__main__':
    sys.exit(main())
