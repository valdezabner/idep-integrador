'use strict';

/**
 * monitoreo.js
 * Service health-monitoring dashboard endpoints for IDE Nacional (IDEP).
 * The actual probing runs on a schedule (jobs/healthCheckJob.js) via
 * monitorService; this router exposes status reads and an on-demand probe.
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = Router();
router.use(authenticate);

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

// ── GET /estado ─── all services with health + uptime ──────────────────────
router.get('/estado', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (!isAdminIde(req.user)) {
      params.push(req.user.entidad_id);
      conditions.push(`s.entidad_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT s.id, s.nombre, s.tipo, s.entidad_id, s.estado,
              s.fallos_consecutivos, s.ultimo_chequeo,
              COALESCE(up.uptime_30d, 100)::NUMERIC(5,2) AS uptime_30d
         FROM ide.services s
         LEFT JOIN LATERAL (
           SELECT AVG(uptime_pct) AS uptime_30d
             FROM ide.service_uptime_daily
            WHERE service_id = s.id AND fecha >= CURRENT_DATE - INTERVAL '30 days'
         ) up ON true
        ${where}
        ORDER BY s.estado DESC, s.nombre`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[monitoreo] GET /estado error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /servicio/:id ─── last 24h checks + 30d uptime chart ───────────────
router.get('/servicio/:id', async (req, res) => {
  try {
    const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = svcRes.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: checks } = await query(
      `SELECT * FROM ide.service_health_checks
        WHERE service_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC`,
      [req.params.id]
    );

    const { rows: uptimeChart } = await query(
      `SELECT fecha, total_checks, checks_ok, uptime_pct
         FROM ide.service_uptime_daily
        WHERE service_id = $1 AND fecha >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY fecha`,
      [req.params.id]
    );

    res.json({ data: { ...service, health_checks_24h: checks, uptime_chart: uptimeChart } });
  } catch (err) {
    console.error('[monitoreo] GET /servicio/:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /servicio/:id/sondear ─── on-demand probe ───────────────────────────
router.post('/servicio/:id/sondear', async (req, res) => {
  try {
    const svcRes = await query('SELECT entidad_id FROM ide.services WHERE id = $1', [req.params.id]);
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!isAdminIde(req.user) && svcRes.rows[0].entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const result = await require('../../services/monitorService').sondarServicio(req.params.id);
    res.json({ data: result });
  } catch (err) {
    console.error('[monitoreo] POST /servicio/:id/sondear error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
