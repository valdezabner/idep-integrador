'use strict';

/**
 * catalogoObjetos.js
 * ISO 19110 feature catalogue (feature_catalogues / feature_types /
 * feature_attributes / attribute_domain_values) for IDE Nacional (IDEP).
 */

const { Router } = require('express');

const { query, withTransaction } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = Router();
router.use(authenticate);

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

/** Introspect information_schema.columns for a datos.<table> and build attribute rows. */
async function introspectColumns(tableName, schema = 'datos') {
  const { rows } = await query(
    `SELECT column_name, data_type, ordinal_position
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, tableName]
  );
  if (!rows.length) return null;

  const EXCLUDED = new Set(['geom', 'gid']);
  const geometryColumn = rows.find((c) => c.column_name === 'geom') || null;
  const attributes = rows
    .filter((c) => !EXCLUDED.has(c.column_name))
    .map((c, idx) => ({
      nombre: c.column_name,
      tipo_dato: c.data_type,
      orden: idx,
    }));

  return { attributes, geometryColumn: geometryColumn ? geometryColumn.column_name : null };
}

/** Build a nested catalogue response from flat SQL rows. */
async function loadCatalogueFull(catalogueId) {
  const { rows: catRows } = await query(
    'SELECT * FROM ide.feature_catalogues WHERE id = $1',
    [catalogueId]
  );
  if (!catRows.length) return null;
  const catalogue = catRows[0];

  const { rows: types } = await query(
    'SELECT * FROM ide.feature_types WHERE catalogue_id = $1 ORDER BY id',
    [catalogueId]
  );
  const typeIds = types.map((t) => t.id);

  let attributes = [];
  if (typeIds.length) {
    const { rows } = await query(
      `SELECT * FROM ide.feature_attributes WHERE feature_type_id = ANY($1::int[]) ORDER BY orden, id`,
      [typeIds]
    );
    attributes = rows;
  }

  const attrIds = attributes.map((a) => a.id);
  let domainValues = [];
  if (attrIds.length) {
    const { rows } = await query(
      `SELECT * FROM ide.attribute_domain_values WHERE attribute_id = ANY($1::int[]) ORDER BY id`,
      [attrIds]
    );
    domainValues = rows;
  }

  catalogue.tipos = types.map((t) => ({
    ...t,
    atributos: attributes
      .filter((a) => a.feature_type_id === t.id)
      .map((a) => ({
        ...a,
        dominio: domainValues.filter((d) => d.attribute_id === a.id),
      })),
  }));

  return catalogue;
}

async function pregenerar({ tableName, dataset_id, servicio_id, nombre, resProp }) {
  const introspected = await introspectColumns(tableName);
  if (!introspected) {
    const err = new Error(
      `No se encontró la tabla datos.${tableName}. Verifique que el dataset/servicio tenga datos cargados.`
    );
    err.statusCode = 404;
    throw err;
  }

  return withTransaction(async (txQuery) => {
    const catRes = await txQuery(
      `INSERT INTO ide.feature_catalogues (dataset_id, servicio_id, nombre)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [dataset_id || null, servicio_id || null, nombre]
    );
    const catalogue = catRes.rows[0];

    const typeRes = await txQuery(
      `INSERT INTO ide.feature_types (catalogue_id, nombre, tabla_postgis)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [catalogue.id, nombre, tableName]
    );
    const featureType = typeRes.rows[0];

    const attrRows = [];
    for (const attr of introspected.attributes) {
      const attrRes = await txQuery(
        `INSERT INTO ide.feature_attributes (feature_type_id, nombre, tipo_dato, orden)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [featureType.id, attr.nombre, attr.tipo_dato, attr.orden]
      );
      attrRows.push(attrRes.rows[0]);
    }

    return {
      ...catalogue,
      tipos: [
        {
          ...featureType,
          columna_geometria: introspected.geometryColumn,
          atributos: attrRows.map((a) => ({ ...a, dominio: [] })),
        },
      ],
    };
  });
}

// ── POST /dataset/:datasetId/pregenerar ─────────────────────────────────────
router.post('/dataset/:datasetId/pregenerar', async (req, res) => {
  try {
    const dsRes = await query(
      `SELECT d.id, d.nombre, d.entidad_id, dv.tabla_postgis
         FROM ide.datasets d
         LEFT JOIN ide.dataset_versions dv ON dv.id = d.version_actual_id
        WHERE d.id = $1`,
      [req.params.datasetId]
    );
    if (!dsRes.rows.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    const ds = dsRes.rows[0];

    if (!isAdminIde(req.user) && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!ds.tabla_postgis) {
      return res.status(409).json({ error: 'El dataset no tiene una versión activa con tabla PostGIS' });
    }

    const catalogue = await pregenerar({
      tableName: ds.tabla_postgis,
      dataset_id: ds.id,
      nombre: ds.nombre,
    });

    res.status(201).json({ data: catalogue });
  } catch (err) {
    console.error('[catalogoObjetos] POST /dataset/:datasetId/pregenerar error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor' });
  }
});

// ── POST /servicio/:servicioId/pregenerar ───────────────────────────────────
router.post('/servicio/:servicioId/pregenerar', async (req, res) => {
  try {
    const svcRes = await query(
      'SELECT id, nombre, entidad_id, replica_tabla FROM ide.services WHERE id = $1',
      [req.params.servicioId]
    );
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const svc = svcRes.rows[0];

    if (!isAdminIde(req.user) && svc.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!svc.replica_tabla) {
      return res.status(409).json({ error: 'El servicio no tiene una tabla de réplica configurada' });
    }

    const catalogue = await pregenerar({
      tableName: svc.replica_tabla,
      servicio_id: svc.id,
      nombre: svc.nombre,
    });

    res.status(201).json({ data: catalogue });
  } catch (err) {
    console.error('[catalogoObjetos] POST /servicio/:servicioId/pregenerar error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor' });
  }
});

// ── GET /dataset/:datasetId ──────────────────────────────────────────────────
router.get('/dataset/:datasetId', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM ide.feature_catalogues WHERE dataset_id = $1',
      [req.params.datasetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catálogo de objetos no encontrado' });

    const catalogue = await loadCatalogueFull(rows[0].id);
    res.json({ data: catalogue });
  } catch (err) {
    console.error('[catalogoObjetos] GET /dataset/:datasetId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /servicio/:servicioId ────────────────────────────────────────────────
router.get('/servicio/:servicioId', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM ide.feature_catalogues WHERE servicio_id = $1',
      [req.params.servicioId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catálogo de objetos no encontrado' });

    const catalogue = await loadCatalogueFull(rows[0].id);
    res.json({ data: catalogue });
  } catch (err) {
    console.error('[catalogoObjetos] GET /servicio/:servicioId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /dataset/:datasetId/xml ──────────────────────────────────────────────
router.get('/dataset/:datasetId/xml', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM ide.feature_catalogues WHERE dataset_id = $1',
      [req.params.datasetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catálogo de objetos no encontrado' });

    const catalogue = await loadCatalogueFull(rows[0].id);
    const xml = await require('../../services/iso19110Service').generar(catalogue);
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[catalogoObjetos] GET /dataset/:datasetId/xml error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /servicio/:servicioId/xml ────────────────────────────────────────────
router.get('/servicio/:servicioId/xml', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id FROM ide.feature_catalogues WHERE servicio_id = $1',
      [req.params.servicioId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catálogo de objetos no encontrado' });

    const catalogue = await loadCatalogueFull(rows[0].id);
    const xml = await require('../../services/iso19110Service').generar(catalogue);
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[catalogoObjetos] GET /servicio/:servicioId/xml error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /atributos/:id ────────────────────────────────────────────────────────
router.put('/atributos/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.feature_attributes WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Atributo no encontrado' });

    const { alias, definicion, tipo_dominio, obligatorio, dominio } = req.body || {};

    const result = await withTransaction(async (txQuery) => {
      const { rows } = await txQuery(
        `UPDATE ide.feature_attributes
            SET alias        = COALESCE($1, alias),
                definicion   = COALESCE($2, definicion),
                tipo_dominio = COALESCE($3, tipo_dominio),
                obligatorio  = COALESCE($4, obligatorio)
          WHERE id = $5
          RETURNING *`,
        [alias ?? null, definicion ?? null, tipo_dominio ?? null, obligatorio ?? null, req.params.id]
      );
      const attribute = rows[0];

      if (Array.isArray(dominio)) {
        await txQuery('DELETE FROM ide.attribute_domain_values WHERE attribute_id = $1', [req.params.id]);
        for (const item of dominio) {
          if (!item || !item.codigo) continue;
          await txQuery(
            `INSERT INTO ide.attribute_domain_values (attribute_id, codigo, descripcion)
             VALUES ($1, $2, $3)`,
            [req.params.id, item.codigo, item.descripcion || null]
          );
        }
      }

      const { rows: domainRows } = await txQuery(
        'SELECT * FROM ide.attribute_domain_values WHERE attribute_id = $1 ORDER BY id',
        [req.params.id]
      );

      return { ...attribute, dominio: domainRows };
    });

    res.json({ data: result });
  } catch (err) {
    console.error('[catalogoObjetos] PUT /atributos/:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /tipos/:id ─────────────────────────────────────────────────────────────
router.put('/tipos/:id', async (req, res) => {
  try {
    const { definicion, alias, style_id } = req.body || {};

    const { rows } = await query(
      `UPDATE ide.feature_types
          SET definicion = COALESCE($1, definicion),
              alias      = COALESCE($2, alias),
              style_id   = COALESCE($3, style_id)
        WHERE id = $4
        RETURNING *`,
      [definicion ?? null, alias ?? null, style_id ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tipo de entidad no encontrado' });

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[catalogoObjetos] PUT /tipos/:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
