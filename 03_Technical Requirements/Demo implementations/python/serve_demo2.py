#!/usr/bin/env python3
"""Demo 2 in the browser, served by Python - search & select (U01-U08, S01-S03, TSP1, TSP6, TSP7).

Serves the *same* pages as the Node demo eHR (``ehr-demo-app/public``) and implements the JSON API
they use, with nothing but the Python standard library. It exists for machines that have Python but
no Node.js, no Java 17 and no Docker: point ``--fhir`` at any FHIR R4 terminology server that serves
the SNOMED CT Belgian Edition.

    python3 serve_demo2.py --fhir http://localhost:8090/fhir
    -> http://localhost:3100/search.html

What is covered: the search & select component (U01 progressive matching, query rewriting,
context subsets, ranking; U02 Concept ID / Description ID; U03 hierarchy; U04 binding; U05 free
text; U06 selected term; U07 favourites and recently used; U08 text-analysis suggestions), storing
an entry with its context (S01, S02), the validation before storing (S03), the FHIR request log
(TSP1), the language reference sets (TSP6) and the NRC feedback (TSP7).

What is not covered: Demo 3 (the patient record, release impact, ICD-10 maps, reports and the FHIR
export) and TSP4/TSP5, which drive two terminology servers. Use the Node demo for those, or read
the recorded screenshots and reports in this repository.

Example implementation for discussion - not a normative implementation, and not secure: there is no
authentication, no authorisation and no audit trail. Never use it with real patient data.
"""

import argparse
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lexicon as lexmod                                                      # noqa: E402
from feedback import FEEDBACK_KINDS, NRC_PORTAL, portal_for, summary         # noqa: E402
from fhir_ts import (FhirError, FhirTerminologyClient, implicit_ecl,         # noqa: E402
                     ssl_context_from_env, token_from_env)
from nlp_suggest import ReferenceTextAnalyser, call_suggestion_service       # noqa: E402
from search_service import SearchService                                     # noqa: E402
from store import Store                                                      # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', 'ehr-demo-app', 'public')
DEMO1_REPORTS = os.path.join(HERE, '..', '01-terminology-services', 'reports')
PY_REPORTS = os.path.join(HERE, 'reports')

BE_LANGUAGE_REFSETS = {
    'nl-BE': {'refset': '31000172101', 'lang': 'nl', 'label': 'Nederlands (BE)'},
    'fr-BE': {'refset': '21000172104', 'lang': 'fr', 'label': 'Français (BE)'},
    'de-BE': {'refset': '120961000172108', 'lang': 'de', 'label': 'Deutsch (BE)'},
    'nl-BE-GP': {'refset': '701000172104', 'lang': 'nl', 'label': 'Nederlands – huisarts (BE GP)'},
    'fr-BE-GP': {'refset': '711000172101', 'lang': 'fr', 'label': 'Français – médecin généraliste (BE GP)'},
    'en-US': {'refset': '900000000000509007', 'lang': 'en', 'label': 'English (US)'},
}

# Three fictitious patients, the same ones the Node demo seeds.
DEMO_PATIENTS = [
    ('pat-001', 'Peeters', 'Maria', 'female', '1959-03-14'),
    ('pat-002', 'Janssens', 'Lucas', 'male', '2019-07-02'),
    ('pat-003', 'Dubois', 'Amélie', 'female', '1984-11-23'),
]

MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
        '.ico': 'image/x-icon', '.map': 'application/json'}

RECORD_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Demo 3 is not served by the Python server</title><link rel="stylesheet" href="/css/app.css"></head>
<body><main style="padding:24px;max-width:760px">
<h1>Demo 3 is not part of the Python server</h1>
<p>This server (<code>python/serve_demo2.py</code>) implements <b>Demo 2 &middot; search &amp; select</b>
only. Demo 3 - the patient record, the release upgrade, the ICD-10 maps, the ECL reports and the FHIR
export - runs in the Node demo eHR (<code>ehr-demo-app/server.mjs</code>).</p>
<p>Everything Demo 3 does is documented with screenshots and example requests per requirement in
<code>03_Technical Requirements/REQ16 &hellip; REQ23/Examples/README.md</code>.</p>
<p><a href="/search.html">&larr; Back to Demo 2</a></p>
</main></body></html>"""


class Config(object):
    pass


cfg = Config()
state = {'store': None, 'search': None, 'analyser': None, 'components': {}, 'version': None}


# --------------------------------------------------------------------------- helpers
def now():
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + '.000Z'


def displays_for(ids, lang, trace, ts=None):
    """Display terms (in the user's language) for a list of concepts; inactive ones via $lookup."""
    ts = ts or state['components']['validation']
    seen = []
    for i in ids:
        if i and i not in seen:
            seen.append(str(i))
    out = {}
    for i in range(0, len(seen), 200):
        batch = seen[i:i + 200]
        r = ts.expand(implicit_ecl(' OR '.join(batch)), count=len(batch), display_language=lang,
                      include_inactive=True, trace=trace)
        for c in r['contains']:
            out[c['code']] = c.get('display')
    for identifier in seen:
        if identifier not in out:
            try:
                out[identifier] = ts.lookup(identifier, display_language=lang, trace=trace).display
            except FhirError:
                pass
    return out


def favourites(care_set, lang, trace):
    """U07: favourites and recently used, each re-validated with the same rules as search results."""
    store = state['store']
    favs = store.all("SELECT *, 'favourite' AS kind FROM favourite WHERE user_id = ? AND care_set = ? "
                     "ORDER BY term", cfg.user_id, care_set)
    recent = store.all("SELECT *, 'recent' AS kind FROM recent WHERE user_id = ? AND care_set = ? "
                       "ORDER BY used_at DESC LIMIT 8", cfg.user_id, care_set)
    items = []
    for f in favs + recent:
        v = state['search'].validate_selection(f['sct_concept_id'], care_set,
                                               display_language=lang, trace=trace)
        items.append({'kind': f['kind'], 'code': f['sct_concept_id'], 'term': f['term'],
                      'valid': v['valid'], 'reason': v.get('reason'), 'currentDisplay': v.get('display')})
    return items


# --------------------------------------------------------------------------- HTTP handler
class Handler(BaseHTTPRequestHandler):
    server_version = 'sct-demo-python/1.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if cfg.verbose:
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    # -- plumbing ----------------------------------------------------------
    def send_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def send_bytes(self, status, content_type, payload):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        return json.loads(raw.decode('utf-8')) if raw else {}

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_DELETE(self):
        self.handle_request('DELETE')

    def handle_request(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            if path.startswith('/api/'):
                self.api(method, path, query)
            else:
                self.static(path)
        except FhirError as e:
            self.send_json(502, {'error': str(e)})
        except ValueError as e:
            self.send_json(400, {'error': str(e)})
        except BrokenPipeError:
            pass
        except Exception as e:                                   # noqa: BLE001 - demo server
            import traceback
            traceback.print_exc()
            self.send_json(500, {'error': '%s: %s' % (type(e).__name__, e)})

    # -- static ------------------------------------------------------------
    def static(self, path):
        if path in ('/', ''):
            path = '/search.html'
        if path == '/record.html':
            return self.send_bytes(200, 'text/html; charset=utf-8', RECORD_PAGE.encode('utf-8'))
        base = PUBLIC
        if path.startswith('/demo1/'):
            base, path = DEMO1_REPORTS, path[len('/demo1'):]
        elif path.startswith('/python-reports/'):
            base, path = PY_REPORTS, path[len('/python-reports'):]
        target = os.path.normpath(os.path.join(base, urllib.parse.unquote(path).lstrip('/')))
        if not target.startswith(os.path.normpath(base)):
            return self.send_json(403, {'error': 'forbidden'})
        if os.path.isdir(target):
            target = os.path.join(target, 'index.html')
        if not os.path.exists(target):
            return self.send_json(404, {'error': 'not found'})
        with open(target, 'rb') as f:
            payload = f.read()
        ctype = MIME.get(os.path.splitext(target)[1], 'application/octet-stream')
        self.send_bytes(200, ctype, payload)

    # -- API ---------------------------------------------------------------
    def api(self, method, path, q):
        store = state['store']
        search = state['search']
        lang = q.get('lang') or cfg.default_language
        trace = []

        if path == '/api/config':
            return self.send_json(200, {
                'careSets': cfg.bindings['careSets'], 'qualifiers': cfg.bindings['qualifiers'],
                'languages': BE_LANGUAGE_REFSETS, 'debounceMs': cfg.debounce_ms,
                'minChars': cfg.min_chars, 'defaultLanguage': cfg.default_language,
                'productionVersion': state['version'], 'nrcPortal': NRC_PORTAL,
                'feedbackKinds': FEEDBACK_KINDS, 'suggestService': cfg.suggest_url,
                'associations': {}, 'reports': [], 'profiles': {},
                'server': 'python',
            })

        # TSP5: which SNOMED CT version does every component use?
        if path == '/api/version':
            rows = []
            for name, ts in state['components'].items():
                server_version, error = None, None
                try:
                    versions = ts.snomed_versions()
                    server_version = versions[0]['version'] if versions else None
                except FhirError as e:
                    error = str(e)
                rows.append({'component': name, 'terminologyServer': ts.base_url,
                             'pinnedVersion': ts.system_version, 'serverVersion': server_version,
                             'consistent': server_version == state['version'], 'error': error})
            in_record = store.all('SELECT sct_version AS version, COUNT(*) AS entries FROM clinical_entry '
                                  'WHERE sct_version IS NOT NULL GROUP BY sct_version')
            return self.send_json(200, {'productionVersion': state['version'],
                                        'consistent': all(r['consistent'] for r in rows),
                                        'components': rows, 'versionsInRecord': in_record})

        if path == '/api/displays':
            codes = [c for c in (q.get('codes') or '').split(',') if re.match(r'^\d{6,18}$', c)]
            return self.send_json(200, {'displays': displays_for(codes, lang, trace)})

        if path == '/api/search':
            return self.send_json(200, search.search(
                text=q.get('text'), care_set_id=q.get('careSet') or 'problem',
                context_id=q.get('context'), display_language=lang,
                extend=q.get('extend') == 'true', trace=trace))

        m = re.match(r'^/api/concept/(\d+)$', path)
        if m:
            return self.send_json(200, search.concept_details(
                m.group(1), care_set_id=q.get('careSet') or 'problem', display_language=lang, trace=trace))

        if path == '/api/validate' and method == 'POST':
            b = self.read_body()
            out = search.validate_selection(b.get('code'), b.get('careSet'), display=b.get('display'),
                                            display_language=b.get('lang') or lang, trace=trace)
            out['trace'] = trace
            return self.send_json(200, out)

        # U07
        if path == '/api/favourites' and method == 'GET':
            return self.send_json(200, {'items': favourites(q.get('careSet') or 'problem', lang, trace),
                                        'trace': trace})
        if path == '/api/favourites' and method == 'POST':
            b = self.read_body()
            store.run('INSERT OR REPLACE INTO favourite VALUES (?,?,?,?,?)',
                      cfg.user_id, b.get('careSet'), b.get('code'), b.get('term'), now())
            return self.send_json(200, {'ok': True})
        if path == '/api/favourites' and method == 'DELETE':
            store.run('DELETE FROM favourite WHERE user_id = ? AND care_set = ? AND sct_concept_id = ?',
                      cfg.user_id, q.get('careSet'), q.get('code'))
            return self.send_json(200, {'ok': True})

        # U08: the "external" text analysis tool (reference implementation) ...
        if path == '/api/text-analysis' and method == 'POST':
            b = self.read_body()
            return self.send_json(200, state['analyser'].analyse(
                text=b.get('text') or '', language=b.get('language') or lang,
                care_set=b.get('careSet') or 'problem'))
        # ... and the eHR side: call the configured tool, then validate every candidate
        if path == '/api/suggest' and method == 'POST':
            b = self.read_body()
            out = call_suggestion_service(cfg.suggest_url, {
                'text': b.get('text') or '', 'language': b.get('lang') or lang,
                'careSet': b.get('careSet') or 'problem'}, trace)
            validated = []
            for c in out.get('candidates') or []:
                item = dict(c)
                item['validation'] = search.validate_selection(
                    c['conceptId'], b.get('careSet') or 'problem',
                    display_language=b.get('lang') or lang, trace=trace)
                validated.append(item)
            return self.send_json(200, {'service': out.get('service'), 'candidates': validated,
                                        'trace': trace})

        # TSP7
        if path == '/api/feedback' and method == 'POST':
            b = self.read_body()
            f = {'kind': b.get('kind') or 'missing-concept', 'language': b.get('lang') or lang,
                 'search_text': b.get('searchText') or None, 'sct_concept_id': b.get('code') or None,
                 'care_set': b.get('careSet') or None, 'comment': b.get('comment') or None}
            text = summary(f, state['version'])
            new_id = None
            if b.get('mode') == 'queue':
                cur = store.run('INSERT INTO nrc_feedback (created_at,user_id,kind,language,search_text,'
                                'sct_concept_id,care_set,comment,status) VALUES (?,?,?,?,?,?,?,?,?)',
                                now(), cfg.user_id, f['kind'], f['language'], f['search_text'],
                                f['sct_concept_id'], f['care_set'], f['comment'], 'queued for NRC')
                new_id = cur.lastrowid
            return self.send_json(200, {'id': new_id, 'portal': portal_for(f['language']), 'summary': text})
        if path == '/api/feedback' and method == 'GET':
            return self.send_json(200, {'items': store.all('SELECT * FROM nrc_feedback ORDER BY id DESC')})

        # patients and entries (the parts of Demo 3 the search page needs)
        if path == '/api/patients' and method == 'GET':
            return self.send_json(200, {'items': store.all(
                'SELECT p.*, (SELECT COUNT(*) FROM clinical_entry e WHERE e.patient_id = p.id) AS entries '
                'FROM patient p ORDER BY family')})

        if path == '/api/entries' and method == 'POST':
            b = self.read_body()
            cs = next((c for c in cfg.bindings['careSets'] if c['id'] == b.get('careSet')), None)
            if not cs:
                return self.send_json(400, {'error': 'unknown care set'})
            entry = dict(b.get('context') or {})
            entry.update({'patient_id': b.get('patientId'), 'care_set': cs['id'],
                          'data_element': cs['dataElement'], 'entry_method': b.get('method') or ('free-text' if b.get('freeText') else 'search'),
                          'recorded_at': b.get('recordedAt') or now(),
                          'recorder_id': b.get('recorderId') or cfg.user_id})
            if b.get('freeText'):
                entry['free_text'] = b['freeText']
            else:
                # S03 + U04: the same validation for every entry method
                v = search.validate_selection(b.get('code'), cs['id'],
                                              display_language=b.get('lang') or lang, trace=trace)
                if not v['valid']:
                    return self.send_json(422, {'error': v.get('reason'), 'validation': v, 'trace': trace})
                entry.update({'sct_concept_id': b.get('code'), 'sct_term_selected': b.get('term'),
                              'sct_description_id': b.get('descriptionId'),
                              'term_language': b.get('lang') or lang, 'sct_version': state['version']})
            try:
                new_id = store.record_entry(entry)
            except ValueError as e:
                return self.send_json(400, {'error': str(e)})
            if entry.get('sct_concept_id'):
                store.run('INSERT OR REPLACE INTO recent VALUES (?,?,?,?,?)', cfg.user_id, cs['id'],
                          entry['sct_concept_id'], entry['sct_term_selected'], now())
            return self.send_json(201, {'id': new_id, 'trace': trace,
                                        'entry': store.get('SELECT * FROM clinical_entry WHERE id = ?',
                                                           new_id)})

        # read-only view of the stored rows (S01, S02)
        m = re.match(r'^/api/db/(clinical_entry|nrc_feedback|favourite|recent)$', path)
        if m:
            return self.send_json(200, {'table': m.group(1), 'rows': store.all(
                'SELECT * FROM %s ORDER BY rowid DESC LIMIT 200' % m.group(1))})

        return self.send_json(501, {'error': 'This endpoint belongs to Demo 3 and is not implemented '
                                             'by the Python server: %s' % path})


# --------------------------------------------------------------------------- start-up
def load_lexicon(path, rf2_dir, log=print):
    if path and os.path.exists(path):
        t0 = time.time()
        built = lexmod.load_cache(path)
        log('[lexicon] cache %s loaded in %.1f s (%d active descriptions)'
            % (path, time.time() - t0, built['descriptionIndex'].size))
    elif rf2_dir:
        built = lexmod.build_from_rf2(rf2_dir, log=log)
        lexmod.save_cache(path, built)
        log('[lexicon] cache written to %s' % path)
    else:
        log('[lexicon] no cache and no --rf2: variants, decompounding, typo correction and '
            'Description ID search are disabled (everything else works)')
        return {}, None
    for lex in built['lexicons'].values():
        lex.build_deletes()          # typo index, built once at start-up
    return built['lexicons'], built['descriptionIndex']


def main():
    p = argparse.ArgumentParser(description='Demo 2 (search & select) served by Python.')
    p.add_argument('--fhir', default=os.environ.get('LTS_BASE_URL', 'http://localhost:8090/fhir'),
                   help='FHIR base URL of the terminology server')
    p.add_argument('--port', type=int, default=int(os.environ.get('PORT', '3100')), help='HTTP port')
    p.add_argument('--db', default=os.environ.get('DB_FILE', os.path.join(HERE, 'data', 'ehr-demo.sqlite')),
                   help='SQLite file (the Node demo database can be reused)')
    p.add_argument('--lexicon', default=os.environ.get('LEXICON_CACHE'),
                   help='lexicon cache (default: python/data/lexicon-cache.json, or the Node one)')
    p.add_argument('--rf2', default=os.environ.get('RF2_SNAPSHOT_DIR'),
                   help='RF2 Snapshot folder, used to build the lexicon when there is no cache')
    p.add_argument('--bindings', default=os.path.join(HERE, '..', 'ehr-demo-app', 'config', 'bindings.json'))
    p.add_argument('--lang', default=os.environ.get('DEFAULT_LANGUAGE', 'nl-BE'), help='default language')
    p.add_argument('--min-chars', type=int, default=int(os.environ.get('MIN_CHARS', '3')))
    p.add_argument('--debounce-ms', type=int, default=int(os.environ.get('DEBOUNCE_MS', '500')))
    p.add_argument('--timeout', type=int, default=60, help='terminology request timeout in seconds')
    p.add_argument('--ca-bundle', default=None, help='extra CA bundle (corporate TLS proxy)')
    p.add_argument('--verbose', action='store_true', help='log every HTTP request')
    a = p.parse_args()

    cfg.verbose = a.verbose
    cfg.default_language = a.lang
    cfg.min_chars = a.min_chars
    cfg.debounce_ms = a.debounce_ms
    cfg.user_id = os.environ.get('DEMO_USER', 'dr-demo')
    cfg.suggest_url = os.environ.get('SUGGEST_SERVICE_URL', 'http://localhost:%d/api/text-analysis' % a.port)
    with open(a.bindings, encoding='utf-8') as f:
        cfg.bindings = json.load(f)

    ssl_ctx = ssl_context_from_env(a.ca_bundle)
    token = token_from_env(ssl_context=ssl_ctx)
    probe = FhirTerminologyClient(a.fhir, timeout=a.timeout, ssl_context=ssl_ctx, bearer_token=token)
    try:
        versions = probe.snomed_versions()
    except FhirError as e:
        raise SystemExit('cannot reach the terminology server %s: %s' % (a.fhir, e))
    state['version'] = os.environ.get('SCT_PRODUCTION_VERSION') or (versions[0]['version'] if versions else None)
    print('[eHR] terminology server %s, production version %s' % (a.fhir, state['version']))

    # TSP5: one terminology client per component, all pinned to the production version
    for name in ('search', 'validation', 'reporting', 'fhir-export', 'release-impact'):
        base = os.environ.get('%s_LTS_BASE_URL' % name.upper().replace('-', '_')) or a.fhir
        state['components'][name] = FhirTerminologyClient(
            base, system_version=state['version'], timeout=a.timeout, ssl_context=ssl_ctx,
            bearer_token=token, name=name)

    cache = a.lexicon
    if not cache:
        node_cache = os.path.join(HERE, '..', 'ehr-demo-app', 'data', 'lexicon-cache.json')
        own_cache = os.path.join(HERE, 'data', 'lexicon-cache.json')
        cache = own_cache if os.path.exists(own_cache) else (
            node_cache if os.path.exists(node_cache) else own_cache)
    lexicons, description_index = load_lexicon(cache, a.rf2)

    state['store'] = Store(a.db)
    state['store'].run('INSERT OR IGNORE INTO practitioner VALUES (?,?,?)', cfg.user_id, 'Demo', 'Dr')
    for row in DEMO_PATIENTS:
        state['store'].run('INSERT OR IGNORE INTO patient (id, family, given, gender, birth_date) '
                           'VALUES (?,?,?,?,?)', *row)
    print('[eHR] database %s' % os.path.abspath(a.db))

    state['search'] = SearchService(ts=state['components']['search'], validator=state['components']['validation'],
                                    bindings=cfg.bindings, lexicons=lexicons,
                                    description_index=description_index, min_chars=a.min_chars)
    state['analyser'] = ReferenceTextAnalyser(ts=state['components']['search'], bindings=cfg.bindings)

    socketserver.TCPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(('0.0.0.0', a.port), Handler)
    httpd.daemon_threads = True
    print('[eHR] Demo 2 on http://localhost:%d/search.html  (Ctrl+C to stop)' % a.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n[eHR] stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
