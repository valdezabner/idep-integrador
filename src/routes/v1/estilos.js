'use strict';

/**
 * estilos.js
 * Cartographic styles (SLD content and ESRI LYR files) for IDE Nacional
 * (IDEP), published to GeoServer via geoserverService.
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');
const { uploadLyr } = require('../../middleware/upload');

const router = Router();
router.use(authenticate);

const MUTATE_ROLES = ['publicador', 'admin_entidad', 'admin_ide'];

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

// ── GET / ─── list styles ─────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { entidad_id } = req.query;
    const conditions = [];
    const params = [];

    if (entidad_id) {
      params.push(parseInt(entidad_id, 10));
      conditions.push(`entidad_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT id, entidad_id, nombre, descripcion, tipo_geometria, geoserver_style_name,
              lyr_nombre_original, created_at, updated_at
         FROM ide.styles
        ${where}
        ORDER BY nombre`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[estilos] GET / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ─── detail including SLD content ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.styles WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Estilo no encontrado' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[estilos] GET /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST / ─── create style + publish to GeoServer ──────────────────────────
router.post('/', authorize(MUTATE_ROLES, { entidadParam: true }), async (req, res) => {
  try {
    const { nombre, descripcion, tipo_geometria, sld_content, entidad_id } = req.body || {};
    if (!nombre || !sld_content) {
      return res.status(400).json({ error: 'nombre y sld_content son requeridos' });
    }
    if (entidad_id && !isAdminIde(req.user) && entidad_id != req.user.entidad_id) {
      return res.status(403).json({ error: 'Solo puede crear estilos de su propia entidad' });
    }

    const geoserverStyleName = `${(entidad_id || req.user.entidad_id || 'ide')}_${nombre}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 100);

    await require('../../services/geoserverService').publishStyle({
      name: geoserverStyleName,
      sldContent: sld_content,
    });

    const { rows } = await query(
      `INSERT INTO ide.styles
         (entidad_id, nombre, descripcion, tipo_geometria, sld_content, geoserver_style_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [entidad_id || req.user.entidad_id, nombre.trim(), descripcion || null, tipo_geometria || null, sld_content, geoserverStyleName]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[estilos] POST / error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id ─── update SLD + re-publish ─────────────────────────────────────
router.put('/:id', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.styles WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Estilo no encontrado' });
    const style = existing.rows[0];

    if (!isAdminIde(req.user) && style.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { sld_content, nombre, descripcion, tipo_geometria } = req.body || {};
    const finalSld = sld_content || style.sld_content;

    if (sld_content) {
      await require('../../services/geoserverService').publishStyle({
        name: style.geoserver_style_name,
        sldContent: finalSld,
      });
    }

    const { rows } = await query(
      `UPDATE ide.styles
          SET nombre         = COALESCE($1, nombre),
              descripcion    = COALESCE($2, descripcion),
              tipo_geometria = COALESCE($3, tipo_geometria),
              sld_content    = $4,
              updated_at     = NOW()
        WHERE id = $5
        RETURNING *`,
      [nombre || null, descripcion || null, tipo_geometria || null, finalSld, req.params.id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[estilos] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/asignar ─── assign style to a layer or feature type ──────────
router.post('/:id/asignar', authorize(MUTATE_ROLES), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.styles WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Estilo no encontrado' });
    const style = existing.rows[0];

    const { dataset_id, layer_name, feature_type_id, workspace } = req.body || {};
    const results = {};

    if (layer_name) {
      results.geoserver = await require('../../services/geoserverService').assignStyle({
        workspace: workspace || 'ide',
        layer: layer_name,
        styleName: style.geoserver_style_name,
      });
    }

    if (feature_type_id) {
      const { rows } = await query(
        `UPDATE ide.feature_types SET style_id = $1 WHERE id = $2 RETURNING *`,
        [req.params.id, feature_type_id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Tipo de entidad no encontrado' });
      }
      results.feature_type = rows[0];
    }

    if (!layer_name && !feature_type_id) {
      return res.status(400).json({ error: 'Se requiere layer_name o feature_type_id' });
    }

    res.json({ data: results, dataset_id: dataset_id || null, message: 'Estilo asignado correctamente' });
  } catch (err) {
    console.error('[estilos] POST /:id/asignar error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/lyr ─── upload an ESRI LYR file ────────────────────────────────
router.post('/:id/lyr', authorize(MUTATE_ROLES), uploadLyr, async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.styles WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Estilo no encontrado' });
    if (!req.file) return res.status(400).json({ error: 'El archivo (campo "lyr") es requerido' });

    const { rows } = await query(
      `UPDATE ide.styles
          SET lyr_ruta            = $1,
              lyr_nombre_original = $2,
              updated_at          = NOW()
        WHERE id = $3
        RETURNING *`,
      [req.file.path, req.file.originalname, req.params.id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[estilos] POST /:id/lyr error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id/lyr ─── download the LYR file ───────────────────────────────────
router.get('/:id/lyr', async (req, res) => {
  try {
    const { rows } = await query('SELECT lyr_ruta, lyr_nombre_original FROM ide.styles WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Estilo no encontrado' });
    const style = rows[0];

    if (!style.lyr_ruta) {
      return res.status(404).json({ error: 'Este estilo no tiene un archivo LYR asociado' });
    }

    const filePath = path.resolve(style.lyr_ruta);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo LYR no encontrado en disco' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${style.lyr_nombre_original || path.basename(filePath)}"`
    );

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[estilos] GET /:id/lyr stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error leyendo el archivo' });
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[estilos] GET /:id/lyr error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
