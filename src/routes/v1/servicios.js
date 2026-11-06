'use strict';

/**
 * servicios.js
 * OGC service registry (WMS/WFS/WCS), health status and config backups for
 * IDE Nacional (IDEP).
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);

const MUTATE_ROLES = ['publicador', 'admin_entidad', 'admin_ide'];

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

async function validateCapabilities(urlBase, tipo) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const sep = urlBase.includes('?') ? '&' : '?';
    const r = await fetch(`${urlBase}${sep}SERVICE=${tipo}&REQUEST=GetCapabilities`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: r.ok, httpStatus: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── GET / ─── list services with health + uptime ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { entidad_id } = req.query;
    const conditions = [];
    const params = [];

    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`s.entidad_id = $${params.length}`);
    } else if (!isAdminIde(req.user)) {
      params.push(req.user.entidad_id);
      conditions.push(`s.entidad_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT s.id, s.nombre, s.tipo, s.url_base, s.workspace, s.layer_name,
              s.estado, s.fallos_consecutivos, s.ultimo_chequeo,
              s.tiene_replica, s.entidad_id, s.codigo_unico,
              s.created_at, s.updated_at,
              e.nombre AS entidad_nombre,
              COALESCE(up.uptime_30d, 100)::NUMERIC(5,2) AS uptime_30d
         FROM ide.services s
         JOIN ide.entidades e ON e.id = s.entidad_id
         LEFT JOIN LATERAL (
           SELECT AVG(uptime_pct) AS uptime_30d
             FROM ide.service_uptime_daily
            WHERE service_id = s.id AND fecha >= CURRENT_DATE - INTERVAL '30 days'
         ) up ON true
        ${where}
        ORDER BY s.nombre`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[servicios] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ─── detail + recent health checks + backups ───────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.*, e.nombre AS entidad_nombre
         FROM ide.services s
         JOIN ide.entidades e ON e.id = s.entidad_id
        WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: healthChecks } = await query(
      `SELECT * FROM ide.service_health_checks
        WHERE service_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );

    const { rows: backups } = await query(
      `SELECT id, service_id, motivo, created_at
         FROM ide.service_config_backups
        WHERE service_id = $1
        ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ data: { ...service, health_checks: healthChecks, backups } });
  } catch (err) {
    console.error('[servicios] GET /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST / ─── register a new service ────────────────────────────────────────
router.post('/', authorize(MUTATE_ROLES, { entidadParam: true }), async (req, res) => {
  try {
    const {
      nombre, tipo, url_base, entidad_id,
      workspace, layer_name, intervalo_chequeo_min,
    } = req.body || {};

    if (!nombre || !tipo || !url_base || !entidad_id) {
      return res.status(400).json({ error: 'nombre, tipo, url_base y entidad_id son requeridos' });
    }
    if (!['WMS', 'WFS', 'WCS'].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'WMS', 'WFS' o 'WCS'" });
    }
    if (!isAdminIde(req.user) && entidad_id != req.user.entidad_id) {
      return res.status(403).json({ error: 'Solo puede registrar servicios de su propia entidad' });
    }

    // Best-effort validation; never blocks registration
    const capCheck = await validateCapabilities(url_base, tipo);
    if (!capCheck.ok) {
      console.warn(`[servicios] GetCapabilities no accesible para ${url_base}:`, capCheck.error || capCheck.httpStatus);
    }

    const { rows } = await query(
      `INSERT INTO ide.services
         (entidad_id, nombre, tipo, url_base, workspace, layer_name, intervalo_chequeo_min, estado)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 60), 'activo')
       RETURNING *`,
      [entidad_id, nombre.trim(), tipo, url_base, workspace || null, layer_name || null, intervalo_chequeo_min]
    );

    res.status(201).json({ data: rows[0], capabilities_check: capCheck });
  } catch (err) {
    console.error('[servicios] POST / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id ─── update service info ─────────────────────────────────────────
router.put('/:id', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = existing.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { nombre, url_base, workspace, layer_name, intervalo_chequeo_min } = req.body || {};

    const { rows } = await query(
      `UPDATE ide.services
          SET nombre                = COALESCE($1, nombre),
              url_base              = COALESCE($2, url_base),
              workspace             = COALESCE($3, workspace),
              layer_name            = COALESCE($4, layer_name),
              intervalo_chequeo_min = COALESCE($5, intervalo_chequeo_min),
              updated_at            = NOW()
        WHERE id = $6
        RETURNING *`,
      [nombre || null, url_base || null, workspace || null, layer_name || null, intervalo_chequeo_min || null, req.params.id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[servicios] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/backup ─── manual GeoServer config snapshot ──────────────────
router.post('/:id/backup', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = existing.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const snapshot = await require('../../services/geoserverService').snapshot(service);

    const { rows } = await query(
      `INSERT INTO ide.service_config_backups (service_id, snapshot, motivo)
       VALUES ($1, $2, 'manual')
       RETURNING *`,
      [req.params.id, JSON.stringify(snapshot)]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[servicios] POST /:id/backup error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/restore ─── restore from a config backup ──────────────────────
router.post('/:id/restore', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = existing.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { backup_id } = req.body || {};
    const geoserverService = require('../../services/geoserverService');

    let backupRes;
    if (backup_id) {
      backupRes = await query(
        'SELECT * FROM ide.service_config_backups WHERE id = $1 AND service_id = $2',
        [backup_id, req.params.id]
      );
    } else {
      backupRes = await query(
        `SELECT * FROM ide.service_config_backups
          WHERE service_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]
      );
    }
    if (!backupRes.rows.length) {
      return res.status(404).json({ error: 'No se encontró un respaldo para restaurar' });
    }
    const backup = backupRes.rows[0];

    // Snapshot current state first, for undo purposes
    const preRestoreSnapshot = await geoserverService.snapshot(service);
    await query(
      `INSERT INTO ide.service_config_backups (service_id, snapshot, motivo)
       VALUES ($1, $2, 'pre_restore')`,
      [req.params.id, JSON.stringify(preRestoreSnapshot)]
    );

    const result = await geoserverService.restore(backup.snapshot, service);

    res.json({ data: result, backup_restaurado: backup.id, message: 'Restauración completada' });
  } catch (err) {
    console.error('[servicios] POST /:id/restore error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /restore-all ─── admin_ide: restore every GeoServer-published service ─
router.post('/restore-all', authorize(['admin_ide']), async (req, res) => {
  try {
    const geoserverService = require('../../services/geoserverService');

    const { rows: services } = await query(
      `SELECT * FROM ide.services WHERE tiene_replica = false ORDER BY id`
    );

    const summary = { restored: 0, failed: [] };

    for (const service of services) {
      try {
        const backupRes = await query(
          `SELECT * FROM ide.service_config_backups
            WHERE service_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [service.id]
        );
        if (!backupRes.rows.length) {
          summary.failed.push({ service_id: service.id, error: 'Sin respaldo disponible' });
          continue;
        }

        await geoserverService.restore(backupRes.rows[0].snapshot, service);
        summary.restored += 1;
      } catch (err) {
        summary.failed.push({ service_id: service.id, error: err.message });
      }
    }

    res.json({ data: summary });
  } catch (err) {
    console.error('[servicios] POST /restore-all error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE /:id ─── soft delete ──────────────────────────────────────────────
router.delete('/:id', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = existing.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows } = await query(
      `UPDATE ide.services SET estado = 'inactivo', updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ data: rows[0], message: 'Servicio desactivado correctamente' });
  } catch (err) {
    console.error('[servicios] DELETE /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id/uptime ─── daily uptime for last 30 days + summary ─────────────
router.get('/:id/uptime', async (req, res) => {
  try {
    const svcRes = await query('SELECT entidad_id FROM ide.services WHERE id = $1', [req.params.id]);
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    if (!isAdminIde(req.user) && svcRes.rows[0].entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: daily } = await query(
      `SELECT fecha, total_checks, checks_ok, uptime_pct
         FROM ide.service_uptime_daily
        WHERE service_id = $1 AND fecha >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY fecha`,
      [req.params.id]
    );

    const { rows: summaryRows } = await query(
      `SELECT
         COALESCE(AVG(uptime_pct) FILTER (WHERE fecha >= CURRENT_DATE - INTERVAL '1 day'), 100)::NUMERIC(5,2) AS uptime_24h,
         COALESCE(AVG(uptime_pct) FILTER (WHERE fecha >= CURRENT_DATE - INTERVAL '7 days'), 100)::NUMERIC(5,2) AS uptime_7d,
         COALESCE(AVG(uptime_pct) FILTER (WHERE fecha >= CURRENT_DATE - INTERVAL '30 days'), 100)::NUMERIC(5,2) AS uptime_30d
       FROM ide.service_uptime_daily
       WHERE service_id = $1`,
      [req.params.id]
    );

    res.json({ data: { daily, summary: summaryRows[0] } });
  } catch (err) {
    console.error('[servicios] GET /:id/uptime error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
