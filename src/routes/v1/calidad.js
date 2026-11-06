'use strict';

/**
 * calidad.js
 * Quality control (ISO 19157-inspired) reports for IDE Nacional (IDEP).
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);

async function withChecks(reportRows) {
  if (!reportRows.length) return reportRows;
  const ids = reportRows.map((r) => r.id);
  const { rows: checks } = await query(
    `SELECT id, report_id, elemento_iso19157, chequeo, resultado,
            valor_obtenido, umbral, es_bloqueante, detalles, created_at
       FROM ide.quality_check_results
      WHERE report_id = ANY($1::int[])
      ORDER BY id`,
    [ids]
  );
  return reportRows.map((r) => ({
    ...r,
    checks: checks.filter((c) => c.report_id === r.id),
  }));
}

// ── GET /upload/:uploadId ────────────────────────────────────────────────────
router.get('/upload/:uploadId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM ide.quality_reports WHERE upload_id = $1 ORDER BY created_at DESC`,
      [req.params.uploadId]
    );
    const data = await withChecks(rows);
    res.json({ data });
  } catch (err) {
    console.error('[calidad] GET /upload/:uploadId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /dataset/:datasetId ──────────────────────────────────────────────────
router.get('/dataset/:datasetId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM ide.quality_reports
        WHERE dataset_id = $1 AND tipo_recurso IN ('dato', 'documentacion')
        ORDER BY created_at DESC`,
      [req.params.datasetId]
    );
    const data = await withChecks(rows);
    res.json({ data });
  } catch (err) {
    console.error('[calidad] GET /dataset/:datasetId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /dataset/:datasetId/documentacion ──────────────────────────────────
router.post('/dataset/:datasetId/documentacion', async (req, res) => {
  try {
    const dsRes = await query('SELECT id FROM ide.datasets WHERE id = $1', [req.params.datasetId]);
    if (!dsRes.rows.length) return res.status(404).json({ error: 'Dataset no encontrado' });

    const result = await require('../../services/qualityService').evaluarDocumentacion(
      req.params.datasetId
    );
    res.json({ data: result });
  } catch (err) {
    console.error('[calidad] POST /dataset/:datasetId/documentacion error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /servicio/:servicioId ───────────────────────────────────────────────
router.post('/servicio/:servicioId', async (req, res) => {
  try {
    const svcRes = await query('SELECT id FROM ide.services WHERE id = $1', [req.params.servicioId]);
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });

    const result = await require('../../services/qualityService').evaluarServicio(
      req.params.servicioId
    );
    res.json({ data: result });
  } catch (err) {
    console.error('[calidad] POST /servicio/:servicioId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /servicio/:servicioId ────────────────────────────────────────────────
router.get('/servicio/:servicioId', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM ide.quality_reports WHERE servicio_id = $1 ORDER BY created_at DESC`,
      [req.params.servicioId]
    );
    const data = await withChecks(rows);
    res.json({ data });
  } catch (err) {
    console.error('[calidad] GET /servicio/:servicioId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /resumen ─── average score by entidad ───────────────────────────────
router.get('/resumen', authorize(['admin_ide', 'admin_entidad']), async (req, res) => {
  try {
    const isAdminIde = (req.user.roles || []).some((r) => r.rol === 'admin_ide');
    const params = [];
    let entidadFilter = '';
    if (!isAdminIde) {
      params.push(req.user.entidad_id);
      entidadFilter = `WHERE e.id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT e.id AS entidad_id, e.nombre AS entidad_nombre, e.codigo AS entidad_codigo,
              COALESCE(AVG(qr.score) FILTER (WHERE qr.tipo_recurso = 'dato'), 0)::NUMERIC(5,2)
                AS score_promedio_dato,
              COALESCE(AVG(qr.score) FILTER (WHERE qr.tipo_recurso = 'documentacion'), 0)::NUMERIC(5,2)
                AS score_promedio_documentacion,
              COALESCE(AVG(qr.score) FILTER (WHERE qr.tipo_recurso = 'servicio'), 0)::NUMERIC(5,2)
                AS score_promedio_servicio,
              COALESCE(AVG(qr.score), 0)::NUMERIC(5,2) AS score_promedio_total,
              COUNT(qr.id) AS total_reportes
         FROM ide.entidades e
         LEFT JOIN (
           SELECT qr.id, qr.score, qr.tipo_recurso,
                  COALESCE(d.entidad_id, s.entidad_id) AS resolved_entidad_id
             FROM ide.quality_reports qr
             LEFT JOIN ide.datasets d ON d.id = qr.dataset_id
             LEFT JOIN ide.services s ON s.id = qr.servicio_id
         ) qr ON qr.resolved_entidad_id = e.id
        ${entidadFilter}
        GROUP BY e.id, e.nombre, e.codigo
        ORDER BY e.nombre`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[calidad] GET /resumen error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
