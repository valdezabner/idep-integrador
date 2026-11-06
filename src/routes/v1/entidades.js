'use strict';

/**
 * entidades.js
 * Entidad (organisation) management routes for IDE Nacional (IDEP).
 *
 * GET    /            – list all (requires authenticate)
 * GET    /:id         – single entidad with usage stats
 * POST   /            – create (admin_ide only)
 * PUT    /:id         – update (admin_ide or admin_entidad of same entidad)
 * DELETE /:id         – soft delete (admin_ide only)
 */

const { Router } = require('express');

const { query }        = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize }    = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);

// ── GET / ──────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { activo, search } = req.query;

    const conditions = [];
    const params     = [];

    if (activo !== undefined) {
      params.push(activo === 'true' || activo === '1');
      conditions.push(`e.activo = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      conditions.push(`(e.nombre ILIKE $${i} OR e.sigla ILIKE $${i} OR e.codigo ILIKE $${i})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT e.id,
              e.nombre,
              e.codigo,
              e.sigla,
              e.descripcion,
              e.cuota_almacenamiento_mb,
              e.activo,
              e.created_at
         FROM ide.entidades e
        ${where}
        ORDER BY e.nombre ASC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('[entidades] GET / error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ───────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const entResult = await query(
      `SELECT e.id,
              e.nombre,
              e.codigo,
              e.sigla,
              e.descripcion,
              e.cuota_almacenamiento_mb,
              e.activo,
              e.created_at
         FROM ide.entidades e
        WHERE e.id = $1`,
      [id]
    );

    if (!entResult.rows[0]) {
      return res.status(404).json({ error: 'Entidad no encontrada' });
    }

    const entidad = entResult.rows[0];

    // ── Stats ──────────────────────────────────────────────────────────────
    const [usersRes, datasetsRes, servicesRes, storageRes] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE activo) AS activos
           FROM ide.usuarios WHERE entidad_id = $1`,
        [id]
      ),
      query(
        `SELECT COUNT(*) AS total
           FROM ide.datasets WHERE entidad_id = $1 AND activo = true`,
        [id]
      ).catch(() => ({ rows: [{ total: 0 }] })),
      query(
        `SELECT COUNT(*) AS total
           FROM ide.servicios WHERE entidad_id = $1 AND activo = true`,
        [id]
      ).catch(() => ({ rows: [{ total: 0 }] })),
      query(
        `SELECT COALESCE(SUM(tamano_bytes), 0) AS bytes_usados
           FROM ide.uploads
          WHERE entidad_id = $1 AND activo = true AND estado = 'completado'`,
        [id]
      ).catch(() => ({ rows: [{ bytes_usados: 0 }] })),
    ]);

    entidad.stats = {
      usuarios:          parseInt(usersRes.rows[0].total, 10),
      usuarios_activos:  parseInt(usersRes.rows[0].activos, 10),
      datasets:          parseInt(datasetsRes.rows[0].total, 10),
      servicios:         parseInt(servicesRes.rows[0].total, 10),
      almacenamiento_mb: Math.round(
        Number(storageRes.rows[0].bytes_usados) / (1024 * 1024)
      ),
    };

    return res.json(entidad);
  } catch (err) {
    console.error('[entidades] GET /:id error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST / ─────────────────────────────────────────────────────────────────
router.post('/', authorize(['admin_ide']), async (req, res) => {
  try {
    const {
      nombre,
      codigo,
      sigla,
      descripcion,
      cuota_almacenamiento_mb = 10240,
    } = req.body || {};

    if (!nombre || !codigo) {
      return res.status(400).json({ error: 'nombre y codigo son requeridos' });
    }

    // Unique code check
    const existing = await query(
      'SELECT id FROM ide.entidades WHERE codigo = $1',
      [codigo.toUpperCase().trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'El código de entidad ya existe' });
    }

    const result = await query(
      `INSERT INTO ide.entidades
         (nombre, codigo, sigla, descripcion, cuota_almacenamiento_mb, activo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [
        nombre.trim(),
        codigo.toUpperCase().trim(),
        sigla  ? sigla.toUpperCase().trim()  : null,
        descripcion || null,
        cuota_almacenamiento_mb,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[entidades] POST / error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Código o nombre ya registrado' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id ───────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    // Check entidad exists
    const existing = await query(
      'SELECT id FROM ide.entidades WHERE id = $1',
      [targetId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Entidad no encontrada' });
    }

    // Permission: admin_ide or admin_entidad of the same entidad
    const roles = req.user.roles || [];
    const isAdminIde     = roles.some((r) => r.rol === 'admin_ide');
    const isAdminEntidad = roles.some(
      (r) => r.rol === 'admin_entidad' && Number(r.entidad_id) === targetId
    );

    if (!isAdminIde && !isAdminEntidad) {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }

    const { nombre, sigla, descripcion, cuota_almacenamiento_mb } = req.body || {};

    const updates = [];
    const params  = [];

    if (nombre !== undefined) {
      params.push(nombre.trim());
      updates.push(`nombre = $${params.length}`);
    }
    if (sigla !== undefined) {
      params.push(sigla ? sigla.toUpperCase().trim() : null);
      updates.push(`sigla = $${params.length}`);
    }
    if (descripcion !== undefined) {
      params.push(descripcion || null);
      updates.push(`descripcion = $${params.length}`);
    }
    // Only admin_ide can change the storage quota
    if (cuota_almacenamiento_mb !== undefined && isAdminIde) {
      params.push(parseInt(cuota_almacenamiento_mb, 10));
      updates.push(`cuota_almacenamiento_mb = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron campos a actualizar' });
    }

    params.push(targetId);
    const result = await query(
      `UPDATE ide.entidades SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[entidades] PUT /:id error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
router.delete('/:id', authorize(['admin_ide']), async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await query(
      'SELECT id FROM ide.entidades WHERE id = $1',
      [id]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Entidad no encontrada' });
    }

    // Check for active users before deleting
    const activeUsers = await query(
      'SELECT COUNT(*) AS n FROM ide.usuarios WHERE entidad_id = $1 AND activo = true',
      [id]
    );
    if (parseInt(activeUsers.rows[0].n, 10) > 0) {
      return res.status(409).json({
        error: 'No se puede desactivar: la entidad tiene usuarios activos',
      });
    }

    await query(
      'UPDATE ide.entidades SET activo = false WHERE id = $1',
      [id]
    );

    return res.json({ message: 'Entidad desactivada correctamente' });
  } catch (err) {
    console.error('[entidades] DELETE /:id error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
