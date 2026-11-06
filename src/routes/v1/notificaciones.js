'use strict';

/**
 * notificaciones.js
 * In-app notification inbox for IDE Nacional (IDEP).
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = Router();
router.use(authenticate);

function parsePagination(q) {
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  return { limit, offset };
}

// ── GET / ─── list notifications for the current user ──────────────────────
router.get('/', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);
    const { leido } = req.query;

    const conditions = ['usuario_id = $1'];
    const params = [req.user.id];

    if (leido !== undefined) {
      params.push(leido === 'true' || leido === '1');
      conditions.push(`leido = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await query(`SELECT COUNT(*) FROM ide.notifications ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT * FROM ide.notifications
        ${where}
        ORDER BY created_at DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ data: rows, meta: { total, limit, offset } });
  } catch (err) {
    console.error('[notificaciones] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/leer ─── mark one as read ──────────────────────────────────────
router.post('/:id/leer', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE ide.notifications SET leido = true
        WHERE id = $1 AND usuario_id = $2
        RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[notificaciones] POST /:id/leer error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /leer-todas ─── mark all unread as read ─────────────────────────────
router.post('/leer-todas', async (req, res) => {
  try {
    const { rowCount } = await query(
      `UPDATE ide.notifications SET leido = true WHERE usuario_id = $1 AND leido = false`,
      [req.user.id]
    );
    res.json({ message: 'Notificaciones marcadas como leídas', actualizadas: rowCount });
  } catch (err) {
    console.error('[notificaciones] POST /leer-todas error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
