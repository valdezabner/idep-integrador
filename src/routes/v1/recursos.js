'use strict';

/**
 * recursos.js
 * Unified pipeline view (datos → clasificación → calidad → catálogo →
 * metadatos → publicar) over ide.recursos for IDE Nacional (IDEP).
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = Router();
router.use(authenticate);

const PUBLISHED_STATES = ['publicado', 'activo'];

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

/** Attach latest quality_reports scores (per tipo_recurso dimension) and derived etapas. */
async function enrichWithEtapasAndScores(rows) {
  if (!rows.length) return rows;

  const datasetIds = rows.filter((r) => r.tipo_recurso === 'dataset').map((r) => r.id);
  const servicioIds = rows.filter((r) => r.tipo_recurso === 'servicio').map((r) => r.id);

  const reportsByResource = new Map(); // key `${tipo}:${id}` -> { dimension: report }

  if (datasetIds.length) {
    const { rows: reports } = await query(
      `SELECT DISTINCT ON (dataset_id, tipo_recurso) dataset_id, tipo_recurso, score, resultado_global, created_at
         FROM ide.quality_reports
        WHERE dataset_id = ANY($1::int[])
        ORDER BY dataset_id, tipo_recurso, created_at DESC`,
      [datasetIds]
    );
    for (const r of reports) {
      const key = `dataset:${r.dataset_id}`;
      if (!reportsByResource.has(key)) reportsByResource.set(key, {});
      reportsByResource.get(key)[r.tipo_recurso] = { score: r.score, resultado_global: r.resultado_global };
    }
  }
  if (servicioIds.length) {
    const { rows: reports } = await query(
      `SELECT DISTINCT ON (servicio_id, tipo_recurso) servicio_id, tipo_recurso, score, resultado_global, created_at
         FROM ide.quality_reports
        WHERE servicio_id = ANY($1::int[])
        ORDER BY servicio_id, tipo_recurso, created_at DESC`,
      [servicioIds]
    );
    for (const r of reports) {
      const key = `servicio:${r.servicio_id}`;
      if (!reportsByResource.has(key)) reportsByResource.set(key, {});
      reportsByResource.get(key)[r.tipo_recurso] = { score: r.score, resultado_global: r.resultado_global };
    }
  }

  return rows.map((r) => {
    const scores = reportsByResource.get(`${r.tipo_recurso}:${r.id}`) || {};
    const tieneCalidad = Object.keys(scores).length > 0;

    return {
      ...r,
      scores,
      etapas: {
        datos: true,
        clasificacion: r.codigo_unico != null,
        calidad: tieneCalidad,
        catalogo: r.tiene_catalogo,
        metadatos: r.tiene_metadatos,
        publicar: PUBLISHED_STATES.includes(r.estado),
      },
    };
  });
}

// ── GET / ─── list resources with pipeline checklist ────────────────────────
router.get('/', async (req, res) => {
  try {
    const { entidad_id, estado } = req.query;

    const conditions = [];
    const params = [];

    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`entidad_id = $${params.length}`);
    } else if (!isAdminIde(req.user)) {
      params.push(req.user.entidad_id);
      conditions.push(`entidad_id = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      conditions.push(`estado = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT * FROM ide.recursos ${where} ORDER BY updated_at DESC`,
      params
    );

    const data = await enrichWithEtapasAndScores(rows);
    res.json({ data });
  } catch (err) {
    console.error('[recursos] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:tipo/:id ─── single resource, detailed ────────────────────────────
router.get('/:tipo/:id', async (req, res) => {
  try {
    const { tipo, id } = req.params;
    if (!['dataset', 'servicio'].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'dataset' o 'servicio'" });
    }

    const { rows } = await query(
      `SELECT * FROM ide.recursos WHERE tipo_recurso = $1 AND id = $2`,
      [tipo, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recurso no encontrado' });
    const recurso = rows[0];

    if (!isAdminIde(req.user) && recurso.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const [enriched] = await enrichWithEtapasAndScores([recurso]);

    // Extra entidad + resource-specific detail
    const entidadRes = await query('SELECT * FROM ide.entidades WHERE id = $1', [recurso.entidad_id]);

    let detalle = {};
    if (tipo === 'dataset') {
      const { rows: dsRows } = await query(
        `SELECT d.upload_id, d.geoserver_workspace, d.geoserver_layer,
                dv.numero_version, dv.conteo_registros, dv.srid, dv.bbox, dv.tabla_postgis
           FROM ide.datasets d
           LEFT JOIN ide.dataset_versions dv ON dv.id = d.version_actual_id
          WHERE d.id = $1`,
        [id]
      );
      detalle = dsRows[0] || {};
    } else {
      const { rows: svcRows } = await query(
        `SELECT tipo AS tipo_ogc, url_base, workspace, layer_name, fallos_consecutivos,
                ultimo_chequeo, tiene_replica, replica_tabla
           FROM ide.services WHERE id = $1`,
        [id]
      );
      detalle = svcRows[0] || {};
    }

    res.json({
      data: {
        ...enriched,
        entidad: entidadRes.rows[0] || null,
        detalle,
      },
    });
  } catch (err) {
    console.error('[recursos] GET /:tipo/:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
