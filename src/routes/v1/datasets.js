'use strict';

const { Router } = require('express');
const { query, withTransaction } = require('../../db/pool');
const config = require('../../config');
const { authenticate } = require('../../middleware/auth');
const { authorize } = require('../../middleware/authorize');

const router = Router();

/* ── shared helpers ──────────────────────────────────────────────────────── */
function parsePage(q) {
  const page  = Math.max(1, parseInt(q.page  || '1',  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || '20', 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

async function auditLog(usuarioId, entidadId, accion, tabla, registroId, ip, detalle) {
  try {
    await query(
      `INSERT INTO ide.audit_log (usuario_id, entidad_id, accion, tabla_afectada, registro_id, ip, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [usuarioId, entidadId, accion, tabla, registroId, ip, JSON.stringify(detalle)]
    );
  } catch (_) { /* non-blocking */ }
}

async function notify(usuarioId, tipo, mensaje, url) {
  try {
    await query(
      `INSERT INTO ide.notifications (usuario_id, tipo, mensaje, url)
       VALUES ($1,$2,$3,$4)`,
      [usuarioId, tipo, mensaje, url]
    );
  } catch (_) { /* non-blocking */ }
}

/* ── GET / ─── list datasets ─────────────────────────────────────────────── */
router.get('/', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = parsePage(req.query);
    const isAdmin = req.user.roles.includes('admin_ide');
    const { estado } = req.query;

    const params = [];
    const conditions = [];

    if (!isAdmin) {
      params.push(req.user.entidad_id);
      conditions.push(`d.entidad_id = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      conditions.push(`d.estado = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM ide.datasets d ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT d.id, d.nombre, d.descripcion, d.estado, d.codigo_unico,
              d.geoserver_workspace, d.geoserver_layer,
              d.created_at, d.updated_at,
              e.nombre AS entidad_nombre, e.codigo AS entidad_codigo,
              dv.numero_version, dv.conteo_registros, dv.srid, dv.bbox,
              qr.score AS score_dato,
              qrd.score AS score_documentacion
       FROM ide.datasets d
       JOIN ide.entidades e ON e.id = d.entidad_id
       LEFT JOIN ide.dataset_versions dv ON dv.id = d.version_actual_id
       LEFT JOIN LATERAL (
         SELECT score FROM ide.quality_reports
         WHERE dataset_id = d.id AND tipo_recurso = 'dato'
         ORDER BY created_at DESC LIMIT 1
       ) qr ON true
       LEFT JOIN LATERAL (
         SELECT score FROM ide.quality_reports
         WHERE dataset_id = d.id AND tipo_recurso = 'documentacion'
         ORDER BY created_at DESC LIMIT 1
       ) qrd ON true
       ${where}
       ORDER BY d.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      pagination: {
        total: parseInt(countRows[0].count, 10),
        page,
        limit,
        pages: Math.ceil(parseInt(countRows[0].count, 10) / limit),
      },
    });
  } catch (err) {
    console.error('[datasets GET /]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── GET /:id ─── full detail ────────────────────────────────────────────── */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT d.*, e.nombre AS entidad_nombre, e.codigo AS entidad_codigo,
              dv.numero_version, dv.conteo_registros, dv.srid, dv.bbox,
              dv.tabla_postgis, dv.schema_postgis, dv.hash_contenido, dv.created_at AS version_created_at,
              u.nombre AS usuario_nombre
       FROM ide.datasets d
       JOIN ide.entidades e ON e.id = d.entidad_id
       LEFT JOIN ide.dataset_versions dv ON dv.id = d.version_actual_id
       LEFT JOIN ide.usuarios u ON u.id = d.usuario_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Dataset no encontrado' });

    const ds = rows[0];
    if (!req.user.roles.includes('admin_ide') && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: qReports } = await query(
      `SELECT qr.id, qr.tipo_recurso, qr.score, qr.resultado_global,
              qr.total_checks, qr.checks_ok, qr.checks_advertencia, qr.checks_falla,
              qr.created_at
       FROM ide.quality_reports qr
       WHERE qr.dataset_id = $1
       ORDER BY qr.created_at DESC LIMIT 10`,
      [ds.id]
    );

    res.json({ data: { ...ds, quality_reports: qReports } });
  } catch (err) {
    console.error('[datasets GET /:id]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── POST /:id/aprobar ───────────────────────────────────────────────────── */
router.post('/:id/aprobar', authenticate, authorize('revisor_qa', 'admin_ide'), async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE ide.datasets SET estado = 'publicado', updated_at = NOW()
       WHERE id = $1 AND estado = 'en_revision'
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Dataset no encontrado o no está en estado en_revision' });
    }
    const ds = rows[0];

    await auditLog(req.user.id, req.user.entidad_id, 'DATASET_APROBADO', 'ide.datasets', ds.id, req.ip, { estado: 'publicado' });

    if (ds.usuario_id) {
      await notify(
        ds.usuario_id,
        'dataset_aprobado',
        `El dataset "${ds.nombre}" ha sido aprobado y publicado.`,
        `/datasets/${ds.id}`
      );
    }

    res.json({ data: ds, message: 'Dataset publicado exitosamente' });
  } catch (err) {
    console.error('[datasets POST /:id/aprobar]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── PUT /:id ─── update dataset fields ─────────────────────────────────── */
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { rows: existing } = await query('SELECT * FROM ide.datasets WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Dataset no encontrado' });

    const ds = existing[0];
    if (!req.user.roles.includes('admin_ide') && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { nombre, descripcion, geoserver_workspace, geoserver_layer } = req.body;

    const { rows } = await query(
      `UPDATE ide.datasets
       SET nombre              = COALESCE($1, nombre),
           descripcion         = COALESCE($2, descripcion),
           geoserver_workspace = COALESCE($3, geoserver_workspace),
           geoserver_layer     = COALESCE($4, geoserver_layer),
           updated_at          = NOW()
       WHERE id = $5
       RETURNING *`,
      [nombre || null, descripcion || null, geoserver_workspace || null, geoserver_layer || null, req.params.id]
    );

    await auditLog(req.user.id, req.user.entidad_id, 'DATASET_ACTUALIZADO', 'ide.datasets', ds.id, req.ip, req.body);
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[datasets PUT /:id]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── GET /:id/versiones ──────────────────────────────────────────────────── */
router.get('/:id/versiones', authenticate, async (req, res) => {
  try {
    const { rows: dsRows } = await query(
      'SELECT entidad_id FROM ide.datasets WHERE id = $1',
      [req.params.id]
    );
    if (!dsRows.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    if (!req.user.roles.includes('admin_ide') && dsRows[0].entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows } = await query(
      `SELECT dv.*
       FROM ide.dataset_versions dv
       WHERE dv.dataset_id = $1
       ORDER BY dv.numero_version DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[datasets GET /:id/versiones]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── GET /:id/versiones/comparar?a=v1&b=v2 ─────────────────────────────── */
router.get('/:id/versiones/comparar', authenticate, async (req, res) => {
  try {
    const a = parseInt(req.query.a, 10);
    const b = parseInt(req.query.b, 10);
    if (!a || !b) return res.status(400).json({ error: 'Parámetros a y b (número de versión) requeridos' });

    const { rows: dsRows } = await query(
      'SELECT entidad_id FROM ide.datasets WHERE id = $1',
      [req.params.id]
    );
    if (!dsRows.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    if (!req.user.roles.includes('admin_ide') && dsRows[0].entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: versions } = await query(
      `SELECT * FROM ide.dataset_versions
       WHERE dataset_id = $1 AND numero_version IN ($2, $3)
       ORDER BY numero_version ASC`,
      [req.params.id, a, b]
    );
    if (versions.length < 2) {
      return res.status(404).json({ error: 'Una o ambas versiones no encontradas' });
    }

    const vA = versions.find(v => v.numero_version === a);
    const vB = versions.find(v => v.numero_version === b);

    // Latest quality reports per version (using created_at order as proxy)
    const { rows: allReports } = await query(
      `SELECT id, score, tipo_recurso, resultado_global, total_checks,
              checks_ok, checks_advertencia, checks_falla, created_at,
              json_agg(
                json_build_object(
                  'chequeo', qcr.chequeo,
                  'resultado', qcr.resultado,
                  'valor_obtenido', qcr.valor_obtenido,
                  'elemento_iso19157', qcr.elemento_iso19157
                )
              ) AS checks
       FROM ide.quality_reports qr
       LEFT JOIN ide.quality_check_results qcr ON qcr.report_id = qr.id
       WHERE qr.dataset_id = $1 AND qr.tipo_recurso = 'dato'
       GROUP BY qr.id
       ORDER BY qr.created_at ASC`,
      [req.params.id]
    );

    // Approximate: first report ~ version a, last report ~ version b
    const reportA = allReports[0] || null;
    const reportB = allReports[allReports.length - 1] || null;

    function bboxDiff(b1, b2) {
      if (!b1 || !b2) return null;
      return {
        minx: +((b2.minx || 0) - (b1.minx || 0)).toFixed(6),
        miny: +((b2.miny || 0) - (b1.miny || 0)).toFixed(6),
        maxx: +((b2.maxx || 0) - (b1.maxx || 0)).toFixed(6),
        maxy: +((b2.maxy || 0) - (b1.maxy || 0)).toFixed(6),
      };
    }

    res.json({
      data: {
        version_a: {
          numero: vA.numero_version,
          conteo_registros: vA.conteo_registros,
          bbox: vA.bbox,
          srid: vA.srid,
          tabla_postgis: vA.tabla_postgis,
          created_at: vA.created_at,
          quality: reportA,
        },
        version_b: {
          numero: vB.numero_version,
          conteo_registros: vB.conteo_registros,
          bbox: vB.bbox,
          srid: vB.srid,
          tabla_postgis: vB.tabla_postgis,
          created_at: vB.created_at,
          quality: reportB,
        },
        diff: {
          registros: (vB.conteo_registros || 0) - (vA.conteo_registros || 0),
          bbox: bboxDiff(vA.bbox, vB.bbox),
          score: reportB && reportA ? (reportB.score - reportA.score) : null,
        },
      },
    });
  } catch (err) {
    console.error('[datasets GET /:id/versiones/comparar]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── POST /:id/versiones/:vid/rollback ──────────────────────────────────── */
router.post('/:id/versiones/:vid/rollback', authenticate, authorize('admin_ide', 'admin_entidad'), async (req, res) => {
  try {
    const datasetId = parseInt(req.params.id, 10);
    const versionId = parseInt(req.params.vid, 10);

    const { rows: dsRows } = await query('SELECT * FROM ide.datasets WHERE id = $1', [datasetId]);
    if (!dsRows.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    const ds = dsRows[0];

    if (!req.user.roles.includes('admin_ide') && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows: verRows } = await query(
      'SELECT * FROM ide.dataset_versions WHERE id = $1 AND dataset_id = $2',
      [versionId, datasetId]
    );
    if (!verRows.length) return res.status(404).json({ error: 'Versión no encontrada' });
    const targetVersion = verRows[0];

    await withTransaction(async (txQuery) => {
      // Mark previous active version as historica
      if (ds.version_actual_id && ds.version_actual_id !== versionId) {
        await txQuery(
          `UPDATE ide.dataset_versions SET estado = 'historica' WHERE id = $1`,
          [ds.version_actual_id]
        );
      }
      // Point dataset to target version
      await txQuery(
        `UPDATE ide.datasets SET version_actual_id = $1, updated_at = NOW() WHERE id = $2`,
        [versionId, datasetId]
      );
      // Mark target version as active
      await txQuery(
        `UPDATE ide.dataset_versions SET estado = 'activa' WHERE id = $1`,
        [versionId]
      );
    });

    await auditLog(
      req.user.id, req.user.entidad_id, 'DATASET_ROLLBACK', 'ide.datasets',
      datasetId, req.ip, { version_id: versionId, numero_version: targetVersion.numero_version }
    );

    // TODO: wire geoserverService.updateFeaturetype(ds, targetVersion)
    // to point the GeoServer layer to targetVersion.tabla_postgis

    res.json({
      message: `Rollback a versión ${targetVersion.numero_version} aplicado exitosamente`,
      version: targetVersion,
    });
  } catch (err) {
    console.error('[datasets POST /:id/versiones/:vid/rollback]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/* ── DELETE /:id ─── archive ─────────────────────────────────────────────── */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { rows: existing } = await query('SELECT * FROM ide.datasets WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Dataset no encontrado' });
    const ds = existing[0];

    if (!req.user.roles.includes('admin_ide') && ds.entidad_id !== req.user.entidad_id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { rows } = await query(
      `UPDATE ide.datasets SET estado = 'archivado', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    await auditLog(req.user.id, req.user.entidad_id, 'DATASET_ARCHIVADO', 'ide.datasets', ds.id, req.ip, {});
    res.json({ data: rows[0], message: 'Dataset archivado exitosamente' });
  } catch (err) {
    console.error('[datasets DELETE /:id]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
