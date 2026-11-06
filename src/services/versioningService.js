'use strict';

/**
 * versioningService.js
 * Dataset version lifecycle: create new versions, roll back to a previous
 * one (re-publishing it in GeoServer when applicable), and compare two
 * versions of a dataset.
 */

const { query, withTransaction } = require('../db/pool');

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
function assertSafeIdent(name, label) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`Identificador inválido para ${label}: ${name}`);
  }
  return name;
}

/**
 * Register a new version of a dataset's PostGIS table and make it the
 * dataset's current version.
 *
 * @param {number} datasetId
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} [opts.schema='datos']
 * @param {object} [opts.bbox]
 * @param {number} [opts.srid]
 * @param {number} [opts.conteoRegistros]
 * @param {string} [opts.hashContenido]
 * @returns {Promise<object>} the new ide.dataset_versions row
 */
async function crearVersion(datasetId, { tableName, schema = 'datos', bbox, srid, conteoRegistros, hashContenido } = {}) {
  if (!tableName) {
    throw new Error('crearVersion requiere tableName');
  }

  return withTransaction(async (txQuery) => {
    const dsRes = await txQuery('SELECT id FROM ide.datasets WHERE id = $1 FOR UPDATE', [datasetId]);
    if (dsRes.rowCount === 0) {
      throw new Error(`Dataset ${datasetId} no existe`);
    }

    const maxRes = await txQuery(
      'SELECT COALESCE(MAX(numero_version), 0) AS max_version FROM ide.dataset_versions WHERE dataset_id = $1',
      [datasetId]
    );
    const numeroVersion = Number(maxRes.rows[0].max_version) + 1;

    const insertRes = await txQuery(
      `INSERT INTO ide.dataset_versions
          (dataset_id, numero_version, tabla_postgis, schema_postgis, bbox, srid, conteo_registros, hash_contenido, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'activa')
       RETURNING *`,
      [
        datasetId,
        numeroVersion,
        tableName,
        schema,
        bbox ? JSON.stringify(bbox) : null,
        srid || null,
        conteoRegistros ?? null,
        hashContenido || null,
      ]
    );
    const version = insertRes.rows[0];

    await txQuery(
      `UPDATE ide.dataset_versions SET estado = 'historica'
        WHERE dataset_id = $1 AND id <> $2 AND estado = 'activa'`,
      [datasetId, version.id]
    );

    await txQuery('UPDATE ide.datasets SET version_actual_id = $2, updated_at = NOW() WHERE id = $1', [
      datasetId,
      version.id,
    ]);

    return version;
  });
}

/**
 * Roll a dataset back to a previous version: flips version_actual_id and,
 * when the dataset has an associated GeoServer layer, re-publishes it
 * pointing at the target version's PostGIS table.
 *
 * @param {number} datasetId
 * @param {number} versionId  an ide.dataset_versions.id belonging to datasetId
 * @returns {Promise<{dataset:object, version:object}>}
 */
async function rollback(datasetId, versionId) {
  const versionRes = await query('SELECT * FROM ide.dataset_versions WHERE id = $1 AND dataset_id = $2', [
    versionId,
    datasetId,
  ]);
  if (versionRes.rowCount === 0) {
    throw new Error(`Versión ${versionId} no encontrada para el dataset ${datasetId}`);
  }
  const targetVersion = versionRes.rows[0];

  const dsRes = await query('SELECT * FROM ide.datasets WHERE id = $1', [datasetId]);
  if (dsRes.rowCount === 0) {
    throw new Error(`Dataset ${datasetId} no existe`);
  }
  const dataset = dsRes.rows[0];

  await query(
    `UPDATE ide.dataset_versions
        SET estado = CASE WHEN id = $2 THEN 'activa' ELSE 'historica' END
      WHERE dataset_id = $1`,
    [datasetId, versionId]
  );

  await query('UPDATE ide.datasets SET version_actual_id = $2, updated_at = NOW() WHERE id = $1', [
    datasetId,
    versionId,
  ]);

  if (dataset.geoserver_workspace && dataset.geoserver_layer) {
    try {
      const geoserverService = require('./geoserverService');
      await geoserverService.publicarCapa({
        workspace: dataset.geoserver_workspace,
        tableName: targetVersion.tabla_postgis,
        layerName: dataset.geoserver_layer,
        srid: targetVersion.srid || 4326,
        schema: targetVersion.schema_postgis || 'datos',
      });
      console.log(
        `[versioningService] Rollback dataset ${datasetId} → versión ${versionId}: capa GeoServer re-publicada (nativeName=${targetVersion.tabla_postgis})`
      );
    } catch (err) {
      console.error(`[versioningService] Rollback dataset ${datasetId}: error al re-publicar en GeoServer:`, err.message);
    }
  } else {
    console.log(`[versioningService] Rollback dataset ${datasetId} → versión ${versionId} (sin capa GeoServer asociada)`);
  }

  const updatedDsRes = await query('SELECT * FROM ide.datasets WHERE id = $1', [datasetId]);
  return { dataset: updatedDsRes.rows[0], version: targetVersion };
}

async function inspeccionarVersion(version) {
  const schema = assertSafeIdent(version.schema_postgis || 'datos', 'schema_postgis');
  const tabla = assertSafeIdent(version.tabla_postgis, 'tabla_postgis');

  let registros = null;
  try {
    const r = await query(`SELECT COUNT(*)::INT AS n FROM ${schema}.${tabla}`);
    registros = r.rows[0].n;
  } catch (err) {
    registros = null;
  }

  let bbox = null;
  try {
    const r = await query(`SELECT ST_Extent(geom)::TEXT AS extent FROM ${schema}.${tabla}`);
    bbox = (r.rows[0] && r.rows[0].extent) || null;
  } catch (err) {
    bbox = null;
  }

  let columnas = [];
  try {
    const r = await query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schema, tabla]
    );
    columnas = r.rows.map((row) => ({ nombre: row.column_name, tipo: row.data_type }));
  } catch (err) {
    columnas = [];
  }

  return {
    id: version.id,
    numero_version: version.numero_version,
    tabla_postgis: version.tabla_postgis,
    schema_postgis: version.schema_postgis,
    conteo_registros: registros,
    bbox,
    columnas,
  };
}

/**
 * Compare two versions of a dataset: record counts, bbox and column-level
 * schema differences.
 *
 * @param {number} datasetId
 * @param {number} versionIdA
 * @param {number} versionIdB
 * @returns {Promise<{a:object, b:object, diff:object}>}
 */
async function compararVersiones(datasetId, versionIdA, versionIdB) {
  const res = await query('SELECT * FROM ide.dataset_versions WHERE dataset_id = $1 AND id = ANY($2::int[])', [
    datasetId,
    [versionIdA, versionIdB],
  ]);
  const versionA = res.rows.find((r) => r.id === versionIdA);
  const versionB = res.rows.find((r) => r.id === versionIdB);
  if (!versionA || !versionB) {
    throw new Error(`No se encontraron ambas versiones (${versionIdA}, ${versionIdB}) para el dataset ${datasetId}`);
  }

  const [a, b] = await Promise.all([inspeccionarVersion(versionA), inspeccionarVersion(versionB)]);

  const nombresA = new Set(a.columnas.map((col) => col.nombre));
  const nombresB = new Set(b.columnas.map((col) => col.nombre));
  const columnasAgregadas = [...nombresB].filter((n) => !nombresA.has(n));
  const columnasEliminadas = [...nombresA].filter((n) => !nombresB.has(n));

  const diff = {
    registros: (b.conteo_registros ?? 0) - (a.conteo_registros ?? 0),
    columnas_agregadas: columnasAgregadas,
    columnas_eliminadas: columnasEliminadas,
  };

  return { a, b, diff };
}

module.exports = { crearVersion, rollback, compararVersiones };
