'use strict';

/**
 * usuarios.js
 * User-management routes for IDE Nacional (IDEP).
 *
 * All routes require the authenticate middleware.
 * Creation/deletion requires admin_ide or admin_entidad roles.
 */

const { Router } = require('express');
const bcrypt = require('bcryptjs');

const { query, withTransaction } = require('../../db/pool');
const { authenticate }           = require('../../middleware/auth');
const { authorize }              = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);

const BCRYPT_ROUNDS = 12;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX     = 100;

// ── Helpers ────────────────────────────────────────────────────────────────

function parsePagination(reqQuery) {
  const page  = Math.max(1, parseInt(reqQuery.page, 10)  || 1);
  const limit = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, parseInt(reqQuery.limit, 10) || PAGE_SIZE_DEFAULT)
  );
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** Return true if the caller can administer the target entidad. */
function canAdminEntidad(reqUser, entidadId) {
  const roles = reqUser.roles || [];
  return roles.some(
    (r) =>
      r.rol === 'admin_ide' ||
      (r.rol === 'admin_entidad' && Number(r.entidad_id) === Number(entidadId))
  );
}

// ── GET / ──────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { entidad_id, activo } = req.query;

    const conditions = [];
    const params     = [];

    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`u.entidad_id = $${params.length}`);
    }
    if (activo !== undefined) {
      params.push(activo === 'true' || activo === '1');
      conditions.push(`u.activo = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const countRes = await query(
      `SELECT COUNT(*) FROM ide.usuarios u ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    // Data
    const dataParams = [...params, limit, offset];
    const dataRes = await query(
      `SELECT u.id,
              u.nombre,
              u.email,
              u.entidad_id,
              u.activo,
              u.created_at,
              u.updated_at,
              COALESCE(
                json_agg(
                  json_build_object('rol', r.nombre, 'entidad_id', ur.entidad_id)
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
              ) AS roles
         FROM ide.usuarios u
         LEFT JOIN ide.usuario_roles ur ON ur.usuario_id = u.id
         LEFT JOIN ide.roles          r  ON r.id = ur.rol_id
        ${where}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      data:  dataRes.rows,
      meta:  { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[usuarios] GET / error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ───────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const res2 = await query(
      `SELECT u.id,
              u.nombre,
              u.email,
              u.entidad_id,
              u.activo,
              u.created_at,
              u.updated_at,
              COALESCE(
                json_agg(
                  json_build_object('rol', r.nombre, 'entidad_id', ur.entidad_id)
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
              ) AS roles
         FROM ide.usuarios u
         LEFT JOIN ide.usuario_roles ur ON ur.usuario_id = u.id
         LEFT JOIN ide.roles          r  ON r.id = ur.rol_id
        WHERE u.id = $1
        GROUP BY u.id`,
      [id]
    );

    if (!res2.rows[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = { ...res2.rows[0] };
    delete user.password_hash;
    return res.json(user);
  } catch (err) {
    console.error('[usuarios] GET /:id error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST / ─────────────────────────────────────────────────────────────────
router.post(
  '/',
  authorize(['admin_ide', 'admin_entidad']),
  async (req, res) => {
    try {
      const { nombre, email, password, entidad_id, roles: assignedRoles = [] } = req.body || {};

      if (!nombre || !email || !password) {
        return res.status(400).json({ error: 'nombre, email y password son requeridos' });
      }
      if (!entidad_id) {
        return res.status(400).json({ error: 'entidad_id es requerido' });
      }

      // admin_entidad can only create users in their own entidad
      const isAdminIde = (req.user.roles || []).some((r) => r.rol === 'admin_ide');
      if (!isAdminIde && !canAdminEntidad(req.user, entidad_id)) {
        return res.status(403).json({ error: 'Solo puede crear usuarios en su propia entidad' });
      }

      // Check email uniqueness
      const existing = await query(
        'SELECT id FROM ide.usuarios WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'El email ya está registrado' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const newUser = await withTransaction(async (txQuery) => {
        const ins = await txQuery(
          `INSERT INTO ide.usuarios (nombre, email, password_hash, entidad_id, activo)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, nombre, email, entidad_id, activo, created_at`,
          [nombre.trim(), email.toLowerCase().trim(), passwordHash, entidad_id]
        );
        const createdUser = ins.rows[0];

        // Assign roles
        for (const roleEntry of assignedRoles) {
          const { rol_nombre, entidad_id: roleEntidadId } = roleEntry;
          if (!rol_nombre) continue;

          const roleRes = await txQuery(
            'SELECT id FROM ide.roles WHERE nombre = $1',
            [rol_nombre]
          );
          if (!roleRes.rows[0]) continue;

          await txQuery(
            `INSERT INTO ide.usuario_roles (usuario_id, rol_id, entidad_id)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [createdUser.id, roleRes.rows[0].id, roleEntidadId || entidad_id]
          );
        }

        return createdUser;
      });

      // Reload with roles
      const full = await query(
        `SELECT u.id, u.nombre, u.email, u.entidad_id, u.activo, u.created_at,
                COALESCE(
                  json_agg(json_build_object('rol', r.nombre, 'entidad_id', ur.entidad_id))
                  FILTER (WHERE r.id IS NOT NULL), '[]'::json
                ) AS roles
           FROM ide.usuarios u
           LEFT JOIN ide.usuario_roles ur ON ur.usuario_id = u.id
           LEFT JOIN ide.roles r ON r.id = ur.rol_id
          WHERE u.id = $1
          GROUP BY u.id`,
        [newUser.id]
      );

      return res.status(201).json(full.rows[0]);
    } catch (err) {
      console.error('[usuarios] POST / error:', err.message);
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Email ya registrado' });
      }
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── PUT /:id ───────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    // Allow self-update or admin-level update
    const isSelf    = req.user.id === targetId;
    const isAdmin   = (req.user.roles || []).some((r) =>
      r.rol === 'admin_ide' || r.rol === 'admin_entidad'
    );

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Permisos insuficientes' });
    }

    const existing = await query(
      'SELECT id, entidad_id FROM ide.usuarios WHERE id = $1',
      [targetId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const target = existing.rows[0];

    // Non-admin cannot change activo or entidad_id
    const { nombre, email, password, activo } = req.body || {};

    const updates = [];
    const params  = [];

    if (nombre !== undefined) {
      params.push(nombre.trim());
      updates.push(`nombre = $${params.length}`);
    }
    if (email !== undefined) {
      params.push(email.toLowerCase().trim());
      updates.push(`email = $${params.length}`);
    }
    if (password !== undefined && password !== '') {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      params.push(hash);
      updates.push(`password_hash = $${params.length}`);
    }
    if (activo !== undefined && isAdmin) {
      params.push(Boolean(activo));
      updates.push(`activo = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron campos a actualizar' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(targetId);

    const result = await query(
      `UPDATE ide.usuarios SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, nombre, email, entidad_id, activo, updated_at`,
      params
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[usuarios] PUT /:id error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email ya en uso' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  authorize(['admin_ide', 'admin_entidad']),
  async (req, res) => {
    try {
      const targetId = parseInt(req.params.id, 10);

      const existing = await query(
        'SELECT id, entidad_id FROM ide.usuarios WHERE id = $1',
        [targetId]
      );
      if (!existing.rows[0]) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const isAdminIde = (req.user.roles || []).some((r) => r.rol === 'admin_ide');
      if (!isAdminIde && !canAdminEntidad(req.user, existing.rows[0].entidad_id)) {
        return res.status(403).json({ error: 'Solo puede desactivar usuarios de su propia entidad' });
      }

      // Prevent self-deactivation
      if (req.user.id === targetId) {
        return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
      }

      await query(
        `UPDATE ide.usuarios SET activo = false, updated_at = NOW() WHERE id = $1`,
        [targetId]
      );

      return res.json({ message: 'Usuario desactivado correctamente' });
    } catch (err) {
      console.error('[usuarios] DELETE /:id error:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── GET /:id/roles ─────────────────────────────────────────────────────────
router.get('/:id/roles', async (req, res) => {
  try {
    const result = await query(
      `SELECT ur.usuario_id,
              ur.rol_id,
              ur.entidad_id,
              r.nombre AS rol,
              e.nombre AS entidad_nombre,
              e.sigla  AS entidad_sigla
         FROM ide.usuario_roles ur
         JOIN ide.roles    r ON r.id = ur.rol_id
         JOIN ide.entidades e ON e.id = ur.entidad_id
        WHERE ur.usuario_id = $1
        ORDER BY r.nombre`,
      [req.params.id]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('[usuarios] GET /:id/roles error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/roles ────────────────────────────────────────────────────────
router.post(
  '/:id/roles',
  authorize(['admin_ide', 'admin_entidad']),
  async (req, res) => {
    try {
      const targetId = parseInt(req.params.id, 10);
      const { rol_nombre, entidad_id } = req.body || {};

      if (!rol_nombre || !entidad_id) {
        return res.status(400).json({ error: 'rol_nombre y entidad_id son requeridos' });
      }

      // Verify user exists
      const userExists = await query('SELECT id FROM ide.usuarios WHERE id = $1', [targetId]);
      if (!userExists.rows[0]) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // Verify role exists
      const roleRes = await query('SELECT id FROM ide.roles WHERE nombre = $1', [rol_nombre]);
      if (!roleRes.rows[0]) {
        return res.status(404).json({ error: `Rol '${rol_nombre}' no encontrado` });
      }

      await query(
        `INSERT INTO ide.usuario_roles (usuario_id, rol_id, entidad_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [targetId, roleRes.rows[0].id, entidad_id]
      );

      return res.status(201).json({ message: 'Rol asignado correctamente' });
    } catch (err) {
      console.error('[usuarios] POST /:id/roles error:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── DELETE /:id/roles/:rolId ───────────────────────────────────────────────
router.delete(
  '/:id/roles/:rolId',
  authorize(['admin_ide', 'admin_entidad']),
  async (req, res) => {
    try {
      const { id, rolId } = req.params;

      const result = await query(
        `DELETE FROM ide.usuario_roles
          WHERE usuario_id = $1 AND rol_id = $2
         RETURNING usuario_id`,
        [id, rolId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Asignación de rol no encontrada' });
      }

      return res.json({ message: 'Rol removido correctamente' });
    } catch (err) {
      console.error('[usuarios] DELETE /:id/roles/:rolId error:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

module.exports = router;
