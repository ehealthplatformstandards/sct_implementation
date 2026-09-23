"""U08 - integration of a tool that analyses clinical text and proposes SNOMED CT concepts.

Python counterpart of ``ehr-demo-app/lib/nlp-suggest.mjs``. The eHR talks to the tool through a
small HTTP/JSON contract (example contract, not a standard):

    POST {SUGGEST_SERVICE_URL}
    { "text": "...", "language": "nl-BE", "careSet": "problem" }
    -> { "service": "...", "candidates": [ { "start": 12, "end": 22, "text": "hypertensie",
           "conceptId": "38341003", "term": "hypertensie", "confidence": 0.9, "negated": false } ] }

Whatever tool is plugged in, the eHR only shows the candidates as suggestions, runs the normal
validation (active concept + binding of the data element) before recording, and shows the Concept ID.

``ReferenceTextAnalyser`` is a deliberately naive stand-in that implements the same contract with
dictionary look-ups on the terminology server. It exists only to make the demo self-contained.
"""

import json
import re
import time
import urllib.error
import urllib.request

from fhir_ts import FhirError, implicit_ecl
from lexicon import words

FSN = '900000000000003001'
NEGATION = {
    'nl': ['geen', 'niet', 'zonder', 'uitgesloten'],
    'fr': ['pas', 'sans', 'aucun', 'aucune', 'exclu'],
    'de': ['kein', 'keine', 'ohne', 'nicht'],
    'en': ['no', 'without', 'denies', 'not'],
}
STOP = set('en van de het een met op in sinds dagen jaar et la le les des du avec depuis und der die '
           'das mit seit and the of with since patient patiente patiënt patiënte gekende klinisch '
           'beeld bekannte connu connue'.split())

_TOKEN = re.compile(r'[^\W_]+', re.UNICODE)
_BREAK = re.compile(r'[.;\n]')


class ReferenceTextAnalyser(object):
    def __init__(self, ts, bindings, max_ngram=5):
        self.ts = ts
        self.bindings = bindings
        self.max_ngram = max_ngram

    def analyse(self, text, language='nl-BE', care_set='problem'):
        cs = next(c for c in self.bindings['careSets'] if c['id'] == care_set)
        lang = (language or 'nl-BE')[:2]
        negation = NEGATION.get(lang) or []
        toks = []
        for m in _TOKEN.finditer(text or ''):
            w = (words(m.group(0)) or [m.group(0).lower()])[0]
            toks.append({'w': w, 'start': m.start(), 'end': m.end(), 'raw': m.group(0)})

        def sentence_start(i):
            j = i
            while j > 0 and not _BREAK.search(text[toks[j - 1]['end']:toks[j]['start']]):
                j -= 1
            return j

        def edge(w):  # a phrase never starts or ends with a stop word or a negation cue
            return w in STOP or w in negation

        used = [False] * len(toks)
        candidates = []
        for n in range(self.max_ngram, 0, -1):
            for i in range(0, len(toks) - n + 1):
                if any(used[i:i + n]):
                    continue
                span = toks[i:i + n]
                if edge(span[0]['w']) or edge(span[n - 1]['w']) or (n == 1 and len(span[0]['w']) < 5):
                    continue
                phrase = ' '.join(t['w'] for t in span)
                try:
                    res = self.ts.expand(implicit_ecl(cs['binding']['ecl']), filter=phrase, count=5,
                                         display_language=language, include_designations=True)
                except FhirError:
                    continue
                best = pick_best(res['contains'], lang, [t['w'] for t in span])
                if not best:
                    continue
                for k in range(i, i + n):
                    used[k] = True
                s0 = sentence_start(i)
                negated = any(t['w'] in negation for t in toks[s0:i])
                candidates.append({
                    'start': span[0]['start'], 'end': span[n - 1]['end'],
                    'text': text[span[0]['start']:span[n - 1]['end']],
                    'conceptId': best['code'], 'term': best['term'], 'pt': best['display'],
                    'confidence': best['score'], 'negated': negated,
                })
        candidates.sort(key=lambda c: c['start'])
        return {'service': 'demo reference text analyser (dictionary look-up, not a real NLP engine)',
                'language': language, 'careSet': care_set, 'candidates': candidates}


def pick_best(contains, lang, phrase_words):
    """Accept a result only when one of its designations covers the phrase closely."""
    best = None
    for c in contains:
        for d in c.get('designation') or []:
            if (d.get('language') or '')[:2] != lang or (d.get('use') or {}).get('code') == FSN:
                continue
            dw = words(d.get('value') or '')

            # every word of the phrase must match a word of the description: exactly, or with a
            # short inflection (knie/knieën)
            def close(x, w):
                return x == w or (x.startswith(w) and len(x) - len(w) <= 2) \
                    or (w.startswith(x) and len(w) - len(x) <= 2)

            if not all(any(close(x, w) for x in dw) for w in phrase_words):
                continue
            score = round(len(phrase_words) / max(len(dw), len(phrase_words)), 2)
            if score >= 0.6 and (best is None or score > best['score']
                                 or (score == best['score'] and len(d['value']) < len(best['term']))):
                best = {'code': c.get('code'), 'term': d.get('value'), 'display': c.get('display'),
                        'score': score}
    return best


def call_suggestion_service(url, payload, trace=None, timeout=20):
    """eHR-side adapter: calls the configured tool over HTTP (the contract above)."""
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
    started = time.time()
    status = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            status = res.getcode()
            out = json.loads(res.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        status = e.code
        raise RuntimeError('suggestion service returned HTTP %s' % e.code)
    except urllib.error.URLError as e:
        raise RuntimeError('suggestion service unreachable: %s' % e.reason)
    finally:
        if trace is not None:
            trace.append({'op': 'text analysis service', 'method': 'POST', 'url': url,
                          'status': status, 'ms': int(round((time.time() - started) * 1000))})
    return out
