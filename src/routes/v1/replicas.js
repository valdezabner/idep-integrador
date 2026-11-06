'use strict';

/**
 * replicas.js
 * Local WFS-harvested replicas for third-party OGC services, and the public
 * OGC pass-through/failover redirect for IDE Nacional (IDEP).
 *
 * GET /ogc/:serviceId is UNAUTHENTICATED — it is the stable public entry
 * point ("url_estable") that redirects clients to the live upstream service,
 * or to the local replica workspace when the upstream is down.
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();

const MUTATE_ROLES = ['publicador', 'admin_entidad', 'admin_ide'];

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

function slugify(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// ── POST /servicios/:id/replica ─── create/update replica config ───────────
router.post(
  '/servicios/:id/replica',
  authenticate,
  authorize(MUTATE_ROLES),
  async (req, res) => {
    try {
      const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
      if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
      const service = svcRes.rows[0];

      if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }

      const { wfs_url, intervalo_horas } = req.body || {};
      if (['WMS', 'WCS'].includes(service.tipo) && !wfs_url) {
        return res.status(400).json({
          error: `Los servicios de tipo ${service.tipo} requieren wfs_url para poder generar una réplica vectorial`,
        });
      }

      const tableName = `respaldo_${service.id}_${slugify(service.nombre)}`;

      const { rows } = await query(
        `UPDATE ide.services
            SET tiene_replica           = true,
                replica_tabla           = $1,
                replica_intervalo_horas = COALESCE($2, 24),
                replica_ultima_sync     = NOW(),
                updated_at              = NOW()
          WHERE id = $3
          RETURNING *`,
        [tableName, intervalo_horas, req.params.id]
      );

      // Actual WFS harvesting (ogr2ogr) is triggered asynchronously by the
      // sync endpoint / scheduled job; here we only register the replica.
      res.status(201).json({
        data: rows[0],
        message: 'Réplica registrada. La sincronización inicial quedará pendiente.',
      });
    } catch (err) {
      console.error('[replicas] POST /servicios/:id/replica error:', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── POST /servicios/:id/replica/sync ─── trigger/record a sync ─────────────
router.post('/servicios/:id/replica/sync', authenticate, async (req, res) => {
  try {
    const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = svcRes.rows[0];

    if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!service.tiene_replica) {
      return res.status(409).json({ error: 'Este servicio no tiene una réplica configurada' });
    }

    const { rows } = await query(
      `UPDATE ide.services SET replica_ultima_sync = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ data: rows[0], message: 'Sincronización de réplica registrada' });
  } catch (err) {
    console.error('[replicas] POST /servicios/:id/replica/sync error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE /servicios/:id/replica ─── remove replica config ─────────────────
router.delete(
  '/servicios/:id/replica',
  authenticate,
  authorize(MUTATE_ROLES),
  async (req, res) => {
    try {
      const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.id]);
      if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
      const service = svcRes.rows[0];

      if (!isAdminIde(req.user) && service.entidad_id !== req.user.entidad_id) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }

      const { rows } = await query(
        `UPDATE ide.services
            SET tiene_replica = false, replica_tabla = NULL, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [req.params.id]
      );

      res.json({ data: rows[0], message: 'Réplica eliminada correctamente' });
    } catch (err) {
      console.error('[replicas] DELETE /servicios/:id/replica error:', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── GET /ogc/:serviceId ─── PUBLIC pass-through / failover redirect ────────
router.get('/ogc/:serviceId', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.services WHERE id = $1', [req.params.serviceId]);
    if (!rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = rows[0];

    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    if (service.estado !== 'caido') {
      return res.redirect(302, `${service.url_base}${qs}`);
    }

    if (!service.tiene_replica || !service.replica_tabla) {
      return res.status(503).json({
        error: 'Servicio no disponible',
        detalle: 'El servicio de origen está caído y no cuenta con una réplica local.',
      });
    }

    // Rewrite LAYERS / TYPENAME query params to point at the local replica
    // workspace ("respaldo") and layer/table name.
    const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
    const replicaLayer = `respaldo:${service.replica_tabla}`;
    if (params.has('LAYERS')) params.set('LAYERS', replicaLayer);
    if (params.has('layers')) params.set('layers', replicaLayer);
    if (params.has('TYPENAME')) params.set('TYPENAME', replicaLayer);
    if (params.has('typename')) params.set('typename', replicaLayer);
    if (params.has('TYPENAMES')) params.set('TYPENAMES', replicaLayer);

    const base = service.url_base.split('?')[0];
    const replicaUrl = `${base}?${params.toString()}`;

    return res.redirect(302, replicaUrl);
  } catch (err) {
    console.error('[replicas] GET /ogc/:serviceId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
