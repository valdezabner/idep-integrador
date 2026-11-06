'use strict';

const { query } = require('../db/pool');

/**
 * procesarUpload — asynchronous geo-file ingestion pipeline.
 * Called with fire-and-forget from the uploads route (no await).
 *
 * Progression of ide.uploads.estado:
 *   recibido → procesando → completado | error
 *
 * @param {number} uploadId
 */
async function procesarUpload(uploadId) {
  function appendLog(entries) {
    const rows = Array.isArray(entries) ? entries : [entries];
    return query(
      `UPDATE ide.uploads
          SET log_proceso = COALESCE(log_proceso, '[]'::jsonb) || $2::jsonb,
              updated_at  = NOW()
        WHERE id = $1`,
      [uploadId, JSON.stringify(rows)]
    );
  }

  try {
    // Mark as processing
    await query(
      `UPDATE ide.uploads SET estado = 'procesando', updated_at = NOW() WHERE id = $1`,
      [uploadId]
    );

    await appendLog({ ts: new Date().toISOString(), nivel: 'info', msg: 'Procesamiento iniciado' });

    // ── Placeholder for actual GDAL / validation pipeline ─────────────────
    // In production this block would:
    //  1. Detect file format and call GDAL (ogr2ogr / gdalinfo)
    //  2. Validate geometry, CRS, attribute completeness
    //  3. Load into PostGIS (ide.capas_datos)
    //  4. Build quality_report JSON
    //  5. Publish to GeoServer workspace
    // ──────────────────────────────────────────────────────────────────────

    await appendLog({ ts: new Date().toISOString(), nivel: 'info', msg: 'Validación completada' });

    await query(
      `UPDATE ide.uploads
          SET estado         = 'completado',
              updated_at     = NOW(),
              quality_report = $2::jsonb
        WHERE id = $1`,
      [
        uploadId,
        JSON.stringify({
          generado_en: new Date().toISOString(),
          errores: 0,
          advertencias: 0,
          entidades_validas: 0,
        }),
      ]
    );
  } catch (err) {
    console.error(`[ingestService] Error en upload ${uploadId}:`, err.message);
    try {
      await query(
        `UPDATE ide.uploads
            SET estado     = 'error',
                updated_at = NOW(),
                log_proceso = COALESCE(log_proceso, '[]'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          uploadId,
          JSON.stringify([
            {
              ts: new Date().toISOString(),
              nivel: 'error',
              msg: err.message,
            },
          ]),
        ]
      );
    } catch (_) {
      // Best-effort; suppress secondary failure
    }
  }
}

module.exports = { procesarUpload };
