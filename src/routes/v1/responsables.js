'use strict';

/**
 * responsables.js
 * Designated officials (responsables de la IDE institucional) for IDE
 * Nacional (IDEP). Each responsable is backed by an appointment resolution
 * (PDF) uploaded on creation.
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');

const { query } = require('../../db/pool');
const config = require('../../config');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');
const { uploadPdf } = require('../../middleware/upload');

const router = Router();
router.use(authenticate);

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

function canAdminEntidad(user, entidadId) {
  return (user.roles || []).some(
    (r) =>
      r.rol === 'admin_ide' ||
      ((r.rol === 'admin_entidad' || r.rol === 'publicador') &&
        (r.entidad_id === null || Number(r.entidad_id) === Number(entidadId)))
  );
}

// ── GET / ─── list responsables ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { entidad_id, activo } = req.query;

    const conditions = [];
    const params = [];

    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`r.entidad_id = $${params.length}`);
    } else if (!isAdminIde(req.user)) {
      // Non admin_ide users default to their own entidad
      params.push(req.user.entidad_id);
      conditions.push(`r.entidad_id = $${params.length}`);
    }
    if (activo !== undefined) {
      params.push(activo === 'true' || activo === '1');
      conditions.push(`r.activo = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT r.id, r.entidad_id, r.nombre, r.cargo, r.email, r.telefono,
              r.resolucion_numero, r.resolucion_fecha, r.activo, r.fecha_cese,
              r.created_at,
              e.nombre AS entidad_nombre, e.codigo AS entidad_codigo
         FROM ide.responsables r
         JOIN ide.entidades e ON e.id = r.entidad_id
        ${where}
        ORDER BY r.activo DESC, r.created_at DESC`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[responsables] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST / ─── create responsable with PDF upload ───────────────────────────
router.post('/', uploadPdf, async (req, res) => {
  try {
    const { entidad_id, nombre, cargo, email, telefono, resolucion_numero, resolucion_fecha } =
      req.body || {};

    if (!entidad_id || !nombre) {
      return res.status(400).json({ error: 'entidad_id y nombre son requeridos' });
    }

    if (!canAdminEntidad(req.user, entidad_id)) {
      return res.status(403).json({ error: 'Solo puede registrar responsables de su propia entidad' });
    }

    const rutaPdf = req.file ? req.file.path : null;

    const { rows } = await query(
      `INSERT INTO ide.responsables
         (entidad_id, nombre, cargo, email, telefono,
          resolucion_numero, resolucion_fecha, resolucion_pdf_ruta, activo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING *`,
      [
        entidad_id,
        nombre.trim(),
        cargo || null,
        email || null,
        telefono || null,
        resolucion_numero || null,
        resolucion_fecha || null,
        rutaPdf,
      ]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[responsables] POST / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id/resolucion ─── stream the appointment PDF ─────────────────────
router.get('/:id/resolucion', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT entidad_id, resolucion_pdf_ruta FROM ide.responsables WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Responsable no encontrado' });

    const responsable = rows[0];
    if (!isAdminIde(req.user) && responsable.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!responsable.resolucion_pdf_ruta) {
      return res.status(404).json({ error: 'No hay resolución PDF registrada para este responsable' });
    }

    const filePath = path.resolve(responsable.resolucion_pdf_ruta);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo de resolución no encontrado en disco' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[responsables] GET /:id/resolucion stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error leyendo el archivo' });
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[responsables] GET /:id/resolucion error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id ─── update responsable info ────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.responsables WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Responsable no encontrado' });

    const responsable = existing.rows[0];
    if (!canAdminEntidad(req.user, responsable.entidad_id)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { nombre, cargo, email, telefono, resolucion_numero, resolucion_fecha } = req.body || {};

    const { rows } = await query(
      `UPDATE ide.responsables
          SET nombre             = COALESCE($1, nombre),
              cargo              = COALESCE($2, cargo),
              email              = COALESCE($3, email),
              telefono           = COALESCE($4, telefono),
              resolucion_numero  = COALESCE($5, resolucion_numero),
              resolucion_fecha   = COALESCE($6, resolucion_fecha)
        WHERE id = $7
        RETURNING *`,
      [
        nombre || null,
        cargo || null,
        email || null,
        telefono || null,
        resolucion_numero || null,
        resolucion_fecha || null,
        req.params.id,
      ]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[responsables] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id/cesar ─── mark as ceased, keeping history ──────────────────────
router.put('/:id/cesar', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.responsables WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Responsable no encontrado' });

    const responsable = existing.rows[0];
    if (!canAdminEntidad(req.user, responsable.entidad_id)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows } = await query(
      `UPDATE ide.responsables
          SET activo = false, fecha_cese = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id]
    );

    res.json({ data: rows[0], message: 'Responsable cesado correctamente' });
  } catch (err) {
    console.error('[responsables] PUT /:id/cesar error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
