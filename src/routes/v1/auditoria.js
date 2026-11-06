'use strict';

/**
 * auditoria.js
 * Read-only access to ide.audit_log for IDE Nacional (IDEP). admin_ide only.
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);
router.use(authorize(['admin_ide']));

function parsePagination(q) {
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  return { limit, offset };
}

// ── GET / ─── list audit log entries, filterable ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const { fecha_desde, fecha_hasta, usuario_id, entidad_id, accion } = req.query;

    const conditions = [];
    const params = [];

    if (fecha_desde) {
      params.push(fecha_desde);
      conditions.push(`a.created_at >= $${params.length}`);
    }
    if (fecha_hasta) {
      params.push(fecha_hasta);
      conditions.push(`a.created_at <= $${params.length}`);
    }
    if (usuario_id) {
      params.push(parseInt(usuario_id, 10));
      conditions.push(`a.usuario_id = $${params.length}`);
    }
    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`a.entidad_id = $${params.length}`);
    }
    if (accion) {
      params.push(`%${accion}%`);
      conditions.push(`a.accion ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await query(`SELECT COUNT(*) FROM ide.audit_log a ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT a.id, a.usuario_id, a.entidad_id, a.accion, a.tabla_afectada,
              a.registro_id, a.ip, a.detalle, a.created_at,
              u.nombre AS usuario_nombre, u.email AS usuario_email
         FROM ide.audit_log a
         LEFT JOIN ide.usuarios u ON u.id = a.usuario_id
        ${where}
        ORDER BY a.created_at DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ data: rows, meta: { total, limit, offset } });
  } catch (err) {
    console.error('[auditoria] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
