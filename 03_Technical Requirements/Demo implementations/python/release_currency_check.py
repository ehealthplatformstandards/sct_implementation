#!/usr/bin/env python3
"""Demo 1 in Python - TSP3 Belgian Edition release currency.

"The SNOMED CT release used by the production solution shall not be more than one month behind the
 most recent Belgian Edition published by the BE NRC."

The production version is read from the terminology server (CodeSystem?url=http://snomed.info/sct).
The most recent published version comes from one of these sources:

    --upstream <FHIR base>   a FHIR terminology server that lists the published versions, for example
                             the Belgian national terminology server; credentials come from the
                             UPSTREAM_* or TS_* environment variables (see README.md)
    --release-info <files>   release_package_information.json of downloaded Belgian Edition packages
                             (effectiveTime + previousPublishedPackage give the publication chain)
    --latest YYYYMMDD        manual value

Meant to run on a schedule (daily): the exit code is 1 when the production version is too old.
The result uses the distance in months between the effective times. Two other readings of "one month
behind" (number of newer releases, days since the newest release) are reported as information.

This is the Python version of ``01-terminology-services/release-currency-check.mjs``.

Usage:
    python3 release_currency_check.py --fhir http://localhost:8090/fhir --release-info a.json,b.json
    python3 release_currency_check.py --fhir https://<server>/fhir --latest 20260915

Example implementation for discussion - not a normative test suite.
"""

import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fhir_ts import (BE_MODULE, FhirTerminologyClient, parse_version_uri,  # noqa: E402
                     ssl_context_from_env, token_from_env)
from report import Report, esc  # noqa: E402


def year_month(effective_time):
    return int(effective_time[0:4]) * 12 + int(effective_time[4:6]) - 1


def as_date(effective_time):
    return datetime.date(int(effective_time[0:4]), int(effective_time[4:6]), int(effective_time[6:8]))


def main():
    p = argparse.ArgumentParser(description='TSP3: is the production SNOMED CT release recent enough?')
    p.add_argument('--fhir', default='http://localhost:8090/fhir', help='FHIR base URL of the production server')
    p.add_argument('--upstream', help='FHIR base URL that lists the published Belgian Edition versions')
    p.add_argument('--release-info', help='comma-separated release_package_information.json files')
    p.add_argument('--latest', help='most recent published effective time (YYYYMMDD)')
    p.add_argument('--max-lag-months', type=int, default=1, help='allowed lag in months (default 1)')
    p.add_argument('--id', default='tsp3-release-currency-python', help='report id (file name)')
    p.add_argument('--note', help='free text shown in the report')
    p.add_argument('--out', default=None, help='output folder for the report (default: ./reports)')
    p.add_argument('--timeout', type=int, default=60, help='request timeout in seconds')
    p.add_argument('--ca-bundle', default=None, help='extra CA bundle (corporate TLS proxy)')
    a = p.parse_args()
    if not (a.upstream or a.release_info or a.latest):
        p.error('give --upstream, --release-info or --latest')

    ctx = ssl_context_from_env(a.ca_bundle)
    ts = FhirTerminologyClient(a.fhir, timeout=a.timeout, ssl_context=ctx,
                               bearer_token=token_from_env(ssl_context=ctx))
    r = Report(id=a.id, title='Belgian Edition release currency', requirements=['TSP3'], report_dir=a.out,
               intro='Compares the SNOMED CT version used in production (read from the terminology server) '
                     'with the most recent Belgian Edition published by the NRC. The requirement allows a '
                     'lag of at most one month.')

    trace = []
    versions = ts.snomed_versions(trace=trace)
    prod_uri = versions[0]['version'] if versions else None
    prod = parse_version_uri(prod_uri)
    r.meta['Terminology server'] = a.fhir
    r.meta['Production version'] = prod_uri
    r.meta['Run with'] = 'Python %d.%d.%d' % sys.version_info[:3]
    if not prod:
        r.check(name='Production edition is a Belgian Edition', req='TSP3',
                expected='module %s' % BE_MODULE, actual=prod_uri or 'no SNOMED CT CodeSystem found',
                status='fail', request=trace[-1]['url'] if trace else None)
        r.write()
        return 1

    # ------------------------------------------------------------- published versions
    published = []
    if a.upstream:
        up = FhirTerminologyClient(a.upstream, timeout=a.timeout, ssl_context=ctx,
                                   bearer_token=token_from_env(prefix='UPSTREAM', ssl_context=ctx)
                                   or token_from_env(ssl_context=ctx))
        for v in up.snomed_versions(trace=trace):
            parsed = parse_version_uri(v['version'])
            if parsed and parsed['module'] == BE_MODULE:
                published.append(parsed['effectiveTime'])
        source = 'FHIR CodeSystem versions on %s' % a.upstream
    elif a.release_info:
        files = [f.strip() for f in a.release_info.split(',') if f.strip()]
        for path in files:
            with open(path, encoding='utf-8') as f:
                info = json.load(f)
            published.append(str(info.get('effectiveTime')))
            previous = re.search(r'_(\d{8})T\d{6}Z\.zip$', info.get('previousPublishedPackage') or '')
            if previous:
                published.append(previous.group(1))
        source = 'release_package_information.json of %d Belgian Edition package(s)' % len(files)
    else:
        published = [a.latest]
        source = 'manual (--latest)'

    published = sorted(set(v for v in published if re.match(r'^\d{8}$', v or '')))
    if not published:
        r.check(name='Published Belgian Edition versions found', req='TSP3', expected='at least one',
                actual='none', status='fail', detail=source)
        r.write()
        return 1
    latest = published[-1]
    r.meta['Source of published versions'] = source
    r.meta['Published Belgian Edition versions known'] = ', '.join(published)
    if a.note:
        r.meta['Note'] = a.note

    lag = year_month(latest) - year_month(prod['effectiveTime'])
    newer = [v for v in published if v > prod['effectiveTime']]
    days = (datetime.date.today() - as_date(latest)).days
    days_text = ('%d day(s) since %s' % (days, latest) if days >= 0
                 else 'effective time %s is %d day(s) in the future' % (latest, -days))

    r.check(name='Production edition is a Belgian Edition', req='TSP3', expected='module %s' % BE_MODULE,
            actual=prod['module'], status='pass' if prod['module'] == BE_MODULE else 'fail')
    r.check(name='Months between the production version and the most recent published Belgian Edition',
            req='TSP3',
            detail='production %s vs. most recent %s; newer releases not deployed: %s'
                   % (prod['effectiveTime'], latest, ', '.join(newer) or 'none'),
            expected='<= %d month' % a.max_lag_months, actual='%d month(s)' % lag,
            status='pass' if lag <= a.max_lag_months else 'fail')
    # Other ways to read "not more than one month behind" (shown for discussion, not used for the result)
    r.check(name='Published releases newer than the production version', req='TSP3',
            detail='Another reading of the requirement: at most one release behind. '
                   'Not used for the result of this check.',
            actual='%d (%s)' % (len(newer), ', '.join(newer) or 'none'), status='info')
    r.check(name='Days since the effective time of the most recent release', req='TSP3',
            detail='How long the newest release has been available '
                   '(effective time used as the publication date).',
            actual=days_text, status='info')

    rows = ''.join(
        '<tr><td class="mono">%s</td><td>%s</td></tr>' % (
            esc(v),
            '<b>in production</b>' if v == prod['effectiveTime']
            else ('<span class="bad">published, not deployed</span>' if v > prod['effectiveTime'] else 'older'))
        for v in reversed(published))
    verdict = ('<span class="ok"><b>Compliant.</b></span>' if lag <= a.max_lag_months
               else '<span class="bad"><b>Not compliant:</b></span> deploy %s (controlled deployment, TSP4).'
                    % esc(latest))
    r.block('Published Belgian Edition versions and the production version',
            '<table><tr><th>Effective time</th><th>Status</th></tr>%s</table>'
            '<p style="font-size:13px">%s The check can run daily from a scheduler '
            '(Windows Task Scheduler, cron); the exit code is non-zero when the production version '
            'is too old.</p>' % (rows, verdict))
    r.write()
    return 0 if r.ok else 1


if __name__ == '__main__':
    sys.exit(main())
