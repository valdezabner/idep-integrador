'use strict';

/**
 * geoserverService.js
 * Thin REST client for GeoServer: workspaces, PostGIS datastores,
 * featuretypes, layers, styles, and config snapshot/restore.
 */

const config = require('../config');

// ── internal helpers ──────────────────────────────────────────────────────

function authHeader() {
  const token = Buffer.from(`${config.GEOSERVER_ADMIN_USER}:${config.GEOSERVER_ADMIN_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Parse a Postgres connection string into GeoServer datastore connection
 * parameters using the WHATWG URL parser.
 */
function parseDbUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  return {
    host: u.hostname,
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username || ''),
    passwd: decodeURIComponent(u.password || ''),
  };
}

/**
 * Low level fetch wrapper: builds the full GeoServer REST URL, adds Basic
 * auth + JSON headers, and normalises the response.
 *
 * @param {string} path            REST path, e.g. '/rest/workspaces'
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object|string} [opts.body]
 * @param {object} [opts.headers]
 * @param {boolean} [opts.allow404=false]  return null instead of throwing on 404
 * @param {boolean} [opts.raw=false]       return the raw response text instead of parsing JSON
 * @returns {Promise<any>}
 */
async function gsFetch(path, opts = {}) {
  const { method = 'GET', body, headers = {}, allow404 = false, raw = false } = opts;
  const url = `${config.GEOSERVER_URL}${path.startsWith('/') ? path : `/${path}`}`;

  const finalHeaders = {
    Authorization: authHeader(),
    Accept: 'application/json',
    ...headers,
  };
  if (body !== undefined && !finalHeaders['Content-Type']) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`GeoServer no accesible (${method} ${path}): ${err.message}`);
  }

  if (resp.status === 404 && allow404) return null;

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GeoServer ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  if (resp.status === 204) return null;
  if (raw) return resp.text();

  const contentType = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (!text) return null;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }
  return text;
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Ensure a GeoServer workspace exists, creating it if necessary.
 * @param {string} workspace
 */
async function ensureWorkspace(workspace) {
  const existing = await gsFetch(`/rest/workspaces/${encodeURIComponent(workspace)}.json`, { allow404: true });
  if (existing) return existing;

  await gsFetch('/rest/workspaces', {
    method: 'POST',
    body: { workspace: { name: workspace } },
  });
  return { workspace: { name: workspace } };
}

/**
 * Ensure a PostGIS datastore exists inside a workspace, (re)creating it with
 * the connection parameters derived from config.DATABASE_URL when missing.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} [opts.datastore='postgis']
 * @param {string} [opts.schema='datos']
 */
async function ensureDatastore({ workspace, datastore = 'postgis', schema = 'datos' }) {
  await ensureWorkspace(workspace);

  const existing = await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}.json`, { allow404: true });
  if (existing) return existing;

  const db = parseDbUrl(config.DATABASE_URL);
  const body = {
    dataStore: {
      name: datastore,
      connectionParameters: {
        entry: [
          { '@key': 'dbtype', $: 'postgis' },
          { '@key': 'host', $: db.host },
          { '@key': 'port', $: db.port },
          { '@key': 'database', $: db.database },
          { '@key': 'schema', $: schema },
          { '@key': 'user', $: db.user },
          { '@key': 'passwd', $: db.passwd },
          { '@key': 'validate connections', $: 'true' },
          { '@key': 'Expose primary keys', $: 'true' },
        ],
      },
    },
  };

  await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}`, { method: 'PUT', body });
  return body;
}

/**
 * Publish a PostGIS table as a WMS/WFS layer.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} [opts.datastore='postgis']
 * @param {string} opts.tableName     nativeName in PostGIS (schema-less)
 * @param {string} opts.layerName     published layer name
 * @param {number} [opts.srid=4326]
 * @param {string} [opts.schema='datos']
 * @param {string} [opts.styleName]
 * @returns {Promise<{wmsUrl:string, wfsUrl:string}>}
 */
async function publicarCapa({ workspace, datastore = 'postgis', tableName, layerName, srid = 4326, schema = 'datos', styleName }) {
  if (!workspace || !tableName || !layerName) {
    throw new Error('publicarCapa requiere workspace, tableName y layerName');
  }

  await ensureWorkspace(workspace);
  await ensureDatastore({ workspace, datastore, schema });

  await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes`, {
    method: 'PUT',
    body: {
      featureType: {
        name: layerName,
        nativeName: tableName,
        srs: `EPSG:${srid}`,
      },
    },
  });

  if (styleName) {
    await assignStyle({ workspace, layer: layerName, styleName });
  }

  return {
    wmsUrl: `${config.GEOSERVER_URL}/${workspace}/wms`,
    wfsUrl: `${config.GEOSERVER_URL}/${workspace}/wfs`,
  };
}

/**
 * Take a JSON snapshot of a service's GeoServer configuration
 * (workspace, datastore, featuretype, layer and, if any, its SLD).
 *
 * @param {object} service  a row of ide.services (workspace, layer_name, [datastore])
 */
async function snapshot(service) {
  const workspace = service.workspace;
  const layerName = service.layer_name;
  const datastore = service.datastore || 'postgis';

  const result = { workspace: null, datastore: null, featuretype: null, layer: null, sld: null };

  try {
    result.workspace = await gsFetch(`/rest/workspaces/${workspace}.json`, { allow404: true });
  } catch (err) {
    result.workspace = { error: err.message };
  }

  try {
    result.datastore = await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}.json`, { allow404: true });
  } catch (err) {
    result.datastore = { error: err.message };
  }

  try {
    result.featuretype = await gsFetch(
      `/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes/${layerName}.json`,
      { allow404: true }
    );
  } catch (err) {
    result.featuretype = { error: err.message };
  }

  let layer = null;
  try {
    layer = await gsFetch(`/rest/layers/${workspace}:${layerName}.json`, { allow404: true });
    result.layer = layer;
  } catch (err) {
    result.layer = { error: err.message };
  }

  try {
    const styleName = layer && layer.layer && layer.layer.defaultStyle && layer.layer.defaultStyle.name;
    if (styleName) {
      result.sld = await gsFetch(`/rest/workspaces/${workspace}/styles/${styleName}.sld`, {
        allow404: true,
        raw: true,
        headers: { Accept: 'application/vnd.ogc.sld+xml' },
      });
      if (!result.sld) {
        result.sld = await gsFetch(`/rest/styles/${styleName}.sld`, {
          allow404: true,
          raw: true,
          headers: { Accept: 'application/vnd.ogc.sld+xml' },
        });
      }
    }
  } catch (err) {
    result.sld = null;
  }

  return result;
}

/**
 * Restore a service's GeoServer configuration from a snapshot produced by
 * `snapshot()`. Idempotent: every step is a PUT that creates-or-replaces.
 *
 * @param {object} snapshotObj  output of snapshot()
 * @param {object} service      row of ide.services (workspace, layer_name, [datastore])
 */
async function restore(snapshotObj, service) {
  const workspace = service.workspace;
  const layerName = service.layer_name;
  const datastore = service.datastore || 'postgis';

  if (!workspace || !layerName) {
    throw new Error('restore requiere service.workspace y service.layer_name');
  }

  if (snapshotObj.workspace && !snapshotObj.workspace.error) {
    await gsFetch(`/rest/workspaces/${workspace}`, { method: 'PUT', body: snapshotObj.workspace });
  } else {
    await ensureWorkspace(workspace);
  }

  if (snapshotObj.datastore && !snapshotObj.datastore.error) {
    const dsBody = JSON.parse(JSON.stringify(snapshotObj.datastore));
    try {
      const db = parseDbUrl(config.DATABASE_URL);
      const entries = dsBody && dsBody.dataStore && dsBody.dataStore.connectionParameters && dsBody.dataStore.connectionParameters.entry;
      if (Array.isArray(entries)) {
        const passEntry = entries.find((e) => e['@key'] === 'passwd');
        if (passEntry) passEntry.$ = db.passwd;
        else entries.push({ '@key': 'passwd', $: db.passwd });
      }
    } catch (err) {
      console.error('[geoserverService] No se pudo refrescar la contraseña del datastore en restore():', err.message);
    }
    await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}`, { method: 'PUT', body: dsBody });
  }

  if (snapshotObj.featuretype && !snapshotObj.featuretype.error) {
    await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes/${layerName}`, {
      method: 'PUT',
      body: snapshotObj.featuretype,
    });
  }

  if (snapshotObj.layer && !snapshotObj.layer.error) {
    await gsFetch(`/rest/layers/${workspace}:${layerName}`, { method: 'PUT', body: snapshotObj.layer });
  }

  if (snapshotObj.sld) {
    const styleName =
      snapshotObj.layer && snapshotObj.layer.layer && snapshotObj.layer.layer.defaultStyle && snapshotObj.layer.layer.defaultStyle.name;
    if (styleName) {
      await publishStyle({ name: styleName, sldContent: snapshotObj.sld });
    }
  }

  return true;
}

/**
 * Create (if missing) and/or update a style's SLD content.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.sldContent
 */
async function publishStyle({ name, sldContent }) {
  const existing = await gsFetch(`/rest/styles/${name}.json`, { allow404: true });
  if (!existing) {
    await gsFetch('/rest/styles', {
      method: 'POST',
      body: { style: { name, filename: `${name}.sld` } },
    });
  }

  await gsFetch(`/rest/styles/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/vnd.ogc.sld+xml' },
    body: sldContent,
  });

  return { name };
}

/**
 * Assign a style as the default style of a published layer.
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.layer
 * @param {string} opts.styleName
 */
async function assignStyle({ workspace, layer, styleName }) {
  await gsFetch(`/rest/layers/${workspace}:${layer}`, {
    method: 'PUT',
    body: { layer: { defaultStyle: { name: styleName } } },
  });
  return { workspace, layer, styleName };
}

/**
 * Remove a published layer and its underlying featuretype.
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.layerName
 * @param {string} [opts.datastore='postgis']
 */
async function deleteLayer({ workspace, layerName, datastore = 'postgis' }) {
  await gsFetch(`/rest/layers/${workspace}:${layerName}`, { method: 'DELETE', allow404: true });
  try {
    await gsFetch(`/rest/workspaces/${workspace}/datastores/${datastore}/featuretypes/${layerName}`, {
      method: 'DELETE',
      allow404: true,
    });
  } catch (err) {
    console.error(`[geoserverService] No se pudo eliminar el featuretype ${layerName}:`, err.message);
  }
  return { deleted: true };
}

module.exports = {
  ensureWorkspace,
  ensureDatastore,
  publicarCapa,
  snapshot,
  restore,
  publishStyle,
  assignStyle,
  deleteLayer,
};
