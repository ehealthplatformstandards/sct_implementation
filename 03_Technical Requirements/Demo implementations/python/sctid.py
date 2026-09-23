"""SNOMED CT identifier helpers (SCTID) - Python version of ``shared/sctid.mjs``.

An SCTID is a 6-18 digit integer whose last digit is a Verhoeff check digit and whose second- and
third-last digits form the "partition identifier":
    00 / 10 = concept, 01 / 11 = description, 02 / 12 = relationship
(x0 = short format, x1 = long format with namespace). See the SNOMED CT Technical Implementation
Guide, section "SCTID data type".

Used by U02 (search by Concept ID / Description ID) so that a typed number is only treated as an
identifier when it is structurally valid.
"""

import re

_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

_PARTITIONS = {
    '00': ('concept', 'short'), '01': ('description', 'short'), '02': ('relationship', 'short'),
    '10': ('concept', 'long'), '11': ('description', 'long'), '12': ('relationship', 'long'),
}


def verhoeff_valid(number):
    """True when the full string (including its last digit) passes the Verhoeff check."""
    c = 0
    for i, digit in enumerate(reversed(str(number))):
        c = _D[c][_P[i % 8][int(digit)]]
    return c == 0


def classify_sctid(text):
    """Classify a string as an SCTID: {'valid': bool, 'kind': ..., 'format': ..., 'reason': ...}."""
    s = str(text or '').strip()
    if not re.match(r'^\d{6,18}$', s):
        return {'valid': False, 'reason': 'not a 6-18 digit number'}
    if s.startswith('0'):
        return {'valid': False, 'reason': 'leading zero'}
    if not verhoeff_valid(s):
        return {'valid': False, 'reason': 'Verhoeff check digit mismatch'}
    partition = s[-3:-1]
    if partition not in _PARTITIONS:
        return {'valid': False, 'reason': 'unknown partition identifier %s' % partition}
    kind, fmt = _PARTITIONS[partition]
    return {'valid': True, 'kind': kind, 'format': fmt,
            'namespace': s[-10:-3] if fmt == 'long' else None}


def is_concept_id(text):
    return classify_sctid(text).get('kind') == 'concept'


def is_description_id(text):
    return classify_sctid(text).get('kind') == 'description'
