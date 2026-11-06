'use strict';

/**
 * geonetworkService.js
 * Push ISO 19139 XML records to an external GeoNetwork catalog (create or
 * update), authenticating with a Basic-auth session + XSRF token.
 */

const config = require('../config');

/**
 * Extract Set-Cookie header values from a fetch Response, handling both the
 * modern Headers.getSetCookie() (Node 20 undici) and single-header fallback.
 */
function extractSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    const cookies = resp.headers.getSetCookie();
    if (cookies && cookies.length) return cookies;
  }
  const single = resp.headers.get('set-cookie');
  return single ? [single] : [];
}

function buildCookieJar(setCookieHeaders) {
  const jar = {};
  for (const line of setCookieHeaders) {
    const first = line.split(';')[0];
    const idx = first.indexOf('=');
    if (idx === -1) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

/**
 * Establish a GeoNetwork session via Basic auth and capture the session
 * cookies plus the XSRF-TOKEN needed for state-changing requests.
 */
async function login() {
  const basic = 'Basic ' + Buffer.from(`${config.GEONETWORK_USER}:${config.GEONETWORK_PASS}`).toString('base64');

  const resp = await fetch(`${config.GEONETWORK_URL}/srv/api/me`, {
    method: 'GET',
    headers: { Authorization: basic, Accept: 'application/json' },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GeoNetwork login falló: HTTP ${resp.status} ${text.slice(0, 300)}`);
  }

  const jar = buildCookieJar(extractSetCookies(resp));
  const xsrfToken = jar['XSRF-TOKEN'];
  const cookieHeader = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return { basic, cookieHeader, xsrfToken };
}

/**
 * Best-effort extraction of the UUID assigned/updated by a GeoNetwork
 * records API response, which varies across GeoNetwork versions.
 */
function extractUuid(json, fallback) {
  if (!json || typeof json !== 'object') return fallback;

  if (json.metadataInfos && typeof json.metadataInfos === 'object') {
    const first = Object.values(json.metadataInfos)[0];
    if (Array.isArray(first) && first[0] && first[0].uuid) return first[0].uuid;
  }
  if (Array.isArray(json.uuids) && json.uuids.length) return json.uuids[0];
  if (Array.isArray(json.metadata) && json.metadata[0] && json.metadata[0].uuid) return json.metadata[0].uuid;
  if (json.uuid) return json.uuid;

  return fallback;
}

/**
 * Push an ISO 19139 XML record to GeoNetwork: creates a new record, or
 * updates an existing one when `gnUuid` is supplied.
 *
 * @param {string} xmlContent      ISO 19139 XML document
 * @param {string} fileIdentifier  local metadata_records.file_identifier (used as fallback uuid)
 * @param {string} [gnUuid]        existing GeoNetwork uuid to update; omit to create
 * @returns {Promise<{skipped:true, reason:string} | {gnUuid:string, status:'sincronizado'}>}
 */
async function pushRecord(xmlContent, fileIdentifier, gnUuid) {
  if (!config.GEONETWORK_URL) {
    return { skipped: true, reason: 'not_configured' };
  }

  try {
    const { basic, cookieHeader, xsrfToken } = await login();

    const headers = {
      'Content-Type': 'application/xml',
      Accept: 'application/json',
      Authorization: basic,
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;

    const method = gnUuid ? 'PUT' : 'POST';
    const url = gnUuid
      ? `${config.GEONETWORK_URL}/srv/api/records/${encodeURIComponent(gnUuid)}`
      : `${config.GEONETWORK_URL}/srv/api/records`;

    const resp = await fetch(url, { method, headers, body: xmlContent });
    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(`GeoNetwork ${method} ${url} → HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    let resultUuid = gnUuid || fileIdentifier;
    try {
      const json = text ? JSON.parse(text) : null;
      resultUuid = extractUuid(json, gnUuid || fileIdentifier);
    } catch (_) {
      // Non-JSON response body: keep the fallback uuid.
    }

    // `uuid` is included alongside `gnUuid` for callers (e.g. routes/v1/metadatos.js)
    // that read the GeoNetwork-assigned identifier as `result.uuid`.
    return { gnUuid: resultUuid, uuid: resultUuid, status: 'sincronizado' };
  } catch (err) {
    throw new Error(`Error al sincronizar con GeoNetwork: ${err.message}`);
  }
}

module.exports = { pushRecord };
