"""Minimal HL7 FHIR R4 terminology client - Python standard library only.

This is the Python counterpart of ``shared/fhir-ts-client.mjs`` and ``shared/oauth.mjs``.
It exists so that the Demo 1 checks can be run on a machine that has Python but no Node.js,
no Java 17 and no Docker: point ``--fhir`` at any FHIR R4 terminology server that serves the
SNOMED CT Belgian Edition (a local Snowstorm Lite, a Snowstorm, an Ontoserver, ...).

Only the standard FHIR terminology operations are used:
    CodeSystem/$lookup, CodeSystem/$validate-code, CodeSystem/$subsumes,
    ValueSet/$expand, ValueSet/$validate-code, ConceptMap/$translate,
    and the CodeSystem search (for the version information).

Requires Python 3.8 or later. No third-party packages.

Example implementation for discussion - not a normative test suite.
"""

import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

SNOMED = 'http://snomed.info/sct'
BE_MODULE = '11000172109'  # SNOMED CT Belgium module (Belgian Edition)

USER_AGENT = 'sct-demo-python/1.0 (FHIR R4 terminology checks)'


# --------------------------------------------------------------------------- implicit URLs
# SNOMED CT implicit value sets / concept maps, http://hl7.org/fhir/R4/snomedct.html#implicit

def implicit_ecl(ecl):
    return '%s?fhir_vs=ecl/%s' % (SNOMED, ecl)


def implicit_refset(refset_id):
    return '%s?fhir_vs=refset/%s' % (SNOMED, refset_id)


def implicit_isa(concept_id):
    return '%s?fhir_vs=isa/%s' % (SNOMED, concept_id)


def implicit_concept_map(refset_id):
    return '%s?fhir_cm=%s' % (SNOMED, refset_id)


def edition_uri(module=BE_MODULE):
    return '%s/%s' % (SNOMED, module)


def version_uri(effective_time, module=BE_MODULE):
    return '%s/%s/version/%s' % (SNOMED, module, effective_time)


def parse_version_uri(uri):
    """http://snomed.info/sct/11000172109/version/20260915 -> {'module': ..., 'effectiveTime': ...}"""
    prefix = SNOMED + '/'
    if not uri or not uri.startswith(prefix) or '/version/' not in uri:
        return None
    module, _, effective = uri[len(prefix):].partition('/version/')
    if not module.isdigit() or not (len(effective) == 8 and effective.isdigit()):
        return None
    return {'module': module, 'effectiveTime': effective}


# --------------------------------------------------------------------------- errors

class FhirError(Exception):
    def __init__(self, op, status, body, url):
        issue = (body or {}).get('issue') or [{}]
        details = (issue[0].get('diagnostics')
                   or (issue[0].get('details') or {}).get('text')
                   or (body or {}).get('message')
                   or 'no details')
        Exception.__init__(self, '%s failed (HTTP %s): %s' % (op, status, details))
        self.op = op
        self.status = status
        self.body = body
        self.url = url


class VersionMismatchError(Exception):
    """The server answered with another SNOMED CT version than the pinned production version (TSP5)."""

    def __init__(self, expected, actual, op):
        Exception.__init__(self, '%s: terminology server used %s but the production version is %s '
                                 '(TSP5 version consistency).' % (op, actual, expected))
        self.expected = expected
        self.actual = actual
        self.status = 409


# --------------------------------------------------------------------------- FHIR Parameters

def parameters_to_object(parameters):
    """Turn a FHIR Parameters resource into a plain dict (repeating names become lists)."""
    out = {}
    multi = set()
    for p in (parameters or {}).get('parameter') or []:
        if 'part' in p:
            value = parameters_to_object({'parameter': p['part']})
        else:
            key = next((k for k in p if k.startswith('value')), None)
            value = p[key] if key else None
        name = p.get('name')
        if name not in out:
            out[name] = value
        elif name in multi:
            out[name].append(value)
        else:
            out[name] = [out[name], value]
            multi.add(name)
    return out


class LookupResult(dict):
    """$lookup output with the designations and properties flattened."""

    def prop(self, code):
        return [p.get('value') for p in self.get('property', []) if p.get('code') == code]

    @property
    def display(self):
        return self.get('display')

    @property
    def designation(self):
        return self.get('designation', [])


def normalise_lookup(parameters):
    out = LookupResult(designation=[], property=[])
    for p in (parameters or {}).get('parameter') or []:
        name = p.get('name')
        if name == 'designation':
            d = {}
            for part in p.get('part') or []:
                if part.get('name') == 'language':
                    d['language'] = part.get('valueCode')
                elif part.get('name') == 'use':
                    d['use'] = part.get('valueCoding')
                elif part.get('name') == 'value':
                    d['value'] = part.get('valueString')
            out['designation'].append(d)
        elif name == 'property':
            prop = {}
            for part in p.get('part') or []:
                pname = part.get('name')
                if pname == 'code':
                    prop['code'] = part.get('valueCode')
                elif pname == 'description':
                    prop['description'] = part.get('valueString')
                elif pname == 'value':
                    key = next((k for k in part if k.startswith('value')), None)
                    prop['value'] = part[key] if key else None
                elif pname == 'subproperty':
                    sub = {}
                    for x in part.get('part') or []:
                        if x.get('name') == 'code':
                            sub['code'] = x.get('valueCode')
                        elif x.get('name') == 'value':
                            key = next((k for k in x if k.startswith('value')), None)
                            sub['value'] = x[key] if key else None
                    prop.setdefault('subproperty', []).append(sub)
            out['property'].append(prop)
        else:
            key = next((k for k in p if k.startswith('value')), None)
            out[name] = p[key] if key else None
    return out


# --------------------------------------------------------------------------- OAuth2 (optional)
# Nothing is stored in this repository: credentials come from the environment.
#   TS_BEARER_TOKEN                                  a token you already have (simplest, but it expires)
#   TS_TOKEN_URL + TS_CLIENT_ID + TS_CLIENT_SECRET   OAuth2 client credentials; the token is fetched
#   [TS_SCOPE]                                       here and cached until shortly before it expires

def client_credentials_token(token_url, client_id, client_secret, scope=None, skew_seconds=30,
                             ssl_context=None, timeout=20):
    """Return a callable that yields a cached access token for the client credentials grant."""
    cache = {'token': None, 'expires': 0.0}

    def get_token():
        if cache['token'] and cache['expires'] > time.time():
            return cache['token']
        form = {'grant_type': 'client_credentials', 'client_id': client_id, 'client_secret': client_secret}
        if scope:
            form['scope'] = scope
        data = urllib.parse.urlencode(form).encode('utf-8')
        req = urllib.request.Request(token_url, data=data, method='POST', headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'User-Agent': USER_AGENT,
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as res:
                body = res.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            raise RuntimeError('token endpoint %s: HTTP %s %s'
                               % (token_url, e.code, e.read().decode('utf-8', 'replace')[:200]))
        except urllib.error.URLError as e:
            raise RuntimeError('token endpoint %s: %s' % (token_url, e.reason))
        try:
            payload = json.loads(body)
        except ValueError:
            raise RuntimeError('token endpoint %s: response is not JSON' % token_url)
        if not payload.get('access_token'):
            raise RuntimeError('token endpoint %s: no access_token in the response' % token_url)
        cache['token'] = payload['access_token']
        cache['expires'] = time.time() + float(payload.get('expires_in') or 300) - skew_seconds
        return cache['token']

    return get_token


def token_from_env(env=None, prefix='TS', ssl_context=None):
    """Token provider built from environment variables, or None when nothing is configured."""
    env = os.environ if env is None else env

    def v(name):
        return env.get('%s_%s' % (prefix, name))

    if v('BEARER_TOKEN'):
        return lambda: v('BEARER_TOKEN')
    if v('TOKEN_URL') and v('CLIENT_ID') and v('CLIENT_SECRET'):
        return client_credentials_token(v('TOKEN_URL'), v('CLIENT_ID'), v('CLIENT_SECRET'),
                                        scope=v('SCOPE'), ssl_context=ssl_context)
    return None


def ssl_context_from_env(ca_bundle=None, env=None):
    """Default TLS verification, optionally with an extra CA bundle (corporate proxy, --ca-bundle)."""
    env = os.environ if env is None else env
    ca = ca_bundle or env.get('TS_CA_BUNDLE')
    ctx = ssl.create_default_context()
    if ca:
        ctx.load_verify_locations(cafile=ca)
    return ctx


# --------------------------------------------------------------------------- client

class FhirTerminologyClient(object):
    """FHIR R4 terminology client.

    :param base_url: FHIR base, e.g. http://localhost:8090/fhir
    :param system_version: pin every SNOMED CT call to one edition version URI (TSP5)
    :param bearer_token: str, or a callable returning a token (see token_from_env)
    """

    def __init__(self, base_url, system_version=None, timeout=30, bearer_token=None,
                 name='terminology', ssl_context=None):
        if not base_url:
            raise ValueError('base_url is required')
        self.base_url = base_url.rstrip('/')
        self.system_version = system_version
        self.timeout = timeout
        self.bearer_token = bearer_token
        self.name = name
        self.ssl_context = ssl_context or ssl.create_default_context()

    # -- plumbing ----------------------------------------------------------
    def request(self, op, path, params=None, method='GET', body=None, trace=None, headers=None):
        pairs = []
        for key, value in (params or {}).items():
            values = value if isinstance(value, (list, tuple)) else [value]
            for item in values:
                if item is None or item == '':
                    continue
                if item is True:
                    item = 'true'
                elif item is False:
                    item = 'false'
                pairs.append((key, str(item)))
        query = urllib.parse.urlencode(pairs, quote_via=urllib.parse.quote)
        url = '%s/%s%s' % (self.base_url, path, ('?' + query) if query else '')
        # An explicit Accept-Language avoids the runtime default ('*'), which some servers reject.
        head = {
            'Accept': 'application/fhir+json',
            'Accept-Language': (params or {}).get('displayLanguage') or 'en',
            'User-Agent': USER_AGENT,
        }
        head.update(headers or {})
        token = self.bearer_token() if callable(self.bearer_token) else self.bearer_token
        if token:
            head['Authorization'] = 'Bearer ' + token
        payload = None
        if body is not None:
            payload = json.dumps(body).encode('utf-8')
            head['Content-Type'] = 'application/fhir+json'

        req = urllib.request.Request(url, data=payload, method=method, headers=head)
        started = time.time()
        status = 0
        parsed = None
        error = None
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ssl_context) as res:
                status = res.getcode()
                text = res.read().decode('utf-8', 'replace')
                parsed = json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            status = e.code
            text = e.read().decode('utf-8', 'replace')
            try:
                parsed = json.loads(text) if text else None
            except ValueError:
                parsed = {'raw': text}
            error = FhirError(op, status, parsed, url)
        except urllib.error.URLError as e:
            error = FhirError(op, 0, {'message': str(e.reason)}, url)
        except ValueError as e:  # body was not JSON
            error = FhirError(op, status, {'message': 'response is not JSON: %s' % e}, url)
        ms = round((time.time() - started) * 1000, 1)
        if trace is not None:
            trace.append({'op': op, 'method': method, 'url': urllib.parse.unquote(url),
                          'status': status, 'ms': ms, 'server': self.name})
        if error:
            raise error
        return parsed

    # -- operations --------------------------------------------------------
    # Version pinning (TSP5). The R4 parameter names differ per operation:
    #   $expand: system-version (canonical|version), $validate-code: systemVersion, $lookup: version.

    def expand(self, url, filter=None, count=20, offset=None, display_language=None,
               active_only=True, include_inactive=False, include_designations=None,
               property=None, trace=None):
        """ValueSet/$expand.

        Inactive concepts are removed from ``contains`` unless include_inactive is set: some servers
        return inactive reference set members (contains[].inactive = true) even with activeOnly=true.
        """
        vs = self.request('ValueSet/$expand', 'ValueSet/$expand', {
            'url': url, 'filter': filter, 'count': count, 'offset': offset,
            'displayLanguage': display_language, 'activeOnly': active_only,
            'includeDesignations': include_designations, 'property': property,
            'system-version': ('%s|%s' % (SNOMED, self.system_version)) if self.system_version else None,
        }, trace=trace)
        expansion = (vs or {}).get('expansion') or {}
        used_version = None
        for p in expansion.get('parameter') or []:
            if p.get('name') == 'version':
                # the server reports "<canonical>|<version>"; some report the version URI alone
                parts = (p.get('valueUri') or '').split('|')
                used_version = parts[1] if len(parts) > 1 else None
        if self.system_version and used_version and used_version != self.system_version:
            raise VersionMismatchError(self.system_version, used_version, 'ValueSet/$expand')
        every = expansion.get('contains') or []
        contains = every if include_inactive else [c for c in every if c.get('inactive') is not True]
        return {'total': expansion.get('total'), 'contains': contains,
                'inactiveRemoved': len(every) - len(contains), 'usedVersion': used_version, 'raw': vs}

    def validate_in_valueset(self, url, code, system=SNOMED, display=None,
                             display_language=None, trace=None):
        """ValueSet/$validate-code: is ``code`` a member of the value set (binding) - and active?"""
        return parameters_to_object(self.request('ValueSet/$validate-code', 'ValueSet/$validate-code', {
            'url': url, 'system': system, 'code': code, 'display': display,
            'displayLanguage': display_language, 'systemVersion': self.system_version,
        }, trace=trace))

    def validate_in_codesystem(self, code, display=None, display_language=None, trace=None):
        """CodeSystem/$validate-code: does the code exist (and is the display valid) in SNOMED CT?"""
        return parameters_to_object(self.request('CodeSystem/$validate-code', 'CodeSystem/$validate-code', {
            'url': SNOMED, 'code': code, 'display': display,
            'displayLanguage': display_language, 'version': self.system_version,
        }, trace=trace))

    def lookup(self, code, display_language=None, property=None, trace=None):
        """CodeSystem/$lookup with optional properties (parent, child, inactive, normalForm, ...)."""
        return normalise_lookup(self.request('CodeSystem/$lookup', 'CodeSystem/$lookup', {
            'system': SNOMED, 'code': code, 'displayLanguage': display_language,
            'property': property, 'version': self.system_version,
        }, trace=trace))

    def translate(self, url, code, system=SNOMED, target_system=None, reverse=None, trace=None):
        """ConceptMap/$translate on an implicit SNOMED CT concept map (history, ICD-10, ...)."""
        params = parameters_to_object(self.request('ConceptMap/$translate', 'ConceptMap/$translate', {
            'url': url, 'system': system, 'code': code,
            'targetsystem': target_system, 'reverse': reverse,
        }, trace=trace))
        match = params.get('match')
        matches = [] if match is None else (match if isinstance(match, list) else [match])
        return {'result': params.get('result'), 'message': params.get('message'), 'matches': matches}

    def subsumes(self, code_a, code_b, trace=None):
        params = parameters_to_object(self.request('CodeSystem/$subsumes', 'CodeSystem/$subsumes', {
            'system': SNOMED, 'codeA': code_a, 'codeB': code_b, 'version': self.system_version,
        }, trace=trace))
        return params.get('outcome')

    def snomed_versions(self, trace=None):
        """Which SNOMED CT edition/version(s) does this server expose?"""
        bundle = self.request('CodeSystem?url', 'CodeSystem', {'url': SNOMED}, trace=trace)
        out = []
        for entry in (bundle or {}).get('entry') or []:
            resource = entry.get('resource') or {}
            out.append({'version': resource.get('version'), 'title': resource.get('title'),
                        'date': resource.get('date'), 'id': resource.get('id')})
        return out

    def metadata(self, trace=None):
        return self.request('metadata', 'metadata', {}, trace=trace)
