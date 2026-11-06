'use strict';

/**
 * clasificacion.js
 * Thematic classification catalogue (temas / subtemas) and resource
 * classification assignment for IDE Nacional (IDEP).
 *
 * ide.temas / ide.subtemas hold the fixed 14-tema / 53-subtema catalogue.
 * PUT /:tipo/:id assigns a tema+subtema pair to a dataset or a service and
 * generates its codigo_unico:  {temaCodigo}{subtemaCodigo}-{entidadSigla}-{NNNN}
 */

const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();
router.use(authenticate);

const ASSIGN_ROLES = ['publicador', 'admin_entidad', 'admin_ide'];

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

// ── GET /temas ─── temas with nested subtemas ───────────────────────────────
router.get('/temas', async (req, res) => {
  try {
    const { rows: temas } = await query(
      `SELECT codigo, nombre, descripcion, orden FROM ide.temas ORDER BY orden, codigo`
    );
    const { rows: subtemas } = await query(
      `SELECT codigo, tema_codigo, nombre, descripcion, orden FROM ide.subtemas ORDER BY orden, codigo`
    );

    const data = temas.map((t) => ({
      ...t,
      subtemas: subtemas.filter((s) => s.tema_codigo === t.codigo),
    }));

    res.json({ data });
  } catch (err) {
    console.error('[clasificacion] GET /temas error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /temas ─── create tema (admin_ide only) ────────────────────────────
router.post('/temas', authorize(['admin_ide']), async (req, res) => {
  try {
    const { codigo, nombre, descripcion, orden } = req.body || {};
    if (!codigo || !nombre) {
      return res.status(400).json({ error: 'codigo y nombre son requeridos' });
    }

    const { rows } = await query(
      `INSERT INTO ide.temas (codigo, nombre, descripcion, orden)
       VALUES ($1, $2, $3, COALESCE($4, 0))
       RETURNING codigo, nombre, descripcion, orden`,
      [codigo.trim(), nombre.trim(), descripcion || null, orden]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[clasificacion] POST /temas error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un tema con ese código' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /temas/:temaCodigo/subtemas ─── create subtema (admin_ide only) ───
router.post('/temas/:temaCodigo/subtemas', authorize(['admin_ide']), async (req, res) => {
  try {
    const { temaCodigo } = req.params;
    const { codigo, nombre, descripcion, orden } = req.body || {};
    if (!codigo || !nombre) {
      return res.status(400).json({ error: 'codigo y nombre son requeridos' });
    }

    const temaRes = await query('SELECT codigo FROM ide.temas WHERE codigo = $1', [temaCodigo]);
    if (!temaRes.rows.length) {
      return res.status(404).json({ error: 'Tema no encontrado' });
    }

    const { rows } = await query(
      `INSERT INTO ide.subtemas (codigo, tema_codigo, nombre, descripcion, orden)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0))
       RETURNING codigo, tema_codigo, nombre, descripcion, orden`,
      [codigo.trim(), temaCodigo, nombre.trim(), descripcion || null, orden]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[clasificacion] POST /temas/:temaCodigo/subtemas error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un subtema con ese código' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /temas/:codigo ─── update tema ──────────────────────────────────────
router.put('/temas/:codigo', authorize(['admin_ide']), async (req, res) => {
  try {
    const { nombre, descripcion, orden } = req.body || {};
    const { rows } = await query(
      `UPDATE ide.temas
          SET nombre      = COALESCE($1, nombre),
              descripcion = COALESCE($2, descripcion),
              orden       = COALESCE($3, orden)
        WHERE codigo = $4
        RETURNING codigo, nombre, descripcion, orden`,
      [nombre || null, descripcion || null, orden, req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tema no encontrado' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[clasificacion] PUT /temas/:codigo error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /subtemas/:codigo ─── update subtema ────────────────────────────────
router.put('/subtemas/:codigo', authorize(['admin_ide']), async (req, res) => {
  try {
    const { nombre, descripcion, orden } = req.body || {};
    const { rows } = await query(
      `UPDATE ide.subtemas
          SET nombre      = COALESCE($1, nombre),
              descripcion = COALESCE($2, descripcion),
              orden       = COALESCE($3, orden)
        WHERE codigo = $4
        RETURNING codigo, tema_codigo, nombre, descripcion, orden`,
      [nombre || null, descripcion || null, orden, req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Subtema no encontrado' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[clasificacion] PUT /subtemas/:codigo error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:tipo/:id ─── assign classification + generate codigo_unico ───────
router.put(
  '/:tipo/:id',
  authorize(ASSIGN_ROLES, { entidadParam: true }),
  async (req, res) => {
    try {
      const { tipo, id } = req.params;
      if (!['dataset', 'servicio'].includes(tipo)) {
        return res.status(400).json({ error: "tipo debe ser 'dataset' o 'servicio'" });
      }

      const { tema_codigo, subtema_codigo } = req.body || {};
      if (!tema_codigo || !subtema_codigo) {
        return res.status(400).json({ error: 'tema_codigo y subtema_codigo son requeridos' });
      }

      const table = tipo === 'dataset' ? 'ide.datasets' : 'ide.services';

      const resourceRes = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (!resourceRes.rows.length) {
        return res.status(404).json({ error: `${tipo === 'dataset' ? 'Dataset' : 'Servicio'} no encontrado` });
      }
      const resource = resourceRes.rows[0];

      if (!isAdminIde(req.user) && resource.entidad_id !== req.user.entidad_id) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }

      // Validate tema+subtema exist and are related
      const subtemaRes = await query(
        `SELECT codigo, tema_codigo FROM ide.subtemas WHERE codigo = $1`,
        [subtema_codigo]
      );
      if (!subtemaRes.rows.length) {
        return res.status(400).json({ error: 'subtema_codigo no existe' });
      }
      if (subtemaRes.rows[0].tema_codigo !== tema_codigo) {
        return res.status(400).json({ error: 'El subtema no pertenece al tema indicado' });
      }
      const temaRes = await query('SELECT codigo FROM ide.temas WHERE codigo = $1', [tema_codigo]);
      if (!temaRes.rows.length) {
        return res.status(400).json({ error: 'tema_codigo no existe' });
      }

      // Entidad sigla
      const entidadRes = await query(
        'SELECT sigla, codigo FROM ide.entidades WHERE id = $1',
        [resource.entidad_id]
      );
      if (!entidadRes.rows.length) {
        return res.status(400).json({ error: 'Entidad del recurso no encontrada' });
      }
      const entidadSigla = (entidadRes.rows[0].sigla || entidadRes.rows[0].codigo || 'ENT')
        .toString()
        .toUpperCase();

      const prefix = `${tema_codigo}${subtema_codigo}-${entidadSigla}-`;

      const countRes = await query(
        `SELECT COUNT(*) FROM ${table} WHERE codigo_unico LIKE $1`,
        [`${prefix}%`]
      );
      const correlativo = parseInt(countRes.rows[0].count, 10) + 1;
      const codigoUnico = `${prefix}${String(correlativo).padStart(4, '0')}`;

      const { rows } = await query(
        `UPDATE ${table}
            SET tema_codigo    = $1,
                subtema_codigo = $2,
                codigo_unico   = $3,
                updated_at     = NOW()
          WHERE id = $4
          RETURNING *`,
        [tema_codigo, subtema_codigo, codigoUnico, id]
      );

      res.json({ data: rows[0], message: 'Clasificación asignada correctamente' });
    } catch (err) {
      console.error('[clasificacion] PUT /:tipo/:id error:', err.message);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

module.exports = router;
