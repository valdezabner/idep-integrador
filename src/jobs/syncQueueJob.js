'use strict';

const cron = require('node-cron');
const { query } = require('../db/pool');

let task = null;

// Backoff schedule (minutes) indexed by attempt number (1st retry → 1 min, …)
const BACKOFF_MINUTES = [1, 5, 15, 60];
const MAX_INTENTOS = 10;

/**
 * Retry failed GeoNetwork pushes queued in ide.sync_queue.
 * Each row references a metadata_records entry whose last push attempt failed;
 * routes/v1/metadatos.js is the only writer of this table.
 */
async function processSyncQueue() {
  try {
    const { rows } = await query(
      `SELECT sq.id, sq.metadata_id, sq.intentos
         FROM ide.sync_queue sq
        WHERE sq.intentos < $1
          AND sq.proximo_intento <= NOW()
        ORDER BY sq.proximo_intento
        LIMIT 5`,
      [MAX_INTENTOS]
    );

    for (const item of rows) {
      try {
        await reintentarPush(item.metadata_id);
        await query('DELETE FROM ide.sync_queue WHERE id = $1', [item.id]);
        console.log(`[syncQueue] metadata_id=${item.metadata_id} sincronizado tras reintento`);
      } catch (err) {
        const intentos = item.intentos + 1;
        const delayMin = BACKOFF_MINUTES[Math.min(intentos - 1, BACKOFF_MINUTES.length - 1)];
        await query(
          `UPDATE ide.sync_queue
              SET intentos = $2,
                  ultimo_error = $3,
                  proximo_intento = NOW() + ($4 || ' minutes')::interval
            WHERE id = $1`,
          [item.id, intentos, err.message.slice(0, 500), String(delayMin)]
        );
        console.error(
          `[syncQueue] metadata_id=${item.metadata_id} intento ${intentos} falló: ${err.message}`
        );
      }
    }
  } catch (err) {
    console.error('[syncQueue] Error en el barrido de la cola:', err.message);
  }
}

async function reintentarPush(metadataId) {
  const { rows } = await query('SELECT * FROM ide.metadata_records WHERE id = $1', [metadataId]);
  if (!rows.length) return; // record deleted meanwhile; drop the queue entry silently
  const record = rows[0];

  const iso19139Service = require('../services/iso19139Service');
  const geonetworkService = require('../services/geonetworkService');

  const xmlContent = record.xml_iso19139 || (await iso19139Service.generar(record));
  const result = await geonetworkService.pushRecord(xmlContent, record.file_identifier, record.gn_uuid);

  await query(
    `UPDATE ide.metadata_records
        SET gn_uuid = $1, gn_sync_estado = 'sincronizado', gn_sync_at = NOW(),
            gn_sync_error = NULL, xml_iso19139 = $2, updated_at = NOW()
      WHERE id = $3`,
    [result?.uuid || record.gn_uuid || record.file_identifier, xmlContent, metadataId]
  );
}

function start() {
  // Every 2 minutes; proximo_intento gates which rows actually get retried.
  task = cron.schedule('*/2 * * * *', processSyncQueue, { timezone: 'America/Lima' });
  console.log('[syncQueue] Programado — cada 2 minutos');
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, processSyncQueue };
