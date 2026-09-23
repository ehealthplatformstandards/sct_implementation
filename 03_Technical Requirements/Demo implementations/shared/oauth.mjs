// Optional authentication for a terminology server that is not local, for example the Belgian national
// terminology server (NTS). Nothing is stored in this repository: the credentials come from the environment.
//
//   TS_BEARER_TOKEN                                  a token you already have (simplest, but it expires)
//   TS_TOKEN_URL + TS_CLIENT_ID + TS_CLIENT_SECRET   OAuth2 client credentials; the token is fetched and
//   [TS_SCOPE]                                       cached here, and renewed shortly before it expires
//
// Every script and the eHR call tokenFromEnv() and pass the result to FhirTerminologyClient({ bearerToken }).
// It returns undefined when nothing is configured, which is the normal case for a local server.

/** Token provider for the OAuth2 client credentials grant, with in-memory caching. */
export function clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope, skewSeconds = 30 }) {
  let cached = null;
  return async () => {
    if (cached && cached.expires > Date.now()) return cached.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (scope) body.set('scope', scope);
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token endpoint ${tokenUrl}: HTTP ${res.status} ${text.slice(0, 200)}`);
    let json; try { json = JSON.parse(text); } catch { throw new Error(`token endpoint ${tokenUrl}: response is not JSON`); }
    if (!json.access_token) throw new Error(`token endpoint ${tokenUrl}: no access_token in the response`);
    cached = { token: json.access_token, expires: Date.now() + (Number(json.expires_in) || 300) * 1000 - skewSeconds * 1000 };
    return cached.token;
  };
}

/**
 * Token provider built from environment variables, or undefined when none are set.
 * @param {object} [env]
 * @param {string} [prefix] variable prefix, default TS (TS_BEARER_TOKEN, TS_TOKEN_URL, ...)
 */
export function tokenFromEnv(env = process.env, prefix = 'TS') {
  const v = (name) => env[`${prefix}_${name}`];
  if (v('BEARER_TOKEN')) return () => v('BEARER_TOKEN');
  if (v('TOKEN_URL') && v('CLIENT_ID') && v('CLIENT_SECRET')) {
    return clientCredentialsToken({ tokenUrl: v('TOKEN_URL'), clientId: v('CLIENT_ID'), clientSecret: v('CLIENT_SECRET'), scope: v('SCOPE') });
  }
  return undefined;
}
