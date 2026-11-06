'use strict';

/**
 * uploads.js
 * Raw geo-file upload intake for IDE Nacional (IDEP).
 *
 * POST /   – accept a geographic file, persist the ide.uploads row, and
 *            kick off asynchronous ingestion (ingestService.procesarUpload)
 *            without blocking the HTTP response.
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');
const { uploadGeo } = require('../../middleware/upload');

const router = Router();
router.use(authenticate);
router.use(authorize(['publicador', 'admin_entidad', 'admin_ide']));

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

function parsePagination(q) {
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  return { limit, offset };
}

// ── POST / ─── receive upload, fire-and-forget ingestion ───────────────────
router.post('/', uploadGeo, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'El archivo (campo "archivo") es requerido' });
    }
    if (!req.user.entidad_id) {
      return res.status(400).json({ error: 'El usuario no tiene una entidad asociada' });
    }

    const { rows } = await query(
      `INSERT INTO ide.uploads
         (entidad_id, usuario_id, nombre_original, ruta_archivo, estado)
       VALUES ($1, $2, $3, $4, 'recibido')
       RETURNING id, entidad_id, usuario_id, nombre_original, estado, created_at`,
      [req.user.entidad_id, req.user.id, req.file.originalname, req.file.path]
    );

    const upload = rows[0];

    // Fire-and-forget: does not block the response, errors are self-logged
    // and self-recorded by ingestService.
    require('../../services/ingestService')
      .procesarUpload(upload.id)
      .catch((err) => console.error('[uploads] procesarUpload background error:', err.message));

    res.status(202).json({ data: upload, message: 'Archivo recibido, procesamiento en curso' });
  } catch (err) {
    console.error('[uploads] POST / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET / ─── list uploads (paginated) ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const { estado } = req.query;

    const conditions = [];
    const params = [];

    if (!isAdminIde(req.user)) {
      params.push(req.user.entidad_id);
      conditions.push(`u.entidad_id = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      conditions.push(`u.estado = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await query(`SELECT COUNT(*) FROM ide.uploads u ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT u.id, u.entidad_id, u.usuario_id, u.nombre_original, u.formato_detectado,
              u.estado, u.error_mensaje, u.created_at, u.updated_at,
              e.nombre AS entidad_nombre
         FROM ide.uploads u
         JOIN ide.entidades e ON e.id = u.entidad_id
        ${where}
        ORDER BY u.created_at DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ data: rows, meta: { total, limit, offset } });
  } catch (err) {
    console.error('[uploads] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ─── single upload + quality_report if present ─────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.*, e.nombre AS entidad_nombre,
              qr.id AS quality_report_id, qr.score AS quality_score,
              qr.resultado_global AS quality_resultado
         FROM ide.uploads u
         JOIN ide.entidades e ON e.id = u.entidad_id
         LEFT JOIN LATERAL (
           SELECT id, score, resultado_global
             FROM ide.quality_reports
            WHERE upload_id = u.id
            ORDER BY created_at DESC
            LIMIT 1
         ) qr ON true
        WHERE u.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Upload no encontrado' });

    const upload = rows[0];
    if (!isAdminIde(req.user) && upload.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    res.json({ data: upload });
  } catch (err) {
    console.error('[uploads] GET /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id/log ─── processing log ──────────────────────────────────────────
router.get('/:id/log', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT entidad_id, log_proceso FROM ide.uploads WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Upload no encontrado' });

    const upload = rows[0];
    if (!isAdminIde(req.user) && upload.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    res.json({ data: upload.log_proceso || [] });
  } catch (err) {
    console.error('[uploads] GET /:id/log error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE /:id ─── soft delete when safe ───────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.uploads WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Upload no encontrado' });

    const upload = rows[0];
    if (!isAdminIde(req.user) && upload.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!['rechazado', 'recibido'].includes(upload.estado)) {
      return res.status(409).json({
        error: `No se puede eliminar un upload en estado "${upload.estado}"`,
      });
    }

    await query(
      `UPDATE ide.uploads SET estado = 'rechazado', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Upload eliminado correctamente' });
  } catch (err) {
    console.error('[uploads] DELETE /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
