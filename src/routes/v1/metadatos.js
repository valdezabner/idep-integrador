'use strict';

/**
 * metadatos.js
 * ISO 19139 metadata records for IDE Nacional (IDEP).
 *
 * One metadata_records row per dataset or servicio. `contenido` is a free
 * JSONB bag pre-filled from the underlying resource and enriched with
 * GetCapabilities data (for services) or edited manually via PUT.
 */

const { Router } = require('express');
const { XMLParser } = require('fast-xml-parser');

const { query } = require('../../db/pool');
const { authenticate } = require('../../middleware/auth');

const router = Router();
router.use(authenticate);

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function isAdminIde(user) {
  return (user.roles || []).some((r) => r.rol === 'admin_ide');
}

async function fetchGetCapabilities(urlBase, tipo) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const service = tipo === 'WFS' ? 'WFS' : tipo === 'WCS' ? 'WCS' : 'WMS';
    const sep = urlBase.includes('?') ? '&' : '?';
    const url = `${urlBase}${sep}SERVICE=${service}&REQUEST=GetCapabilities`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return xmlParser.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function extractCapabilitiesInfo(parsed) {
  try {
    const root =
      parsed?.['WMS_Capabilities'] ||
      parsed?.['WFS_Capabilities'] ||
      parsed?.['wfs:WFS_Capabilities'] ||
      parsed?.['WCS_Capabilities'] ||
      {};
    const serviceNode = root?.Service || root?.['ows:ServiceIdentification'] || {};
    const titulo = serviceNode?.Title || serviceNode?.['ows:Title'] || null;
    const resumen = serviceNode?.Abstract || serviceNode?.['ows:Abstract'] || null;
    let keywords = serviceNode?.KeywordList?.Keyword || serviceNode?.['ows:Keywords']?.['ows:Keyword'];
    if (keywords && !Array.isArray(keywords)) keywords = [keywords];
    const palabras_clave = Array.isArray(keywords)
      ? keywords.map((k) => (typeof k === 'string' ? k : k['#text'] || '')).filter(Boolean)
      : [];

    return { titulo, resumen, palabras_clave };
  } catch (_) {
    return { titulo: null, resumen: null, palabras_clave: [] };
  }
}

// ── POST /dataset/:datasetId ─── create/update metadata for a dataset ──────
router.post('/dataset/:datasetId', async (req, res) => {
  try {
    const { datasetId } = req.params;

    const dsRes = await query(
      `SELECT d.id, d.nombre, d.descripcion, d.entidad_id,
              dv.bbox, dv.srid
         FROM ide.datasets d
         LEFT JOIN ide.dataset_versions dv ON dv.id = d.version_actual_id
        WHERE d.id = $1`,
      [datasetId]
    );
    if (!dsRes.rows.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    const ds = dsRes.rows[0];

    if (!isAdminIde(req.user) && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const contenido = {
      titulo: ds.nombre,
      resumen: ds.descripcion || '',
      bbox: ds.bbox || null,
      srid: ds.srid || null,
      ...(req.body?.contenido || {}),
    };

    const existing = await query(
      'SELECT id FROM ide.metadata_records WHERE dataset_id = $1',
      [datasetId]
    );

    let record;
    if (existing.rows.length) {
      const { rows } = await query(
        `UPDATE ide.metadata_records
            SET contenido = $1, tipo_recurso = 'dataset', updated_at = NOW()
          WHERE dataset_id = $2
          RETURNING *`,
        [JSON.stringify(contenido), datasetId]
      );
      record = rows[0];
    } else {
      const { rows } = await query(
        `INSERT INTO ide.metadata_records (dataset_id, tipo_recurso, contenido)
         VALUES ($1, 'dataset', $2)
         RETURNING *`,
        [datasetId, JSON.stringify(contenido)]
      );
      record = rows[0];
    }

    res.status(existing.rows.length ? 200 : 201).json({ data: record });
  } catch (err) {
    console.error('[metadatos] POST /dataset/:datasetId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /servicio/:servicioId ─── create/update, best-effort GetCapabilities ─
router.post('/servicio/:servicioId', async (req, res) => {
  try {
    const { servicioId } = req.params;

    const svcRes = await query(
      'SELECT id, nombre, tipo, url_base, entidad_id FROM ide.services WHERE id = $1',
      [servicioId]
    );
    if (!svcRes.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const svc = svcRes.rows[0];

    if (!isAdminIde(req.user) && svc.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    let contenido = { titulo: svc.nombre };
    try {
      const parsed = await fetchGetCapabilities(svc.url_base, svc.tipo);
      const info = extractCapabilitiesInfo(parsed);
      contenido = {
        titulo: info.titulo || svc.nombre,
        resumen: info.resumen || '',
        palabras_clave: info.palabras_clave,
      };
    } catch (fetchErr) {
      console.warn(
        `[metadatos] GetCapabilities no disponible para servicio ${servicioId}:`,
        fetchErr.message
      );
    }

    contenido = { ...contenido, ...(req.body?.contenido || {}) };

    const existing = await query(
      'SELECT id FROM ide.metadata_records WHERE servicio_id = $1',
      [servicioId]
    );

    let record;
    if (existing.rows.length) {
      const { rows } = await query(
        `UPDATE ide.metadata_records
            SET contenido = $1, tipo_recurso = 'servicio', updated_at = NOW()
          WHERE servicio_id = $2
          RETURNING *`,
        [JSON.stringify(contenido), servicioId]
      );
      record = rows[0];
    } else {
      const { rows } = await query(
        `INSERT INTO ide.metadata_records (servicio_id, tipo_recurso, contenido)
         VALUES ($1, 'servicio', $2)
         RETURNING *`,
        [servicioId, JSON.stringify(contenido)]
      );
      record = rows[0];
    }

    res.status(existing.rows.length ? 200 : 201).json({ data: record });
  } catch (err) {
    console.error('[metadatos] POST /servicio/:servicioId error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id ─── full metadata record ───────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Registro de metadatos no encontrado' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[metadatos] GET /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PUT /:id ─── merge contenido JSONB fields ────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Registro de metadatos no encontrado' });

    const record = existing.rows[0];
    const nuevoContenido = {
      ...(record.contenido || {}),
      ...(req.body?.contenido || req.body || {}),
    };
    delete nuevoContenido.id;

    const { rows } = await query(
      `UPDATE ide.metadata_records
          SET contenido = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [JSON.stringify(nuevoContenido), req.params.id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[metadatos] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── GET /:id/xml ─── generate ISO 19139 XML ──────────────────────────────────
router.get('/:id/xml', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Registro de metadatos no encontrado' });

    const xml = await require('../../services/iso19139Service').generar(rows[0]);
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[metadatos] GET /:id/xml error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /:id/push ─── push to GeoNetwork ────────────────────────────────────
router.post('/:id/push', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Registro de metadatos no encontrado' });
    const record = existing.rows[0];

    const iso19139Service = require('../../services/iso19139Service');
    const geonetworkService = require('../../services/geonetworkService');

    const xmlContent = record.xml_iso19139 || (await iso19139Service.generar(record));

    try {
      const result = await geonetworkService.pushRecord(
        xmlContent,
        record.file_identifier,
        record.gn_uuid
      );

      const { rows } = await query(
        `UPDATE ide.metadata_records
            SET gn_uuid          = $1,
                gn_sync_estado   = 'sincronizado',
                gn_sync_at       = NOW(),
                gn_sync_error    = NULL,
                xml_iso19139     = $2,
                updated_at       = NOW()
          WHERE id = $3
          RETURNING *`,
        [result?.uuid || record.gn_uuid || record.file_identifier, xmlContent, req.params.id]
      );

      res.json({ data: rows[0], message: 'Publicado en GeoNetwork correctamente' });
    } catch (pushErr) {
      await query(
        `UPDATE ide.metadata_records
            SET gn_sync_estado = 'error', gn_sync_error = $1, updated_at = NOW()
          WHERE id = $2`,
        [pushErr.message, req.params.id]
      );

      await query(
        `INSERT INTO ide.sync_queue (metadata_id, intentos, proximo_intento, ultimo_error)
         VALUES ($1, 1, NOW() + INTERVAL '1 minute', $2)`,
        [req.params.id, pushErr.message]
      );

      res.status(502).json({ error: 'No se pudo publicar en GeoNetwork', detalle: pushErr.message });
    }
  } catch (err) {
    console.error('[metadatos] POST /:id/push error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
