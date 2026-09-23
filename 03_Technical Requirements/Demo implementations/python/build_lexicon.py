#!/usr/bin/env python3
"""Build the word lexicon and the Description ID index from an RF2 Snapshot folder (U01, U02).

Python counterpart of ``ehr-demo-app/build-lexicon.mjs``. The cache format is identical, so the file
written here can also be used by the Node demo and vice versa.

    python3 build_lexicon.py /path/to/SnomedCT_ManagedServiceBE_.../Snapshot
    python3 build_lexicon.py C:\\snomed\\rf2\\...\\Snapshot --out data/lexicon-cache.json

The lexicon is only used to rewrite the query (plural and feminine forms, decompounding, one
character spelling mistakes) and to resolve a Description ID. Every result and every recorded code
is still checked by the terminology server. Rebuild it whenever the production edition changes.

Example implementation for discussion - not a normative implementation.
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lexicon import build_from_rf2, load_cache, save_cache  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    p = argparse.ArgumentParser(description='Build the lexicon cache from an RF2 Snapshot folder.')
    p.add_argument('snapshot', help='RF2 Snapshot folder of the Belgian Edition')
    p.add_argument('--out', default=os.path.join(HERE, 'data', 'lexicon-cache.json'),
                   help='cache file to write (default: python/data/lexicon-cache.json)')
    p.add_argument('--languages', default='nl,fr,de,en', help='comma-separated language codes')
    a = p.parse_args()

    if not os.path.isdir(a.snapshot):
        raise SystemExit('not a folder: %s' % a.snapshot)
    t0 = time.time()
    built = build_from_rf2(a.snapshot, languages=tuple(x.strip() for x in a.languages.split(',') if x.strip()))
    save_cache(a.out, built)
    size = os.path.getsize(a.out) / (1024 * 1024)
    print('[lexicon] cache written to %s (%.1f MB, %.0f s)' % (a.out, size, time.time() - t0))

    # read it back, so a broken cache is noticed here and not at the first search
    check = load_cache(a.out)
    print('[lexicon] verified: %s, %d active descriptions'
          % (', '.join('%s %d words' % (k, len(v.sorted)) for k, v in check['lexicons'].items()),
             check['descriptionIndex'].size))
    return 0


if __name__ == '__main__':
    sys.exit(main())
