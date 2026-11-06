'use strict';

/**
 * publico.js
 * Public (unauthenticated) catalogue endpoints for IDE Nacional (IDEP).
 * Serves the public geo-catalogue frontend under /catalogo.
 */

const { Router } = require('express');

const { query } = require('../../db/pool');

const router = Router();

const PUBLISHED_STATES = ['publicado', 'activo'];

// ── GET /recursos ─── search the unified catalogue view ────────────────────
router.get('/recursos', async (req, res) => {
  try {
    const { q } = req.query;

    const conditions = [`estado = ANY($1::text[])`];
    const params = [PUBLISHED_STATES];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(titulo ILIKE $${params.length} OR descripcion ILIKE $${params.length})`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await query(
      `SELECT id, tipo_recurso, titulo, descripcion, entidad_codigo, entidad_nombre,
              tiene_metadatos, tiene_catalogo, codigo_unico
         FROM ide.recursos
        ${where}
        ORDER BY titulo`,
      params
    );

    const data = rows.map((r) => ({
      id: r.id,
      tipo_recurso: r.tipo_recurso,
      titulo: r.titulo,
      resumen: (r.descripcion || '').slice(0, 180),
      entidad_codigo: r.entidad_codigo,
      entidad_nombre: r.entidad_nombre,
      tiene_metadatos: r.tiene_metadatos,
      tiene_catalogo: r.tiene_catalogo,
      codigo_unico: r.codigo_unico,
    }));

    res.json({ data });
  } catch (err) {
    console.error('[publico] GET /recursos error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /recursos/:tipo/:id ─── full public record ─────────────────────────
router.get('/recursos/:tipo/:id', async (req, res) => {
  try {
    const { tipo, id } = req.params;
    if (!['dataset', 'servicio'].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'dataset' o 'servicio'" });
    }

    const recursoRes = await query(
      `SELECT * FROM ide.recursos WHERE tipo_recurso = $1 AND id = $2`,
      [tipo, id]
    );
    if (!recursoRes.rows.length || !PUBLISHED_STATES.includes(recursoRes.rows[0].estado)) {
      return res.status(404).json({ error: 'Recurso no encontrado' });
    }
    const recurso = recursoRes.rows[0];

    // ── Metadata ────────────────────────────────────────────────────────────
    const metadataRes = await query(
      `SELECT id, contenido FROM ide.metadata_records WHERE ${tipo === 'dataset' ? 'dataset_id' : 'servicio_id'} = $1`,
      [id]
    );
    const metadataRow = metadataRes.rows[0] || null;
    const contenido = metadataRow?.contenido || {};
    const metadato = metadataRow ? {
      id: metadataRow.id,
      resumen: contenido.resumen || recurso.descripcion || null,
      fecha: contenido.fecha || null,
      escala_denominador: contenido.escala_denominador || null,
      palabras_clave: contenido.palabras_clave || [],
    } : null;

    // ── Servicios asociados ─────────────────────────────────────────────────
    let servicios = [];
    if (tipo === 'dataset') {
      const { rows } = await query(
        `SELECT id, nombre, tipo, url_base, estado, tiene_replica
           FROM ide.services
          WHERE dataset_id = $1 AND tipo IN ('WMS', 'WFS')`,
        [id]
      );
      servicios = rows.map((s) => ({
        ...s,
        url_estable: s.tiene_replica ? `/api/v1/ogc/${s.id}` : null,
      }));
    } else {
      const { rows } = await query('SELECT * FROM ide.services WHERE id = $1', [id]);
      servicios = rows.map((s) => ({
        ...s,
        url_estable: s.tiene_replica ? `/api/v1/ogc/${s.id}` : null,
      }));
    }

    // ── Diccionario de datos (feature catalogue) ────────────────────────────
    const catFilterCol = tipo === 'dataset' ? 'dataset_id' : 'servicio_id';
    const catalogueRes = await query(
      `SELECT id FROM ide.feature_catalogues WHERE ${catFilterCol} = $1`,
      [id]
    );

    let diccionario = [];
    if (catalogueRes.rows.length) {
      const catalogueId = catalogueRes.rows[0].id;
      const { rows: types } = await query(
        'SELECT * FROM ide.feature_types WHERE catalogue_id = $1',
        [catalogueId]
      );
      const typeIds = types.map((t) => t.id);
      let attributes = [];
      if (typeIds.length) {
        const { rows } = await query(
          'SELECT * FROM ide.feature_attributes WHERE feature_type_id = ANY($1::int[]) ORDER BY orden',
          [typeIds]
        );
        attributes = rows;
      }
      const attrIds = attributes.map((a) => a.id);
      let domainValues = [];
      if (attrIds.length) {
        const { rows } = await query(
          'SELECT * FROM ide.attribute_domain_values WHERE attribute_id = ANY($1::int[])',
          [attrIds]
        );
        domainValues = rows;
      }

      diccionario = types.map((t) => ({
        id: t.id,
        nombre: t.nombre,
        alias: t.alias,
        atributos: attributes
          .filter((a) => a.feature_type_id === t.id)
          .map((a) => ({
            nombre: a.nombre,
            alias: a.alias,
            definicion: a.definicion,
            tipo_dato: a.tipo_dato,
            dominio: domainValues.filter((d) => d.attribute_id === a.id),
          })),
      }));
    }

    // ── Scores de calidad ────────────────────────────────────────────────────
    const scoreCol = tipo === 'dataset' ? 'dataset_id' : 'servicio_id';
    const { rows: scoreRows } = await query(
      `SELECT DISTINCT ON (tipo_recurso) tipo_recurso, score, resultado_global, created_at
         FROM ide.quality_reports
        WHERE ${scoreCol} = $1
        ORDER BY tipo_recurso, created_at DESC`,
      [id]
    );
    const scores = {};
    for (const row of scoreRows) {
      scores[row.tipo_recurso] = { score: row.score, resultado_global: row.resultado_global };
    }

    res.json({
      data: {
        id: recurso.id,
        tipo_recurso: recurso.tipo_recurso,
        titulo: recurso.titulo,
        descripcion: recurso.descripcion,
        entidad_nombre: recurso.entidad_nombre,
        entidad_codigo: recurso.entidad_codigo,
        codigo_unico: recurso.codigo_unico,
        metadato,
        servicios,
        diccionario,
        scores,
      },
    });
  } catch (err) {
    console.error('[publico] GET /recursos/:tipo/:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /metadatos/:id/xml ─── ISO 19139 XML, generated on the fly if needed ─
router.get('/metadatos/:id/xml', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Registro de metadatos no encontrado' });
    const record = rows[0];

    const xml = record.xml_iso19139 || (await require('../../services/iso19139Service').generar(record));
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[publico] GET /metadatos/:id/xml error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /catalogo-objetos/:tipo/:id/xml ─── ISO 19110 XML ───────────────────
router.get('/catalogo-objetos/:tipo/:id/xml', async (req, res) => {
  try {
    const { tipo, id } = req.params;
    if (!['dataset', 'servicio'].includes(tipo)) {
      return res.status(400).json({ error: "tipo debe ser 'dataset' o 'servicio'" });
    }
    const col = tipo === 'dataset' ? 'dataset_id' : 'servicio_id';

    const { rows } = await query(`SELECT * FROM ide.feature_catalogues WHERE ${col} = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Catálogo de objetos no encontrado' });
    const catalogue = rows[0];

    if (catalogue.xml_iso19110) {
      return res.type('application/xml').send(catalogue.xml_iso19110);
    }

    const { rows: types } = await query(
      'SELECT * FROM ide.feature_types WHERE catalogue_id = $1',
      [catalogue.id]
    );
    const typeIds = types.map((t) => t.id);
    let attributes = [];
    if (typeIds.length) {
      const { rows: attrRows } = await query(
        'SELECT * FROM ide.feature_attributes WHERE feature_type_id = ANY($1::int[]) ORDER BY orden',
        [typeIds]
      );
      attributes = attrRows;
    }
    catalogue.tipos = types.map((t) => ({
      ...t,
      atributos: attributes.filter((a) => a.feature_type_id === t.id),
    }));

    const xml = await require('../../services/iso19110Service').generar(catalogue);
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[publico] GET /catalogo-objetos/:tipo/:id/xml error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
