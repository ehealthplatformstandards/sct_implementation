// Minimal HL7 FHIR R4 terminology client used by all demos (no dependencies, Node >= 18 or browser).
//
// It only uses the standard FHIR terminology operations required by TSP1/TSP2:
//   CodeSystem/$lookup, CodeSystem/$validate-code, ValueSet/$expand, ValueSet/$validate-code,
//   ConceptMap/$translate, CodeSystem/$subsumes, and the CodeSystem search (for version info).
// Nothing in here is specific to one terminology server product: point `baseUrl` at a
// Snowstorm Lite, Snowstorm, Ontoserver, ... endpoint that serves the Belgian Edition.
//
// Every call can be recorded in a `trace` array ({op, method, url, status, ms}) so the demos can
// show exactly which FHIR requests were made and how long they took.

export const SNOMED = 'http://snomed.info/sct';
export const BE_MODULE = '11000172109'; // SNOMED CT Belgium module (Belgian Edition)

/** SNOMED CT implicit value set / concept map URLs (http://hl7.org/fhir/R4/snomedct.html#implicit). */
export const implicit = {
  ecl: (ecl) => `${SNOMED}?fhir_vs=ecl/${ecl}`,
  refset: (refsetId) => `${SNOMED}?fhir_vs=refset/${refsetId}`,
  isa: (conceptId) => `${SNOMED}?fhir_vs=isa/${conceptId}`,
  conceptMap: (refsetId) => `${SNOMED}?fhir_cm=${refsetId}`,
};

/** Edition / version URI helpers (SNOMED CT URI Standard). */
export const editionUri = (module = BE_MODULE) => `${SNOMED}/${module}`;
export const versionUri = (effectiveTime, module = BE_MODULE) => `${SNOMED}/${module}/version/${effectiveTime}`;
export function parseVersionUri(uri) {
  const m = /^http:\/\/snomed\.info\/sct\/(\d+)\/version\/(\d{8})$/.exec(uri || '');
  return m ? { module: m[1], effectiveTime: m[2] } : null;
}

/** Convert a FHIR Parameters resource into a plain object (repeating names become arrays). */
export function parametersToObject(parameters) {
  const out = {};
  for (const p of parameters?.parameter || []) {
    let v;
    if (p.part) v = parametersToObject({ parameter: p.part });
    else {
      const key = Object.keys(p).find((k) => k.startsWith('value'));
      v = key ? p[key] : undefined;
    }
    if (out[p.name] === undefined) out[p.name] = v;
    else if (Array.isArray(out[p.name]) && out[`__multi_${p.name}`]) out[p.name].push(v);
    else { out[p.name] = [out[p.name], v]; out[`__multi_${p.name}`] = true; }
  }
  for (const k of Object.keys(out)) if (k.startsWith('__multi_')) delete out[k];
  return out;
}

const asArray = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export class FhirTerminologyClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  FHIR base, e.g. http://localhost:8090/fhir
   * @param {string} [opts.systemVersion]  pin all SNOMED CT calls to one edition version URI (TSP5)
   * @param {number} [opts.timeoutMs]
   * @param {() => Promise<string|undefined>|string|undefined} [opts.bearerToken] optional OAuth2 token provider (e.g. Belgian NTS)
   */
  constructor({ baseUrl, systemVersion, timeoutMs = 10000, bearerToken, name = 'terminology' } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.systemVersion = systemVersion;
    this.timeoutMs = timeoutMs;
    this.bearerToken = bearerToken;
    this.name = name;
  }

  async request(op, path, params = {}, { method = 'GET', body, trace, headers = {} } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const item of asArray(v)) if (item !== undefined && item !== null && item !== '') qs.append(k, String(item));
    }
    const url = `${this.baseUrl}/${path}${qs.toString() ? `?${qs}` : ''}`;
    // An explicit Accept-Language avoids the runtime default ('*'), which some servers reject.
    const h = { Accept: 'application/fhir+json', 'Accept-Language': params.displayLanguage || 'en', ...headers };
    const token = typeof this.bearerToken === 'function' ? await this.bearerToken() : this.bearerToken;
    if (token) h.Authorization = `Bearer ${token}`;
    if (body) h['Content-Type'] = 'application/fhir+json';
    const t0 = performance.now();
    let status = 0; let json; let error;
    try {
      const res = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
      status = res.status;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
      if (!res.ok) error = new FhirError(op, status, json, url);
    } catch (e) {
      error = e instanceof FhirError ? e : new FhirError(op, 0, { message: e.message }, url);
    }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (trace) trace.push({ op, method, url: safeDecode(url), status, ms, server: this.name });
    if (error) throw error;
    return json;
  }

  // Version pinning (TSP5). The R4 parameter names differ per operation:
  //   $expand: system-version (canonical|version), $validate-code: systemVersion, $lookup: version.

  /**
   * ValueSet/$expand, e.g. expand({url: implicit.refset('40811000172108'), filter: 'astma', count: 20}).
   * Inactive concepts are removed from `contains` unless includeInactive is set: some servers return
   * inactive reference set members (flagged contains[].inactive = true) even with activeOnly=true.
   */
  async expand({ url, filter, count = 20, offset, displayLanguage, activeOnly = true, includeInactive = false, includeDesignations, property, trace }) {
    const vs = await this.request('ValueSet/$expand', 'ValueSet/$expand', {
      url, filter, count, offset, displayLanguage, activeOnly, includeDesignations, property,
      'system-version': this.systemVersion ? `${SNOMED}|${this.systemVersion}` : undefined,
    }, { trace });
    const usedVersion = (vs?.expansion?.parameter || []).find((p) => p.name === 'version')?.valueUri?.split('|')[1];
    if (this.systemVersion && usedVersion && usedVersion !== this.systemVersion) {
      throw new VersionMismatchError(this.systemVersion, usedVersion, 'ValueSet/$expand');
    }
    const all = vs?.expansion?.contains || [];
    const contains = includeInactive ? all : all.filter((c) => c.inactive !== true);
    return { total: vs?.expansion?.total, contains, inactiveRemoved: all.length - contains.length, usedVersion, raw: vs };
  }

  /** ValueSet/$validate-code: is `code` a member of the value set (binding) - and active? */
  async validateInValueSet({ url, code, system = SNOMED, display, displayLanguage, trace }) {
    const p = await this.request('ValueSet/$validate-code', 'ValueSet/$validate-code', {
      url, system, code, display, displayLanguage, systemVersion: this.systemVersion,
    }, { trace });
    return parametersToObject(p);
  }

  /** CodeSystem/$validate-code: does the code exist (and is the display valid) in SNOMED CT? */
  async validateInCodeSystem({ code, display, displayLanguage, trace }) {
    const p = await this.request('CodeSystem/$validate-code', 'CodeSystem/$validate-code', {
      url: SNOMED, code, display, displayLanguage, version: this.systemVersion,
    }, { trace });
    return parametersToObject(p);
  }

  /** CodeSystem/$lookup with optional properties (parent, child, inactive, normalForm, ...). */
  async lookup({ code, displayLanguage, property, trace }) {
    const p = await this.request('CodeSystem/$lookup', 'CodeSystem/$lookup', {
      system: SNOMED, code, displayLanguage, property, version: this.systemVersion,
    }, { trace });
    return normaliseLookup(p);
  }

  /** ConceptMap/$translate on an implicit SNOMED CT concept map (historical associations, ICD-10, ...). */
  async translate({ url, code, system = SNOMED, targetSystem, reverse, trace }) {
    const p = await this.request('ConceptMap/$translate', 'ConceptMap/$translate', {
      url, system, code, targetsystem: targetSystem, reverse,
    }, { trace });
    const o = parametersToObject(p);
    return { result: o.result, message: o.message, matches: asArray(o.match), raw: p };
  }

  async subsumes({ codeA, codeB, trace }) {
    const p = await this.request('CodeSystem/$subsumes', 'CodeSystem/$subsumes', { system: SNOMED, codeA, codeB, version: this.systemVersion }, { trace });
    return parametersToObject(p).outcome;
  }

  /** Which SNOMED CT edition/version(s) does this server expose? */
  async snomedVersions({ trace } = {}) {
    const b = await this.request('CodeSystem?url', 'CodeSystem', { url: SNOMED }, { trace });
    return (b?.entry || []).map((e) => ({ version: e.resource.version, title: e.resource.title, date: e.resource.date, id: e.resource.id }));
  }

  async metadata({ trace } = {}) {
    return this.request('metadata', 'metadata', {}, { trace });
  }
}

/** Raised when the terminology server answers with another SNOMED CT version than the pinned production version (TSP5). */
export class VersionMismatchError extends Error {
  constructor(expected, actual, op) {
    super(`${op}: terminology server used ${actual} but the production version is ${expected} (TSP5 version consistency).`);
    this.expected = expected; this.actual = actual; this.status = 409;
  }
}

export class FhirError extends Error {
  constructor(op, status, body, url) {
    const issue = body?.issue?.[0];
    super(`${op} failed (HTTP ${status}): ${issue?.diagnostics || issue?.details?.text || body?.message || 'no details'}`);
    this.status = status; this.body = body; this.url = url; this.op = op;
  }
}

function safeDecode(u) { try { return decodeURIComponent(u); } catch { return u; } }

/** Flatten $lookup output: designations and properties become arrays of simple objects. */
export function normaliseLookup(parameters) {
  const out = { designation: [], property: [] };
  for (const p of parameters?.parameter || []) {
    if (p.name === 'designation') {
      const d = {};
      for (const part of p.part || []) {
        if (part.name === 'language') d.language = part.valueCode;
        if (part.name === 'use') d.use = part.valueCoding;
        if (part.name === 'value') d.value = part.valueString;
      }
      out.designation.push(d);
    } else if (p.name === 'property') {
      const prop = {};
      for (const part of p.part || []) {
        if (part.name === 'code') prop.code = part.valueCode;
        else if (part.name === 'description') prop.description = part.valueString;
        else if (part.name === 'value') {
          const key = Object.keys(part).find((k) => k.startsWith('value'));
          prop.value = part[key];
        } else if (part.name === 'subproperty') {
          prop.subproperty = prop.subproperty || [];
          const sp = {};
          for (const x of part.part || []) {
            if (x.name === 'code') sp.code = x.valueCode;
            if (x.name === 'value') { const k = Object.keys(x).find((kk) => kk.startsWith('value')); sp.value = x[k]; }
          }
          prop.subproperty.push(sp);
        }
      }
      out.property.push(prop);
    } else {
      const key = Object.keys(p).find((k) => k.startsWith('value'));
      out[p.name] = key ? p[key] : undefined;
    }
  }
  out.prop = (code) => out.property.filter((x) => x.code === code).map((x) => x.value);
  return out;
}
