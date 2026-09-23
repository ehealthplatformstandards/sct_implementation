"""Word lexicon and Description ID index built from an RF2 Snapshot (U01, U02).

Python counterpart of ``ehr-demo-app/lib/lexicon.mjs``. The lexicon is used only to *rewrite the
query* (plural and feminine forms, decompounding, one-character spelling mistakes) and to resolve a
Description ID. Every result and every recorded code is still checked by the terminology server.

The on-disk cache uses exactly the same format as the Node version, so a cache built by
``ehr-demo-app/build-lexicon.mjs`` can be read here and vice versa.

Standard library only; requires Python 3.8 or later.
"""

import array
import base64
import bisect
import json
import math
import os
import re
import time
import unicodedata

FSN = '900000000000003001'

STOPWORDS = {
    'nl': set('van met en de het een bij door voor zonder na in op of aan als uit tot ten ter naar '
              'over onder niet geen'.split()),
    'de': set('der die das und von mit bei durch fur ohne nach im in an auf aus zum zur des dem den '
              'ein eine oder nicht kein'.split()),
}

_WORD_SPLIT = re.compile(r'[^a-z0-9]+')
_DIGITS = re.compile(r'\d')


def fold(text):
    """Lower-case and remove diacritics (the terminology server folds characters the same way)."""
    s = unicodedata.normalize('NFD', str(text).lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return s.replace('œ', 'oe').replace('æ', 'ae').replace('ß', 'ss')


def words(text):
    """Split a (folded) term into word tokens."""
    return [w for w in _WORD_SPLIT.split(fold(text)) if w]


def damerau_levenshtein(a, b):
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


class Lexicon(object):
    def __init__(self, lang):
        self.lang = lang
        self.freq = {}      # word -> number of descriptions containing it
        self.sorted = []    # sorted word list, for prefix checks
        self.deletes = None  # one-delete index for typo correction

    def add(self, term):
        for w in set(words(term)):
            self.freq[w] = self.freq.get(w, 0) + 1

    def finish(self):
        self.sorted = sorted(self.freq)
        return self

    def has(self, w):
        return w in self.freq

    def count(self, w):
        return self.freq.get(w, 0)

    def has_prefix(self, prefix):
        """Is `prefix` the beginning of at least one word?"""
        i = bisect.bisect_left(self.sorted, prefix)
        return i < len(self.sorted) and self.sorted[i].startswith(prefix)

    def prefix_weight(self, prefix, cap=200):
        """Total frequency of the words starting with `prefix` (capped scan, used for scoring)."""
        i = bisect.bisect_left(self.sorted, prefix)
        total = 0
        n = 0
        while i < len(self.sorted) and n < cap and self.sorted[i].startswith(prefix):
            total += self.freq[self.sorted[i]]
            i += 1
            n += 1
        return total

    # ---------------------------------------------------------------- typo correction
    def build_deletes(self, min_length=4):
        self.deletes = {}
        for w, f in self.freq.items():
            if len(w) < min_length or f < 2 or _DIGITS.search(w):
                continue
            for i in range(len(w)):
                d = w[:i] + w[i + 1:]
                lst = self.deletes.get(d)
                if lst is None:
                    self.deletes[d] = [w]
                elif len(lst) < 30:
                    lst.append(w)

    def corrections(self, token):
        """Words at Damerau-Levenshtein distance 1 from `token`, most frequent first."""
        if len(token) < 5:
            return []
        if self.deletes is None:
            self.build_deletes()
        candidates = set()
        candidates.update(self.deletes.get(token, ()))      # token has one extra character
        if token in self.freq:
            return []
        for i in range(len(token)):
            d = token[:i] + token[i + 1:]
            candidates.update(self.deletes.get(d, ()))      # substitution / transposition
            if self.freq.get(d, 0) >= 2:
                candidates.add(d)                           # token has one character too many
        hits = [w for w in candidates if w != token and damerau_levenshtein(w, token) == 1]
        hits.sort(key=lambda w: -self.count(w))
        return hits[:3]

    # ---------------------------------------------------------------- plural / feminine variants
    def variants(self, token):
        """Candidate base forms (light, rule-based; kept only if the base form is a known word)."""
        out = set()
        t = token

        def add(w):
            if w and len(w) >= 3 and w != t and self.freq.get(w, 0) >= 2:
                out.add(w)

        if self.lang == 'nl':
            if t.endswith("'s"):
                add(t[:-2])
            if t.endswith('s'):
                add(t[:-1])                                             # infecties -> infectie
            if t.endswith('en'):
                b = t[:-2]
                add(b)
                add(b + 'e')                                            # ziekten -> ziekte
                m = re.match(r'^(.*[^aeiou])([aeiou])([^aeiou])$', b)   # fracturen -> fractuur
                if m:
                    add('%s%s%s%s' % (m.group(1), m.group(2), m.group(2), m.group(3)))
                if re.search(r'([bcdfgklmnprstvz])\1$', b):
                    add(b[:-1])                                         # wratten -> wrat
                if b.endswith('er'):
                    add(b[:-2])                                         # kinderen -> kind
            if not t.endswith('en') and t.endswith('n') and re.search(r'[ie]n$', t):
                add(t[:-1])
        elif self.lang == 'fr':
            if t.endswith('aux'):
                add(t[:-3] + 'al')                                      # medicaux -> medical
            if t and t[-1] in 'sx':
                add(t[:-1])                                             # fractures -> fracture
            u = re.sub(r'[sx]$', '', t)
            fem = [(r'iere$', 'ier'), (r'ere$', 'er'), (r'euse$', 'eux'), (r'euse$', 'eur'),
                   (r'ive$', 'if'), (r'elle$', 'el'), (r'enne$', 'en'), (r'ette$', 'et'),
                   (r'ee$', 'e'), (r'ale$', 'al'), (r'aire$', 'aire'), (r'que$', 'que'), (r'e$', '')]
            for pattern, rep in fem:
                if re.search(pattern, u):
                    add(re.sub(pattern, rep, u))
        elif self.lang == 'de':
            for suf in ('en', 'n', 'e', 'er', 's', 'es'):
                if t.endswith(suf):
                    add(t[:-len(suf)])
        else:
            if t.endswith('ies'):
                add(t[:-3] + 'y')
            if t.endswith('ves'):
                add(t[:-3] + 'f')
            if t.endswith('es'):
                add(t[:-2])
            if t.endswith('s'):
                add(t[:-1])
        return sorted(out, key=lambda w: -self.count(w))

    # ---------------------------------------------------------------- decompounding
    def decompound(self, token, last_token_prefix=False, min_part=3, min_tail=4, depth=0):
        """Split a compound token into known words, e.g. nl "heupprothese" -> ["heup", "prothese"].

        Linking elements (nl "s", "e", "en"; de "s", "n", "en", "es") may join the parts. When
        `last_token_prefix` is true the final part may be the prefix of a word (still typing).
        """
        if self.lang not in ('nl', 'de') or len(token) < min_part + min_tail:
            return None
        links = ['', 's', 'e', 'en'] if self.lang == 'nl' else ['', 's', 'n', 'en', 'es', 'e']
        stop = STOPWORDS[self.lang]
        best = None
        for i in range(min_part, len(token) - min_tail + 1):
            head, tail = token[:i], token[i:]
            if tail in stop:
                continue
            for link in links:
                if link and not head.endswith(link):
                    continue
                # "niersteen": prefer nier + steen over nier + s + teen when the letters start a word
                if link and self.count(link + tail) >= 1:
                    continue
                left = head[:-len(link)] if link else head
                if len(left) < min_part or left in stop or self.count(left) < 3:
                    continue
                right_parts = None
                right_score = 0.0
                if self.count(tail) >= 2:
                    right_parts = [tail]
                    right_score = math.log(1 + self.count(tail))
                elif last_token_prefix and self.has_prefix(tail):
                    right_parts = [tail]
                    right_score = math.log(1 + self.prefix_weight(tail)) - 1
                elif depth == 0:
                    sub = self.decompound(tail, last_token_prefix, min_part, min_tail, depth=1)
                    if sub:
                        right_parts = sub['parts']
                        right_score = sub['score'] - 1
                if not right_parts:
                    continue
                # prefer frequent parts and splits without a linking element
                score = math.log(1 + self.count(left)) + right_score - (1.5 if link else 0)
                if best is None or score > best['score']:
                    best = {'parts': [left] + list(right_parts), 'score': score, 'link': link}
        return best


class DescriptionIndex(object):
    """Sorted Description ID -> Concept ID index (U02)."""

    def __init__(self, desc_ids=None, concept_ids=None):
        # array('q') keeps 1.5 million descriptions in ~24 MB instead of ~110 MB as Python ints
        if desc_ids is None:
            self.ids, self.concepts = array.array('q'), array.array('q')
        else:
            order = sorted(range(len(desc_ids)), key=lambda i: desc_ids[i])
            self.ids = array.array('q', (desc_ids[i] for i in order))
            self.concepts = array.array('q', (concept_ids[i] for i in order))
        self.size = len(self.ids)

    def concept_for(self, description_id):
        try:
            key = int(description_id)
        except (TypeError, ValueError):
            return None
        i = bisect.bisect_left(self.ids, key)
        if i < len(self.ids) and self.ids[i] == key:
            return str(self.concepts[i])
        return None


# --------------------------------------------------------------------------- RF2 reading
def find_rf2_files(snapshot_dir, pattern):
    """Every file under `snapshot_dir` whose name matches `pattern` (compiled regex), sorted."""
    hits = []
    for root, _dirs, files in os.walk(snapshot_dir):
        for name in files:
            if pattern.search(name):
                hits.append(os.path.join(root, name))
    return sorted(hits)


def stream_rf2(path, on_row):
    """Call `on_row(fields)` for every data row of a tab-separated RF2 file (header skipped)."""
    n = 0
    with open(path, encoding='utf-8', newline='') as f:
        f.readline()  # header
        for line in f:
            if not line.strip():
                continue
            on_row(line.rstrip('\r\n').split('\t'))
            n += 1
    return n


def build_from_rf2(snapshot_dir, languages=('nl', 'fr', 'de', 'en'), log=print):
    """Build the lexicons and the Description ID index from an RF2 Snapshot folder."""
    t0 = time.time()
    active_concepts = set()
    concept_files = find_rf2_files(snapshot_dir, re.compile(r'^sct2_Concept_Snapshot.*\.txt$'))
    if not concept_files:
        raise SystemExit('no sct2_Concept_Snapshot file under %s' % snapshot_dir)

    def concept_row(r):
        if r[2] == '1':
            active_concepts.add(r[0])

    for f in concept_files:
        stream_rf2(f, concept_row)
    log('[lexicon] %d active concepts (%.0f ms)' % (len(active_concepts), (time.time() - t0) * 1000))

    lexicons = {}
    desc_ids = []
    desc_concepts = []
    for lang in languages:
        lex = Lexicon(lang)
        add = lex.add
        pattern = re.compile(r'^sct2_Description_Snapshot-%s_.*\.txt$' % lang)
        for f in find_rf2_files(snapshot_dir, pattern):
            def description_row(r, add=add):
                # id effectiveTime active moduleId conceptId languageCode typeId term caseSignificanceId
                if r[2] != '1' or r[4] not in active_concepts:
                    return
                if r[6] != FSN:
                    add(r[7])
                desc_ids.append(int(r[0]))
                desc_concepts.append(int(r[4]))
            stream_rf2(f, description_row)
        lexicons[lang] = lex.finish()
        log('[lexicon] %s: %d distinct words (%.0f ms)'
            % (lang, len(lex.sorted), (time.time() - t0) * 1000))

    index = DescriptionIndex(desc_ids, desc_concepts)
    log('[lexicon] description index: %d active descriptions (%.0f ms)'
        % (index.size, (time.time() - t0) * 1000))
    return {'lexicons': lexicons, 'descriptionIndex': index,
            'stats': {'ms': int((time.time() - t0) * 1000), 'activeConcepts': len(active_concepts)}}


# --------------------------------------------------------------------------- cache (same format as Node)
def save_cache(path, built):
    ids = built['descriptionIndex'].ids
    concepts = built['descriptionIndex'].concepts
    obj = {
        'v': 1,
        'lexicons': {k: [[w, f] for w, f in lex.freq.items()] for k, lex in built['lexicons'].items()},
        'desc': {
            'ids': base64.b64encode(ids.tobytes()).decode('ascii'),
            'concepts': base64.b64encode(concepts.tobytes()).decode('ascii'),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def load_cache(path):
    with open(path, encoding='utf-8') as f:
        obj = json.load(f)
    lexicons = {}
    for lang, entries in (obj.get('lexicons') or {}).items():
        lex = Lexicon(lang)
        lex.freq = dict(entries)
        lexicons[lang] = lex.finish()
    index = DescriptionIndex()
    desc = obj.get('desc') or {}
    if desc.get('ids'):
        raw_ids = base64.b64decode(desc['ids'])
        raw_concepts = base64.b64decode(desc['concepts'])
        index.ids = array.array('q')
        index.ids.frombytes(raw_ids)
        index.concepts = array.array('q')
        index.concepts.frombytes(raw_concepts)
        index.size = len(index.ids)
    return {'lexicons': lexicons, 'descriptionIndex': index}
